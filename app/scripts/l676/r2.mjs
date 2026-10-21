// LIFE-676 R2 — 도우미 정합·비용·권한 (실 프로세스, 읽기 전용). 01-criteria R2 + 코디 보완(r1 C1-1·r2 C2-6①②·r3 C3-2).
//   node scripts/l676/r2.mjs <회차 이름>  → stdout JSON, 종료코드 0 = 모든 칸 통과
// 순서(같은 순간): `top -l 1 -stats pid,mem` 먼저 → 끝나자마자 도우미. 두 시각을 기록한다. 조인 키 = 도우미 성공 pid ∩ top.
// ⓐ euid 501(실행 사용자) pid 의 ERR(ESRCH 제외) 0 — ruid 501·euid≠501(setuid-root ps·top·sudo)의 ERR 1 은 기대값으로 따로 목록
// ⓑ 무작위 30 pid |도우미 − top| ≤ max(5%, 2 MiB), 30 중 ≥ 28 ⓒ 도우미 30회 소요 중앙값 ≤ 50 ms · p95 기록
// ⓓ root·다른 사용자 pid 가 있어도 도우미 종료코드 0(죽지 않음) · 추가: INITIAL_CAPACITY=2 시험 빌드 exit 2
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP, ensureHelper } from './ensure-helper.mjs'

const label = process.argv[2] ?? 'run'
const helper = ensureHelper()
const env = { ...process.env, LC_ALL: 'C' }
const UNIT = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
const me = process.getuid()
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6

const topStart = new Date().toISOString()
const topOut = execFileSync('top', ['-l', '1', '-stats', 'pid,mem'], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
const topEnd = new Date().toISOString()
const helperStart = new Date().toISOString()
const run = spawnSync(helper.path, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const helperEnd = new Date().toISOString()
const ids = execFileSync('ps', ['-axo', 'pid=,uid=,ruid=,comm='], { encoding: 'utf8', env })

const top = new Map()
for (const line of topOut.split('\n')) {
  const m = line.trim().match(/^(\d+)\s+([\d.]+)([BKMGT])[+-]?$/)
  if (m) top.set(Number(m[1]), Math.round(Number(m[2]) * UNIT[m[3]]))
}
const ok = new Map()
const err = new Map()
for (const line of run.stdout.split('\n')) {
  const c = line.trim().split(/\s+/)
  if (c.length === 2) ok.set(Number(c[0]), Number(c[1]))
  else if (c.length === 3 && c[1] === 'ERR') err.set(Number(c[0]), Number(c[2]))
}
const who = new Map()
for (const line of ids.split('\n')) {
  const c = line.trim().split(/\s+/)
  if (c.length >= 4) who.set(Number(c[0]), { euid: Number(c[1]), ruid: Number(c[2]), comm: c.slice(3).join(' ') })
}

// ⓐ
const errRows = [...err].map(([pid, errno]) => ({ pid, errno, ...(who.get(pid) ?? { euid: null, ruid: null, comm: '(ps 에 없음 — 그 사이 끝남)' }) }))
const violations = errRows.filter((row) => row.euid === me && row.errno !== 3)
const setuidExpected = errRows.filter((row) => row.ruid === me && row.euid !== me)
const exited = errRows.filter((row) => row.errno === 3)
const mineTotal = [...who.values()].filter((row) => row.euid === me).length
// ⓑ
const joined = [...ok.keys()].filter((pid) => top.has(pid))
const sample = [...joined].sort(() => Math.random() - 0.5).slice(0, 30)
const compared = sample.map((pid) => {
  const a = ok.get(pid)
  const b = top.get(pid)
  const tol = Math.max(0.05 * Math.max(a, b), 2 * 1024 ** 2)
  return { pid, comm: who.get(pid)?.comm ?? '?', helper: a, top: b, diff: Math.abs(a - b), tol, within: Math.abs(a - b) <= tol }
})
const within = compared.filter((row) => row.within).length
const outsideAll = joined.filter((pid) => Math.abs(ok.get(pid) - top.get(pid)) > Math.max(0.05 * Math.max(ok.get(pid), top.get(pid)), 2 * 1024 ** 2))
// ⓒ
const times = []
for (let i = 0; i < 30; i += 1) {
  const start = process.hrtime.bigint()
  const r = spawnSync(helper.path, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  times.push({ ms: ms(start), status: r.status })
}
const sorted = times.map((t) => t.ms).sort((a, b) => a - b)
const median = (sorted[14] + sorted[15]) / 2
const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]
// ⓓ
const otherUsers = errRows.filter((row) => row.euid !== null && row.euid !== me).length
const survived = run.status === 0 && times.every((t) => t.status === 0)
// 추가 — 절단 시험 빌드
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l676-r2-'))
let truncation
try {
  const out = path.join(dir, 'fp-cap2')
  const b = spawnSync('clang', ['-O2', '-Wall', '-Werror', '-arch', 'arm64', '-DINITIAL_CAPACITY=2', '-o', out, path.join(APP, 'helper', 'corral-footprint.c')], { encoding: 'utf8' })
  const r = b.status === 0 ? spawnSync(out, { encoding: 'utf8' }) : null
  truncation = { buildStatus: b.status, status: r?.status ?? null, stdoutLines: r === null ? null : r.stdout.split('\n').filter(Boolean).length, stderr: r?.stderr.trim() ?? b.stderr.trim() }
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

const verdict = {
  a: violations.length === 0,
  b: compared.length >= 30 && within >= 28,
  c: median <= 50,
  d: survived && otherUsers > 0,
  truncation: truncation.status === 2 && truncation.stdoutLines === 0,
}
console.log(JSON.stringify({
  label, helper, uid: me, uptime: execFileSync('uptime', { encoding: 'utf8' }).trim(),
  times: { topStart, topEnd, helperStart, helperEnd },
  a: { mineTotal, errTotal: err.size, violations, setuidExpected, exitedDuring: exited.length },
  b: { helperOk: ok.size, topRows: top.size, joined: joined.length, sample: compared.length, within, outside: compared.filter((r) => !r.within), outsideAllJoined: outsideAll.length },
  c: { medianMs: median, p95Ms: p95, minMs: sorted[0], maxMs: sorted.at(-1), runs: times.map((t) => Number(t.ms.toFixed(2))) },
  d: { helperStatus: run.status, otherUserErrPids: otherUsers, allRunsExit0: times.every((t) => t.status === 0) },
  truncation,
  verdict,
  pass: Object.values(verdict).every(Boolean),
}, null, 2))
process.exit(Object.values(verdict).every(Boolean) ? 0 : 1)
