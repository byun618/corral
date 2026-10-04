// LIFE-497 K1ⓒ **격리** 실측 — ⌘V 를 받은 pane 에만 쓰는가. 한 탭을 좌우로 나눠 pane A·B 에 바이트 싱크를 하나씩 띄운다.
//   E1 A 에서 OS ⌘V(이미지) → **곧바로**(기다림 없이) B 를 누른다 → A 에만 경로가 와야 한다.
//   E2 A 에서 ⌘V(이미지, CDP paste 명령 — OS 키 뒤에 바로 닫기를 붙이려고) → 곧바로 A 를 닫는다 → B 에 아무것도 오면 안 된다.
//   E3 B 에서 OS ⌘V(이미지) → B 에만(대조).
// 사용: node iso-target.mjs --app <app> --work /tmp/l497iX --port 97NN --out <raw 폴더>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { clip, keypost, pause, run, sinkRows, solidPng } from './lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l497i')) throw new Error('--work 는 /tmp/l497i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(work, { recursive: true, mode: 0o700 })
const NODE = `${process.env.HOME}/.nvm/versions/node/v24.14.1/bin/node`
const SINK = path.join(path.dirname(new URL(import.meta.url).pathname), 'byte-sink.mjs')
const fixture = path.join(work, 'fx')
if (!fs.existsSync(fixture)) {
  fs.mkdirSync(fixture)
  execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })
}
const clipPng = path.join(work, 'clip.png')
fs.writeFileSync(clipPng, solidPng({ width: 32, height: 20, rgb: [30, 90, 200] }))
const result = { startedAt: new Date().toISOString(), cases: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-target.json'), `${JSON.stringify(result, null, 1)}\n`)
const owned = []
let exitCode = 0
try {
  const handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  const appPid = handle.status?.runtime?.pid
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
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
  const created = await evaluate((input) => window.corral.createRow(input), { workspaceId: ws.workspaceId, kind: 'shell' })
  await control({ cmd: 'click', selector: `[data-worktree="${real}"] [data-worktree-card-surface]` })
  await pause(800)
  await control({ cmd: 'click', selector: `[data-main-tab="${created.tabId}"]` })
  await pause(1500)
  const split = await evaluate((input) => window.corral.splitPane(input), { paneId: created.paneId, direction: 'right' })
  const A = created.paneId
  const B = split.paneId
  result.panes = { A, B, split }
  for (let i = 0; i < 50 && !(await evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, B)); i += 1) await pause(200)
  await pause(1500)
  const sinks = { [A]: path.join(work, 'sink-a.ndjson'), [B]: path.join(work, 'sink-b.ndjson') }
  for (const pane of [A, B]) {
    await evaluate((input) => window.corral.termInput(input), { paneId: pane, data: `${NODE} ${SINK} ${sinks[pane]} 1\r` })
  }
  for (let i = 0; i < 75 && ![A, B].every((pane) => sinkRows(sinks[pane]).rows.some((row) => row.event === 'start')); i += 1) await pause(200)
  const at = { [A]: sinkRows(sinks[A]).next, [B]: sinkRows(sinks[B]).next }
  const take = () => Object.fromEntries([A, B].map((pane) => {
    const { rows, next } = sinkRows(sinks[pane], at[pane])
    at[pane] = next
    return [pane === A ? 'A' : 'B', rows.filter((row) => row.event === 'data').map((row) => row.text)]
  }))
  const focus = async (pane) => {
    await control({ cmd: 'window-visibility', action: 'show' })
    run('activate', [appPid])
    await control({ cmd: 'click', selector: `[data-term-pane-box="${pane}"] .xterm-screen` })
    await pause(400)
  }
  clip('png', clipPng)
  // E1
  await focus(A)
  const e1Key = keypost({ pid: appPid, keycode: 9, mods: ['cmd'] })
  const e1Switch = await control({ cmd: 'click', selector: `[data-term-pane-box="${B}"] .xterm-screen` })
  await pause(1500)
  result.cases.push({ name: 'E1-paste-A-then-select-B', key: e1Key.parsed, switchAt: e1Switch.at ?? null, sinks: take() })
  save()
  // E3 (대조)
  await focus(B)
  const e3Key = keypost({ pid: appPid, keycode: 9, mods: ['cmd'] })
  await pause(1500)
  result.cases.push({ name: 'E3-paste-B', key: e3Key.parsed, sinks: take() })
  save()
  // E2
  await focus(A)
  await handle.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 4, windowsVirtualKeyCode: 86, commands: ['paste'] })
  const closed = await evaluate((pane) => window.corral.closePane({ paneId: pane }), A)
  await pause(2000)
  const logPath = path.join(handle.paths.userData, 'corral.ndjson')
  const tail = fs.readFileSync(logPath, 'utf8').split('\n').filter((line) => /paste\.clipboard_image|input_blocked/.test(line)).slice(-3)
  result.cases.push({ name: 'E2-paste-A-then-close-A', closed, sinks: take(), logTail: tail })
  save()
  for (const entry of result.cases) console.log('[target]', entry.name, JSON.stringify(entry.sinks).slice(0, 300))
} catch (error) {
  result.error = String(error?.stack ?? error)
  exitCode = 2
} finally {
  for (const entry of [...owned].reverse()) {
    if (!entry.pid) continue
    try { process.kill(entry.pid, 'SIGTERM') } catch {}
  }
  await pause(2500)
  result.survivors = owned.filter((entry) => entry.pid).filter((entry) => { try { process.kill(entry.pid, 0); return true } catch { return false } }).map((entry) => entry.pid)
  if (result.survivors.length > 0 && exitCode === 0) exitCode = 3
  clip('clear')
  result.clipboardAfter = clip('dump').out
  result.exitCode = exitCode
  save()
}
process.exit(exitCode)
