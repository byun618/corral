// K4 — 버퍼 적용 멱등. 이미 반영된 create 이벤트를 **의도적으로 중복 주입**한다.
//
// 주입은 앱 안에서 한다 (CORRAL_INJECT_DUP=1): 버퍼의 모든 이벤트를 두 번 적용한다.
// 하네스가 밖에서 흉내내면 "앱이 안 깨진다"를 증명하지 못한다.

import { sleep, startApp, startChurn, tidySession, writeRaw } from './lib.mjs'

await tidySession()
const churns = [0, 1, 2, 3].map(() => startChurn({ intervalMs: 0 }))
await sleep(600)

const app = await startApp({
  name: 'k4',
  env: { CORRAL_INJECT_DUP: '1' },
  waitFor: (entries) => entries.some((entry) => entry.tag === 'boot.converged'),
})
for (const churn of churns) await churn.stop()
await sleep(1200)

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

writeRaw('22-k4-idempotent.json', result)
console.log(
  JSON.stringify(
    {
      injectedDuplicates: result.injectedDuplicates,
      listHasDuplicateIds: result.listHasDuplicateIds,
      verifyMatch: result.verifyMatch,
      rows: result.rows,
    },
    null,
    2,
  ),
)

await app.stop()
await tidySession()
