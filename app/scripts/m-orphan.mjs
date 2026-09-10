// M5 — 주인보다 먼저 온 pane/tab 을 어떻게 하는가.
//
// 1회차 구현은 **그냥 버렸다**. 관측된 실패는 아니었지만 원리상 pane 이 영영 안 보일 수 있고,
// Step 2 ② 가 pane 단위로 터미널을 붙이므로 그건 빈 화면이 된다 (판정문 M5).
// 그래서 버리지 않고 **보류함**에 담았다가 주인이 오면 붙이도록 고쳤다. 여기서 그게 실제로
// 도는지 잰다 — 보류함이 한 번도 안 쓰이면 "고쳤다"는 말에 근거가 없다.
//
// 재는 것: ① 보류함이 실제로 쓰였는가 ② 살아남은 workspace 의 pane 이 하나도 빠지지 않았는가
//          ③ 목록과 실제가 어긋난다면 그 책임이 어디인가 — 앱이 잘못 적용한 것인가,
//             herdr 가 push 를 안 보낸 것인가. 후자는 앱이 고칠 수 없다 (27-push-ordering.json).

import { SESSION, sleep, startApp, startChurn, tidySession, writeRaw } from './lib.mjs'

await tidySession()
const app = await startApp({ name: 'orphan' })
await sleep(500)

// keep 2 씩 — 살아남는 workspace 가 있어야 "붙였다"를 확인할 수 있다.
const churns = [0, 1, 2, 3, 4, 5].map(() => startChurn({ intervalMs: 0, keep: 2 }))
await sleep(8000)
const kept = []
for (const churn of churns) kept.push(...(await churn.stop()).kept)
await waitQuiet(app, 1500, 30000)

const verified = await app.verify()
const state = await app.state()
const entries = app.entries()
await app.stop()

const held = entries.filter((entry) => String(entry.note ?? '').includes('보류함'))
const heldPaneWorkspaces = [...new Set(held.map((entry) => String(entry.subject ?? '').split(':')[0]))]
const actual = verified.verify?.actual ?? { workspaces: [], panes: [] }
// 살아남은 workspace 는 전부 pane 을 하나씩 달고 있어야 한다 — 보류분이 버려졌다면 여기가 빈다.
const survivorsWithoutPane = state.state.workspaces
  .filter((row) => kept.includes(row.workspaceId))
  .filter((row) => row.panes.length === 0)
  .map((row) => row.workspaceId)

// 목록에만 남은 workspace 를 두 갈래로 가른다.
//   (가) 앱이 workspace_closed 를 **받고도** 안 지운 것 → 앱의 잘못이다
//   (나) 앱이 workspace_closed 를 **아예 못 받은** 것 → herdr 가 흘린 것이라 앱이 고칠 수 없다
const receivedCloses = new Set(
  entries.filter((entry) => entry.event === 'workspace_closed').map((entry) => entry.subject),
)
const ghosts = actual.workspaces.length === 0 ? [] : (verified.verify?.converged.workspaces ?? []).filter((id) => !actual.workspaces.includes(id))
const ghostsWithClose = ghosts.filter((id) => receivedCloses.has(id))
const ghostsWithoutClose = ghosts.filter((id) => !receivedCloses.has(id))

const result = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  question: '주인보다 먼저 온 pane/tab 을 보류했다가 붙이는가 (버리지 않는가)',
  churnLanes: churns.length,
  keptWorkspaces: kept,
  heldEvents: { count: held.length, workspaces: heldPaneWorkspaces, notes: held.slice(0, 10).map((entry) => entry.note) },
  finalMatch: verified.verify?.match ?? null,
  comparedWorkspaces: actual.workspaces.length,
  comparedPanes: actual.panes.length,
  survivorsWithoutPane,
  ghosts: {
    total: ghosts.length,
    appFault: { count: ghostsWithClose.length, ids: ghostsWithClose.slice(0, 10) },
    lostPush: { count: ghostsWithoutClose.length, ids: ghostsWithoutClose.slice(0, 10) },
    note:
      'appFault = workspace_closed 를 받고도 목록에 남은 것 (앱 결함). lostPush = 그 push 가 앱에 ' +
      '한 번도 안 온 것 — herdr 가 부하에서 push 를 흘린다는 별도 실측이 있다(27-push-ordering.json).',
  },
  conclusion:
    held.length === 0
      ? '이번 부하에서는 보류함이 한 번도 안 쓰였다 — 고친 경로가 돌았다는 근거가 없다. 공백으로 남긴다.'
      : survivorsWithoutPane.length === 0 && ghostsWithClose.length === 0
        ? `보류함이 ${held.length}회 쓰였고 살아남은 workspace 중 pane 이 빈 것은 없다 — 보류분이 ` +
          `주인에게 붙었다. 목록에만 남은 ${ghosts.length}개는 전부 workspace_closed push 가 앱에 ` +
          '오지 않은 것이라 앱이 잘못 적용한 것이 아니다 (앱이 고칠 수 있는 것도 아니다).'
        : '앱이 받은 close 를 안 지웠다. 원자료를 그대로 두고 결과 문서에 미달로 적을 것.',
}

writeRaw('28-orphan-holding.json', result)
console.log(
  JSON.stringify(
    {
      held: held.length,
      kept: kept.length,
      finalMatch: result.finalMatch,
      comparedWorkspaces: result.comparedWorkspaces,
      survivorsWithoutPane: survivorsWithoutPane.length,
      ghostsAppFault: ghostsWithClose.length,
      ghostsLostPush: ghostsWithoutClose.length,
    },
    null,
    2,
  ),
)
await tidySession()

async function waitQuiet(handle, quietMs, timeoutMs) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const pushes = handle.entries().filter((entry) => entry.tag === 'push.applied')
    const last = pushes.length === 0 ? started : pushes[pushes.length - 1].at
    if (Date.now() - last >= quietMs) return Date.now() - started
    await sleep(100)
  }
  return null
}
