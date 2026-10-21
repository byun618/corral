// LIFE-676 R6 한 회차 — 637 l637/r2.mjs 개작(pane 4개, footprint 기준). app/ 에서: node scripts/l676/r6.mjs <root> <회차 n> <out.json>
// pane A(셸만) w1:p1 · B(420 MiB 메모리 부하 node) w1:p2 · C(yes > /dev/null) w1:p3 · D(setuid-root 자식 top -l 0 -s 2) w1:p4.
// 부하 시작 9초 뒤 다음 푸시(+ 같은 렌더 프레임의 상태바 DOM)를 받고 곧바로 오라클(ps 트리 + top MEM, 제품 코드 미사용)과 맞춘다.
// 그 뒤 B 를 Ctrl-C 로 끄고 다음 주기에 그 pid 가 빠지는가. 끝에 C·D 도 Ctrl-C.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const [root, n, out] = process.argv.slice(2)
const APP = process.cwd()
const handles = JSON.parse(fs.readFileSync(`${root}/final/handles.json`, 'utf8'))
const herdr = fs.readFileSync(`${root}/herdr.bin`, 'utf8').trim()
const session = `l676f-${root.split('l676f-')[1]}`
const env = { ...process.env, CORRAL_RUNTIME_SOCKET: `${root}/ud/runtime/rpc.sock` }
const cli = (...args) => execFileSync('node', [`${APP}/cli/corral.mjs`, ...args], { encoding: 'utf8', env })
const cdp = (kind, expr) => JSON.parse(execFileSync('node', [`${APP}/scripts/l676/cdp.mjs`, root, kind, expr], { encoding: 'utf8' }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const NEXT = `new Promise((resolve) => { const stop = window.corral.onResourceSnapshot((s) => { stop(); requestAnimationFrame(() => requestAnimationFrame(() => resolve({ s, segment: document.querySelector('[data-statusbar-resource]')?.textContent ?? null }))) }) })`
const oracle = () => JSON.parse(execFileSync('node', [`${APP}/scripts/l676/oracle.mjs`, '--herdr', herdr, '--session', session, '--panes', 'w1:p1,w1:p2,w1:p3,w1:p4'], { encoding: 'utf8' }))
const ids = { A: 'w1:p1', B: 'w1:p2', C: 'w1:p3', D: 'w1:p4' }
const MiB = 1024 ** 2
const cores = cdp('main', `globalThis.__l676.require('os').cpus().length`)
const result = { round: Number(n), mainCpuCount: cores, steps: {} }

cli('terminal', 'send', '--terminal', handles.B, '--text', `node ${APP}/scripts/l676/memload.cjs L676M`, '--enter')
cli('terminal', 'send', '--terminal', handles.C, '--text', 'yes > /dev/null', '--enter')
cli('terminal', 'send', '--terminal', handles.D, '--text', 'top -l 0 -s 2 > /dev/null', '--enter')
result.loadStartedAt = new Date().toISOString()
await sleep(9000)
const { s: snap, segment } = cdp('eval', NEXT)
const orc = oracle()
result.snapshotAt = new Date(snap.collectedAt).toISOString()
result.oracle = orc
result.segment = segment
result.snapshot = { stats: snap.stats, host: snap.host, total: snap.total, herdr: snap.herdr, app: snap.app.state, panes: Object.fromEntries(snap.panes.map((p) => [p.paneId, p.measure])) }
const memOf = (m) => (m?.state === 'measured' ? m.usage.memory : null)
const cmp = {}
for (const [k, id] of Object.entries(ids)) {
  const m = snap.panes.find((p) => p.paneId === id)?.measure
  const o = orc.panes[id]
  const mp = m?.state === 'measured' ? [...m.pids].sort((a, b) => a - b) : null
  cmp[k] = { pane: id, product: mp, oracle: o?.pids ?? null, equal: JSON.stringify(mp) === JSON.stringify(o?.pids ?? null), productCpu: m?.state === 'measured' ? m.usage.cpu : null, oracleCpu: o?.cpu ?? null, productMemory: memOf(m), oracleMemory: o?.memoryBytes ?? null, oracleMemoryReadable: o?.memoryBytesReadable ?? null, oracleReadablePids: o?.readablePids ?? null, unavailable: m?.state === 'unavailable' ? m.reason : null }
}
result.compare = cmp
const within = (a, b) => a !== null && b !== null && b > 0 && Math.abs(a - b) / b <= 0.1
const bMem = cmp.B.productMemory
const dMem = cmp.D.productMemory
const topPid = (orc.panes[ids.D].procs ?? []).map((p) => p.split(':')).find((p) => p[1].endsWith('top') && p[4] === 'uid0')?.[0] ?? null
const expectedSegmentCpu = `${Math.min(100, Math.max(0, Math.round(snap.total.cpu / cores)))}%`
result.topPid = topPid
result.expectedSegmentCpu = expectedSegmentCpu
result.checks = {
  pidSets4of4: Object.values(cmp).every((c) => c.equal),
  memB_measured_ge350MiB: bMem?.state === 'measured' && bMem.bytes >= 350 * MiB,
  memB_within10pct: bMem?.state === 'measured' && within(bMem.bytes, cmp.B.oracleMemory),
  yesCpuGe50: (cmp.C.productCpu ?? 0) >= 50,
  shellCpuLt5: cmp.A.productCpu !== null && cmp.A.productCpu < 5,
  segmentCpu_eq_total_div_cores: segment !== null && segment.startsWith(`CPU ${expectedSegmentCpu} ·`) && snap.host.cpuCoreCount === cores,
  memD_partial: dMem?.state === 'partial',
  memD_eq_oracleReadable_within10pct: dMem?.state === 'partial' && within(dMem.bytes, cmp.D.oracleMemoryReadable),
  memD_reason_has_topPid: dMem?.state === 'partial' && topPid !== null && dMem.reason.includes(`pid ${topPid}`),
}
// B 끄기 → 다음 주기
const memPid = (orc.panes[ids.B].procs ?? []).map((p) => p.split(':')).find((p) => p[1] === 'node' || p[1].includes('node'))?.[0]
result.memPid = memPid ? Number(memPid) : null
cli('terminal', 'send', '--terminal', handles.B, '--interrupt')
result.interruptedBAt = new Date().toISOString()
const after1 = cdp('eval', NEXT).s
const after2 = cdp('eval', NEXT).s
const pidsOf = (s) => { const m = s.panes.find((p) => p.paneId === ids.B)?.measure; return m?.state === 'measured' ? m.pids : null }
result.afterStop = { first: { at: new Date(after1.collectedAt).toISOString(), pids: pidsOf(after1), memory: memOf(after1.panes.find((p) => p.paneId === ids.B)?.measure) }, second: { at: new Date(after2.collectedAt).toISOString(), pids: pidsOf(after2) } }
result.checks.memB_gone_next_cycle = result.memPid !== null && pidsOf(after2) !== null && !pidsOf(after2).includes(result.memPid)
result.checks.memB_gone_first_push = result.memPid !== null && pidsOf(after1) !== null && !pidsOf(after1).includes(result.memPid)
cli('terminal', 'send', '--terminal', handles.C, '--interrupt')
cli('terminal', 'send', '--terminal', handles.D, '--interrupt')
await sleep(1500)
const left = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => /L676M|^\s*\d+\s+\d+\s+yes$|top -l 0 -s 2/.test(l))
result.leftAfterInterrupt = left
// 판정: 「다음 주기에 빠진다」 = 끈 뒤 첫 푸시가 Ctrl-C 처리 전 수집일 수 있어 둘째 푸시로 본다(첫 푸시 결과도 기록).
const gate = { ...result.checks }
delete gate.memB_gone_first_push
result.pass = Object.values(gate).every(Boolean)
fs.writeFileSync(out, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ round: n, pass: result.pass, checks: result.checks, cpu: { A: cmp.A.productCpu, C: cmp.C.productCpu, total: snap.total.cpu, cores, segment }, memB: bMem, oracleB: cmp.B.oracleMemory, memD: dMem, oracleDReadable: cmp.D.oracleMemoryReadable, uptime: orc.uptime }))
