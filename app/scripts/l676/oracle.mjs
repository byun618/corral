// LIFE-676 오라클 — 제품 코드를 쓰지 않는 독립 스크립트(01-criteria 「오라클」). 637 `scripts/l637/oracle.mjs` 를 footprint 기준으로 개작.
// 루트 pid 에서 같은 시각 `LC_ALL=C ps -axo pid=,ppid=,pcpu=` 로 자손을 워크하고, 메모리는 그 pid 들의 `top -l 1 -stats pid,mem` 값을 더한다
// (제품 도우미 `corral-footprint` 와 다른 경로 — Apple 도구, 00-analysis C3). 시스템 지표 = `sysctl vm.swapusage`·`kern.memorystatus_vm_pressure_level`·`vm_stat`.
//   node scripts/l676/oracle.mjs --herdr <herdr 바이너리> --session <session> --panes <paneId,...>
//   node scripts/l676/oracle.mjs --roots <이름=pid,...>
// → JSON { at, panes|roots: { id: { root, pids, cpu, memoryBytes, missingInTop } }, system }
import { execFileSync } from 'node:child_process'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const env = { ...process.env, LC_ALL: 'C' }
const run = (file, argv) => execFileSync(file, argv, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })

const roots = {}
if (args.roots) {
  for (const pair of args.roots.split(',').filter(Boolean)) {
    const [name, pid] = pair.split('=')
    roots[name] = Number(pid)
  }
} else {
  for (const id of (args.panes ?? '').split(',').filter(Boolean)) {
    const out = run(args.herdr, ['--session', args.session, 'pane', 'process-info', '--pane', id])
    const match = out.match(/"shell_pid"\s*:\s*(\d+)/) ?? out.match(/shell[_ ]pid\D+(\d+)/i)
    roots[id] = match ? Number(match[1]) : null
  }
}

const at = new Date().toISOString()
const uptime = run('uptime', []).trim()
const rows = new Map()
const children = new Map()
for (const line of run('ps', ['-axo', 'pid=,ppid=,pcpu=,uid=,comm=']).split('\n')) {
  const cols = line.trim().split(/\s+/)
  if (cols.length < 5) continue
  const [pid, ppid, pcpu, uid] = cols.slice(0, 4).map(Number)
  rows.set(pid, { pid, ppid, pcpu, uid, comm: cols.slice(4).join(' ') })
  if (!children.has(ppid)) children.set(ppid, [])
  children.get(ppid).push(pid)
}

// top MEM 칸: 「326M」·「1024K」·「2G」·「512B」, 뒤에 +/- 가 붙을 수 있다.
const UNIT = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
const topMem = new Map()
for (const line of run('top', ['-l', '1', '-stats', 'pid,mem']).split('\n')) {
  const match = line.trim().match(/^(\d+)\s+([\d.]+)([BKMGT])[+-]?$/)
  if (match) topMem.set(Number(match[1]), Math.round(Number(match[2]) * UNIT[match[3]]))
}
const topAt = new Date().toISOString()

const result = {}
for (const [id, root] of Object.entries(roots)) {
  if (root === null || !rows.has(root)) {
    result[id] = { root, pids: null, reason: 'root 없음' }
    continue
  }
  const pids = []
  const stack = [root]
  while (stack.length > 0) {
    const pid = stack.pop()
    pids.push(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  pids.sort((a, b) => a - b)
  const missingInTop = pids.filter((pid) => !topMem.has(pid))
  result[id] = {
    root,
    parentOfRoot: rows.get(root).ppid,
    pids,
    cpu: Math.round(pids.reduce((sum, pid) => sum + rows.get(pid).pcpu, 0) * 10) / 10,
    memoryBytes: pids.reduce((sum, pid) => sum + (topMem.get(pid) ?? 0), 0),
    // euid 가 이 사용자인 pid 만의 합 — setuid-root 자식(top·sudo)은 제품 도우미가 못 읽으므로 하한 대조는 이 값과(r2 C2-6⑤).
    readablePids: pids.filter((pid) => rows.get(pid).uid === process.getuid()),
    memoryBytesReadable: pids.filter((pid) => rows.get(pid).uid === process.getuid()).reduce((sum, pid) => sum + (topMem.get(pid) ?? 0), 0),
    missingInTop,
    procs: pids.map((pid) => `${pid}:${rows.get(pid).comm}:${rows.get(pid).pcpu}:${topMem.get(pid) ?? '?'}:uid${rows.get(pid).uid}`),
  }
}

const swapRaw = run('sysctl', ['vm.swapusage']).trim()
const swap = swapRaw.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/)
const pressureRaw = run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim()
const vmStat = run('vm_stat', [])
const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1])
const occupied = Number(vmStat.match(/Pages occupied by compressor:\s+(\d+)/)?.[1])
const system = {
  swapRaw,
  swapUsedBytes: swap ? Number(swap[2]) * 1024 ** 2 : null,
  swapTotalBytes: swap ? Number(swap[1]) * 1024 ** 2 : null,
  pressureLevel: Number(pressureRaw),
  pressure: { 1: 'normal', 2: 'warning', 4: 'critical' }[pressureRaw] ?? null,
  compressedBytes: Number.isFinite(pageSize * occupied) ? pageSize * occupied : null,
}
console.log(JSON.stringify({ at, topAt, uptime, [args.roots ? 'roots' : 'panes']: result, system }, null, 2))
