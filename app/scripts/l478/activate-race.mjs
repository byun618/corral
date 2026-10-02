// LIFE-478 대조 실험 — 다른 워크트리가 활성인 채 아직 안 연 링크 워크트리 제목을 누르면 그 워크트리가 활성이 되나.
//
// 격리 run6 에서 고정 카드(K5ⓔ)와 d-active(K7ⓖ) 둘 다 「열렸지만 활성 아님」 이었다. 고정과 무관한 기존 경합인지
// (useLifecycleActions 의 활성 동기화 effect) 가르려고, 같은 시나리오를 **기준 커밋 빌드**와 **구현 브랜치 빌드**에서 똑같이 돈다.
// 사용: node <이 파일> --app <앱 루트(빌드된 out/ 이 있는)> --out <raw 폴더> [--work /tmp/l478a] [--port 9480] [--trials 6]
// 결과: <out>/result.json — 회차별 {clicked, opened, selectedWithin5s}. 종료코드 0 = 하네스 완주(판정은 결과 값으로 한다).

/* global document */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { connect, pickTarget, until, setViewport, assertPortFree, pause } from '../gui-diff/lib/cdp.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]?.startsWith('--') ? true : (all[index + 1] ?? true)]] : pairs), []),
)
const appRoot = path.resolve(String(args.app))
const work = path.resolve(String(args.work ?? '/tmp/l478a'))
if (!work.startsWith('/tmp/l478')) throw new Error(`--work 는 /tmp/l478* 아래: ${work}`)
const out = path.resolve(String(args.out))
const port = Number(args.port ?? 9480)
const trials = Number(args.trials ?? 6)
fs.mkdirSync(out, { recursive: true })
const log = (...parts) => console.log('[race]', ...parts)

const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const userData = path.join(work, 'corral-userdata')
const herdrHome = path.join(work, 'corral-herdr')
const control = path.join(work, 'corral-control.sock')
const env = { ...process.env }
for (const key of ['CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'ELECTRON_RUN_AS_NODE']) delete env[key]
Object.assign(env, {
  CORRAL_USER_DATA: userData,
  CORRAL_UI_PREFS: path.join(work, 'ui-prefs.json'),
  HERDR_CONFIG_PATH: path.join(herdrHome, 'config.toml'),
  XDG_CONFIG_HOME: herdrHome,
  CORRAL_CONTROL_SOCKET: control,
  CORRAL_REGISTRY: path.join(userData, 'repos.json'),
  SHELL: '/bin/sh',
})
const spawned = []
let backend = null
let desktopPid = null
let cdp = null
const rows = []

async function main() {
  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true, mode: 0o700 })
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  const root = path.join(work, 'repos', 'race')
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, '-c', 'user.email=l478@example.invalid', '-c', 'user.name=l478', 'commit', '-q', '--allow-empty', '-m', 'init')
  const names = Array.from({ length: trials + 1 }, (_, index) => `r-${index}`)
  for (const name of names) git(root, 'worktree', 'add', '-q', '-b', name, path.join(work, 'repos', 'race-wt', name))
  const real = fs.realpathSync(path.join(work, 'repos'))
  const wt = (name) => path.join(real, 'race-wt', name)

  fs.mkdirSync(herdrHome, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(herdrHome, 'config.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
  const logFd = fs.openSync(path.join(out, 'backend.log'), 'a')
  backend = spawn('herdr', ['--session', 'l478-race', 'server'], { env, stdio: ['ignore', logFd, logFd] })
  fs.closeSync(logFd)
  spawned.push({ pid: backend.pid, label: 'herdr backend' })
  const socket = path.join(herdrHome, 'herdr/sessions', 'l478-race', 'herdr.sock')
  await until(() => fs.existsSync(socket), 'backend socket', 30_000)
  env.CORRAL_BACKEND_SOCKET = socket
  env.CORRAL_SESSION = 'l478-race'

  await assertPortFree(port, 'corral race')
  const wrapper = path.join(work, 'corral-electron')
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${path.join(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')}' --remote-debugging-port=${port} "$@"\n`, { mode: 0o755 })
  env.CORRAL_ELECTRON = wrapper
  const opened = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), 'open', '--json'], { env, encoding: 'utf8', timeout: 120_000 })
  if (opened.status !== 0) throw new Error(`open → ${opened.status}\n${opened.stdout}\n${opened.stderr}`)
  desktopPid = JSON.parse(opened.stdout).result?.runtime?.pid ?? null
  spawned.push({ pid: desktopPid, label: 'corral desktop' })
  await until(() => fs.existsSync(control), 'control socket', 60_000)
  await until(async () => (await rpc(control, { cmd: 'state' })).state?.link?.phase === 'live', 'link live', 60_000)
  const { target } = await pickTarget(port, { label: 'corral', match: (entry) => /out\/renderer\/index\.html/.test(entry.url) })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await setViewport(cdp, { width: 1200, height: 1100 })
  await rpc(control, { cmd: 'add-repo', root: fs.realpathSync(root) })
  await until(async () => {
    await rpc(control, { cmd: 'rebuild-tree' }, 30_000)
    return (await cdp.evaluate(() => document.querySelectorAll('[data-worktree]').length)) === names.length + 1 ? true : null
  }, 'rendered', 60_000, 500)

  const selected = () => cdp.evaluate(() => document.querySelector('[data-worktree-card-active="primary"]')?.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null)
  const clickTitle = async (p) => {
    const point = await cdp.evaluate((s) => {
      const el = document.querySelector(`[data-worktree="${s}"] [data-worktree-branch]`)
      el?.scrollIntoView({ block: 'center' })
      const r = el?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    }, p)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
  }
  for (let index = 0; index < names.length; index++) {
    const target2 = wt(names[index])
    const before = await selected()
    await clickTitle(target2)
    const t = Date.now()
    let ok = false
    while (Date.now() - t < 5000) {
      if ((await selected()) === target2) {
        ok = true
        break
      }
      await pause(100)
    }
    const st = (await rpc(control, { cmd: 'state' })).state
    const opened2 = st.repos.flatMap((r) => r.worktrees).find((w) => w.path === target2)?.openWorkspaceId ?? null
    rows.push({ trial: index, before, target: target2, opened: opened2 !== null, selectedWithin5s: ok, selectedNow: await selected() })
    log(JSON.stringify(rows.at(-1)))
    await pause(800)
  }
}

let exitCode = 0
try {
  await main()
} catch (error) {
  exitCode = 2
  rows.push({ error: String(error?.stack ?? error) })
} finally {
  await cdp?.close().catch(() => {})
  for (const row of [...spawned].reverse()) {
    try {
      process.kill(row.pid, 'SIGTERM')
    } catch {
      // 이미 끝났다.
    }
  }
  await pause(1500)
  const alive = spawned.filter((row) => {
    try {
      process.kill(row.pid, 0)
      return true
    } catch {
      return false
    }
  })
  const trialsRun = rows.filter((row) => row.trial !== undefined)
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ appRoot, trials: trialsRun.length, selectedOk: trialsRun.filter((r) => r.selectedWithin5s).length, rows, alive }, null, 2))
  log(`selected ${trialsRun.filter((r) => r.selectedWithin5s).length}/${trialsRun.length}; alive ${JSON.stringify(alive)}`)
  process.exit(exitCode)
}
