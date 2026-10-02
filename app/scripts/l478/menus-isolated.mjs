// LIFE-478 격리 실행 — 카드 우클릭 메뉴·rename·업데이트·Pin·Parent·삭제·하단 바·Reveal (K1~K9, K7ⓙ 삭제 매트릭스).
//
// 격리: 전용 work 폴더(--work, 기본 /tmp/l478i) 아래 userData·ui-prefs·레지스트리·herdr 세션·제어 소켓·fixture 레포.
// 사용자 기본 userData·레지스트리·herdr 기본 세션·설치본 Orca 는 건드리지 않는다. 입력은 **CDP Input**(이 인스턴스 디버깅 포트의
// 페이지에만 간다 — OS 커서·OS 키 입력이 아니다). 실제 OS 입력은 K11 네이티브에서.
//
// G8: 실제 삭제(`git worktree remove`)는 이 실행이 `<work>/repos` 아래 만든 워크트리에서만 돈다 — 삭제 전 대상이 그 아래인지
// 검사하고(아니면 하네스 중단) 회차마다 `deletes.json` 에 대상 경로·관문 소유 판정을 남긴다.
//
// OS 쪽 부작용: 「경로 복사」 는 시스템 클립보드에 쓴다 — 시작 전 텍스트를 /tmp/l478-private 에 백업하고 끝에 되돌린 뒤 해시를 대조한다.
// 「Finder 에서 열기」 는 Finder 창을 연다 — 열린 창의 대상 경로를 AppleScript 로 읽고(대상이 fixture 일 때만) 그 창만 닫는다.
// 「VS Code」 실행은 여기서 하지 않는다(사용자 VS Code 에 창이 생긴다 — 네이티브 관문에서 관문용 임시 레포로 1회).
//
// 사용: node app/scripts/l478/menus-isolated.mjs --out <raw 폴더> [--work /tmp/l478i] [--port 9478] [--restarts 3]
// 결과: <out>/result.json · <out>/shots/*.png · <out>/deletes.json · <out>/prefs-*.json. 종료코드 0 = 전 검사 통과.
// 기동·종료·CDP 도우미는 l477 `display-isolated.mjs` 와 같다(검증된 경로를 그대로 옮겼다).

/* global document, window, getComputedStyle, CSS, KeyboardEvent, Event, HTMLInputElement, HTMLElement -- CDP evaluate 로 페이지 안에서 도는 클로저가 쓴다 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, pickTarget, until, setViewport, assertPortFree, pause } from '../gui-diff/lib/cdp.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { buildIdentity } from './build-identity.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '../..')
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]?.startsWith('--') ? true : (all[index + 1] ?? true)]] : pairs), []),
)
const work = path.resolve(String(args.work ?? '/tmp/l478i'))
if (!work.startsWith('/tmp/l478')) throw new Error(`--work 는 /tmp/l478* 아래여야 한다(G8): ${work}`)
const out = path.resolve(String(args.out ?? 'l478-iso-out'))
/** 이 회차가 잰 소스·번들 (리뷰 r1 C-01ⓑ) — 시작 시점에 한 번. 검사 수는 그대로 두고 result.json 에만 싣는다. */
const build = buildIdentity(appRoot)
const port = Number(args.port ?? 9478)
const restarts = Number(args.restarts ?? 3)
const shots = path.join(out, 'shots')
fs.mkdirSync(shots, { recursive: true })
const privateDir = '/tmp/l478-private'
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 })

const checks = []
const deletes = []
const t0 = Date.now()
const log = (...parts) => console.log(`[l478 +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)
function check(id, criterion, pass, observed) {
  checks.push({ id, criterion, pass: pass === true, observed })
  log(pass ? 'PASS' : 'FAIL', id, criterion, JSON.stringify(observed).slice(0, 400))
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')

// --- fixture ------------------------------------------------------------------------------------------------
const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gitOk = (cwd, ...rest) => spawnSync('git', rest, { cwd, encoding: 'utf8' }).status === 0
const reposDir = path.join(work, 'repos')
const commitAll = (root, message) => {
  git(root, 'add', '-A')
  git(root, '-c', 'user.email=l478@example.invalid', '-c', 'user.name=l478', 'commit', '-q', '--allow-empty', '-m', message)
}
function makeRepo(name, linked) {
  const root = path.join(reposDir, name)
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'fixture\n')
  commitAll(root, 'init')
  for (const name2 of linked) addWorktree(root, name2)
  return fs.realpathSync(root)
}
function addWorktree(root, name) {
  const target = path.join(reposDir, `${path.basename(root)}-wt`, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  git(root, 'worktree', 'add', '-q', '-b', name, target)
  return fs.realpathSync(target)
}
const realRepos = () => fs.realpathSync(reposDir)
/** G8 — 지울 대상이 이 실행이 만든 fixture 인가. */
const gateOwned = (target) => target.startsWith(realRepos() + path.sep)

// --- 앱 기동·종료 (l477 와 같다) -------------------------------------------------------------------------------
const userData = path.join(work, 'corral-userdata')
const herdrHome = path.join(work, 'corral-herdr')
const prefsFile = path.join(work, 'ui-prefs.json')
const registryFile = path.join(userData, 'repos.json')
const control = path.join(work, 'corral-control.sock')
const session = 'l478-iso'
const env = { ...process.env }
for (const key of ['CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'ELECTRON_RUN_AS_NODE']) delete env[key]
Object.assign(env, {
  CORRAL_USER_DATA: userData,
  CORRAL_UI_PREFS: prefsFile,
  HERDR_CONFIG_PATH: path.join(herdrHome, 'config.toml'),
  XDG_CONFIG_HOME: herdrHome,
  CORRAL_CONTROL_SOCKET: control,
  CORRAL_REGISTRY: registryFile,
  SHELL: '/bin/sh',
})
const spawned = []
let backend = null
let desktopPid = null
let cdp = null

async function startBackend() {
  fs.mkdirSync(herdrHome, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(herdrHome, 'config.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
  const logFd = fs.openSync(path.join(out, 'backend.log'), 'a')
  backend = spawn('herdr', ['--session', session, 'server'], { env, stdio: ['ignore', logFd, logFd] })
  fs.closeSync(logFd)
  spawned.push({ pid: backend.pid, label: 'herdr backend' })
  const socket = path.join(herdrHome, 'herdr/sessions', session, 'herdr.sock')
  await until(() => fs.existsSync(socket), 'backend socket', 30_000)
  env.CORRAL_BACKEND_SOCKET = socket
  env.CORRAL_SESSION = session
}
async function stopBackend() {
  const pid = backend?.pid
  if (!pid) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // 이미 끝났다.
  }
  await until(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, 'backend exit', 15_000)
  backend = null
}

const viewport = { width: 1200, height: Number(args.height ?? 900) }
async function launch(label) {
  await assertPortFree(port, 'corral l478')
  const wrapper = path.join(work, 'corral-electron')
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${path.join(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')}' --remote-debugging-port=${port} "$@"\n`, { mode: 0o755 })
  env.CORRAL_ELECTRON = wrapper
  const opened = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), 'open', '--json'], { env, encoding: 'utf8', timeout: 120_000 })
  if (opened.status !== 0) throw new Error(`open(${label}) → ${opened.status}\n${opened.stdout}\n${opened.stderr}`)
  desktopPid = JSON.parse(opened.stdout).result?.runtime?.pid ?? null
  spawned.push({ pid: desktopPid, label: `corral desktop (${label})` })
  await until(() => fs.existsSync(control), 'control socket', 60_000)
  await until(async () => (await rpc(control, { cmd: 'state' })).state?.link?.phase === 'live', 'link live', 60_000)
  const { target } = await pickTarget(port, { label: 'corral', match: (entry) => /out\/renderer\/index\.html/.test(entry.url) })
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await setViewport(cdp, viewport)
  await until(() => cdp.evaluate(() => document.querySelector('[data-repo-list]') !== null), 'sidebar rendered', 30_000)
  log('launched', label, 'pid', desktopPid)
}

async function quit(label) {
  await cdp?.close().catch(() => {})
  cdp = null
  if (desktopPid !== null) {
    try {
      process.kill(desktopPid, 'SIGTERM')
    } catch {
      // 이미 끝났다.
    }
    await until(() => {
      try {
        process.kill(desktopPid, 0)
        return false
      } catch {
        return true
      }
    }, `desktop exit (${label})`, 30_000)
  }
  await until(() => !fs.existsSync(control), 'control socket gone', 15_000).catch(() => fs.rmSync(control, { force: true }))
  desktopPid = null
  await pause(500)
}

const readPrefs = () => (fs.existsSync(prefsFile) ? JSON.parse(fs.readFileSync(prefsFile, 'utf8')) : null)
const readRegistry = () => (fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : null)
const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}
const pointOf = (selector, fx = 0.5, fy = 0.5) =>
  cdp.evaluate(
    (s) => {
      const el = document.querySelector(s.selector)
      if (!el) return null
      let r = el.getBoundingClientRect()
      // 화면 밖·목록 밖(붙은 헤더 밑 포함)이면 보이게 — 사람이 스크롤해서 누르는 것과 같다.
      const list = el.closest('[data-repo-list]')
      const lr = list?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
      if (r.bottom > Math.min(window.innerHeight, lr.bottom) || r.top < Math.max(0, lr.top + (list === null ? 0 : 40))) {
        el.scrollIntoView({ block: 'center' })
        r = el.getBoundingClientRect()
      }
      return { x: r.left + r.width * s.fx, y: r.top + r.height * s.fy }
    },
    { selector, fx, fy },
  )
const cardSel = (wt) => `[data-worktree="${wt}"] [data-worktree-card-surface]`
const titleSel = (wt) => `[data-worktree="${wt}"] [data-worktree-title]`

async function mouse(type, p, extra = {}) {
  const button = extra.button ?? (type === 'mouseMoved' ? 'none' : 'left')
  const pressedButtons = button === 'right' ? 2 : 1
  const params = { type, x: p.x, y: p.y, button, buttons: extra.buttons ?? (type === 'mouseReleased' || type === 'mouseMoved' ? 0 : pressedButtons), clickCount: type === 'mouseMoved' ? 0 : (extra.clickCount ?? 1), modifiers: extra.modifiers ?? 0 }
  return cdp.send('Input.dispatchMouseEvent', params)
}
async function click(p, extra = {}) {
  if (p === null) throw new Error('click: 좌표 없음')
  await mouse('mouseMoved', p, { modifiers: extra.modifiers })
  await mouse('mousePressed', p, extra)
  await mouse('mouseReleased', p, extra)
  await pause(200)
}
const clickSel = async (selector) => {
  const p = await pointOf(selector)
  if (p === null) throw new Error(`click: ${selector} 없음`)
  await click(p)
}
async function rightClick(p) {
  if (p === null) throw new Error('rightClick: 좌표 없음')
  await mouse('mouseMoved', p)
  await mouse('mousePressed', p, { button: 'right' })
  await mouse('mouseReleased', p, { button: 'right' })
  await pause(200)
}
async function dblclick(p) {
  await mouse('mouseMoved', p)
  await mouse('mousePressed', p, { clickCount: 1 })
  await mouse('mouseReleased', p, { clickCount: 1 })
  await mouse('mousePressed', p, { clickCount: 2 })
  await mouse('mouseReleased', p, { clickCount: 2 })
  await pause(250)
}
async function hover(selector) {
  const p = await pointOf(selector)
  if (p === null) throw new Error(`hover: ${selector} 없음`)
  await mouse('mouseMoved', p)
  await pause(150)
}
const KEYS = {
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Alt: { code: 'AltLeft', vk: 18 },
  Home: { code: 'Home', vk: 36 },
  r: { code: 'KeyR', vk: 82 },
  a: { code: 'KeyA', vk: 65 },
}
/** CDP 키 입력 — 이 인스턴스 페이지에만 간다. modifiers: 1 Alt · 2 Ctrl · 4 Meta(⌘) · 8 Shift. */
async function key(name, modifiers = 0) {
  const spec = KEYS[name]
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers })
  if (spec.text && (modifiers & ~8) === 0) await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: name, text: spec.text, modifiers })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers })
  await pause(150)
}
const typeText = async (text) => {
  await cdp.send('Input.insertText', { text })
  await pause(100)
}
const settle = () => pause(400)
async function rebuild() {
  await rpc(control, { cmd: 'rebuild-tree' }, 30_000)
  await pause(800)
}
async function waitFor(fn, label, timeout = 30_000) {
  return until(async () => ((await fn()) ? true : null), label, timeout, 200)
}
const tryWait = (fn, label, timeout) => waitFor(fn, label, timeout).then(() => true).catch(() => false)

// --- CLI (같은 격리 런타임) ---------------------------------------------------------------------------------
function cli(cwd, ...rest) {
  const res = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), ...rest, '--json'], { env, cwd, encoding: 'utf8', timeout: 60_000 })
  try {
    return { status: res.status, ...JSON.parse(res.stdout) }
  } catch {
    return { status: res.status, ok: false, raw: res.stdout + res.stderr }
  }
}
const showMeta = (cwd, wt) => {
  const res = cli(cwd, 'worktree', 'show', '--worktree', `path:${wt}`)
  const row = res.result?.worktree
  return res.ok ? { displayName: row?.displayName ?? null, comment: row?.comment ?? null, parent: row?.parentWorktreeId ?? null } : { error: res.error ?? res.raw }
}

// --- 관측 ---------------------------------------------------------------------------------------------------
const appState = async () => (await rpc(control, { cmd: 'state' })).state
const rowOf = async (wt) => (await appState()).repos.flatMap((repo) => repo.worktrees).find((row) => row.path === wt) ?? null
const snapshot = () =>
  cdp.evaluate(() => {
    const list = document.querySelector('[data-repo-list]')
    const pinned = list.querySelector(':scope > [data-pinned-section]')
    const all = list.querySelector(':scope > [data-reorder-all]')
    const card = (row) => ({
      title: row.querySelector('[data-worktree-title]')?.textContent ?? null,
      metaBranch: row.querySelector('[data-worktree-meta-branch]')?.textContent ?? null,
      note: row.querySelector('[data-worktree-note-badge]') !== null,
      parent: row.querySelector('[data-worktree-parent]')?.textContent ?? null,
      parentPath: row.querySelector('[data-worktree-parent]')?.getAttribute('data-worktree-parent') ?? null,
      pinned: row.hasAttribute('data-worktree-pinned'),
      reorder: row.hasAttribute('data-reorder-card'),
      deleting: row.querySelector('[data-worktree-deleting]') !== null,
      deletingPill: row.querySelector('[data-worktree-deleting-pill]')?.textContent ?? null,
      trash: row.querySelector('[data-worktree-trash]') !== null,
      renaming: row.querySelector('[data-inline-rename]') !== null,
      flash: row.querySelector('.card-reveal-flash') !== null,
      repoLabel: (row.querySelector('[data-worktree-repo-chip]') ?? row.querySelector('[data-worktree-repo-label]'))?.textContent ?? null,
      selected: row.querySelector('[data-worktree-card-active="primary"]') !== null,
    })
    const cards = Object.fromEntries([...list.querySelectorAll('[data-worktree]')].map((row) => [row.getAttribute('data-worktree'), card(row)]))
    const menus = {
      card: document.querySelectorAll('[data-card-menu]').length,
      context: document.querySelectorAll('[data-context-menu]:not([data-context-submenu])').length,
      options: document.querySelectorAll('[data-sidebar-options-menu]').length,
      repo: document.querySelectorAll('[data-repo-menu]').length,
      worktree: document.querySelectorAll('[data-worktree-menu]').length,
      tab: document.querySelectorAll('[data-tab-menu]').length,
      help: document.querySelectorAll('[data-help-menu]').length,
    }
    const menuEl = document.querySelector('[data-card-menu]')
    const menuRect = menuEl?.getBoundingClientRect() ?? null
    return {
      groups: [...list.querySelectorAll(':scope > [data-repo]')].map((group) => ({
        root: group.getAttribute('data-repo'),
        worktrees: [...group.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
      })),
      pinned:
        pinned === null
          ? null
          : {
              head: pinned.querySelector('[data-pinned-head]')?.textContent ?? null,
              expanded: pinned.querySelector('[data-pinned-head]')?.getAttribute('aria-expanded') ?? null,
              worktrees: [...pinned.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
            },
      all: all === null ? null : [...all.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
      cards,
      menus,
      // `context` 는 카드·? 메뉴와 겹쳐 세지는 공용 표지라 합계에서 뺀다.
      menuOpenTotal: Object.entries(menus).filter(([k]) => k !== 'context').reduce((a, [, b]) => a + b, 0),
      cardMenu:
        menuEl === null
          ? null
          : {
              for: menuEl.getAttribute('data-card-menu'),
              rect: { left: menuRect.left, top: menuRect.top, right: menuRect.right, bottom: menuRect.bottom },
              items: [...menuEl.querySelectorAll(':scope > [data-menu-action]')].map((el) => ({
                action: el.getAttribute('data-menu-action'),
                label: el.querySelector('.ctx-menu-text')?.textContent ?? null,
                disabled: el.getAttribute('aria-disabled') === 'true',
                title: el.getAttribute('title'),
                shortcut: el.querySelector('.ctx-menu-shortcut')?.textContent ?? null,
              })),
              active: document.querySelector('[data-context-submenu] [data-menu-active]')?.getAttribute('data-menu-action') ?? menuEl.querySelector('[data-menu-active]')?.getAttribute('data-menu-action') ?? null,
              submenu: document.querySelector('[data-context-submenu]')?.getAttribute('data-context-submenu') ?? null,
            },
      hoverCard: document.querySelector('[data-hover-card]')?.textContent ?? null,
      hoverCardFor: document.querySelector('[data-hover-card]')?.getAttribute('data-hover-card') ?? null,
      notice: document.querySelector('[data-add-notice] .inline-notice-text')?.textContent ?? null,
      metaDialog: document.querySelector('[data-worktree-meta-dialog]')?.getAttribute('data-worktree-meta-dialog') ?? null,
      metaError: document.querySelector('[data-meta-error]')?.textContent ?? null,
      deleteDialog: (() => {
        const el = document.querySelector('[data-delete-worktree-dialog]')
        if (el === null) return null
        return {
          path: el.getAttribute('data-delete-worktree-dialog'),
          decision: el.getAttribute('data-delete-decision'),
          dirty: el.querySelector('[data-delete-dirty]')?.getAttribute('data-delete-dirty') ?? null,
          sessions: el.querySelector('[data-delete-sessions]')?.getAttribute('data-delete-sessions') ?? null,
          children: el.querySelector('[data-delete-children]')?.getAttribute('data-delete-children') ?? null,
          blocked: el.querySelector('[data-delete-blocked]')?.textContent ?? null,
          previewError: el.querySelector('[data-delete-preview-error]')?.textContent ?? null,
          warning: [...el.querySelectorAll('[data-delete-force-warning] li')].map((li) => li.textContent),
          confirm: el.querySelector('[data-delete-confirm]')?.getAttribute('data-delete-confirm') ?? null,
          confirmLabel: el.querySelector('[data-delete-confirm]')?.textContent ?? null,
          text: el.textContent,
        }
      })(),
      picker: (() => {
        const el = document.querySelector('[data-parent-picker]')
        if (el === null) return null
        return {
          for: el.getAttribute('data-parent-picker'),
          candidates: [...el.querySelectorAll('[data-parent-candidate]')].map((c) => c.getAttribute('data-parent-candidate')),
          active: el.querySelector('[data-parent-candidate].is-active, [data-parent-candidate][aria-selected="true"]')?.getAttribute('data-parent-candidate') ?? null,
          empty: el.querySelector('[data-parent-picker-empty]') !== null,
        }
      })(),
      revealConfirm: document.querySelector('[data-reveal-confirm]')?.getAttribute('data-reveal-confirm') ?? null,
      shortcuts: document.querySelector('[data-shortcut-settings]') !== null,
      reordering: document.querySelector('.sidebar.is-reordering') !== null,
      scrollTop: list.scrollTop,
      focusTag: document.activeElement?.tagName ?? null,
    }
  })
const activePath = async () => {
  const snap = await snapshot()
  return Object.entries(snap.cards).find(([, c]) => c.selected)?.[0] ?? null
}

async function openCardMenu(wt) {
  const p = await pointOf(cardSel(wt), 0.4, 0.3)
  await rightClick(p)
  const ok = await tryWait(async () => (await snapshot()).cardMenu?.for === wt, `card menu ${wt}`, 5000)
  if (!ok) {
    const at = await cdp.evaluate((q) => {
      const el = document.elementFromPoint(q.x, q.y)
      return { tag: el?.tagName, cls: el?.className?.toString?.(), wt: el?.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null, menu: el?.closest('[data-context-menu]') !== null }
    }, p)
    throw new Error(`card menu ${wt} 안 열림 — 좌표 ${JSON.stringify(p)} 요소 ${JSON.stringify(at)} 메뉴 ${JSON.stringify((await snapshot()).cardMenu?.for ?? null)}`)
  }
}
async function menuClick(action) {
  await clickSel(`[data-card-menu] [data-menu-action="${action}"], [data-context-submenu] [data-menu-action="${action}"]`)
  await settle()
}
async function closeAllMenus() {
  for (let i = 0; i < 3 && (await snapshot()).menuOpenTotal > 0; i++) await key('Escape')
}

// --- 삭제 도우미 (K7) -------------------------------------------------------------------------------------
async function openDelete(wt) {
  await openCardMenu(wt)
  await menuClick('delete')
  await waitFor(async () => {
    const d = (await snapshot()).deleteDialog
    return d !== null && d.path === wt && d.decision !== 'loading'
  }, `delete dialog ${wt}`, 15_000)
  return (await snapshot()).deleteDialog
}
function diskState(repoRoot, wt, branch) {
  const list = git(repoRoot, 'worktree', 'list', '--porcelain')
  const registryText = fs.readFileSync(registryFile, 'utf8')
  return {
    exists: fs.existsSync(wt),
    inGitList: list.split('\n').some((line) => line === `worktree ${wt}`),
    branch: branch === null ? null : gitOk(repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`),
    registryMentions: registryText.includes(JSON.stringify(wt).slice(1, -1)),
  }
}
async function confirmDeleteAndWait(wt) {
  if (!gateOwned(wt)) throw new Error(`G8 위반 — 관문 소유가 아닌 대상: ${wt}`)
  const t = Date.now()
  await clickSel('[data-delete-confirm]')
  let sawDeleting = false
  const done = await tryWait(async () => {
    const snap = await snapshot()
    if (snap.cards[wt]?.deleting) sawDeleting = true
    return snap.cards[wt] === undefined || (snap.notice !== null && !snap.cards[wt]?.deleting)
  }, `delete finished ${wt}`, 60_000)
  await settle()
  return { done, sawDeleting, ms: Date.now() - t, notice: (await snapshot()).notice }
}
const dismissNotice = async () => {
  if ((await snapshot()).notice !== null) await clickSel('[data-add-notice] .inline-notice-dismiss')
}

// --- Finder / 클립보드 (OS 쪽 부작용 관리) ---------------------------------------------------------------------
const osa = (script) => spawnSync('osascript', ['-e', script], { encoding: 'utf8' })
function finderSelection() {
  const res = osa('tell application "Finder" to set s to selection\nset out to ""\nrepeat with i in s\nset out to out & POSIX path of (i as alias) & linefeed\nend repeat\nreturn out')
  return res.status === 0 ? res.stdout.trim().split('\n').filter(Boolean) : null
}
function closeFinderWindowsUnder(prefix) {
  // 대상이 fixture(prefix) 인 Finder 창만 닫는다 — 사용자 창은 건드리지 않는다.
  const script = `tell application "Finder"
  set n to 0
  repeat with w in (every Finder window)
    try
      if (POSIX path of ((target of w) as alias)) starts with "${prefix}" then
        close w
        set n to n + 1
      end if
    end try
  end repeat
  return n
end tell`
  const res = osa(script)
  return res.status === 0 ? Number(res.stdout.trim()) : `error: ${res.stderr.trim()}`
}
const clipboardBackup = path.join(privateDir, 'iso-clipboard-before.txt')
function backupClipboard() {
  const text = execFileSync('pbpaste', { encoding: 'utf8' })
  fs.writeFileSync(clipboardBackup, text, { mode: 0o600 })
  return sha(text)
}
function restoreClipboard() {
  const text = fs.readFileSync(clipboardBackup, 'utf8')
  execFileSync('pbcopy', { input: text })
  return sha(execFileSync('pbpaste', { encoding: 'utf8' }))
}

// --- 본 실행 ------------------------------------------------------------------------------------------------
async function main() {
  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  fs.mkdirSync(work, { recursive: true, mode: 0o700 })
  fs.chmodSync(work, 0o700)
  fs.mkdirSync(reposDir, { recursive: true })
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })

  const alpha = makeRepo('alpha', ['a-one', 'a-two', 'a-three'])
  const beta = makeRepo('beta', ['b-one'])
  const solo = makeRepo('solo', [])
  const del = makeRepo('del', ['d-clean', 'd-dirty', 'd-untracked', 'd-busy', 'd-locked', 'd-race', 'd-parent', 'd-child', 'd-active', 'd-recent', 'd-nolink', 'd-pin'])
  const R = realRepos()
  const wtA = (name) => path.join(R, 'alpha-wt', name)
  const wtB = (name) => path.join(R, 'beta-wt', name)
  const wtD = (name) => path.join(R, 'del-wt', name)
  // dirty = 추적 파일 수정 + 큰 untracked 폴더(지우는 데 시간이 걸려 「삭제 중…」 을 관측할 수 있게).
  fs.writeFileSync(path.join(wtD('d-dirty'), 'tracked.txt'), 'changed\n')
  const big = path.join(wtD('d-dirty'), 'bulk')
  fs.mkdirSync(big)
  for (let i = 0; i < 20000; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), 'x')
  fs.writeFileSync(path.join(wtD('d-untracked'), 'new.txt'), 'x\n')
  git(del, 'worktree', 'lock', wtD('d-locked'))
  const repos = [alpha, beta, solo, del]

  // 470·477 출고 모양 ui-prefs(핀 칸 없음) — K5ⓖ 「핀 없음으로 선다」.
  const legacy = { version: 1, sidebarWidth: 300, sidebarCollapsed: false, collapsedRepos: [], collapsedGroups: [], expandedAgentGroups: [], tabOrdinals: [], groupLayouts: [], sidebarGroupBy: 'repo', sidebarSortBy: 'manual', sidebarProjectOrderBy: 'manual', sidebarRepoFilter: [], sidebarHideDefaultBranch: false, sidebarHideDetachedHead: false, sidebarCardLayout: 'detailed', sidebarCardProperties: ['inline-agents'], sidebarAgentActivityLayout: 'compact' }
  fs.writeFileSync(prefsFile, JSON.stringify(legacy, null, 2) + '\n')

  const clipBefore = backupClipboard()
  await startBackend()
  await launch('L1')
  for (const root of repos) {
    const res = await rpc(control, { cmd: 'add-repo', root })
    if (!res.ok) throw new Error(`add-repo ${root}: ${JSON.stringify(res)}`)
  }
  const cardCount = 4 + 2 + 1 + 13
  await waitFor(async () => {
    await rebuild()
    return Object.keys((await snapshot()).cards).length === cardCount
  }, 'fixture rendered', 90_000)
  // CLI 로 만든 워크트리 1개(createdBranch = 브랜치 삭제 경로, K7 [Q3]).
  const created = cli(del, 'worktree', 'create', '--name', 'd-cli')
  if (!created.ok) throw new Error(`cli create: ${JSON.stringify(created)}`)
  const wtCli = created.result?.worktree?.path ?? null
  await waitFor(async () => {
    await rebuild()
    return Object.keys((await snapshot()).cards).length === cardCount + 1
  }, 'cli worktree rendered', 60_000)
  await settle()
  await shot('00-first')

  // ── K5ⓖ 470·477 모양 prefs → 핀 없음 ──
  let snap = await snapshot()
  check('K5g-legacy-no-pins', 'K5ⓖ 핀 칸 없는 ui-prefs 첫 기동 → 고정 구획 없음 · 그룹 4개 그대로', snap.pinned === null && snap.groups.length === 4, { pinned: snap.pinned, groups: snap.groups.map((g) => g.worktrees.length) })

  // ── K2ⓐ 메뉴 항목·순서 ──
  await openCardMenu(wtA('a-one'))
  snap = await snapshot()
  const linkedItems = snap.cardMenu.items.map((i) => i.label)
  const wantLinked = ['업데이트', '열기', '경로 복사', '고정', '상위 워크트리 변경…', '상위 워크트리 열기', '상위에서 빼기', '워크트리 삭제']
  await shot('10-menu-linked')
  await closeAllMenus()
  await openCardMenu(alpha)
  snap = await snapshot()
  const mainItems = snap.cardMenu.items
  await closeAllMenus()
  // git 으로 만든 워크트리는 부모가 없다 — 「지정…」. CLI 로 만든 d-cli 는 주 체크아웃이 부모(CLI create 규칙) — 「변경…」+열기+빼기.
  await openCardMenu(wtCli)
  const cliItems = (await snapshot()).cardMenu.items.map((i) => i.label)
  await closeAllMenus()
  check('K2a-items-linked', 'K2ⓐ 링크 워크트리(부모 없음) 메뉴 = 업데이트 | 열기 · 경로 복사 | 고정 | 상위 워크트리 지정… | 워크트리 삭제', same(linkedItems, ['업데이트', '열기', '경로 복사', '고정', '상위 워크트리 지정…', '워크트리 삭제']), { linkedItems })
  check('K2a-items-with-parent', 'K2ⓐ 부모 있는 워크트리 메뉴 = … 상위 워크트리 변경… · 상위 워크트리 열기 · 상위에서 빼기 | 워크트리 삭제', same(cliItems, wantLinked), { cliItems })
  const mainDelete = mainItems.find((i) => i.action === 'delete')
  check('K7a-main-disabled', 'K7ⓐ 주 체크아웃 = 「워크트리 삭제」 disabled + 이유 툴팁, 「프로젝트 제거」 없음(#17645)', mainDelete?.disabled === true && /레포 ⋯/.test(mainDelete?.title ?? '') && !mainItems.some((i) => /프로젝트/.test(i.label ?? '')), { mainItems })

  // ── K2ⓑ 위치·clamp · 우클릭은 활성화·끌기 없음 ──
  const activeBefore = await activePath()
  const p = await pointOf(cardSel(wtA('a-two')), 0.6, 0.3)
  await rightClick(p)
  snap = await snapshot()
  const atPointer = snap.cardMenu !== null && Math.abs(snap.cardMenu.rect.left - p.x) < 2 && Math.abs(snap.cardMenu.rect.top - p.y) < 2
  check('K2b-pointer-no-activate', 'K2ⓑ 포인터 위치에 열림 · 카드 활성화 없음 · 끌기 없음', atPointer && (await activePath()) === activeBefore && !snap.reordering, { rect: snap.cardMenu?.rect, p, activeBefore, activeAfter: await activePath(), reordering: snap.reordering })
  await closeAllMenus()
  // clamp — 창 오른쪽 아래 구석에서 연다(사이드바 밖 카드 좌표가 없으니 뷰포트를 줄여 맨 아래 카드 아래쪽 가장자리를 쓴다).
  await setViewport(cdp, { width: 1200, height: 360 })
  await pause(300)
  const bottomCard = await cdp.evaluate(() => {
    const list = document.querySelector('[data-repo-list]')
    const lr = list.getBoundingClientRect()
    const rows = [...list.querySelectorAll('[data-worktree] [data-worktree-card-surface]')]
    const hit = rows.map((el) => ({ path: el.closest('[data-worktree]').getAttribute('data-worktree'), r: el.getBoundingClientRect() })).find(({ r }) => r.bottom > lr.bottom - 10 && r.top < lr.bottom - 6)
    return hit ? { path: hit.path, x: hit.r.left + hit.r.width * 0.5, y: Math.min(hit.r.bottom, lr.bottom) - 4 } : null
  })
  if (bottomCard !== null) {
    await rightClick(bottomCard)
    snap = await snapshot()
    const vh = 360
    check('K2b-clamp', 'K2ⓑ 창 아래 가장자리 우클릭 → 메뉴가 창 안(4px 여백)으로 밀린다', snap.cardMenu !== null && snap.cardMenu.rect.bottom <= vh - 3.5 && snap.cardMenu.rect.top < bottomCard.y, { at: bottomCard, rect: snap.cardMenu?.rect })
    await closeAllMenus()
  } else check('K2b-clamp', 'K2ⓑ clamp', false, { error: '아래 가장자리 카드 없음' })
  await setViewport(cdp, viewport)
  await pause(300)

  // ── K2ⓒ 키보드·서브메뉴·hover 강조 ──
  await openCardMenu(wtA('a-one'))
  await key('ArrowDown')
  const k1 = (await snapshot()).cardMenu.active
  await key('ArrowDown')
  const k2 = (await snapshot()).cardMenu.active
  await key('ArrowRight')
  const sub = await snapshot()
  await key('ArrowDown')
  const subDown = (await snapshot()).cardMenu.active
  await key('ArrowLeft')
  const back = await snapshot()
  await key('ArrowUp')
  await key('ArrowUp')
  const wrapped = (await snapshot()).cardMenu.active
  await hover('[data-card-menu] [data-menu-action="copy-path"]')
  const hovered = (await snapshot()).cardMenu.active
  check('K2c-keyboard', 'K2ⓒ ↓ 업데이트→열기, → 서브메뉴(Finder 강조), ↓ VS Code, ← 닫고 열기로, ↑↑ 감김(삭제), hover 가 강조를 옮김', k1 === 'update' && k2 === 'open-in' && sub.cardMenu.submenu === 'open-in' && sub.cardMenu.active === 'reveal-finder' && subDown === 'open-editor' && back.cardMenu.submenu === null && back.cardMenu.active === 'open-in' && wrapped === 'delete' && hovered === 'copy-path', { k1, k2, sub: [sub.cardMenu.submenu, sub.cardMenu.active], subDown, back: [back.cardMenu.submenu, back.cardMenu.active], wrapped, hovered })
  // Enter = 선택 — 업데이트 대화가 열린다.
  await key('Home')
  await key('Enter')
  await settle()
  snap = await snapshot()
  check('K2c-enter', 'K2ⓒ Enter 선택 → 메뉴 닫힘 · 「업데이트」 대화 열림', snap.cardMenu === null && snap.metaDialog === wtA('a-one'), { menu: snap.cardMenu, metaDialog: snap.metaDialog })
  await clickSel('[data-meta-cancel]')
  await settle()

  // 카드 ⋯ 단추는 열린 워크트리에만 있다 — a-two 를 연다.
  await clickSel(titleSel(wtA('a-two')))
  await waitFor(async () => (await rowOf(wtA('a-two')))?.openWorkspaceId != null, 'a-two open', 30_000)
  await settle()

  // ── K2ⓓ 닫힘 규칙 · 동시에 하나 ──
  const closeCases = []
  const closeBy = async (label, act, opener = () => openCardMenu(wtA('a-one'))) => {
    await opener()
    await act()
    await settle()
    const s = await snapshot()
    closeCases.push({ label, cardMenu: s.menus.card, total: s.menuOpenTotal, menus: s.menus })
    await closeAllMenus()
  }
  await closeBy('outside-click', () => click({ x: 900, y: 400 }))
  await closeBy('escape', () => key('Escape'))
  await closeBy('window-blur', () => cdp.evaluate(() => window.dispatchEvent(new Event('blur'))))
  await closeBy('list-scroll', () => cdp.evaluate(() => document.querySelector('[data-repo-list]').dispatchEvent(new Event('scroll'))))
  await closeBy('options-menu', () => clickSel('[data-sidebar-options]'))
  // 메뉴는 포인터 아래로 열려 그 아래 단추를 덮는다 — 누를 단추가 메뉴 위쪽에 오게 연다(덮인 좌표를 누르면 메뉴를 누른 것이다).
  await closeBy('repo-menu', async () => {
    await hover(`[data-repo="${alpha}"] [data-repo-head]`)
    await clickSel(`[data-repo-menu-toggle="${alpha}"]`)
  })
  await closeBy('card-dots-menu', async () => {
    await hover(cardSel(wtA('a-two')))
    await clickSel(`[data-worktree-menu-toggle="${wtA('a-two')}"]`)
  }, () => openCardMenu(wtB('b-one')))
  // 메뉴는 포인터 아래로 열려 아래 카드를 덮는다 — 아래 카드(a-two)에서 연 뒤 위 카드(a-one)를 우클릭한다.
  await closeBy('other-card-right-click', () => openCardMenu(wtA('a-one')), () => openCardMenu(wtA('a-two')))
  const expectOther = { 'options-menu': 'options', 'repo-menu': 'repo', 'card-dots-menu': 'worktree', 'other-card-right-click': 'card' }
  check('K2d-close', 'K2ⓓ 바깥 클릭·Esc·창 blur·스크롤에 닫힘, 옵션·레포 ⋯·카드 ⋯·다른 카드 우클릭이 열리면 원래 메뉴는 닫혀 열린 메뉴는 1개', closeCases.every((c) => (expectOther[c.label] === undefined ? c.total === 0 : c.total === 1 && c.menus[expectOther[c.label]] === 1 && (c.label !== 'other-card-right-click' || c.cardMenu === 1))), closeCases)
  // 반대 방향 — 다른 메뉴가 열린 채 카드 우클릭 → 그 메뉴가 닫힌다.
  const reverse = []
  for (const [label, opener] of [
    ['options', () => clickSel('[data-sidebar-options]')],
    ['repo', async () => {
      await hover(`[data-repo="${beta}"] [data-repo-head]`)
      await clickSel(`[data-repo-menu-toggle="${beta}"]`)
    }],
    ['worktree', async () => {
      await hover(cardSel(wtA('a-two')))
      await clickSel(`[data-worktree-menu-toggle="${wtA('a-two')}"]`)
    }],
  ]) {
    await opener()
    const opened = (await snapshot()).menus[label]
    // 열린 메뉴에 덮이지 않는 아래쪽 카드.
    await openCardMenu(wtD('d-child'))
    const s = await snapshot()
    reverse.push({ label, opened, after: s.menus })
    await closeAllMenus()
  }
  check('K2d-reverse', 'K2ⓓ 옵션·레포 ⋯·카드 ⋯ 메뉴가 열린 채 카드 우클릭 → 그 메뉴 닫힘, 카드 메뉴만', reverse.every((r) => r.opened === 1 && r.after.card === 1 && r.after[r.label] === 0), reverse)

  // 탭 메뉴 — 탭이 있어야 한다(a-one 을 연다).
  await clickSel(titleSel(wtA('a-one')))
  await waitFor(async () => (await rowOf(wtA('a-one')))?.openWorkspaceId != null, 'a-one open', 30_000)
  await waitFor(async () => (await pointOf('[data-main-tab]')) !== null, 'main tab', 15_000)
  await openCardMenu(wtA('a-two'))
  await rightClick(await pointOf('[data-main-tab]'))
  const tabOpen = await snapshot()
  await closeAllMenus()
  await rightClick(await pointOf('[data-main-tab]'))
  await openCardMenu(wtA('a-two'))
  const tabThenCard = await snapshot()
  await closeAllMenus()
  check('K2d-tab-menu', 'K2ⓓ 탭 메뉴 ↔ 카드 메뉴 — 한쪽이 열리면 다른 쪽이 닫힌다', tabOpen.menus.tab === 1 && tabOpen.menus.card === 0 && tabThenCard.menus.card === 1 && tabThenCard.menus.tab === 0, { tabOpen: tabOpen.menus, tabThenCard: tabThenCard.menus })

  // ── K2ⓖ 카드 ⋯ 메뉴 닫기 규칙 ──
  const dots = []
  for (const [label, act] of [['escape', () => key('Escape')], ['outside', () => click({ x: 900, y: 400 })], ['toggle', () => clickSel(`[data-worktree-menu-toggle="${wtA('a-two')}"]`)]]) {
    await hover(cardSel(wtA('a-two')))
    await clickSel(`[data-worktree-menu-toggle="${wtA('a-two')}"]`)
    const opened = (await snapshot()).menus.worktree
    await act()
    await settle()
    dots.push({ label, opened, after: (await snapshot()).menus.worktree })
  }
  check('K2g-dots-menu', 'K2ⓖ 카드 ⋯ 메뉴 유지 — Esc·바깥 클릭·⋯ 다시 누름에 닫힘', dots.every((d) => d.opened === 1 && d.after === 0), dots)

  // ── K3ⓐ 인라인 rename ──
  const metaBefore = readRegistry()
  const regText0 = fs.readFileSync(registryFile, 'utf8')
  await dblclick(await pointOf(titleSel(wtA('a-two'))))
  snap = await snapshot()
  const selection = await cdp.evaluate(() => {
    const el = document.activeElement
    return el instanceof HTMLInputElement ? { value: el.value, start: el.selectionStart, end: el.selectionEnd, rename: el.hasAttribute('data-inline-rename') } : null
  })
  check('K3a-dblclick', 'K3ⓐ 제목 더블클릭 → 인라인 입력(포커스·글자 전체 선택)', snap.cards[wtA('a-two')].renaming && selection?.rename === true && selection.start === 0 && selection.end === selection.value.length && selection.value === 'a-two', { selection })
  // 입력 중 끌기 없음 — 입력 위에서 눌러 끌어 본다.
  const inp = await pointOf(`[data-inline-rename="${wtA('a-two')}"]`)
  await mouse('mouseMoved', inp)
  await mouse('mousePressed', inp)
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', { x: inp.x, y: inp.y + i * 12 }, { buttons: 1 })
  const dragDuring = (await snapshot()).reordering
  await mouse('mouseReleased', { x: inp.x, y: inp.y + 72 })
  await cdp.evaluate((wt) => {
    const el = document.querySelector(`[data-inline-rename="${CSS.escape(wt)}"]`)
    el.focus()
    el.select()
  }, wtA('a-two'))
  // 단축키 양보 — ⌘⌥R 은 입력 안에서 아무 일 없이(입력 유지), 글자 입력은 입력에 들어간다.
  await key('r', 4 | 1)
  const afterShortcut = (await snapshot()).cards[wtA('a-two')].renaming
  // IME 조합 중 Enter 는 무시(합성 keydown isComposing).
  await cdp.evaluate((wt) => {
    const el = document.querySelector(`[data-inline-rename="${CSS.escape(wt)}"]`)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }))
  }, wtA('a-two'))
  await settle()
  const afterIme = (await snapshot()).cards[wtA('a-two')].renaming
  await typeText('이름 하나')
  await key('Enter')
  await waitFor(async () => (await snapshot()).cards[wtA('a-two')]?.title === '이름 하나', 'renamed', 10_000).catch(() => {})
  snap = await snapshot()
  const cliShow = showMeta(alpha, wtA('a-two'))
  check('K3a-enter', 'K3ⓐ Enter 확정 → 카드 제목 = 새 이름 · CLI worktree show 가 같은 값(K1ⓒ GUI→CLI) · 입력 중 끌기 없음 · 단축키·IME Enter 는 입력 유지', snap.cards[wtA('a-two')].title === '이름 하나' && cliShow.displayName === '이름 하나' && !dragDuring && afterShortcut && afterIme, { title: snap.cards[wtA('a-two')].title, cliShow, dragDuring, afterShortcut, afterIme })
  check('K3d-meta-branch', 'K3ⓓ 표시 이름이 브랜치와 다르면 메타 줄에 브랜치', snap.cards[wtA('a-two')].metaBranch === 'a-two', { metaBranch: snap.cards[wtA('a-two')].metaBranch })
  // Esc 취소 · 빈 값 = 취소 · 같은 값 = 취소(쓰기 없음 — 레지스트리 바이트 그대로) · blur 확정.
  const regHash = () => sha(fs.readFileSync(registryFile, 'utf8'))
  const cancelCases = []
  for (const [label, act] of [
    ['escape', async () => {
      await typeText('버릴 이름')
      await key('Escape')
    }],
    ['empty', async () => {
      await key('Backspace')
      await key('Enter')
    }],
    ['same', async () => {
      await typeText('이름 하나')
      await key('Enter')
    }],
  ]) {
    const h = regHash()
    await dblclick(await pointOf(titleSel(wtA('a-two'))))
    await waitFor(async () => (await snapshot()).cards[wtA('a-two')].renaming, 'rename open', 5000)
    await act()
    await settle()
    const s = await snapshot()
    cancelCases.push({ label, renaming: s.cards[wtA('a-two')].renaming, title: s.cards[wtA('a-two')].title, registrySame: regHash() === h })
  }
  check('K3a-cancel', 'K3ⓐ Esc · 빈 값 · 같은 값 = 취소(제목 그대로, 레지스트리 쓰기 없음)', cancelCases.every((c) => !c.renaming && c.title === '이름 하나' && c.registrySame), cancelCases)
  await dblclick(await pointOf(titleSel(wtA('a-two'))))
  await typeText('blur 이름')
  await click({ x: 900, y: 400 })
  await waitFor(async () => (await snapshot()).cards[wtA('a-two')]?.title === 'blur 이름', 'blur commit', 10_000).catch(() => {})
  check('K3a-blur', 'K3ⓐ blur = 확정', (await snapshot()).cards[wtA('a-two')].title === 'blur 이름' && showMeta(alpha, wtA('a-two')).displayName === 'blur 이름', { title: (await snapshot()).cards[wtA('a-two')].title })

  // K1ⓒ CLI→GUI · K3ⓓ 표시 이름 = 브랜치여도 그 값(#15908 따라 하지 않기)
  const cliSet = cli(alpha, 'worktree', 'set', '--worktree', `path:${wtA('a-three')}`, '--display-name', 'a-three', '--comment', 'CLI 메모')
  const cliShown = await tryWait(async () => {
    await rebuild()
    const c = (await snapshot()).cards[wtA('a-three')]
    return c.title === 'a-three' && c.note
  }, 'cli→gui', 20_000)
  const row3 = await rowOf(wtA('a-three'))
  check('K1c-cli-to-gui', 'K1ⓒ CLI worktree set(표시 이름·comment) → GUI 카드 제목·노트 배지 · 렌더러 행 displayName·comment', cliSet.ok && cliShown && row3.displayName === 'a-three' && row3.comment === 'CLI 메모', { cliSet: cliSet.ok, row3: { displayName: row3.displayName, comment: row3.comment } })
  check('K3d-same-as-branch', 'K3ⓓ 표시 이름 = 브랜치여도 그 값이 제목(값이 저장돼 있다)', (await snapshot()).cards[wtA('a-three')].title === 'a-three' && row3.displayName === 'a-three', { title: (await snapshot()).cards[wtA('a-three')].title })

  // ── K3ⓒ 업데이트 대화 · K1ⓓ 실패 주입 ──
  await openCardMenu(wtA('a-one'))
  await menuClick('update')
  await waitFor(async () => (await snapshot()).metaDialog === wtA('a-one'), 'meta dialog', 5000)
  await cdp.evaluate(() => document.querySelector('[data-meta-display-name]').focus())
  await typeText('업데이트 이름')
  await cdp.evaluate(() => document.querySelector('[data-meta-comment]').focus())
  await typeText('첫 줄')
  await key('Enter', 8)
  await typeText('둘째 줄')
  // 실패 주입 — 레지스트리 잠금을 살아 있는 주인(이 하네스)이 쥔다 → 1.5s 뒤 Registry busy.
  const lock = registryFile + '.lock'
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, `${process.pid}-00000000-0000-4000-8000-000000000478`), '')
  await key('Enter')
  const errShown = await tryWait(async () => (await snapshot()).metaError !== null, 'meta error', 10_000)
  snap = await snapshot()
  fs.rmSync(lock, { recursive: true, force: true })
  // CLI `worktree show` 의 displayName 은 미설정이면 브랜치로 채운 값이다 — 원값은 렌더러 행(레지스트리 조인)으로 본다.
  const busyRow = await rowOf(wtA('a-one'))
  check('K1d-busy-visible', 'K1ⓓ·K3ⓒ 레지스트리 busy → 대화 안 오류(Registry busy), 대화 유지, 값 안 바뀜', errShown && /Registry busy/.test(snap.metaError ?? '') && snap.metaDialog === wtA('a-one') && busyRow?.displayName === null && busyRow?.comment === null, { metaError: snap.metaError, metaDialog: snap.metaDialog, row: { displayName: busyRow?.displayName, comment: busyRow?.comment } })
  await shot('20-meta-busy')
  await key('Enter')
  await tryWait(async () => (await snapshot()).metaDialog === null, 'meta saved', 10_000)
  const m1 = showMeta(alpha, wtA('a-one'))
  check('K3c-dialog-save', 'K3ⓒ 다시 Enter → 저장 · 대화 닫힘 · Shift+Enter 줄바꿈이 comment 에', (await snapshot()).metaDialog === null && m1.displayName === '업데이트 이름' && m1.comment === '첫 줄\n둘째 줄', { m1 })
  // 빈 표시 이름 저장 = 브랜치로 되돌림(제목 밖 더블클릭으로 연다).
  await dblclick(await pointOf(cardSel(wtA('a-one')), 0.9, 0.85))
  const dblOpened = await tryWait(async () => (await snapshot()).metaDialog === wtA('a-one'), 'dblclick details', 5000)
  await cdp.evaluate(() => {
    const el = document.querySelector('[data-meta-display-name]')
    el.focus()
    el.select()
  })
  await key('Backspace')
  await clickSel('[data-meta-save]')
  await tryWait(async () => (await snapshot()).metaDialog === null, 'meta saved 2', 10_000)
  await tryWait(async () => (await snapshot()).cards[wtA('a-one')].title === 'a-one', 'title back to branch', 10_000)
  const emptyRow = await rowOf(wtA('a-one'))
  check('K3c-empty-reverts', 'K3ⓒ 제목 밖 더블클릭 → 상세 대화 · 빈 표시 이름 저장 = 브랜치로(레지스트리 표시 이름 없음, CLI show 는 브랜치)', dblOpened && (await snapshot()).cards[wtA('a-one')].title === 'a-one' && emptyRow?.displayName === null && showMeta(alpha, wtA('a-one')).displayName === 'a-one', { dblOpened, row: emptyRow?.displayName, cli: showMeta(alpha, wtA('a-one')) })

  // ── K3ⓔ 노트 배지 · hover · Compact hover ──
  await hover(`[data-worktree="${wtA('a-one')}"] [data-worktree-note-badge]`)
  const noteHover = await tryWait(async () => /첫 줄/.test((await snapshot()).hoverCard ?? ''), 'note hover', 5000)
  await mouse('mouseMoved', { x: 900, y: 600 })
  await pause(300)
  await openMenuSet('compact')
  await hover(titleSel(wtA('a-one')))
  const compactHover = await tryWait(async () => /첫 줄/.test((await snapshot()).hoverCard ?? ''), 'compact hover', 5000)
  await mouse('mouseMoved', { x: 900, y: 600 })
  await pause(300)
  await openMenuSet('detailed')
  check('K3e-note', 'K3ⓔ comment → 노트 배지 + hover 내용 · Compact 카드 hover 카드에도 comment', (await snapshot()).cards[wtA('a-one')].note && noteHover && compactHover, { noteHover, compactHover })

  // ── K2ⓔ 메뉴가 열려 있는 동안 HoverCard 가 뜨지 않는다 ──
  await openCardMenu(wtA('a-three'))
  await mouse('mouseMoved', await pointOf(`[data-worktree="${wtA('a-one')}"] [data-worktree-note-badge]`))
  await pause(900)
  const hoverWhileMenu = (await snapshot()).hoverCard
  await closeAllMenus()
  check('K2e-no-hover-under-menu', 'K2ⓔ 카드 메뉴가 열린 동안 노트 배지 hover → HoverCard 없음', hoverWhileMenu === null, { hoverWhileMenu })
  await mouse('mouseMoved', { x: 900, y: 600 })

  // ── r2 R2B-02: 열려 있는 hover 카드는 카드 대화가 뜨면 닫힌다 — 커서는 배지 위에 그대로(떠나서 닫히는 경로가 아니다) ──
  const badge = `[data-worktree="${wtA('a-one')}"] [data-worktree-note-badge]`
  const dialogPaths = {}
  for (const via of ['cmd-shift-backspace', 'dblclick-badge']) {
    await hover(badge)
    const opened = await tryWait(async () => /첫 줄/.test((await snapshot()).hoverCard ?? ''), `note hover ${via}`, 5000)
    if (via === 'cmd-shift-backspace') await key('Backspace', 4 | 8)
    else await dblclick(await pointOf(badge))
    const dialogUp = await tryWait(async () => {
      const snap = await snapshot()
      return snap.deleteDialog !== null || snap.metaDialog !== null
    }, `dialog ${via}`, 5000)
    await pause(300)
    const after = await snapshot()
    dialogPaths[via] = { opened, dialogUp, deleteDialog: after.deleteDialog?.path ?? null, metaDialog: after.metaDialog, hoverCard: after.hoverCard }
    await key('Escape')
    await tryWait(async () => {
      const snap = await snapshot()
      return snap.deleteDialog === null && snap.metaDialog === null
    }, `dialog closed ${via}`, 5000)
    await mouse('mouseMoved', { x: 900, y: 600 })
    await pause(300)
  }
  check('K2e-dialog-closes-hovercard', 'r2 R2B-02 · K2ⓔ 노트 hover 카드가 열린 채(커서 그대로) ⌘⇧⌫ → 삭제 대화 · 배지 더블클릭 → 정보 수정 대화 — 둘 다 hover 카드 닫힘', Object.values(dialogPaths).every((r) => r.opened && r.dialogUp && r.hoverCard === null) && dialogPaths['cmd-shift-backspace'].deleteDialog === wtA('a-one') && dialogPaths['dblclick-badge'].metaDialog === wtA('a-one'), dialogPaths)

  // ── K1ⓔ·ⓕ 레지스트리 형식·다른 칸 보존 ──
  const metaAfter = readRegistry()
  const regKeysBefore = Object.keys(metaBefore ?? {}).sort()
  const regKeysAfter = Object.keys(metaAfter ?? {}).sort()
  fs.writeFileSync(path.join(out, 'registry-shape.json'), JSON.stringify({ before: shapeOf(metaBefore), after: shapeOf(metaAfter) }, null, 2))
  check('K1ef-registry-shape', 'K1ⓔⓕ 레지스트리 version 2 · 최상위 칸 그대로 · 레포 목록 그대로 · 워크트리 메타 칸 = CLI 가 쓰는 칸만', metaAfter?.version === 2 && same(regKeysBefore, regKeysAfter) && same(metaBefore.repos, metaAfter.repos) && sameMetaFieldSets(metaAfter), { before: shapeOf(metaBefore), after: shapeOf(metaAfter), regText0Len: regText0.length })

  // ── K4 Finder · 경로 복사 · 레포 Finder · 경로 거절 ──
  closeFinderWindowsUnder(R)
  await openCardMenu(wtA('a-one'))
  await key('ArrowDown')
  await key('ArrowDown')
  await key('ArrowRight')
  await key('Enter')
  const finderWt = await tryWait(async () => (finderSelection() ?? []).some((s) => s.replace(/\/$/, '') === wtA('a-one')), 'finder selects worktree', 10_000)
  const finderSel1 = finderSelection()
  const closed1 = closeFinderWindowsUnder(R)
  check('K4a-finder', 'K4ⓐ 「열기 ▸ Finder」 → Finder 가 워크트리 폴더를 선택해 보인다(showItemInFolder)', finderWt, { selection: finderSel1, closed: closed1 })
  await openCardMenu(wtA('a-two'))
  await menuClick('copy-path')
  const clip = (await rpc(control, { cmd: 'read-clipboard' })).text
  check('K4c-copy-path', 'K4ⓒ 「경로 복사」 → 클립보드 = 절대경로 · 알림 없음', clip === wtA('a-two') && (await snapshot()).notice === null, { clip, notice: (await snapshot()).notice })
  await hover(`[data-repo="${beta}"] [data-repo-head]`)
  await clickSel(`[data-repo-menu-toggle="${beta}"]`)
  const repoMenuText = await cdp.evaluate((r) => document.querySelector(`[data-repo-menu="${r}"]`)?.textContent ?? null, beta)
  await clickSel(`[data-repo-menu="${beta}"] [data-repo-menu-reveal]`)
  const finderRepo = await tryWait(async () => (finderSelection() ?? []).some((s) => s.replace(/\/$/, '') === beta), 'finder selects repo', 10_000)
  const finderSel2 = finderSelection()
  const closed2 = closeFinderWindowsUnder(R)
  check('K4d-repo-finder', 'K4ⓓ 레포 ⋯ 「Finder 에서 열기」 → 레포 루트 · 레포 메뉴 문구 「목록에서 프로젝트 제거」', finderRepo && /Finder 에서 열기/.test(repoMenuText ?? '') && /목록에서 프로젝트 제거/.test(repoMenuText ?? ''), { selection: finderSel2, closed: closed2, repoMenuText })
  await closeAllMenus()
  const refusals = await cdp.evaluate(async (p2) => ({
    finderEtc: await window.corral.revealInFinder({ path: '/etc', kind: 'worktree' }),
    finderRelative: await window.corral.revealInFinder({ path: 'repos/alpha', kind: 'repo' }),
    finderMissing: await window.corral.revealInFinder({ path: p2.missing, kind: 'worktree' }),
    finderWrongKind: await window.corral.revealInFinder({ path: p2.linked, kind: 'repo' }),
    copyEtc: await window.corral.copyPath({ path: '/etc' }),
    editorEtc: await window.corral.openInEditor({ path: '/etc' }),
    metaEtc: await window.corral.setWorktreeMeta({ path: '/etc', displayName: 'x' }),
    deleteEtc: await window.corral.deleteWorktree({ path: '/etc', force: true }),
    previewEtc: await window.corral.previewWorktreeDelete({ path: '/etc' }),
  }), { missing: path.join(R, 'alpha-wt', 'nope'), linked: wtA('a-one') })
  const clipAfterRefusal = (await rpc(control, { cmd: 'read-clipboard' })).text
  fs.writeFileSync(path.join(out, 'k4e-refusals.json'), JSON.stringify(refusals, null, 2))
  check('K4e-refuse-paths', 'K4ⓔ main IPC 가 등록 안 된·상대·없는·종류가 다른 경로를 거절(Finder·복사·편집기·메타·삭제·미리보기) · 클립보드 그대로', Object.values(refusals).every((r) => r.ok === false) && clipAfterRefusal === wtA('a-two'), refusals)

  // ── K5 Pin ──
  await openCardMenu(wtA('a-three'))
  await menuClick('toggle-pin')
  await openCardMenu(wtB('b-one'))
  await menuClick('toggle-pin')
  await settle()
  snap = await snapshot()
  const groupOf = (s, root) => s.groups.find((g) => g.root === root)?.worktrees ?? []
  const pinOk =
    same(snap.pinned?.worktrees, [wtA('a-three'), wtB('b-one')]) &&
    !groupOf(snap, alpha).includes(wtA('a-three')) &&
    !groupOf(snap, beta).includes(wtB('b-one')) &&
    snap.cards[wtA('a-three')].pinned &&
    !snap.cards[wtA('a-three')].reorder
  const firstChild = await cdp.evaluate(() => {
    const el = document.querySelector('[data-repo-list] > :first-child')
    return { pinned: el?.hasAttribute('data-pinned-section') ?? false, cls: el?.className ?? null, attrs: el === null ? [] : [...el.attributes].map((a) => a.name) }
  })
  check('K5ab-pinned-section', 'K5ⓐⓑ 고정 → 맨 위 「고정됨」 구획(현재 정렬 = 레포 순 → 카드 순), 원래 그룹에서 빠짐(단일 위치) · 끌기 표지 없음(K5ⓕ)', pinOk && firstChild.pinned, { pinned: snap.pinned, alpha: groupOf(snap, alpha), beta: groupOf(snap, beta), card: snap.cards[wtA('a-three')], firstChild })
  check('K5c-repo-label', 'K5ⓒ 고정 구획 카드에 레포 이름이 보이는 글자로(#24304 따라 하지 않기)', snap.cards[wtA('a-three')].repoLabel === 'alpha' && snap.cards[wtB('b-one')].repoLabel === 'beta', { a: snap.cards[wtA('a-three')].repoLabel, b: snap.cards[wtB('b-one')].repoLabel })
  check('K5g-prefs', 'K5ⓖ ui-prefs.json pinnedWorktrees = 고정한 경로', same([...(readPrefs()?.pinnedWorktrees ?? [])].sort(), [wtA('a-three'), wtB('b-one')].sort()), { pinnedWorktrees: readPrefs()?.pinnedWorktrees })
  await openCardMenu(wtA('a-three'))
  const unpinLabel = (await snapshot()).cardMenu.items.find((i) => i.action === 'toggle-pin')?.label
  await closeAllMenus()
  check('K5a-toggle-label', 'K5ⓐ 고정된 카드 메뉴 = 「고정 해제」', unpinLabel === '고정 해제', { unpinLabel })
  // 클릭 활성화 · primary 표시 — 먼저 연 뒤(열기 직후 활성은 기존 경합으로 main 으로 간다 — race/ 대조 실험, 고정과 무관),
  // 다른 카드를 활성화했다가 고정 카드를 다시 누른다(열린 워크스페이스 활성화 경로).
  await clickSel(titleSel(wtB('b-one')))
  await waitFor(async () => (await rowOf(wtB('b-one')))?.openWorkspaceId != null, 'b-one open', 30_000)
  await pause(800)
  await clickSel(titleSel(wtA('a-two')))
  await waitFor(async () => (await snapshot()).cards[wtA('a-two')].selected, 'a-two active', 10_000)
  await clickSel(titleSel(wtB('b-one')))
  const pinActive = await tryWait(async () => (await snapshot()).cards[wtB('b-one')].selected, 'pinned card active', 20_000)
  await shot('25-pinned-click')
  const bRow = await rowOf(wtB('b-one'))
  check('K5e-activate', 'K5ⓔ 고정 구획 카드 클릭 → 활성(primary 표시)', pinActive, { active: await activePath(), bOpen: bRow?.openWorkspaceId ?? null, card: (await snapshot()).cards[wtB('b-one')] })
  // 정렬 순서 — 이름순으로 바꾸면 고정 구획 순서도 이름순(표시 이름 → a-three 'a-three' < b-one).
  // Group 없음에서도 고정 구획.
  await setGroup('none')
  snap = await snapshot()
  check('K5b-group-none', 'K5ⓑ Group 없음에서도 고정 구획 맨 위 · 전체 목록에서 빠짐', same(snap.pinned?.worktrees, [wtA('a-three'), wtB('b-one')]) && !(snap.all ?? []).includes(wtA('a-three')), { pinned: snap.pinned, all: snap.all?.length })
  await setGroup('repo')
  // 접기
  await clickSel('[data-pinned-head]')
  snap = await snapshot()
  const collapsedPinned = snap.pinned?.expanded === 'false' && snap.pinned.worktrees.length === 0
  await clickSel('[data-pinned-head]')
  check('K5c-collapse', 'K5ⓒ 고정 구획 헤더 클릭 = 접기(카드 숨김) · 다시 = 펼침', collapsedPinned && (await snapshot()).pinned.worktrees.length === 2, { collapsedPinned, prefs: readPrefs()?.collapsedRepos })
  // 필터 — beta 만 보기 → 고정 구획에 b-one 만.
  await setRepoFilter([beta])
  snap = await snapshot()
  const filtered = same(snap.pinned?.worktrees, [wtB('b-one')])
  await setRepoFilter([])
  check('K5c-filter', 'K5ⓒ 레포 필터가 고정 구획에도 적용(198 — 필터 뒤 핀)', filtered, { pinned: snap.pinned })

  // ── K6 Parent ──
  await openCardMenu(wtA('a-one'))
  await menuClick('set-parent')
  await waitFor(async () => (await snapshot()).picker?.for === wtA('a-one'), 'picker', 5000)
  const cand1 = (await snapshot()).picker.candidates
  await typeText('blur')
  const filteredCand = (await snapshot()).picker.candidates
  await cdp.evaluate(() => {
    const el = document.querySelector('[data-parent-picker-search]')
    el.select()
  })
  await key('Backspace')
  await key('ArrowDown')
  await key('Enter')
  await tryWait(async () => (await rowOf(wtA('a-one')))?.parentPath != null, 'parent set', 10_000)
  const parentOfOne = (await rowOf(wtA('a-one')))?.parentPath
  // a-two(표시 이름 「blur 이름」) 를 a-one 의 자식으로 → a-one 의 후보에서 a-two 제외(후손) 확인용.
  check('K6a-picker', 'K6ⓐ 피커 후보 = 같은 레포, 자기 제외, 주 체크아웃 포함 · 검색 필터 · ↓ Enter 로 지정', !cand1.includes(wtA('a-one')) && cand1.includes(alpha) && cand1.every((c) => c.startsWith(alpha)) && same(filteredCand, [wtA('a-two')]) && parentOfOne !== null && parentOfOne !== undefined, { cand1, filteredCand, parentOfOne })
  // 후손 제외: a-two 의 부모를 a-one 으로 → a-one 의 후보에 a-two 없음.
  const setChild = cli(alpha, 'worktree', 'set', '--worktree', `path:${wtA('a-two')}`, '--parent-worktree', `path:${wtA('a-one')}`)
  await rebuild()
  // a-one 의 부모가 a-two 였다면 위 CLI 가 순환으로 거절된다 — 그 경우도 기록.
  await openCardMenu(wtA('a-one'))
  await menuClick('set-parent')
  await waitFor(async () => (await snapshot()).picker?.for === wtA('a-one'), 'picker 2', 5000)
  const cand2 = (await snapshot()).picker.candidates
  await key('Escape')
  const pickerClosed = (await snapshot()).picker === null
  const currentParent = (await rowOf(wtA('a-one')))?.parentPath
  check('K6a-exclusions', 'K6ⓐ 후보에서 현재 부모·자기 후손 제외 · Esc 닫힘', setChild.ok ? !cand2.includes(wtA('a-two')) && !cand2.includes(currentParent) && pickerClosed : setChild.error !== undefined, { setChild: setChild.ok ? 'ok' : setChild.error, cand2, currentParent, pickerClosed })
  // 순환은 CLI 와 같은 거절(K6ⓑ) — GUI IPC 로 직접 시도.
  const cycle = await cdp.evaluate((pp) => window.corral.setWorktreeMeta({ path: pp.one, parentPath: pp.two }), { one: wtA('a-one'), two: wtA('a-two') })
  const cliCycle = cli(alpha, 'worktree', 'set', '--worktree', `path:${wtA('a-one')}`, '--parent-worktree', `path:${wtA('a-two')}`)
  check('K6b-cycle', 'K6ⓑ 순환 지정 = GUI 와 CLI 가 같은 오류 코드로 거절', cycle.ok === false && cliCycle.ok === false && cycle.code === (cliCycle.error?.code ?? cliCycle.code), { gui: cycle, cli: cliCycle.error ?? cliCycle })
  snap = await snapshot()
  check('K6e-parent-visible', 'K6ⓔ 카드 메타 줄에 상위 워크트리 이름(↳)', snap.cards[wtA('a-two')].parentPath === wtA('a-one') && /a-one/.test(snap.cards[wtA('a-two')].parent ?? ''), { card: snap.cards[wtA('a-two')] })
  // 상위 열기 → 부모 활성화·드러냄
  await openCardMenu(wtA('a-two'))
  await menuClick('open-parent')
  const parentActive = await tryWait(async () => (await snapshot()).cards[wtA('a-one')].selected, 'parent active', 20_000)
  const parentFlash = (await snapshot()).cards[wtA('a-one')].flash
  check('K6c-open-parent', 'K6ⓒ 「상위 워크트리 열기」 → 부모 활성 · 번쩍(K9 경로)', parentActive && parentFlash, { parentActive, parentFlash })
  // 상위에서 빼기
  await openCardMenu(wtA('a-two'))
  await menuClick('remove-parent')
  const removed = await tryWait(async () => (await rowOf(wtA('a-two')))?.parentPath === null, 'parent removed', 10_000)
  check('K6d-remove-parent', 'K6ⓓ 「상위에서 빼기」 → 부모 없음(CLI show 도)', removed && showMeta(alpha, wtA('a-two')).parent === null && (await snapshot()).cards[wtA('a-two')].parent === null, { meta: showMeta(alpha, wtA('a-two')) })
  // 후보 0 → disabled (solo 주 체크아웃)
  await openCardMenu(solo)
  const soloSet = (await snapshot()).cardMenu.items.find((i) => i.action === 'set-parent')
  await closeAllMenus()
  check('K6a-no-candidates', 'K6ⓐ 후보 0(혼자인 주 체크아웃) → 「상위 워크트리 지정…」 disabled + 사유', soloSet?.disabled === true && (soloSet?.title ?? '').length > 0, { soloSet })

  // ── K8 하단 바 ──
  const footer = await cdp.evaluate(() => {
    const f = document.querySelector('[data-sidebar-footer]')
    const r = (el) => (el === null ? null : el.getBoundingClientRect().left)
    return {
      text: f.textContent,
      settings: r(f.querySelector('.sidebar-footer-glyph[title*="설정"], [data-settings-glyph]')),
      help: r(f.querySelector('[data-help-menu-toggle]')),
      refresh: r(f.querySelector('[data-refresh-tree]')),
      reveal: r(f.querySelector('[data-reveal-active]')),
      width: f.getBoundingClientRect().width,
      left: f.getBoundingClientRect().left,
    }
  })
  check('K8bd-layout', 'K8ⓑⓓ ◫ 없음 · 왼쪽 ⚙·? · 오른쪽 ↻·Reveal(Reveal 이 맨 오른쪽)', !footer.text.includes('◫') && footer.help !== null && footer.reveal !== null && footer.refresh !== null && footer.help < footer.refresh && footer.refresh < footer.reveal && (footer.settings === null || footer.settings < footer.help), footer)
  await clickSel('[data-help-menu-toggle]')
  const helpItems = await cdp.evaluate(() => [...document.querySelectorAll('[data-help-menu] [data-menu-action]')].map((el) => el.textContent))
  await clickSel('[data-help-menu] [data-menu-action]')
  await settle()
  const shortcutsOpen = (await snapshot()).shortcuts
  const renameRow = await cdp.evaluate(() => ({ rename: document.querySelector('[data-shortcut-action="workspace.rename"]')?.textContent ?? null, del: document.querySelector('[data-shortcut-action="workspace.delete"]')?.textContent ?? null, rebind: document.querySelector('[data-shortcut-action="workspace.rename"] button') !== null }))
  await shot('30-shortcuts')
  await key('Escape')
  await settle()
  check('K8a-help-menu', 'K8ⓐ ? = 메뉴(「단축키」) → 단축키 설정 화면 · K3ⓑ 워크트리 이름 바꾸기·삭제 행(재지정 단추)', helpItems.length === 1 && /단축키/.test(helpItems[0]) && shortcutsOpen && renameRow.rename !== null && renameRow.del !== null && renameRow.rebind, { helpItems, shortcutsOpen, renameRow })

  // ── K9 Reveal ──
  // 활성 = a-one(상위 열기에서). ⓕ 활성 없음 경로는 맨 끝(모든 워크스페이스를 닫은 뒤)에서.
  const activeNow = await activePath()
  // ⓑ 보이면 필터를 건드리지 않는다 — 필터를 켜되 활성 레포는 남긴다.
  await setRepoFilter([alpha, beta])
  const prefsFilter = readPrefs()?.sidebarRepoFilter
  await clickSel('[data-reveal-active]')
  await settle()
  snap = await snapshot()
  check('K9b-visible-no-filter-touch', 'K9ⓑ 활성 카드가 보이면 필터 그대로(#17543) · 대화 없음 · 번쩍', snap.revealConfirm === null && same(readPrefs()?.sidebarRepoFilter, prefsFilter) && snap.cards[activeNow]?.flash === true, { revealConfirm: snap.revealConfirm, filter: readPrefs()?.sidebarRepoFilter, flash: snap.cards[activeNow]?.flash })
  // 필터에 가려짐 → 확인 대화 → 「필터 유지」 = 아무 것도 안 바뀜 → 「필터 지우고 보기」 = 지우고 드러냄.
  await setRepoFilter([beta])
  await clickSel('[data-reveal-active]')
  await settle()
  const confirm1 = (await snapshot()).revealConfirm
  await clickSel('[data-reveal-keep-filters]')
  await settle()
  const kept = same(readPrefs()?.sidebarRepoFilter, [beta]) && (await snapshot()).revealConfirm === null
  await clickSel('[data-reveal-active]')
  await settle()
  await clickSel('[data-reveal-clear-filters]')
  const revealedAfterClear = await tryWait(async () => (await snapshot()).cards[activeNow]?.flash === true, 'revealed after clear', 5000)
  await shot('40-reveal-clear')
  check('K9b-hidden-confirm', 'K9ⓑ 필터에 가려짐 → 확인 대화 · 「필터 유지」 = 무변경 · 「필터 지우고 보기」 = 필터 비움 + 드러냄', confirm1 === activeNow && kept && same(readPrefs()?.sidebarRepoFilter, []) && revealedAfterClear, { confirm1, kept, filter: readPrefs()?.sidebarRepoFilter, revealedAfterClear })
  // ⓔ 번쩍 1.5s 뒤 꺼짐
  await pause(1700)
  const flashOff = (await snapshot()).cards[activeNow]?.flash === false
  // ⓒ 접힌 레포 펼치기
  await clickSel(`[data-repo-caret="${alpha}"]`)
  const collapsed = !(await snapshot()).groups.find((g) => g.root === alpha)?.worktrees.includes(activeNow)
  await clickSel('[data-reveal-active]')
  const expanded = await tryWait(async () => (await snapshot()).groups.find((g) => g.root === alpha)?.worktrees.includes(activeNow), 'expanded', 5000)
  check('K9ce-collapse-flash', 'K9ⓒ 접힌 레포 → 펼쳐서 드러냄 · ⓔ 번쩍은 1.5s 뒤 꺼짐', flashOff && collapsed && expanded, { flashOff, collapsed, expanded })
  // ⓓ 스크롤 밖 → 최소 스크롤(sticky 헤더 여백), 이미 보이면 스크롤 안 함.
  await setViewport(cdp, { width: 1200, height: 420 })
  await pause(300)
  await cdp.evaluate(() => {
    const list = document.querySelector('[data-repo-list]')
    list.scrollTop = list.scrollHeight
  })
  await pause(200)
  const beforeScroll = (await snapshot()).scrollTop
  await clickSel('[data-reveal-active]')
  await pause(600)
  const geo = await cdp.evaluate((wt) => {
    const list = document.querySelector('[data-repo-list]')
    const card = document.querySelector(`[data-worktree="${CSS.escape(wt)}"]`)
    const lr = list.getBoundingClientRect()
    const cr = card.getBoundingClientRect()
    const head = card.closest('[data-repo]')?.querySelector('[data-repo-head]')?.getBoundingClientRect() ?? null
    return { listTop: lr.top, listBottom: lr.bottom, cardTop: cr.top, cardBottom: cr.bottom, headBottom: head?.bottom ?? null, scrollTop: list.scrollTop }
  }, activeNow)
  const visible = geo.cardTop >= geo.listTop && geo.cardBottom <= geo.listBottom && (geo.headBottom === null || geo.cardTop >= geo.headBottom - 0.5)
  await clickSel('[data-reveal-active]')
  await pause(600)
  const again = (await snapshot()).scrollTop
  check('K9d-scroll', 'K9ⓓ 스크롤 밖 활성 → 붙은 헤더 아래로 보일 만큼만 스크롤 · 이미 보이면 다시 눌러도 스크롤 무변경', beforeScroll > geo.scrollTop && visible && again === geo.scrollTop, { beforeScroll, geo, again })
  await setViewport(cdp, viewport)
  await pause(300)
  // ⓔ reduced motion — 애니메이션 없이 정지 표시.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await clickSel('[data-reveal-active]')
  await pause(200)
  const reduced = await cdp.evaluate((wt) => {
    const el = document.querySelector(`[data-worktree="${CSS.escape(wt)}"] .card-reveal-flash`)
    if (el === null) return null
    const cs = getComputedStyle(el)
    return { animation: cs.animationName, outline: cs.outlineStyle, box: cs.boxShadow }
  }, activeNow)
  await cdp.send('Emulation.setEmulatedMedia', { features: [] })
  check('K9e-reduced-motion', 'K9ⓔ reduced motion → 애니메이션 없음 · 정지 표시(테두리)', reduced !== null && reduced.animation === 'none' && (reduced.outline !== 'none' || reduced.box !== 'none'), { reduced })
  // ⓖ ⌘⌥R — 활성 카드를 드러내고 인라인 rename.
  await pause(1600)
  await click({ x: 900, y: 400 })
  await key('r', 4 | 1)
  const cmdRename = await tryWait(async () => (await snapshot()).cards[activeNow]?.renaming, '⌘⌥R rename', 5000)
  await key('Escape')
  check('K3b-K9g-cmd-alt-r', 'K3ⓑ·K9ⓖ ⌘⌥R → 활성 카드 드러냄 + 인라인 rename', cmdRename, { activeNow })

  // ── K7 삭제 매트릭스 (K7ⓙ, G8) ──
  const record = (row) => {
    deletes.push(row)
    fs.writeFileSync(path.join(out, 'deletes.json'), JSON.stringify(deletes, null, 2))
  }
  // clean (git 으로 만든 브랜치 = createdBranch 아님 → 보존 알림, [Q3])
  {
    const wt = wtD('d-clean')
    const d = await openDelete(wt)
    const r = await confirmDeleteAndWait(wt)
    const disk = diskState(del, wt, 'd-clean')
    record({ case: 'clean', target: wt, gateOwned: gateOwned(wt), dialog: d, result: r, disk })
    check('K7j-clean', 'K7ⓙ clean → 「삭제」(강제 아님) · 디스크·git 목록에서 사라짐 · 브랜치 보존 + 「남았」 알림(Q3) · 레지스트리 언급 없음', d.decision === 'delete' && d.confirm === 'delete' && d.confirmLabel === '삭제' && d.dirty === '0' && r.done && !disk.exists && !disk.inGitList && disk.branch === true && /d-clean/.test(r.notice ?? '') && /남/.test(r.notice ?? '') && !disk.registryMentions, { d: pick(d), r, disk })
    await dismissNotice()
  }
  // CLI 로 만든 워크트리 = 브랜치도 지운다
  {
    const wt = wtCli
    const d = await openDelete(wt)
    const r = await confirmDeleteAndWait(wt)
    const disk = diskState(del, wt, 'd-cli')
    record({ case: 'cli-created', target: wt, gateOwned: gateOwned(wt), dialog: d, result: r, disk })
    check('K7j-created-branch', 'K7ⓙ·ⓘ CLI 가 만든 워크트리 → 삭제 · 브랜치도 삭제(보존 알림 없음)', d.decision === 'delete' && r.done && !disk.exists && disk.branch === false && !/남/.test(r.notice ?? ''), { d: pick(d), r, disk })
    await dismissNotice()
  }
  // dirty — 강제 + 넘기는 것 목록 · 삭제 중 표시 · 중복 삭제 불가
  {
    const wt = wtD('d-dirty')
    const d = await openDelete(wt)
    await clickSel('[data-delete-confirm]')
    // 삭제 중 관측 — 메뉴 항목 disabled · 휴지통 없음 · ⌘⇧⌫ 무시.
    const sawDeleting = await tryWait(async () => (await snapshot()).cards[wt]?.deleting === true, 'deleting', 5000)
    let during = null
    if (sawDeleting) {
      const s = await snapshot()
      await rightClick(await pointOf(cardSel(wt), 0.6, 0.3))
      const menuDuring = (await snapshot()).cardMenu
      await closeAllMenus()
      await hover(cardSel(wt))
      await key('Backspace', 4 | 8)
      const dialogDuring = (await snapshot()).deleteDialog
      during = { pill: s.cards[wt].deletingPill, menuDelete: menuDuring?.items.find((i) => i.action === 'delete') ?? null, dialogDuring }
    }
    const finished = await tryWait(async () => (await snapshot()).cards[wt] === undefined, 'dirty deleted', 60_000)
    const notice = (await snapshot()).notice
    const disk = diskState(del, wt, 'd-dirty')
    record({ case: 'dirty', target: wt, gateOwned: gateOwned(wt), dialog: d, during, finished, notice, disk })
    // 개수는 198 과 같이 `--untracked-files=all` 로 센다(198 worktree-removal-preflight.ts:20) — 수정 1 + 새 파일 20000.
    check('K7b-dirty-force', 'K7ⓑ dirty → 「강제 삭제」 + 경고에 「변경 20001개」(파일 단위, #16526 정직한 이름)', d.decision === 'force' && d.confirm === 'force' && d.confirmLabel === '강제 삭제' && d.dirty === '20001' && d.warning.some((w) => /20001/.test(w) && /변경/.test(w)), { d: pick(d) })
    check('K7f-deleting', 'K7ⓕ 삭제 중 → 「삭제 중…」 · 메뉴 삭제 항목 disabled · ⌘⇧⌫ 무시(대화 안 열림)', sawDeleting && during !== null && /삭제 중/.test(during.pill ?? '') && during.menuDelete?.disabled === true && during.dialogDuring === null, { sawDeleting, during })
    check('K7j-dirty', 'K7ⓙ dirty 강제 삭제 → 디스크·git 목록에서 사라짐', finished && !disk.exists && !disk.inGitList, { finished, disk, notice })
    await dismissNotice()
  }
  // untracked
  {
    const wt = wtD('d-untracked')
    const d = await openDelete(wt)
    const r = await confirmDeleteAndWait(wt)
    const disk = diskState(del, wt, 'd-untracked')
    record({ case: 'untracked', target: wt, gateOwned: gateOwned(wt), dialog: d, result: r, disk })
    check('K7j-untracked', 'K7ⓙ untracked 만 → dirty 1 · 강제 · 삭제됨', d.decision === 'force' && d.dirty === '1' && r.done && !disk.exists && !disk.inGitList, { d: pick(d), r, disk })
    await dismissNotice()
  }
  // busy — 살아 있는 세션
  {
    const wt = wtD('d-busy')
    await clickSel(titleSel(wt))
    await waitFor(async () => (await rowOf(wt))?.openWorkspaceId != null, 'busy open', 30_000)
    await pause(800)
    const d = await openDelete(wt)
    const r = await confirmDeleteAndWait(wt)
    const disk = diskState(del, wt, 'd-busy')
    const rowAfter = await rowOf(wt)
    record({ case: 'busy', target: wt, gateOwned: gateOwned(wt), dialog: d, result: r, disk })
    check('K7j-busy', 'K7ⓙ busy(세션 살아 있음) → 세션 수 표시 · 강제 + 「세션 N개 종료」 경고 · 세션 닫고 삭제', d.decision === 'force' && Number(d.sessions) >= 1 && d.warning.some((w) => /세션/.test(w)) && r.done && !disk.exists && rowAfter === null, { d: pick(d), r, disk })
    await dismissNotice()
  }
  // locked — 강제 단추 없음 · CLI 도 같은 거절 · 반쯤 지워진 상태 없음
  {
    const wt = wtD('d-locked')
    const d = await openDelete(wt)
    // r2 R2B-10 — 막힘 대화 캡처(익명 격리 데이터) + 사유 문구 들여쓰기가 본문과 같은지(`.delete-blocked` 패딩).
    await shot('70-delete-blocked')
    const blockedLayout = await cdp.evaluate(() => {
      const left = (selector) => document.querySelector(selector)?.getBoundingClientRect().left ?? null
      const focused = document.activeElement
      return { desc: left('[data-delete-worktree-dialog] .modal-desc'), path: left('[data-delete-path]'), blocked: left('[data-delete-blocked]'), firstFocus: focused?.hasAttribute('data-delete-cancel') ? 'cancel' : (focused?.tagName ?? null), cancelLabel: document.querySelector('[data-delete-cancel]')?.textContent ?? null }
    })
    check('R2B-10-blocked-padding', 'r2 R2B-10 · R2B-01 막힘 대화 — 사유 문구가 본문과 같은 들여쓰기 · 첫 포커스 「닫기」', blockedLayout.blocked !== null && Math.abs(blockedLayout.blocked - blockedLayout.desc) <= 1 && blockedLayout.firstFocus === 'cancel' && blockedLayout.cancelLabel === '닫기', blockedLayout)
    // r2 R2B-01 — 포커스가 대화 밖(터미널 입력란이 있으면 그것, 없으면 body)에 있어도 Esc 가 대화를 닫고, 그 Esc 는 포커스 쪽·창 bubble 로 가지 않는다.
    const escTarget = await cdp.evaluate(() => {
      Reflect.set(window, '__l478esc', { focused: 0, bubbled: 0 })
      const terminal = document.querySelector('.xterm-helper-textarea')
      const target = terminal instanceof HTMLElement ? terminal : document.body
      if (terminal instanceof HTMLElement) terminal.focus()
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      const counts = Reflect.get(window, '__l478esc')
      target.addEventListener('keydown', (event) => { if (event.key === 'Escape') counts.focused++ })
      window.addEventListener('keydown', (event) => { if (event.key === 'Escape') counts.bubbled++ })
      return { target: terminal instanceof HTMLElement ? 'xterm-helper-textarea' : 'body', active: document.activeElement?.className ?? document.activeElement?.tagName ?? null }
    })
    await key('Escape')
    const escClosed = await tryWait(async () => (await snapshot()).deleteDialog === null, 'blocked dialog esc', 5000)
    const escCounts = await cdp.evaluate(() => Reflect.get(window, '__l478esc'))
    check('R2B-01-blocked-esc-outside-focus', 'r2 R2B-01 막힘 대화 — 포커스가 대화 밖(터미널/body)이어도 Esc 로 닫힘 · Esc 가 포커스 요소·창 bubble 로 새지 않음', escClosed && escCounts.focused === 0 && escCounts.bubbled === 0, { escTarget, escClosed, escCounts })
    if (!escClosed) await clickSel('[data-delete-cancel]')
    const cliRm = cli(del, 'worktree', 'rm', '--worktree', `path:${wt}`, '--force')
    const disk = diskState(del, wt, 'd-locked')
    record({ case: 'locked', target: wt, gateOwned: gateOwned(wt), dialog: d, cli: cliRm.error ?? cliRm, disk })
    check('K7e-locked', 'K7ⓔ 잠김 → 사유만, 삭제·강제 단추 없음 · CLI rm --force 도 locked_worktree 거절 · 디스크·git 목록 그대로', d.decision === 'blocked' && d.confirm === null && /잠/.test(d.blocked ?? '') && cliRm.ok === false && /locked/.test(JSON.stringify(cliRm.error ?? cliRm)) && disk.exists && disk.inGitList, { d: pick(d), cli: cliRm.error, disk })
  }
  // race — 대화를 연 뒤 git 이 잠금 → 확인 → 오류 알림, 반쯤 지워진 상태 없음
  {
    const wt = wtD('d-race')
    const d = await openDelete(wt)
    git(del, 'worktree', 'lock', wt)
    const r = await confirmDeleteAndWait(wt)
    const disk = diskState(del, wt, 'd-race')
    const row = await rowOf(wt)
    record({ case: 'race-locked', target: wt, gateOwned: gateOwned(wt), dialog: d, result: r, disk })
    check('K7e-race', 'K7ⓔ 대화 뒤 잠김 → 삭제 시 오류 알림 · 카드·디스크·git 목록·브랜치 그대로(반쯤 지운 상태 없음)', d.decision === 'delete' && /삭제하지 못했/.test(r.notice ?? '') && disk.exists && disk.inGitList && disk.branch === true && row !== null && !(await snapshot()).cards[wt]?.deleting, { r, disk })
    git(del, 'worktree', 'unlock', wt)
    await dismissNotice()
  }
  // parent with child — 자식 링크 해제
  {
    const parent = wtD('d-parent')
    const child = wtD('d-child')
    const set = cli(del, 'worktree', 'set', '--worktree', `path:${child}`, '--parent-worktree', `path:${parent}`)
    await rebuild()
    await tryWait(async () => (await snapshot()).cards[child]?.parentPath === parent, 'child chip', 10_000)
    const d = await openDelete(parent)
    const r = await confirmDeleteAndWait(parent)
    await rebuild()
    const childRow = await rowOf(child)
    const disk = diskState(del, parent, 'd-parent')
    record({ case: 'parent-with-child', target: parent, gateOwned: gateOwned(parent), dialog: d, result: r, disk, child: { parentPath: childRow?.parentPath ?? null } })
    check('K7j-children', 'K7ⓙ·K6ⓕ 자식 있음 → 대화에 하위 1개 · 삭제 뒤 자식 링크 풀림(카드 칩 없음·CLI show 부모 없음) · 자식은 남음', set.ok && d.children === '1' && r.done && !disk.exists && childRow !== null && childRow.parentPath === null && (await snapshot()).cards[child]?.parent === null && showMeta(del, child).parent === null, { d: pick(d), r, child: childRow?.parentPath })
    await dismissNotice()
  }
  // active — 같은 레포 최근 형제로 이동
  {
    const recent = wtD('d-recent')
    const wt = wtD('d-active')
    // 열기 직후 활성은 main 으로 간다(기존 경합 — race/) — 연 뒤 한 번 더 눌러 활성으로.
    for (const target of [recent, wt]) {
      await clickSel(titleSel(target))
      await waitFor(async () => (await rowOf(target))?.openWorkspaceId != null, `${path.basename(target)} open`, 30_000)
      await pause(800)
      await clickSel(titleSel(target))
      await waitFor(async () => (await snapshot()).cards[target]?.selected, `${path.basename(target)} selected`, 10_000)
      await pause(400)
    }
    await pause(600)
    const d = await openDelete(wt)
    const r = await confirmDeleteAndWait(wt)
    const moved = await tryWait(async () => (await activePath()) === recent, 'active moved', 10_000)
    const disk = diskState(del, wt, 'd-active')
    record({ case: 'active', target: wt, gateOwned: gateOwned(wt), dialog: d, result: r, disk, activeAfter: await activePath() })
    check('K7g-active-moves', 'K7ⓖ 활성 워크트리 삭제 → 같은 레포 최근 형제(d-recent)로 활성 이동', r.done && !disk.exists && moved, { activeAfter: await activePath(), r })
    await dismissNotice()
  }
  // K7ⓗ Option 휴지통 · ⌘⇧⌫ — d-pin 으로(대화만 열고 취소).
  {
    const wt = wtD('d-pin')
    await hover(cardSel(wt))
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 1 })
    await pause(200)
    const withAlt = await snapshot()
    const trashLinked = withAlt.cards[wt].trash
    const trashMain = withAlt.cards[del].trash
    const altState = await cdp.evaluate(() => ({ focus: document.activeElement?.tagName ?? null, trashes: document.querySelectorAll('[data-worktree-trash]').length }))
    let trashDialog = false
    if (trashLinked) {
      await clickSel(`[data-worktree="${wt}"] [data-worktree-trash]`)
      trashDialog = await tryWait(async () => (await snapshot()).deleteDialog?.path === wt, 'trash dialog', 5000)
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: 0 })
    if ((await snapshot()).deleteDialog !== null) await clickSel('[data-delete-cancel]')
    await settle()
    const trashGone = !(await snapshot()).cards[wt].trash
    // ⌘⇧⌫ — hover 카드 → 대화 · 주 체크아웃이면 무시 · 입력란 포커스면 무시. **터미널이 포커스여도 듣는다**(평상시 상태).
    await hover(cardSel(wt))
    const termFocused = await cdp.evaluate(() => {
      const el = document.querySelector('.xterm-helper-textarea')
      el?.focus()
      return document.activeElement?.classList.contains('xterm-helper-textarea') ?? false
    })
    await key('Backspace', 4 | 8)
    const shortcutDialog = await tryWait(async () => (await snapshot()).deleteDialog?.path === wt, 'shortcut dialog', 5000)
    // 대화가 열린 동안 다시 눌러도 그대로(대화 1개).
    await key('Backspace', 4 | 8)
    const stillOne = await cdp.evaluate(() => document.querySelectorAll('[data-delete-worktree-dialog]').length)
    if ((await snapshot()).deleteDialog !== null) await clickSel('[data-delete-cancel]')
    await hover(cardSel(del))
    await key('Backspace', 4 | 8)
    const mainIgnored = (await snapshot()).deleteDialog === null
    await dblclick(await pointOf(titleSel(wt)))
    await waitFor(async () => (await snapshot()).cards[wt].renaming, 'rename for shortcut', 5000)
    await hover(cardSel(wt))
    await cdp.evaluate((p2) => document.querySelector(`[data-inline-rename="${CSS.escape(p2)}"]`)?.focus(), wt)
    await key('Backspace', 4 | 8)
    const inputIgnored = (await snapshot()).deleteDialog === null
    await key('Escape')
    check('K7h-trash-shortcut', 'K7ⓗ Option+hover → 링크 카드 휴지통(주 체크아웃 없음) → 같은 대화 · Option 떼면 사라짐 · 터미널 포커스에서 ⌘⇧⌫ hover 카드 → 대화(1개), 주 체크아웃·입력 포커스면 무시', trashLinked && !trashMain && trashDialog && trashGone && termFocused && shortcutDialog && stillOne === 1 && mainIgnored && inputIgnored, { trashLinked, trashMain, altState, trashDialog, trashGone, termFocused, shortcutDialog, stillOne, mainIgnored, inputIgnored })
  }
  // K5ⓗ 고정한 워크트리를 지우면 핀도 정리 — d-pin 고정 후 삭제.
  {
    const wt = wtD('d-pin')
    await openCardMenu(wt)
    await menuClick('toggle-pin')
    const pinnedFirst = (await snapshot()).pinned?.worktrees.includes(wt)
    const d = await openDelete(wt)
    const r = await confirmDeleteAndWait(wt)
    await settle()
    const s = await snapshot()
    const disk = diskState(del, wt, 'd-pin')
    record({ case: 'pinned', target: wt, gateOwned: gateOwned(wt), dialog: d, result: r, disk })
    check('K5h-pin-ghost-delete', 'K5ⓗ 고정한 워크트리 삭제 → 고정 구획·prefs 에서 빠짐(유령 없음)', pinnedFirst && r.done && !(s.pinned?.worktrees ?? []).includes(wt) && !(readPrefs()?.pinnedWorktrees ?? []).includes(wt), { pinnedFirst, pinned: s.pinned, prefs: readPrefs()?.pinnedWorktrees })
    await dismissNotice()
  }
  // herdr 링크 끊김 — 삭제하지 않고 이유
  {
    const wt = wtD('d-nolink')
    await stopBackend()
    const down = await tryWait(async () => (await appState()).link?.phase !== 'live', 'link down', 30_000)
    const d = await openDelete(wt)
    await clickSel('[data-delete-cancel]')
    const disk = diskState(del, wt, 'd-nolink')
    record({ case: 'no-herdr-link', target: wt, gateOwned: gateOwned(wt), linkDown: down, dialog: d, disk })
    check('K7d-no-link', 'K7ⓓ herdr 링크 끊김 → 삭제 단추 없음 · 이유 표시 · 디스크 그대로', down && d.confirm === null && (d.blocked !== null || d.previewError !== null) && disk.exists && disk.inGitList, { down, d: pick(d), disk })
    await startBackend()
    const back = await tryWait(async () => (await appState()).link?.phase === 'live', 'link back', 60_000)
    if (!back) {
      await quit('relink')
      await launch('relink')
    }
    await rebuild()
  }

  // ── K5ⓗ 레포 제거 → 고정 유령 없음 (beta 의 b-one 이 고정돼 있다) ──
  {
    await hover(`[data-repo="${beta}"] [data-repo-head]`)
    await clickSel(`[data-repo-menu-toggle="${beta}"]`)
    await clickSel(`[data-repo-menu="${beta}"] [data-repo-menu-remove]`)
    await settle()
    await clickSel('[data-confirm-ok]')
    await tryWait(async () => !(await snapshot()).groups.some((g) => g.root === beta), 'beta removed', 15_000)
    const s = await snapshot()
    check('K5h-pin-ghost-repo', 'K5ⓗ 고정 카드의 레포를 목록에서 제거 → 고정 구획에 유령 없음', !(s.pinned?.worktrees ?? []).includes(wtB('b-one')) && s.cards[wtB('b-one')] === undefined, { pinned: s.pinned })
  }

  // ── K3ⓖ·K5ⓖ·K6 영속 — 재시작 ──
  // 상태를 하나 더: a-one 의 부모 = 주 체크아웃(K6), comment 는 이미 있음, a-three 고정.
  const setP = cli(alpha, 'worktree', 'set', '--worktree', `path:${wtA('a-one')}`, '--parent-worktree', `path:${alpha}`)
  await rebuild()
  const want = async () => {
    const s = await snapshot()
    return {
      a2Title: s.cards[wtA('a-two')]?.title,
      a1Note: s.cards[wtA('a-one')]?.note,
      a1Parent: s.cards[wtA('a-one')]?.parentPath,
      pinned: s.pinned?.worktrees ?? [],
      cards: Object.keys(s.cards).length,
    }
  }
  const before = await want()
  for (let index = 1; index <= restarts; index++) {
    await quit(`R${index}`)
    await launch(`R${index}`)
    await tryWait(async () => Object.keys((await snapshot()).cards).length === before.cards, 'restart rendered', 60_000)
    await settle()
    const after = await want()
    fs.writeFileSync(path.join(out, `prefs-restart-${index}.json`), JSON.stringify(readPrefs(), null, 2))
    check(`K3g-K5g-restart-${index}`, `K3ⓖ·K5ⓖ·K6 재시작 ${index}회차 — 표시 이름·comment·부모·고정 그대로`, setP.ok && same(after, before) && before.a2Title === 'blur 이름' && before.a1Note && before.a1Parent === alpha && same(before.pinned, [wtA('a-three')]), { before, after })
    await shot(`60-restart-${index}`)
  }

  // ── K9ⓕ 활성 없음 → 아무 일 없음 ──
  {
    // 준비 — 열린 워크스페이스를 herdr 백엔드에서 닫는다(링크 먼저, 주 체크아웃 나중 — herdr 부모 제약).
    const st = await appState()
    const open = st.repos.flatMap((repo) => repo.worktrees).filter((row) => row.openWorkspaceId !== null).sort((a, b) => Number(b.isLinked) - Number(a.isLinked))
    const closed = []
    for (const row of open) {
      const res = await rpc(env.CORRAL_BACKEND_SOCKET, { id: `l478-close-${Date.now()}-${Math.random()}`, method: 'workspace.close', params: { workspace_id: row.openWorkspaceId } })
      closed.push({ path: row.path, ok: res.error === undefined, error: res.error ?? null })
    }
    fs.writeFileSync(path.join(out, 'k9f-close.json'), JSON.stringify(closed, null, 2))
    await tryWait(async () => (await activePath()) === null, 'no active', 15_000)
    const s0 = await snapshot()
    await clickSel('[data-reveal-active]')
    await settle()
    const s1 = await snapshot()
    check('K9f-no-active', 'K9ⓕ 활성 없음 → Reveal 이 아무 일 없음(대화·번쩍·스크롤 없음)', (await activePath()) === null && s1.revealConfirm === null && Object.values(s1.cards).every((c) => !c.flash) && s1.scrollTop === s0.scrollTop, { active: await activePath() })
  }

  const clipRestored = restoreClipboard()
  check('os-clipboard-restored', '시스템 클립보드 원복(텍스트 해시 대조)', clipRestored === clipBefore, { before: clipBefore.slice(0, 12), after: clipRestored.slice(0, 12) })
  fs.writeFileSync(path.join(out, 'prefs-final.json'), JSON.stringify(readPrefs(), null, 2))
}

// --- 보조 ---------------------------------------------------------------------------------------------------
function pick(d) {
  if (d === null) return null
  return Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'text'))
}
function shapeOf(registry) {
  if (registry === null) return null
  const out2 = { version: registry.version, keys: Object.keys(registry).sort() }
  for (const [k, v] of Object.entries(registry)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out2[`${k}.fields`] = [...new Set(Object.values(v).flatMap((row) => (row !== null && typeof row === 'object' ? Object.keys(row) : [])))].sort()
    if (Array.isArray(v)) out2[`${k}.length`] = v.length
  }
  return out2
}
const META_FIELDS = new Set(['displayName', 'comment', 'parentWorktreeId', 'issue', 'linearIssue', 'workspaceStatus', 'createdBranch', 'createdAt', 'updatedAt', 'repoId', 'path', 'id', 'branch', 'baseBranch', 'agent', 'setup', 'lineage'])
function sameMetaFieldSets(registry) {
  // 새 칸이 없다 — 워크트리 메타 칸이 CLI 가 쓰는 알려진 칸 안에 있다(모르는 칸이 생기면 실패로 드러난다).
  const shape = shapeOf(registry)
  return Object.entries(shape).filter(([k]) => k.endsWith('.fields') && /worktree/i.test(k)).every(([, fields]) => fields.every((f) => META_FIELDS.has(f)))
}
async function openMenuSet(layout) {
  if (!(await cdp.evaluate(() => document.querySelector('[data-sidebar-options-menu]') !== null))) await clickSel('[data-sidebar-options]')
  await hover('[data-submenu-trigger="card-layout"]')
  await waitFor(async () => cdp.evaluate(() => document.querySelector('[data-options-submenu]')?.getAttribute('data-options-submenu') === 'card-layout'), 'layout submenu', 5000)
  await clickSel(`[data-options-radio="card-layout-${layout}"]`)
  await key('Escape')
  await settle()
}
async function setGroup(value) {
  await clickSel('[data-sidebar-options]')
  await clickSel(`[data-group-by="${value}"]`)
  await key('Escape')
  await settle()
}
async function setRepoFilter(roots) {
  // 470 필터 메뉴(옵션 ▸ 프로젝트)로 바꾼다 — 화면 상태와 prefs 가 같은 경로로 간다.
  await clickSel('[data-sidebar-options]')
  await hover('[data-submenu-trigger="projects"]')
  await waitFor(async () => cdp.evaluate(() => document.querySelector('[data-options-submenu]')?.getAttribute('data-options-submenu') === 'projects'), 'projects submenu', 5000)
  const all = await cdp.evaluate(() => [...document.querySelectorAll('[data-options-project]')].map((el) => ({ root: el.getAttribute('data-options-project'), on: el.getAttribute('aria-checked') === 'true' })))
  const want = new Set(roots)
  for (const row of all) {
    if (row.on !== want.has(row.root)) await clickSel(`[data-options-project="${row.root}"]`)
  }
  await key('Escape')
  await key('Escape')
  await settle()
}

let exitCode = 0
try {
  await Promise.race([main(), pause(Number(args.limitMs ?? 1_200_000)).then(() => Promise.reject(new Error('하네스 시간 상한 초과')))])
} catch (error) {
  exitCode = 2
  checks.push({ id: 'harness', criterion: '하네스 완주', pass: false, observed: String(error?.stack ?? error) })
  log('ERROR', error)
  if (cdp) await shot('zz-error').catch(() => {})
} finally {
  try {
    if (fs.existsSync(clipboardBackup)) restoreClipboard()
  } catch {
    // 원복 실패는 result 에 남는다(위 검사).
  }
  try {
    closeFinderWindowsUnder(realRepos())
  } catch {
    // fixture 가 없으면 열린 창도 없다.
  }
  await quit('final').catch(() => {})
  await stopBackend().catch(() => {})
  await pause(800)
  const alive = spawned.filter((row) => {
    if (!row.pid) return false
    try {
      process.kill(row.pid, 0)
      return true
    } catch {
      return false
    }
  })
  const failed = checks.filter((row) => !row.pass)
  if (exitCode === 0 && failed.length > 0) exitCode = 1
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ build, work, port, spawned, aliveAfterCleanup: alive, total: checks.length, failed: failed.map((row) => row.id), exitCode, checks }, null, 2))
  log(`checks ${checks.length - failed.length}/${checks.length} pass; alive after cleanup: ${JSON.stringify(alive)}`)
  process.exit(exitCode)
}
