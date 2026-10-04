// LIFE-497 R1-06 — K5ⓑ 휠 회귀 **격리** 실측. r1 의 D2 는 `wheel` 이 제품 경로(stream.scroll)를 탔다는 것만 봤고
// 화면이 안 바뀌어 회귀를 판정하지 못했다. 여기서는 l353 S4 처럼 **줄 번호 마커**를 찍은 스크롤백 위에서 휠을 굴리고
// xterm 버퍼(term-read)의 마커 범위로 "과거가 보였다 / 최신으로 돌아왔다" 를 판정한다. before·after 빌드에 같은 순서로.
// 사용: node iso-wheel.mjs --app <app> --work /tmp/l497iX --port 97NN --out <raw 폴더> --label before|after
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { pause, requirements } from './lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l497i')) throw new Error('--work 는 /tmp/l497i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(work, { recursive: true, mode: 0o700 })
const fixture = path.join(work, 'fx')
if (!fs.existsSync(fixture)) {
  fs.mkdirSync(fixture)
  execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })
}
const result = { label: args.label, app: path.resolve(args.app), startedAt: new Date().toISOString(), steps: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-wheel.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => console.log('[wheel] require', row.name, row.pass))
result.requirements = checks.results
const owned = []
let base = 0
const span = (lines) => {
  const nums = lines.flatMap((line) => [...line.matchAll(/wl-(\d{3})/g)].map((m) => Number(m[1])))
  return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : { min: null, max: null }
}
try {
  const handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  const logPath = path.join(handle.paths.userData, 'corral.ndjson')
  let logAt = 0
  const scrollLog = () => {
    if (!fs.existsSync(logPath)) return []
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    const fresh = lines.slice(logAt)
    logAt = lines.length
    return fresh.map((line) => { try { return JSON.parse(line) } catch { return { raw: line } } }).filter((row) => /^stream\.scroll/.test(String(row.tag ?? '')))
  }
  await seedCorralRepo(handle, fixture, { expectedWorktrees: 1 })
  const real = fs.realpathSync(fixture)
  await evaluate((root) => window.corral.openWorktree({ repoRoot: root, path: root, isLinked: false }), real)
  const workspaceOf = async () => {
    const state = (await control({ cmd: 'state' })).state
    for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === real) return row.workspace ?? null
    return null
  }
  let ws = null
  for (let i = 0; i < 150 && !(ws = await workspaceOf()); i += 1) await pause(200)
  if (!checks.require('workspace-open', ws !== null)) throw new Error('fixture workspace 가 안 열렸다')
  const created = await evaluate((input) => window.corral.createRow(input), { workspaceId: ws.workspaceId, kind: 'shell' })
  await control({ cmd: 'click', selector: `[data-worktree="${real}"] [data-worktree-card-surface]` })
  await pause(800)
  await control({ cmd: 'click', selector: `[data-main-tab="${created.tabId}"]` })
  for (let i = 0; i < 50 && !(await evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, created.paneId)); i += 1) await pause(200)
  await pause(1500)
  await evaluate((input) => window.corral.termInput(input), { paneId: created.paneId, data: "seq 1 400 | awk '{printf \"wl-%03d\\n\", $1}'\r" })
  await pause(2500)
  const read = async () => (await control({ cmd: 'term-read' })).term
  const step = async (name, deltaY) => {
    const wheel = deltaY === null ? null : await control({ cmd: 'wheel', deltaY })
    await pause(deltaY === null ? 0 : 1200)
    const term = await read()
    const entry = { name, deltaY, wheel, span: span(term.lines), rows: term.rows, tail: term.lines.filter((line) => line.trim()).slice(-2), log: scrollLog() }
    result.steps.push(entry)
    save()
    console.log('[wheel]', name, JSON.stringify(entry.span), entry.log.map((row) => `${row.tag}:${row.direction ?? ''}${row.lines ?? ''}`).join(','))
    return entry
  }
  const bottom = await step('bottom', null)
  checks.require('bottom-shows-tail', bottom.span.max === 400, { span: bottom.span })
  // 작은 휠(r1 D2 와 같은 -400)과 큰 휠(l353 S4 의 -1200) 둘 다.
  const up1 = await step('up-400', -400)
  checks.require('up-400-shows-past', up1.span.min !== null && bottom.span.min !== null && up1.span.min < bottom.span.min, { bottom: bottom.span, up: up1.span })
  const up2 = await step('up-1200-more', -1200)
  checks.require('up-1200-shows-further-past', up2.span.min !== null && up2.span.min < up1.span.min, { up1: up1.span, up2: up2.span })
  const down = await step('down-4000', 4000)
  checks.require('down-returns-latest', down.span.max === bottom.span.max, { bottom: bottom.span, down: down.span })
  base = 0
} catch (error) {
  result.error = String(error?.stack ?? error)
  base = 2
} finally {
  for (const entry of [...owned].reverse()) {
    if (!entry.pid) continue
    try { process.kill(entry.pid, 'SIGTERM') } catch {}
  }
  await pause(2500)
  result.survivors = owned.filter((entry) => entry.pid).filter((entry) => { try { process.kill(entry.pid, 0); return true } catch { return false } }).map((entry) => entry.pid)
  if (result.survivors.length > 0 && base === 0) base = 3
  result.exitCode = checks.exitCode(base)
  save()
}
process.exit(result.exitCode)
