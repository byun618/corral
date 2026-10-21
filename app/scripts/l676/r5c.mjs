// LIFE-676 R5ⓒ — 시스템 줄 지표: 같은 시각 오라클(`sysctl vm.swapusage`·`kern.memorystatus_vm_pressure_level`·`vm_stat` 를 이 스크립트가 직접 파싱)
// ↔ 제품 `readHostWith`(resource-ipc.ts 그대로, 실제 execFile). 통과선: swap 사용 차 ≤ 0.2 GB · 압박 일치 · 압축 차 ≤ 10%.
//   node scripts/l676/r5c.mjs <회차>  → JSON, 종료코드 0 = 통과
import { execFile, execFileSync } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import { loadProduct } from './ensure-helper.mjs'

const label = process.argv[2] ?? 'run'
const { readHostWith } = await loadProduct('src/main/resource-ipc.ts')
const env = { ...process.env, LC_ALL: 'C' }
const oracle = () => {
  const swapRaw = execFileSync('sysctl', ['vm.swapusage'], { encoding: 'utf8', env }).trim()
  const pressureRaw = execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', env }).trim()
  const vmStat = execFileSync('vm_stat', { encoding: 'utf8', env })
  const swap = swapRaw.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/)
  const page = Number(vmStat.match(/page size of (\d+) bytes/)?.[1])
  const occupied = Number(vmStat.match(/Pages occupied by compressor:\s+(\d+)/)?.[1])
  return { at: new Date().toISOString(), swapRaw, pressureRaw, occupiedLine: vmStat.split('\n').find((l) => l.includes('occupied by compressor')), swapUsed: Number(swap[2]) * 1024 ** 2, swapTotal: Number(swap[1]) * 1024 ** 2, pressure: { 1: 'normal', 2: 'warning', 4: 'critical' }[pressureRaw] ?? null, compressed: page * occupied }
}
const before = oracle()
const productAt = new Date().toISOString()
const host = await readHostWith({ exec: promisify(execFile), env: process.env, physicalMemory: os.totalmem(), cpuCoreCount: os.cpus().length })
const after = oracle()
const GB = 1024 ** 3
const check = (o) => ({
  swapDiffGb: host.swap === null ? null : Math.abs(host.swap.used - o.swapUsed) / GB,
  pressureEqual: host.pressure === o.pressure,
  compressedDiffPct: host.compressed === null || o.compressed === 0 ? null : (100 * Math.abs(host.compressed - o.compressed)) / o.compressed,
})
const near = [check(before), check(after)]
const pass = near.some((c) => c.swapDiffGb !== null && c.swapDiffGb <= 0.2 && c.pressureEqual && c.compressedDiffPct !== null && c.compressedDiffPct <= 10)
console.log(JSON.stringify({ label, productAt, host, oracleBefore: before, oracleAfter: after, checks: near, pass, note: '오라클을 제품 호출 앞뒤로 두 번 — 둘 중 하나가 통과선 안이면 통과(같은 시각의 근사)' }, null, 2))
process.exit(pass ? 0 : 1)
