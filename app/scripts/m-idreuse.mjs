// M7 — herdr 가 workspace_id 를 재사용하는가.
//
// 왜 재나: store.ts 가 "닫힌 지 얼마 안 된 id 로 온 workspace_created 는 늦게 온 과거"로 보고
// 버린다. id 가 재사용되면 이 방어가 **멀쩡한 create 를 버린다**. 1회차 구현은 그 창을 5초로
// 잡아 놓고 재사용 여부를 "모름"으로 뒀다 (판정문 M7). 여기서 재고 창을 정한다.
//
// 두 가지를 본다:
//   ① 한 서버 생애 안에서 만들었다 닫은 id 가 다시 나오는가
//   ② 서버를 껐다 켜면 카운터가 되돌아가는가 (K6 이 실제로 하는 일이다).
//      껐다 켜기를 **두 번** 해서 두 생애의 id 열을 직접 맞대 본다 — 되돌아간다면 같은 열이 나온다.
//   ③ 되돌아간다면, 앱의 늦은-create 방어가 **재사용된 id 의 멀쩡한 create 를 버리는가**.
//      묘비는 시간 제한이 없으므로, 지워지지 않는다면 그 id 는 영영 안 보여야 한다.
//
// 격리: life344-* 세션에서만 돈다 (socketPath 가 코드로 막는다).

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { SESSION, request, sleep, socketPath, startApp, tidySession, writeRaw } from './lib.mjs'

const run = promisify(execFile)
socketPath() // 격리 가드
const ROUNDS = 40

await tidySession()

// --- ① 같은 서버 안에서 만들고 닫기를 반복한다 ---------------------------
const firstLife = []
for (let i = 0; i < ROUNDS; i++) {
  const created = await request('workspace.create')
  const workspaceId = created.result?.workspace?.workspace_id
  firstLife.push(workspaceId)
  await request('workspace.close', { workspace_id: workspaceId })
}

// --- ② 서버를 껐다 켠다. 두 번 해서 두 생애의 id 열을 맞댄다 (K6 과 같은 경로) ---
const stops = []
const secondLife = await nextLife()
const thirdLife = await nextLife()

const repeatsWithinLife = firstLife.filter((id, index) => firstLife.indexOf(id) !== index)
// 카운터가 되돌아가면 두 생애가 **같은 열**을 낸다 — 그게 재사용의 직접 증거다.
const reusedAcrossLives = thirdLife.filter((id) => secondLife.includes(id))
const counterResets = JSON.stringify(secondLife) === JSON.stringify(thirdLife)

// --- ③ 재사용된 id 를 앱이 버리는가 ---
const app = await startApp({ name: 'idreuse' })
// 생애 B — 여기서 만든 workspace 를 닫아 앱에 "닫힘 기록"을 남긴다.
const lifeB = await restartServer()
await waitLive(app, lifeB)
const victim = (await request('workspace.create')).result?.workspace?.workspace_id
await waitRow(app, victim, true)
await request('workspace.close', { workspace_id: victim })
await waitRow(app, victim, false)
const tombstoneAt = Date.now()

// 생애 C — 카운터가 되돌아가므로 같은 id 가 다시 나온다.
const lifeC = await restartServer()
await waitLive(app, lifeC)
const reborn = (await request('workspace.create')).result?.workspace?.workspace_id
const rebornVisible = await waitRow(app, reborn, true)
const tombstoneAgeMs = Date.now() - tombstoneAt
const discarded = app
  .entries()
  .filter((entry) => entry.at >= tombstoneAt && String(entry.note ?? '').includes('늦게 온 것'))
await app.stop()

const result = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  question: 'herdr 가 닫힌 workspace_id 를 다시 쓰는가 (store.ts 의 늦은-create 창이 안전한가)',
  rounds: ROUNDS,
  firstLife: { ids: firstLife, repeats: repeatsWithinLife },
  restarts: stops,
  secondLife: { ids: secondLife },
  thirdLife: { ids: thirdLife, reusedFromSecondLife: reusedAcrossLives },
  withinOneLife:
    repeatsWithinLife.length === 0
      ? `한 생애 안에서는 재사용이 없다 (${ROUNDS}회 연속 생성·종료, 중복 0).`
      : `한 생애 안에서 재사용이 관측됐다 (${repeatsWithinLife.length}건).`,
  acrossLives: counterResets
    ? '**재기동하면 카운터가 처음으로 되돌아간다.** 두 생애가 같은 id 열을 냈다 — id 는 서버 생애 ' +
      '안에서만 유일하다.'
    : '두 생애의 id 열이 달랐다. 이번 측정에서는 되돌아감이 관측되지 않았다.',
  defence: {
    question: '재기동으로 id 가 되돌아왔을 때, 늦은-create 방어가 멀쩡한 create 를 버리는가',
    closedInLifeB: victim,
    createdInLifeC: reborn,
    sameId: victim === reborn,
    tombstoneAgeWhenRebornMs: tombstoneAgeMs,
    rebornVisibleInApp: rebornVisible,
    discardedCreates: discarded.map((entry) => entry.note),
    verdict:
      victim === reborn && rebornVisible && discarded.length === 0
        ? '버리지 않는다. 묘비는 재부트스트랩의 applySnapshot → reset() 에서 지워지므로, ' +
          '시간 제한이 없는데도 새 생애의 같은 id 가 살아남았다 — 실측으로 확인.'
        : '기대와 다르다. 원자료를 그대로 두고 결과 문서에 미달/보류로 적을 것.',
  },
  soWhat:
    '닫힌 id 방어(store.ts 의 묘비)가 위험해지려면 **같은 서버 생애 안에서** ' +
    'id 가 재사용되어야 한다. 재사용은 생애를 건너서만 일어나고, 생애가 바뀌는 유일한 경로는 ' +
    '재부트스트랩이다 — 재부트스트랩은 applySnapshot 이 reset() 을 불러 묘비를 지운 **뒤에** ' +
    '버퍼를 적용한다(session-link.ts). ③ 이 그걸 실측으로 확인한다. ' +
    '이 측정 덕분에 시간창을 아예 버릴 수 있었다 — 한 생애 안에서 재사용이 없으므로 닫힌 id 로 ' +
    '오는 create 는 언제 오든 과거다 (28-orphan-holding.json 이 시간창의 실패를 보였다). ' +
    '**Step 2 가 물려받을 사실**: workspace_id 는 서버 생애 안에서만 유일하다. 재기동을 건너 ' +
    'id 로 무언가를 기억해 두면 다른 workspace 를 가리키게 된다.',
}

writeRaw('29-id-reuse.json', result)
console.log(
  JSON.stringify(
    {
      repeatsWithinLife: repeatsWithinLife.length,
      counterResetsOnRestart: counterResets,
      reusedAcrossLives: reusedAcrossLives.length,
      firstOfEachLife: [firstLife[0], secondLife[0], thirdLife[0]],
      defenceKeepsRebornId: result.defence.sameId && result.defence.rebornVisibleInApp,
      discardedCreates: result.defence.discardedCreates.length,
    },
    null,
    2,
  ),
)
await tidySession()

/** 서버를 껐다 켜고, 새 생애에서 10번 만들었다 닫는다. */
async function nextLife() {
  await restartServer()
  const ids = []
  for (let i = 0; i < 10; i++) {
    const created = await request('workspace.create')
    const workspaceId = created.result?.workspace?.workspace_id
    ids.push(workspaceId)
    await request('workspace.close', { workspace_id: workspaceId })
  }
  return ids
}

/** 격리 세션 서버를 껐다 켠다. 다시 응답할 때까지 기다린다. 돌려주는 값은 재기동 시각이다. */
async function restartServer() {
  const stopped = await run('herdr', ['session', 'stop', SESSION])
  stops.push({ at: Date.now(), stdout: stopped.stdout.trim() })
  await sleep(500)
  const restart = spawn('script', ['-q', '/dev/null', 'herdr', 'session', 'attach', SESSION], {
    detached: true,
    stdio: 'ignore',
  })
  restart.unref()
  const at = Date.now()
  const deadline = at + 20000
  while (Date.now() < deadline) {
    try {
      await request('ping', {}, { timeoutMs: 800 })
      return at
    } catch {
      await sleep(200)
    }
  }
  throw new Error('재기동 뒤 20초 안에 안 붙었다')
}

/** 앱이 그 시각 이후에 다시 live 로 올라올 때까지 기다린다. */
async function waitLive(handle, since) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const live = handle.entries().find((entry) => entry.tag === 'link.phase' && entry.phase === 'live' && entry.at >= since)
    if (live) return true
    await sleep(150)
  }
  throw new Error('앱이 30초 안에 복구하지 못했다')
}

/** 그 workspace 가 앱 목록에 있다/없다가 될 때까지 기다린다. */
async function waitRow(handle, workspaceId, present) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const state = await handle.state()
    if (state.state.workspaces.some((row) => row.workspaceId === workspaceId) === present) return true
    await sleep(150)
  }
  return false
}
