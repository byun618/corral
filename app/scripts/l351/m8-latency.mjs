// M8 — A1(외부 변화 → 목록 반영 지연). 통과선은 없다 — **재는 것 자체가 항목**이다.
//
// 무엇부터 무엇까지인가: herdr 요청이 **응답한 시각**부터 corral 목록에 그 행이 보이는(또는
// 사라지는) 시각까지. 요청을 보낸 시각이 아니라 응답 시각을 0 으로 잡는 이유는, 그 앞 구간이
// herdr 가 일하는 시간이라 corral 의 지연이 아니기 때문이다.
//
// 재는 쪽은 **화면이 받는 상태**(AppState)다. 저장소 내부가 아니다 — 사용자가 보는 것이 목록이다.

import { REPO_DIR, corralIdsFromState, pct, request, sleep, startApp, tidySession, until, writeRaw } from './lib.mjs'

const TIMES = Number(process.env.LIFE351_TIMES ?? 20)
const EVERY_MS = 15

await tidySession(REPO_DIR)
const app = await startApp({ name: 'a1-latency', env: { CORRAL_RESYNC_MS: '3600000' } })
await sleep(800)
await app.addRepo(REPO_DIR)
await until(async () => (await app.state()).repos.length === 1, { what: '레포 등록' })

const rows = []
for (let round = 1; round <= TIMES; round++) {
  const workspaceId = (await request('workspace.list', {})).workspaces[0].workspace_id

  const createdAt0 = Date.now()
  const made = await request('tab.create', { workspace_id: workspaceId, cwd: REPO_DIR })
  const createdAt = Date.now()
  const tabId = made.tab.tab_id
  const appeared = await until(
    async () => corralIdsFromState(await app.state()).tabs.includes(tabId),
    { what: '생성 반영', timeoutMs: 15000, everyMs: EVERY_MS },
  )
  const 생성반영ms = Date.now() - createdAt

  await sleep(300)
  const closedAt = Date.now()
  await request('tab.close', { tab_id: tabId })
  const gone = await until(
    async () => !corralIdsFromState(await app.state()).tabs.includes(tabId),
    { what: '닫기 반영', timeoutMs: 15000, everyMs: EVERY_MS },
  )
  const 닫기반영ms = Date.now() - closedAt

  rows.push({
    round,
    tabId,
    'herdr 응답까지ms': createdAt - createdAt0,
    생성반영ms,
    생성반영ok: appeared.ok,
    닫기반영ms,
    닫기반영ok: gone.ok,
  })
  console.log(`#${round} 생성 ${생성반영ms}ms · 닫기 ${닫기반영ms}ms`)
}

const create = rows.map((row) => row.생성반영ms)
const close = rows.map((row) => row.닫기반영ms)
const out = {
  at: new Date().toISOString(),
  질문: '밖에서 일으킨 변화가 목록에 보이기까지 몇 ms 인가',
  측정구간: 'herdr 요청 응답 → corral AppState 에 그 탭이 나타남(또는 사라짐)',
  해상도ms: EVERY_MS,
  회차: rows.length,
  rows,
  요약: {
    생성: { p50: pct(create, 50), p95: pct(create, 95), min: Math.min(...create), max: Math.max(...create) },
    닫기: { p50: pct(close, 50), p95: pct(close, 95), min: Math.min(...close), max: Math.max(...close) },
    'herdr 응답까지 p50': pct(rows.map((row) => row['herdr 응답까지ms']), 50),
  },
  주의: `해상도 ${EVERY_MS}ms 로 폴링했다 — 그보다 짧은 차이는 이 측정이 가르지 못한다`,
}
console.log(JSON.stringify(out.요약, null, 2))
writeRaw('a1-latency.json', out)
await app.stop()
await tidySession(REPO_DIR)
