// LIFE-519 관측기 — endpoint 를 촘촘히 lstat 해 모드 변화만 기록한다(동기 루프, 별도 프로세스).
// 사용: node observe.mjs <endpoint> <out.json> <stopFile|ms>  — stopFile 이 생기거나 ms 가 지나면 끝.
// 결과: samples(총 lstat 수)·intervalUs(평균 간격)·transitions([tMs, mode|'ENOENT'|'nonsocket:<mode>'])·modes(관측된 모드 집합)·loose(group/other 비트가 있는 소켓을 본 샘플 수)·firstSeen
import fs from 'node:fs'
const [endpoint, out, stop] = process.argv.slice(2)
const deadline = /^\d+$/.test(stop) ? Date.now() + Number(stop) : Infinity
const t0 = process.hrtime.bigint(), modes = {}, transitions = []
let samples = 0, loose = 0, last, firstSeen = null
const tick = () => Number(process.hrtime.bigint() - t0) / 1e6
fs.writeFileSync(out + '.ready', String(process.pid))
for (;;) {
  for (let i = 0; i < 200; i++) {
    let state
    try { const st = fs.lstatSync(endpoint); const m = st.mode & 0o777; state = st.isSocket() ? m.toString(8) : `nonsocket:${m.toString(8)}`; if (st.isSocket() && (m & 0o077)) loose++ }
    catch (error) { state = error.code ?? 'error' }
    samples++
    modes[state] = (modes[state] ?? 0) + 1
    if (state !== last) { transitions.push([Number(tick().toFixed(3)), state]); if (firstSeen === null && state !== 'ENOENT') firstSeen = state; last = state }
  }
  if (Date.now() >= deadline || (!Number.isFinite(deadline) && fs.existsSync(stop))) break
}
const elapsed = tick()
fs.writeFileSync(out, JSON.stringify({ endpoint, samples, elapsedMs: Number(elapsed.toFixed(1)), intervalUs: Number((elapsed * 1000 / samples).toFixed(2)), loose, firstSeen, modes, transitions: transitions.slice(0, 200), transitionCount: transitions.length }, null, 1) + '\n')
fs.rmSync(out + '.ready', { force: true })
