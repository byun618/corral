// LIFE-637 R2 오라클 — 제품 코드를 쓰지 않는 독립 스크립트(01-criteria 「오라클」).
// pane 루트 = herdr CLI `pane process-info --pane <id>` 의 shell_pid, 표 = 같은 시각 `LC_ALL=C ps -axo pid=,ppid=,pcpu=,rss=`, 셸에서 직접 자손 워크.
//   node scripts/l637/oracle.mjs <herdr 바이너리> <session> <paneId,...>  → JSON { at, uptime, panes: { id: { shellPid, pids, cpu, rssKb } }, herdrServer }
import { execFileSync } from 'node:child_process'

const [herdr, session, ids] = process.argv.slice(2)
const shell = {}
for (const id of ids.split(',').filter(Boolean)) {
  const out = execFileSync(herdr, ['--session', session, 'pane', 'process-info', '--pane', id], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  const m = out.match(/"shell_pid"\s*:\s*(\d+)/) ?? out.match(/shell[_ ]pid\D+(\d+)/i)
  shell[id] = m ? Number(m[1]) : null
  if (!m) shell[`${id}#raw`] = out.slice(0, 400)
}
const at = new Date().toISOString()
const table = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
const uptime = execFileSync('uptime', { encoding: 'utf8' }).trim()
const rows = new Map()
const children = new Map()
for (const line of table.split('\n')) {
  const cols = line.trim().split(/\s+/)
  if (cols.length < 5) continue
  const [pid, ppid, pcpu, rss] = cols.slice(0, 4).map(Number)
  rows.set(pid, { pid, ppid, pcpu, rss, comm: cols.slice(4).join(' ') })
  if (!children.has(ppid)) children.set(ppid, [])
  children.get(ppid).push(pid)
}
const panes = {}
for (const [id, root] of Object.entries(shell)) {
  if (id.includes('#')) continue
  if (root === null || !rows.has(root)) { panes[id] = { shellPid: root, pids: null, reason: 'root 없음' }; continue }
  const pids = []
  const stack = [root]
  while (stack.length > 0) { const p = stack.pop(); pids.push(p); stack.push(...(children.get(p) ?? [])) }
  pids.sort((a, b) => a - b)
  panes[id] = { shellPid: root, parentOfShell: rows.get(root).ppid, pids, cpu: Math.round(pids.reduce((s, p) => s + rows.get(p).pcpu, 0) * 10) / 10, rssKb: pids.reduce((s, p) => s + rows.get(p).rss, 0), procs: pids.map((p) => `${p}:${rows.get(p).comm}:${rows.get(p).pcpu}`) }
}
console.log(JSON.stringify({ at, uptime, panes, shellRaw: Object.fromEntries(Object.entries(shell).filter(([k]) => k.includes('#'))) }))
