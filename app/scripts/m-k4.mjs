// K4 — 버퍼 적용 멱등. 이미 반영된 create 이벤트를 **의도적으로 중복 주입**한다.
//
// 주입은 앱 안에서 한다 (CORRAL_INJECT_DUP=1): 버퍼의 모든 이벤트를 두 번 적용한다.
// 하네스가 밖에서 흉내내면 "앱이 안 깨진다"를 증명하지 못한다.

import { sleep, startApp, startChurn, tidySession, writeRaw } from './lib.mjs'

await tidySession()
// 부트스트랩 창은 ~110ms 다. 갈래가 적으면 그 창에 이벤트가 하나도 안 걸려 **주입을 못 하는
// 회차**가 나온다 (실제로 났다). K1 과 같은 밀도로 흔든다.
const churns = [0, 1, 2, 3, 4, 5, 6, 7].map(() => startChurn({ intervalMs: 0 }))
await sleep(600)

const app = await startApp({
  name: 'k4',
  env: { CORRAL_INJECT_DUP: '1' },
  waitFor: (entries) => entries.some((entry) => entry.tag === 'boot.converged'),
})
for (const churn of churns) await churn.stop()
// 흔드는 중의 수렴 비교는 서로 다른 시점을 비교하는 것이라 의미가 없다 — 조용해진 뒤에 본다
// (K1 과 같은 이유). K4 의 통과선은 수렴이 아니라 "중복 주입해도 목록이 안 깨진다" 이지만,
// 곁들여 싣는 값이라도 잴 수 있는 조건에서 재야 한다.
await waitQuiet(app, 1500, 30000)

const verify = await app.verify()
const state = await app.state()
await app.shot('k4-after-duplicate-injection')

const entries = app.entries()
const applied = entries.filter((entry) => entry.tag === 'boot.buffer.apply')
const duplicates = entries.filter((entry) => entry.tag === 'boot.buffer.apply.duplicate')
const rows = state.state.workspaces
const ids = rows.map((row) => row.workspaceId)

const result = {
  measuredAt: new Date().toISOString(),
  injectedDuplicates: duplicates.length,
  firstApplications: applied.length,
  // 중복 적용이 상태를 바꿨는가 — 멱등하면 두 번째 적용은 changed:false 이거나 같은 값을 덮어쓴다
  duplicateOutcomes: duplicates.map((entry) => ({ event: entry.event, changed: entry.changed, note: entry.note })),
  listHasDuplicateIds: ids.length !== new Set(ids).size,
  rows: rows.map((row) => ({ id: row.workspaceId, label: row.label, paneCount: row.paneCount, tabCount: row.tabCount })),
  paneCountsSane: rows.every((row) => row.paneCount >= 0 && row.paneCount <= 20),
  verifyMatch: verify.verify?.match ?? null,
  verify: verify.verify,
}

// 주입이 0건이면 이 회차는 멱등성을 **증명하지 못한 것**이다 — 통과가 아니다.
result.pass = result.injectedDuplicates > 0 && !result.listHasDuplicateIds && result.paneCountsSane
result.conclusion = result.pass
  ? `버퍼 ${result.firstApplications}건을 각각 두 번 적용했는데(중복 ${result.injectedDuplicates}건) 목록에 중복 id 가 없고 pane 수가 안 흔들렸다.`
  : result.injectedDuplicates === 0
    ? '부트스트랩 창에 이벤트가 안 걸려 중복 주입 자체를 못 했다 — 보류(다시 측정할 것).'
    : '중복 주입 뒤 목록이 깨졌다. 결과 문서에 미달로 적을 것.'

writeRaw('22-k4-idempotent.json', result)
console.log(
  JSON.stringify(
    {
      injectedDuplicates: result.injectedDuplicates,
      firstApplications: result.firstApplications,
      listHasDuplicateIds: result.listHasDuplicateIds,
      verifyMatch: result.verifyMatch,
      pass: result.pass,
      rows: result.rows,
    },
    null,
    2,
  ),
)

await app.stop()
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
