/* global fetch, WebSocket */
// LIFE-637 R6ⓑ F13 — main 인스펙터 CPU 프로파일(샘플링 100µs)로 `currentState` 가 쓴 시간을 따로 잰다.
//   node scripts/l637/prof.mjs <root> <초> <out.json>
// 프로파일 구간의 총 currentState 시간(그 함수 아래 서브트리 샘플 합, 재귀 중복 제외)과 구간 동안의 수집 횟수(스냅샷 collections 델타)를 낸다.
// 주의: currentState 는 수집 밖(상태 emit 등)에서도 불린다 — 수집 1회당 값은 상한이다. 수집 경로의 다른 함수(paneSources·attribute·parsePsTable)도 같이 낸다.
import fs from 'node:fs'
const [root, secs, out] = process.argv.slice(2)
const port = fs.readFileSync(`${root}/inspect.port`, 'utf8').trim()
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0; const pending = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id !== undefined) { const p = pending.get(d.id); pending.delete(d.id); if (d.error) p.j(new Error(JSON.stringify(d.error))); else p.r(d.result) } }
const send = (method, params = {}) => new Promise((r, j) => { const id = ++seq; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })) })
// 수집 횟수는 main 쪽에서 읽을 길이 없어 렌더러 스냅샷으로 — 여기서는 구간 시각만 남기고 호출자가 맞춘다.
await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 100 })
const t0 = Date.now(); await send('Profiler.start')
await new Promise((r) => setTimeout(r, Number(secs) * 1000))
const { profile } = await send('Profiler.stop'); const t1 = Date.now()
const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const dt = new Map(); // node id → µs
for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i + 1] ?? 0))
const totals = {}
const names = ['currentState', 'paneSources', 'attribute', 'parsePsTable', 'tick', 'readPsWith', 'closeRouteOf']
for (const [id, us] of dt) {
  const seen = new Set()
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) { const f = nodes.get(cur).callFrame.functionName; if (names.includes(f) && !seen.has(f)) { seen.add(f); totals[f] = (totals[f] ?? 0) + us } }
}
const totalUs = [...dt.values()].reduce((a, b) => a + b, 0)
const res = { from: new Date(t0).toISOString(), to: new Date(t1).toISOString(), sampledMs: Math.round(totalUs / 1000), msByFunction: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v / 100) / 10])), url: profile.nodes.find((n) => n.callFrame.functionName === 'currentState')?.callFrame.url ?? null }
fs.writeFileSync(out, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res)); ws.close()
