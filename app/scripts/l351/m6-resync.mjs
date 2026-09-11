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
//
// **수정 2회차 — 전제를 바꾼 회차를 덧붙인다 (H-1).**
// 위의 회차는 push 를 **전부** 버린다. 그러면 corral 은 아무것도 모르는 채 멈춰 있을 뿐이라,
// 재리뷰가 반증한 상태 — "일부만 모르는 corral 이 **스스로 틀린 추정**을 한다" — 는 안 만들어진다.
// 그래서 §B 는 `tab_created`·`pane_created` **만** 버린다: 새 탭은 못 보고 닫힘 통보는 받는다.
// 그 상태에서 아는 마지막 탭이 닫히면 연쇄 판별식이 산 workspace 를 지운다. 통과선은
// **재동기가 그걸 되돌리는가** 다 (기준 N7 의 문장 그대로).

import { REPO_DIR, herdrTruth, look, request, sleep, startApp, tidySession, until, writeRaw } from './lib.mjs'

const RESYNC_MS = Number(process.env.LIFE351_RESYNC_MS ?? 5000)
const TIMES = Number(process.env.LIFE351_TIMES ?? 3)

await tidySession(REPO_DIR)
let app = await startApp({ name: 'n7-resync', env: { CORRAL_RESYNC_MS: String(RESYNC_MS) } })
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

// ── §B  corral 이 **일부를 모르는** 상태에서 아는 마지막 탭/pane 이 닫힌다 (H-1) ──────────
// 두 경로 모두 본다: `tab_closed`(fix1 이 연 자리)와 `pane_exited`(1회차부터 있던 같은 결함).
// 앱을 **따로 띄운다**: 위 회차의 5초 재동기로는 어긋난 창이 관측 전에 닫힌다 (첫 실행에서
// 실제로 그랬다 — 묘비를 걷은 로그는 남았는데 어긋난 상태를 못 떴다). 여기서는 재동기를
// 넉넉히 밀어 **어긋난 것을 먼저 보고** 나서 타이머를 기다린다. 회복은 여전히 타이머가 시킨다.
const H1_RESYNC_MS = Number(process.env.LIFE351_H1_RESYNC_MS ?? 20000)
await app.stop()
const app2 = await startApp({ name: 'n7-h1', env: { CORRAL_RESYNC_MS: String(H1_RESYNC_MS) } })
await sleep(800)
await app2.addRepo(REPO_DIR)
await until(async () => (await app2.state()).repos.length === 1, { what: 'H-1 레포 등록' })

app = app2
const 부분유실 = ['tab_closed', 'pane_exited']
out['H-1 부분 유실'] = []
out['H-1 재동기간격ms'] = H1_RESYNC_MS

for (const 경로 of 부분유실) {
  await app.dropPush(false)
  await tidySession(REPO_DIR)
  const 수렴 = await until(async () => ((await look(app)).일치 ? true : null), {
    what: `${경로} 준비 수렴`,
    timeoutMs: 20000,
    everyMs: 60,
  })
  const workspaceId = (await request('workspace.list', {})).workspaces[0].workspace_id
  const 아는탭 = (await request('tab.list', { workspace_id: workspaceId })).tabs[0]
  const 아는pane = (await request('pane.list', {})).panes.find((item) => item.tab_id === 아는탭.tab_id)
  const 전 = await look(app)

  // ① **일부만** 버린다 — 새로 생기는 것은 못 보고, 닫힘 통보는 받는다.
  const mark = Date.now()
  /**
   * `pane_updated` 도 같이 버린다 — 첫 실행이 가르쳐 준 것이다: 이 봉투에는 pane 전체가 실려
   * 와서, `pane_created` 만 막아도 corral 이 **모르는 형제 pane 을 update 로 알아 버린다**
   * (그러면 "일부를 모르는 상태" 가 안 만들어진다). 닫힘 통보(`tab_closed`·`pane_exited`)는
   * 그대로 받는다 — 그게 이 재생의 요점이다.
   */
  const 필터 = ['tab_created', 'pane_created', 'pane_updated']
  await app.dropPush(true, 필터)
  const resyncBefore = resyncCount()

  // ② 밖에서 탭을 하나 만든다. corral 은 이 탭을 **모른다**.
  const 새탭 = await request('tab.create', { workspace_id: workspaceId, cwd: REPO_DIR })
  const 새탭id = 새탭.tab.tab_id
  await until(async () => (await herdrTruth()).tabs.includes(새탭id), { what: '새 탭 herdr 확정', timeoutMs: 15000 })
  await sleep(400)
  const 모르는상태 = await look(app)

  // ③ corral 이 **아는 마지막** 탭/pane 을 닫는다 — 이 통보는 받는다.
  if (경로 === 'tab_closed') {
    await request('tab.close', { tab_id: 아는탭.tab_id })
  } else {
    // 셸이 **프롬프트에 온 뒤**에 친다 — 두 번 연속 확인한다 (m5 와 같은 게이트: 이 기계의 zsh
    // 시작 스크립트가 띄우는 `pyenv-rehash` 사이의 틈을 프롬프트로 착각하면 exit 가 안 먹는다).
    const 프롬프트인가 = async () => {
      const info = (await request('pane.process_info', { pane_id: 아는pane.pane_id })).process_info
      return info.foreground_processes?.length === 1 && info.shell_pid === info.foreground_process_group_id
    }
    await until(
      async () => {
        if (!(await 프롬프트인가())) return null
        await sleep(400)
        return (await 프롬프트인가()) ? true : null
      },
      { what: '프롬프트', timeoutMs: 60000, everyMs: 150 },
    )
    await request('pane.send_text', { pane_id: 아는pane.pane_id, text: 'exit\n' })
  }

  const herdr확정 = await until(
    async () => {
      const truth = await herdrTruth()
      return !truth.tabs.includes(아는탭.tab_id) && truth.workspaces.includes(workspaceId) ? truth : null
    },
    { what: `${경로} herdr 확정`, timeoutMs: 20000, everyMs: 40 },
  )
  // **어긋난 순간을 붙잡는다** — herdr 에는 살아 있는 workspace 가 corral 에서 사라지는 그 창.
  const 잃은순간 = await until(
    async () => {
      const view = await look(app)
      return view.herdr.workspaces.includes(workspaceId) && !view.corral.workspaces.includes(workspaceId)
        ? view
        : null
    },
    { what: `${경로} 산 workspace 를 잃는 순간`, timeoutMs: 10000, everyMs: 40 },
  )
  const 어긋난뒤 = 잃은순간.value ?? (await look(app))
  const 어긋난샷 = await app.shot(`h1-${경로}-diverged`)

  // ④ **주기 타이머**가 돌 때까지 기다린다 — 하네스는 resync 를 부르지 않는다.
  const 돌았나 = await until(async () => (resyncCount() > resyncBefore ? resyncCount() : null), {
    what: `${경로} 재동기 타이머`,
    timeoutMs: RESYNC_MS * 5,
    everyMs: 100,
  })
  const 회복대조 = await until(async () => ((await look(app)).일치 ? true : null), {
    what: `${경로} 회복`,
    timeoutMs: 15000,
    everyMs: 40,
  })
  const 회복뒤 = await look(app)
  const 회복샷 = await app.shot(`h1-${경로}-recovered`)
  const resyncLog = app.entries().filter((entry) => entry.tag === 'resync.applied' && entry.at >= mark)
  const 적용 = app
    .entries()
    .filter((entry) => entry.tag === 'push.applied' && entry.at >= mark)
    .map((entry) => ({ at: entry.at, event: entry.event, note: entry.note }))

  out['H-1 부분 유실'].push({
    경로,
    전제: `${필터.join('·')} 만 버린다 — corral 은 새 탭(${새탭id})을 모른 채 ${경로} 를 받는다`,
    준비수렴: 수렴.ok,
    workspaceId,
    아는탭: 아는탭.tab_id,
    아는pane: 아는pane?.pane_id ?? null,
    새탭: 새탭id,
    '① 유실 전': { corral: 전.corral, 일치: 전.일치 },
    '② 새 탭을 모르는 상태': { corral: 모르는상태.corral, herdr: 모르는상태.herdr, 차이: 모르는상태.차이 },
    '③ 아는 마지막 탭이 닫힌 뒤': {
      corral: 어긋난뒤.corral,
      herdr: 어긋난뒤.herdr,
      일치: 어긋난뒤.일치,
      차이: 어긋난뒤.차이,
      'corral 이 산 workspace 를 잃었나':
        어긋난뒤.herdr.workspaces.includes(workspaceId) && !어긋난뒤.corral.workspaces.includes(workspaceId),
      '잃기까지ms': 잃은순간.ms,
      herdr확정: herdr확정.ok,
      shot: 어긋난샷.file,
    },
    '④ 재동기 뒤': {
      corral: 회복뒤.corral,
      herdr: 회복뒤.herdr,
      일치: 회복뒤.일치,
      차이: 회복뒤.차이,
      '산 workspace 가 돌아왔나': 회복뒤.corral.workspaces.includes(workspaceId),
      회복ms: 돌았나.ms + 회복대조.ms,
      shot: 회복샷.file,
    },
    '유실 주입 유지': (await app.state()).link.droppingPush,
    '버린 push': droppedSince(mark),
    '재동기 로그': resyncLog.map((entry) => ({
      at: entry.at,
      reason: entry.reason,
      note: entry.note,
      added: entry.added,
      removed: entry.removed,
      // **걷어 낸 묘비** — 추정이 틀렸고 재동기가 되돌렸다는 바로 그 증거 (H-1ⓑ).
      lifted: entry.lifted,
    })),
    '적용된 push (유실 뒤)': 적용,
  })
  console.log(
    `H-1 ${경로}: 잃음 ${어긋난뒤.일치 ? 'X' : 'O'} · 회복 ${회복뒤.일치 ? 'O' : 'X'} · 걷은 묘비 ${resyncLog
      .flatMap((entry) => entry.lifted ?? [])
      .join(',') || '없음'}`,
  )
}
await app.dropPush(false)

out.판정 = {
  '회차': out.rounds.length,
  '유실로 실제로 어긋났나 (전 회차)': out.rounds.every((item) => item['② 유실 중 (어긋난 상태)'].일치 === false),
  '버린 push 가 실제로 있었나': out.rounds.every((item) => item['② 유실 중 (어긋난 상태)'].버린push > 0),
  '재동기가 회복시켰나 (전 회차)': out.rounds.every((item) => item['③ 재동기 뒤'].일치 === true),
  '회복이 재동기 로그와 짝지나': out.rounds.every((item) => item['재동기 로그'].some((entry) => entry.note !== '어긋난 것 없음')),
  '유실 주입은 회복 중에도 켜져 있었나': out.rounds.every((item) => item['유실 주입 유지'] === true),
  // ── H-1 (수정 2회차) ──
  'H-1 두 경로 다 쟀나': out['H-1 부분 유실'].length === 2,
  'H-1 산 workspace 를 실제로 잃었나 (두 경로)': out['H-1 부분 유실'].every(
    (item) => item['③ 아는 마지막 탭이 닫힌 뒤']['corral 이 산 workspace 를 잃었나'] === true,
  ),
  'H-1 재동기가 되돌렸나 (두 경로)': out['H-1 부분 유실'].every(
    (item) => item['④ 재동기 뒤']['산 workspace 가 돌아왔나'] === true && item['④ 재동기 뒤'].일치 === true,
  ),
  'H-1 걷어 낸 묘비가 로그에 있나': out['H-1 부분 유실'].every((item) =>
    item['재동기 로그'].some((entry) => (entry.lifted ?? []).length > 0),
  ),
  'H-1 유실 주입은 회복 중에도 켜져 있었나': out['H-1 부분 유실'].every((item) => item['유실 주입 유지'] === true),
}
console.log(JSON.stringify(out.판정, null, 2))
writeRaw('n7-resync.json', out)
await app.stop()
await tidySession(REPO_DIR)
