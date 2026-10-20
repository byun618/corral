// LIFE-637 R2 한 회차 — node scripts/l637/r2.mjs <root> <회차 n> <out.json>
// pane A(셸만) w1:p1 · B(sleep 600) w1:p2 · C(yes > /dev/null) w1:p3. 부하 시작 후 9초 뒤 다음 푸시를 받고 곧바로 오라클(독립 ps 워크)과 맞춘다.
// 그 뒤 B 의 sleep 을 kill 하고, 다음 푸시 두 번(다음 주기 = 첫 푸시, 확인용 둘째)에서 그 pid 가 빠졌는가. 끝에 yes 도 끈다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const [root, n, out] = process.argv.slice(2)
const APP = process.cwd()
const handles = JSON.parse(fs.readFileSync(`${root}/final/handles.json`, 'utf8'))
const herdr = fs.readFileSync(`${root}/herdr.bin`, 'utf8').trim()
const session = `l637f-${root.split('l637f-')[1]}`
const herdrPid = Number(fs.readFileSync(`${root}/herdr.pid`, 'utf8').trim())
const env = { ...process.env, CORRAL_RUNTIME_SOCKET: `${root}/ud/runtime/rpc.sock` }
const cli = (...args) => execFileSync('node', [`${APP}/cli/corral.mjs`, ...args], { encoding: 'utf8', env })
const cdp = (kind, expr) => JSON.parse(execFileSync('node', [`${APP}/scripts/l637/cdp.mjs`, root, kind, expr], { encoding: 'utf8' }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const NEXT = `new Promise((resolve) => { const stop = window.corral.onResourceSnapshot((s) => { stop(); resolve(s) }) })`
const oracle = () => JSON.parse(execFileSync('node', [`${APP}/scripts/l637/oracle.mjs`, herdr, session, 'w1:p1,w1:p2,w1:p3'], { encoding: 'utf8' }))
const ids = { A: 'w1:p1', B: 'w1:p2', C: 'w1:p3' }
const result = { round: Number(n), herdrPid, steps: {} }

cli('terminal', 'send', '--terminal', handles.B, '--text', 'sleep 600', '--enter')
cli('terminal', 'send', '--terminal', handles.C, '--text', 'yes > /dev/null', '--enter')
result.loadStartedAt = new Date().toISOString()
await sleep(9000)
const snap = cdp('eval', NEXT)
const orc = oracle()
result.snapshotAt = new Date(snap.collectedAt).toISOString()
result.oracle = orc
result.snapshot = { stats: snap.stats, herdr: snap.herdr, app: snap.app.state, total: snap.total, panes: Object.fromEntries(snap.panes.map((p) => [p.paneId, p.measure])) }
const cmp = {}
for (const [k, id] of Object.entries(ids)) {
  const m = snap.panes.find((p) => p.paneId === id)?.measure
  const o = orc.panes[id]
  const mp = m?.state === 'measured' ? [...m.pids].sort((a, b) => a - b) : null
  cmp[k] = { pane: id, product: mp, oracle: o?.pids ?? null, equal: JSON.stringify(mp) === JSON.stringify(o?.pids ?? null), productCpu: m?.state === 'measured' ? m.usage.cpu : null, oracleCpu: o?.cpu ?? null, unavailable: m?.state === 'unavailable' ? m.reason : null }
}
result.compare = cmp
result.herdrRow = { pids: snap.herdr.state === 'measured' ? snap.herdr.pids : null, includesServer: snap.herdr.state === 'measured' && snap.herdr.pids.includes(herdrPid) }
result.checks = {
  pidSets3of3: Object.values(cmp).every((c) => c.equal),
  yesCpuGe50: (cmp.C.productCpu ?? 0) >= 50,
  shellCpuLt5: cmp.A.productCpu !== null && cmp.A.productCpu < 5,
  herdrServerPid: result.herdrRow.includesServer,
}
// sleep kill → 다음 주기
const sleepProc = (orc.panes[ids.B].procs ?? []).find((p) => p.split(':')[1] === 'sleep')
const sleepPid = sleepProc ? Number(sleepProc.split(':')[0]) : null
result.sleepPid = sleepPid
if (sleepPid !== null) {
  process.kill(sleepPid, 'SIGTERM')
  result.killedAt = new Date().toISOString()
  const after1 = cdp('eval', NEXT)
  const after2 = cdp('eval', NEXT)
  const pidsOf = (s) => { const m = s.panes.find((p) => p.paneId === ids.B)?.measure; return m?.state === 'measured' ? m.pids : null }
  result.afterKill = { first: { at: new Date(after1.collectedAt).toISOString(), pids: pidsOf(after1) }, second: { at: new Date(after2.collectedAt).toISOString(), pids: pidsOf(after2) } }
  result.checks.sleepGoneNextCycle = pidsOf(after1) !== null && !pidsOf(after1).includes(sleepPid)
} else result.checks.sleepGoneNextCycle = false
// yes 끄기 (Ctrl-C)
cli('terminal', 'send', '--terminal', handles.C, '--interrupt')
await sleep(500)
const yesLeft = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').filter((l) => (orc.panes[ids.C].procs ?? []).some((p) => p.split(':')[1] === 'yes' && l.trim().startsWith(p.split(':')[0] + ' ')))
result.yesLeftAfterInterrupt = yesLeft
result.pass = Object.values(result.checks).every(Boolean)
fs.writeFileSync(out, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ round: n, pass: result.pass, checks: result.checks, cpu: { A: cmp.A.productCpu, B: cmp.B.productCpu, C: cmp.C.productCpu, oracleC: cmp.C.oracleCpu }, uptime: orc.uptime }))
