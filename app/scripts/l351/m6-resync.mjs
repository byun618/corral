// M6 — N7(스냅샷이 진실: 유실을 재동기가 회복한다).
//
// 유실을 **실측한 모양 그대로** 만든다: 커넥션은 멀쩡한 채로 push 만 사라진다
// (LIFE-344 실측 152/274 가 그 모양이었다 — 소켓은 살아 있었다). 소켓을 끊으면 EOF 복구 루프가
// 곧바로 재부트스트랩(=스냅샷)을 돌려서 "재동기가 돌아서 맞췄다" 가 아니라 "끊겨서 다시 붙었다"
// 를 재게 된다. 그래서 제어 채널의 `drop-push` 로 **조용한 유실**을 넣는다.
//
// 회복도 **주기 타이머가** 시킨다 — 하네스가 `resync` 를 부르면 "우리가 불렀다" 가 된다.
// 그래서 이 실행만 `CORRAL_RESYNC_MS` 를 짧게 주고, 타이머가 도는 것을 기다린다.
// **유실 주입은 회복 뒤에도 계속 켜 둔다**: 그래야 회복이 push 덕이 아니라 스냅샷 덕임이 갈린다.

import { REPO_DIR, herdrTruth, look, request, sleep, startApp, tidySession, until, writeRaw } from './lib.mjs'

const RESYNC_MS = Number(process.env.LIFE351_RESYNC_MS ?? 5000)
const TIMES = Number(process.env.LIFE351_TIMES ?? 3)

await tidySession(REPO_DIR)
const app = await startApp({ name: 'n7-resync', env: { CORRAL_RESYNC_MS: String(RESYNC_MS) } })
await sleep(800)
await app.addRepo(REPO_DIR)
await until(async () => (await app.state()).repos.length === 1, { what: '레포 등록' })
await until(async () => (await look(app)).일치, { what: '출발 수렴', timeoutMs: 10000, everyMs: 40 })

const out = { at: new Date().toISOString(), 재동기간격ms: RESYNC_MS, rounds: [] }

function resyncCount() {
  return app.entries().filter((entry) => entry.tag === 'resync.applied').length
}
function droppedSince(mark) {
  return app.entries().filter((entry) => entry.tag === 'push.dropped' && entry.at >= mark).length
}

for (let round = 1; round <= TIMES; round++) {
  const workspaceId = (await request('workspace.list', {})).workspaces[0].workspace_id
  const before = await look(app)

  // ① push 를 조용히 버리기 시작한다 (커넥션은 살아 있다).
  const mark = Date.now()
  await app.dropPush(true)
  const resyncBefore = resyncCount()

  // ② 밖에서 변화를 일으킨다 — 탭 둘을 만들고 하나를 닫는다.
  const made = []
  for (let i = 0; i < 2; i++) {
    const result = await request('tab.create', { workspace_id: workspaceId, cwd: REPO_DIR })
    made.push({ tabId: result.tab.tab_id, paneId: result.root_pane?.pane_id ?? null })
  }
  await sleep(400)
  await request('tab.close', { tab_id: made[0].tabId })

  // ③ herdr 가 그 변화를 확정할 때까지 기다린 뒤 **어긋난 상태**를 뜬다.
  const herdrSettled = await until(
    async () => {
      const truth = await herdrTruth()
      return truth.tabs.includes(made[1].tabId) && !truth.tabs.includes(made[0].tabId) ? truth : null
    },
    { what: 'herdr 확정', timeoutMs: 15000, everyMs: 40 },
  )
  await sleep(300)
  const 어긋난뒤 = await look(app)
  const 어긋난샷 = await app.shot(`n7-${round}-diverged`)

  // ④ **주기 타이머**가 돌 때까지 기다린다. 하네스는 resync 를 부르지 않는다.
  const recovered = await until(async () => (resyncCount() > resyncBefore ? resyncCount() : null), {
    what: '재동기 타이머',
    timeoutMs: RESYNC_MS * 4,
    everyMs: 100,
  })
  const 회복대조 = await until(async () => (await look(app)).일치, { what: '회복', timeoutMs: 10000, everyMs: 40 })
  const 회복뒤 = await look(app)
  const 회복샷 = await app.shot(`n7-${round}-recovered`)
  const resyncLog = app.entries().filter((entry) => entry.tag === 'resync.applied' && entry.at >= mark)

  out.rounds.push({
    round,
    '유실 주입 유지': (await app.state()).link.droppingPush,
    만든탭: made,
    herdr확정: herdrSettled.ok,
    '① 유실 전': { corral: before.corral, 일치: before.일치 },
    '② 유실 중 (어긋난 상태)': {
      corral: 어긋난뒤.corral,
      herdr: 어긋난뒤.herdr,
      일치: 어긋난뒤.일치,
      차이: 어긋난뒤.차이,
      버린push: droppedSince(mark),
      shot: 어긋난샷.file,
    },
    '③ 재동기 뒤': {
      corral: 회복뒤.corral,
      herdr: 회복뒤.herdr,
      일치: 회복뒤.일치,
      차이: 회복뒤.차이,
      회복ms: recovered.ms + 회복대조.ms,
      shot: 회복샷.file,
    },
    '재동기 로그': resyncLog.map((entry) => ({
      at: entry.at,
      reason: entry.reason,
      note: entry.note,
      added: entry.added,
      removed: entry.removed,
      keptNewer: entry.keptNewer,
    })),
  })
  console.log(
    `#${round} 어긋남 ${어긋난뒤.일치 ? 'X(안 어긋남)' : 'O'} · 버린push ${droppedSince(mark)} · 회복 ${회복뒤.일치 ? 'O' : 'X'}`,
  )

  // 다음 회차를 위해 주입을 끄고 상태를 맞춘다.
  await app.dropPush(false)
  await until(async () => (await look(app)).일치, { what: '회차 정리', timeoutMs: 10000, everyMs: 40 })
}

out.판정 = {
  '회차': out.rounds.length,
  '유실로 실제로 어긋났나 (전 회차)': out.rounds.every((item) => item['② 유실 중 (어긋난 상태)'].일치 === false),
  '버린 push 가 실제로 있었나': out.rounds.every((item) => item['② 유실 중 (어긋난 상태)'].버린push > 0),
  '재동기가 회복시켰나 (전 회차)': out.rounds.every((item) => item['③ 재동기 뒤'].일치 === true),
  '회복이 재동기 로그와 짝지나': out.rounds.every((item) => item['재동기 로그'].some((entry) => entry.note !== '어긋난 것 없음')),
  '유실 주입은 회복 중에도 켜져 있었나': out.rounds.every((item) => item['유실 주입 유지'] === true),
}
console.log(JSON.stringify(out.판정, null, 2))
writeRaw('n7-resync.json', out)
await app.stop()
await tidySession(REPO_DIR)
