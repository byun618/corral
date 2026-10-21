/* global fetch, WebSocket */
// LIFE-676 R10 네이티브 회차 오라클 대조 — 코디가 사용자 입회로 돌린다. 설치본을 `--remote-debugging-port=<port>` 로 띄운 뒤, app/ 에서:
//   node scripts/l676/r10.mjs --port <port> --out <out.json> [--herdr /Applications/corral.app/Contents/Resources/backend/herdr] [--session default] [--console-ms 10000]
// 하는 일(전부 읽기 — 사용자 pane 에 키·명령을 넣지 않는다):
//   ① 렌더러에 붙어 다음 푸시 1개를 받고 같은 프레임의 세그먼트 라벨·title 을 읽는다(R10ⓐ)
//   ② 곧바로 oracle.mjs(ps 트리 + top MEM, 제품 코드 미사용)를 그 스냅샷의 pane 전부에 돌린다 — pane 별 pid 집합(전부)·메모리 상위 5개 차이 ≤ 10%(R10ⓒ)
//      하한(partial) 행은 오라클의 「읽을 수 있는 pid 합」(euid = 이 사용자)과 맞추고, 사유 문구를 그대로 적는다
//   ③ 시스템 줄 swap·압박·압축 = 같은 시각 오라클(R5ⓒ 통과선: swap 차 ≤ 0.2 GB · 압박 일치 · 압축 차 ≤ 10%)(R10ⓓ)
//   ④ --console-ms 동안 렌더러 콘솔 error·예외 수(R10ⓕ — 0 이어야)
// 종료코드 0 = ⓐⓒⓓⓕ 자동 칸 통과. ⓑ(worktree 별 행)·ⓔ(활동 상태 보기)·ⓖ(체감)는 사용자 관측 칸이라 여기서 판정하지 않는다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const port = args.port
const out = args.out
const herdr = args.herdr ?? '/Applications/corral.app/Contents/Resources/backend/herdr'
const session = args.session ?? 'default'
const consoleMs = Number(args['console-ms'] ?? 10000)
if (!port || !out) {
  console.error('사용법: --port <port> --out <out.json>')
  process.exit(2)
}
const here = path.dirname(new URL(import.meta.url).pathname)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
if (!page) throw new Error('renderer page 없음')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
const consoleErrors = []
ws.onmessage = (message) => {
  const data = JSON.parse(message.data)
  if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') consoleErrors.push({ kind: 'console.error', text: data.params.args.map((a) => a.value ?? a.description ?? '').join(' ') })
  if (data.method === 'Runtime.exceptionThrown') consoleErrors.push({ kind: 'exception', text: data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text })
  if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') consoleErrors.push({ kind: `log.${data.params.entry.source}`, text: data.params.entry.text })
  if (data.id === undefined) return
  const p = pending.get(data.id); pending.delete(data.id)
  if (data.error) p.reject(new Error(JSON.stringify(data.error))); else p.resolve(data.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

// ① 다음 푸시 + 같은 프레임 세그먼트
const { s: snap, segment, segmentTitle } = await evaluate(`new Promise((resolve) => { const stop = window.corral.onResourceSnapshot((s) => { stop(); requestAnimationFrame(() => requestAnimationFrame(() => { const el = document.querySelector('[data-statusbar-resource]'); resolve({ s, segment: el?.textContent ?? null, segmentTitle: el?.getAttribute('title') ?? null }) })) }) })`)
// ② 같은 시각 오라클
const paneIds = snap.panes.map((p) => p.paneId)
const orc = JSON.parse(execFileSync('node', [path.join(here, 'oracle.mjs'), '--herdr', herdr, '--session', session, '--panes', paneIds.join(',')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const MiB = 1024 ** 2
const GB = 1024 ** 3
const rows = snap.panes.map((p) => {
  const m = p.measure
  const o = orc.panes[p.paneId]
  const productPids = m.state === 'measured' ? [...m.pids].sort((a, b) => a - b) : null
  const memory = m.state === 'measured' ? m.usage.memory : null
  const oracleMemory = memory?.state === 'partial' ? o?.memoryBytesReadable ?? null : o?.memoryBytes ?? null
  const bytes = memory?.state === 'measured' || memory?.state === 'partial' ? memory.bytes : null
  const diffPct = bytes === null || oracleMemory === null || oracleMemory === 0 ? null : (100 * Math.abs(bytes - oracleMemory)) / oracleMemory
  return { paneId: p.paneId, title: p.title, group: p.groupLabel, agent: p.agent ?? 'shell', state: m.state, reason: m.state === 'unavailable' ? m.reason : memory?.state === 'partial' || memory?.state === 'unavailable' ? memory.reason : null, memoryState: memory?.state ?? null, productMiB: bytes === null ? null : Math.round(bytes / MiB), oracleMiB: oracleMemory === null ? null : Math.round(oracleMemory / MiB), diffPct, pidsEqual: JSON.stringify(productPids) === JSON.stringify(o?.pids ?? null), productPidCount: productPids?.length ?? null, oraclePidCount: o?.pids?.length ?? null, productCpu: m.state === 'measured' ? m.usage.cpu : null, oracleCpu: o?.cpu ?? null }
})
const top5 = [...rows].filter((r) => r.productMiB !== null).sort((a, b) => b.productMiB - a.productMiB).slice(0, 5)
// ③ 시스템 줄
const sys = orc.system
const host = snap.host
const hostCheck = {
  product: { swapUsedGb: host.swap === null ? null : host.swap.used / GB, swapTotalGb: host.swap === null ? null : host.swap.total / GB, pressure: host.pressure, compressedGb: host.compressed === null ? null : host.compressed / GB, cpuCoreCount: host.cpuCoreCount },
  oracle: { swapUsedGb: sys.swapUsedBytes / GB, swapTotalGb: sys.swapTotalBytes / GB, pressure: sys.pressure, pressureLevel: sys.pressureLevel, compressedGb: sys.compressedBytes / GB, swapRaw: sys.swapRaw },
}
hostCheck.swapDiffGb = host.swap === null ? null : Math.abs(host.swap.used - sys.swapUsedBytes) / GB
hostCheck.pressureEqual = host.pressure === sys.pressure
hostCheck.compressedDiffPct = host.compressed === null || !sys.compressedBytes ? null : (100 * Math.abs(host.compressed - sys.compressedBytes)) / sys.compressedBytes
// ④ 콘솔
await send('Runtime.enable')
await send('Log.enable')
consoleErrors.length = 0 // enable 이 되감아 보내는 과거 기록은 판정에서 뺀다 — 이 창 동안 새로 난 것만
await sleep(consoleMs)
ws.close()

const cores = host.cpuCoreCount
const expectCpu = snap.total === null || !(cores > 0) ? null : `CPU ${Math.min(100, Math.max(0, Math.round(snap.total.cpu / cores)))}%`
const checks = {
  a_segmentCpuInRange: expectCpu !== null && segment?.startsWith(`${expectCpu} ·`) === true,
  a_tooltipScale: segmentTitle?.includes(`코어 ${cores}개 = 100%`) === true,
  c_pidSetsAllEqual: rows.every((r) => r.state !== 'measured' || r.pidsEqual),
  c_top5MemoryWithin10pct: top5.length > 0 && top5.every((r) => r.diffPct !== null && r.diffPct <= 10),
  d_host: hostCheck.swapDiffGb !== null && hostCheck.swapDiffGb <= 0.2 && hostCheck.pressureEqual && hostCheck.compressedDiffPct !== null && hostCheck.compressedDiffPct <= 10,
  f_consoleErrors0: consoleErrors.length === 0,
}
const result = { at: new Date().toISOString(), snapshotAt: new Date(snap.collectedAt).toISOString(), oracleAt: orc.at, uptime: orc.uptime, segment, segmentTitleFirstLines: segmentTitle?.split('\n').slice(0, 3) ?? null, expectCpu, total: snap.total, rows, top5, lowerBoundRows: rows.filter((r) => r.memoryState === 'partial').map((r) => ({ paneId: r.paneId, title: r.title, reason: r.reason })), unavailableRows: rows.filter((r) => r.state === 'unavailable' || r.memoryState === 'unavailable').map((r) => ({ paneId: r.paneId, reason: r.reason })), hostCheck, consoleMs, consoleErrors, checks, pass: Object.values(checks).every(Boolean) }
fs.writeFileSync(out, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ pass: result.pass, checks, segment, top5: top5.map((r) => `${r.paneId} ${r.productMiB}/${r.oracleMiB} MiB ${r.diffPct?.toFixed(1)}%`), lowerBound: result.lowerBoundRows.length, host: hostCheck.product, consoleErrors: consoleErrors.length }))
process.exit(result.pass ? 0 : 1)
