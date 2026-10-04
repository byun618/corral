// LIFE-496 U2 — Quick-launch 워치독(K1ⓔ)의 대상·시간을 정하는 **격리** 실측.
//
//   missing — 에이전트 실행 파일이 PATH 에 없는 herdr 서버에서 createRow(kind) 가 어떻게 끝나는지 + 이후 pane.agent 가 오는지.
//             provider 는 하나도 뜨지 않는다(실행 파일이 없다).
//   normal  — claude 를 **입력 없이** 띄우고 pane.agent 가 store 에 도착하는 시간을 잰 뒤 탭을 닫는다(N 회).
//
// 격리 = launchCorral(/tmp/l496u* 아래 userData·herdr 세션 `l443-gui-diff`·제어 소켓). 사용자 userData·herdr 기본 세션은 건드리지 않는다.
// createRow 는 렌더러 `window.corral.createRow` 를 eval 로 부른다 — 제품의 IPC 경로 그대로다. 도착 판정은 제어 소켓 `state`(렌더러 store 와 같은 AppState).
// 사용: node u2-probe.mjs --app <app> --work /tmp/l496uX --port 96NN --out <raw 폴더> --mode missing|normal [--n 5]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l496u')) throw new Error('--work 는 /tmp/l496u*')
const mode = args.mode
if (mode !== 'missing' && mode !== 'normal') throw new Error('--mode missing|normal')
const n = Number(args.n ?? (mode === 'normal' ? 5 : 1))
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(work, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (mode === 'missing') {
  // 에이전트 실행 파일이 든 폴더를 PATH 에서 뺀다 — 이 프로세스(→ herdr 서버 → pane 셸)에만 적용된다. 사용자 셸 설정은 그대로다.
  const agentDirs = new Set(['claude', 'codex', 'grok'].flatMap((bin) => {
    try { return [path.dirname(execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim())] } catch { return [] }
  }))
  process.env.PATH = process.env.PATH.split(':').filter((dir) => !agentDirs.has(dir)).join(':')
  for (const bin of ['claude', 'codex', 'grok']) {
    let found = null
    try { found = execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() } catch {}
    if (found) throw new Error(`PATH 에서 ${bin} 을 못 뺐다: ${found}`)
  }
}

const fixture = path.join(work, 'fx')
if (!fs.existsSync(fixture)) {
  fs.mkdirSync(fixture)
  execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })
}
const owned = []
const result = { mode, startedAt: new Date().toISOString(), pathForServer: mode === 'missing' ? process.env.PATH : '(사용자 PATH 그대로)', runs: [] }
const save = () => fs.writeFileSync(path.join(out, `u2-${mode}.json`), `${JSON.stringify(result, null, 1)}\n`)
let exitCode = 0
try {
  const handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const run = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  await seedCorralRepo(handle, fixture, { expectedWorktrees: 1 })
  const real = fs.realpathSync(fixture)
  const opened = await run((root) => window.corral.openWorktree({ repoRoot: root, path: root, isLinked: false }), real)
  result.openWorktree = opened
  const workspaceOf = async () => {
    const state = (await control({ cmd: 'state' })).state
    for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === real) return row.workspace ?? null
    return null
  }
  const start = Date.now()
  let ws = null
  while (!(ws = await workspaceOf()) && Date.now() - start < 30_000) await pause(200)
  if (!ws) throw new Error('fixture workspace 가 안 열렸다')
  const kinds = mode === 'missing' ? ['claude', 'codex', 'grok'] : Array.from({ length: n }, () => 'claude')
  const watchMs = mode === 'missing' ? 20_000 : 30_000
  for (const kind of kinds) {
    const t0 = Date.now()
    const created = await run((input) => window.corral.createRow(input), { workspaceId: ws.workspaceId, kind })
    const createMs = Date.now() - t0
    const samples = []
    let agentAt = null
    let firstSeenAt = null
    while (Date.now() - t0 < watchMs) {
      const current = await workspaceOf()
      const pane = current?.tabs.flatMap((tab) => tab.panes).find((entry) => entry.paneId === created.paneId) ?? null
      const at = Date.now() - t0
      if (pane !== null && firstSeenAt === null) firstSeenAt = at
      const sample = { at, present: pane !== null, agent: pane?.agent ?? null, agentStatus: pane?.agentStatus ?? null, title: pane?.title ?? null }
      const last = samples.at(-1)
      if (!last || last.present !== sample.present || last.agent !== sample.agent || last.agentStatus !== sample.agentStatus || last.title !== sample.title) samples.push(sample)
      if (pane?.agent && agentAt === null) {
        agentAt = at
        if (mode === 'normal') break
      }
      await pause(100)
    }
    const screen = await control({ cmd: 'term-read' }).catch((error) => ({ error: String(error) }))
    const entry = { kind, created, createMs, firstSeenInStateMs: firstSeenAt, agentArrivedMs: agentAt, samples, screenTail: screen?.term?.lines?.slice?.(-8) ?? screen?.term ?? screen }
    result.runs.push(entry)
    save()
    console.log('[u2]', JSON.stringify({ kind, ok: created?.ok, error: created?.error, createMs, agentAt }))
    if (created?.tabId) {
      const closed = await run((tabId) => window.corral.closeRow({ tabId, confirmed: true }), created.tabId)
      entry.closed = closed
      await pause(1500)
    }
    save()
  }
} catch (error) {
  result.error = String(error?.stack ?? error)
  exitCode = 2
} finally {
  for (const entry of [...owned].reverse()) {
    if (!entry.pid) continue
    try { process.kill(entry.pid, 'SIGTERM') } catch {}
  }
  await pause(2000)
  result.owned = owned
  result.survivors = owned.filter((entry) => entry.pid).filter((entry) => { try { process.kill(entry.pid, 0); return true } catch { return false } }).map((entry) => entry.pid)
  if (result.survivors.length > 0 && exitCode === 0) exitCode = 3
  result.exitCode = exitCode
  save()
}
process.exit(exitCode)
