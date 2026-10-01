// LIFE-470 격리 실행 — 검색 진입·Workspace options·정렬·그룹·필터(K1~K9) + 회귀 스모크(K12ⓑ 일부).
//
// 격리: 전용 work 폴더(--work, 기본 /tmp/l470i) 아래 userData·ui-prefs·herdr 세션·제어 소켓·fixture 레포. 사용자 기본 userData·
// herdr 기본 세션·설치본 Orca 는 건드리지 않는다. 입력은 **CDP Input**(이 인스턴스 디버깅 포트의 페이지에만 간다 — OS 커서·
// OS 키 입력이 아니다. ⌘J 도 CDP 키 이벤트라 사용자 앱으로 갈 길이 없다 — 468 r0 사건 경로가 아니다). OS 입력은 K11 네이티브에서.
//
// 사용: node app/scripts/l470/options-isolated.mjs --out <raw 폴더> [--work /tmp/l470i] [--port 9470] [--restarts 3]
// 결과: <out>/result.json · <out>/shots/*.png · <out>/prefs-*.json. 종료코드 0 = 전 검사 통과.
//
// 구성은 l469 `reorder-isolated.mjs` 의 기동·종료·드래그 도우미를 그대로 가져왔다(같은 검증된 경로).

/* global document, window, getComputedStyle -- CDP evaluate 로 페이지 안에서 도는 클로저가 쓴다 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, pickTarget, until, setViewport, assertPortFree, pause } from '../gui-diff/lib/cdp.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '../..')
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]?.startsWith('--') ? true : (all[index + 1] ?? true)]] : pairs), []),
)
const work = path.resolve(String(args.work ?? '/tmp/l470i'))
const out = path.resolve(String(args.out ?? 'l470-iso-out'))
const port = Number(args.port ?? 9470)
const restarts = Number(args.restarts ?? 3)
const shots = path.join(out, 'shots')
fs.mkdirSync(shots, { recursive: true })

const checks = []
const t0 = Date.now()
const log = (...parts) => console.log(`[l470 +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)
function check(id, criterion, pass, observed) {
  checks.push({ id, criterion, pass: pass === true, observed })
  log(pass ? 'PASS' : 'FAIL', id, criterion, JSON.stringify(observed).slice(0, 300))
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// --- fixture ------------------------------------------------------------------------------------------------
const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const reposDir = path.join(work, 'repos')
function makeRepo(name, linked) {
  const root = path.join(reposDir, name)
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, '-c', 'user.email=l470@example.invalid', '-c', 'user.name=l470', 'commit', '-q', '--allow-empty', '-m', 'init')
  for (const spec of linked) {
    const target = path.join(reposDir, `${name}-wt`, spec.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (spec.detached) git(root, 'worktree', 'add', '-q', '--detach', target)
    else git(root, 'worktree', 'add', '-q', '-b', spec.name, target)
  }
  return fs.realpathSync(root)
}

// --- 앱 기동·종료 (l469 와 같다) -------------------------------------------------------------------------------
const userData = path.join(work, 'corral-userdata')
const herdrHome = path.join(work, 'corral-herdr')
const prefsFile = path.join(work, 'ui-prefs.json')
const control = path.join(work, 'corral-control.sock')
const session = 'l470-iso'
const env = { ...process.env }
for (const key of ['CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'ELECTRON_RUN_AS_NODE']) delete env[key]
Object.assign(env, {
  CORRAL_USER_DATA: userData,
  CORRAL_UI_PREFS: prefsFile,
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

const viewport = { width: 1200, height: Number(args.height ?? 1000) }
async function launch(label) {
  await assertPortFree(port, 'corral l470')
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

// --- 관측 ---------------------------------------------------------------------------------------------------
const snapshot = () =>
  cdp.evaluate(() => {
    const list = document.querySelector('[data-repo-list]')
    const all = list.querySelector(':scope > [data-reorder-all]')
    const menu = document.querySelector('[data-sidebar-options-menu]')
    const badge = document.querySelector('[data-sidebar-options-badge]')
    return {
      title: document.querySelector('[data-sidebar-section-title]')?.textContent ?? null,
      badge: badge?.textContent ?? null,
      menuOpen: menu !== null,
      submenu: document.querySelector('[data-options-submenu]')?.getAttribute('data-options-submenu') ?? null,
      paletteOpen: document.querySelector('[data-command-palette]') !== null,
      searchIsInput: document.querySelector('[data-sidebar-search]')?.tagName === 'INPUT' || document.querySelector('.sidebar-search-input') !== null,
      groups: [...list.querySelectorAll(':scope > [data-repo]')].map((group) => ({
        root: group.getAttribute('data-repo'),
        worktrees: [...group.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
      })),
      all: all === null ? null : [...all.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
      allCount: all?.querySelector('[data-all-group-count]')?.textContent ?? null,
      titles: Object.fromEntries([...list.querySelectorAll('[data-worktree]')].map((row) => [row.getAttribute('data-worktree'), row.querySelector('[data-worktree-title]')?.textContent ?? ''])),
      selected: [...list.querySelectorAll('[data-worktree-card-active="primary"]')].map((el) => el.closest('[data-worktree]').getAttribute('data-worktree')),
      open: [...list.querySelectorAll('[data-chip-value="open"]')].map((el) => el.closest('[data-worktree]').getAttribute('data-worktree')),
      emptyFiltered: list.querySelector('[data-empty-filtered]') !== null,
      reordering: document.querySelector('.sidebar.is-reordering') !== null,
      active: document.activeElement?.getAttribute('data-options-radio') ?? document.activeElement?.getAttribute('data-submenu-trigger') ?? document.activeElement?.getAttribute('data-group-by') ?? document.activeElement?.getAttribute('data-options-filter') ?? (document.activeElement?.hasAttribute('data-sidebar-options') ? 'trigger' : (document.activeElement?.tagName ?? null)),
    }
  })
const flat = (snap) => (snap.all !== null ? snap.all : snap.groups.flatMap((group) => group.worktrees))
const readPrefs = () => (fs.existsSync(prefsFile) ? JSON.parse(fs.readFileSync(prefsFile, 'utf8')) : null)
const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}
const pointOf = (selector, fx = 0.5, fy = 0.5) =>
  cdp.evaluate(
    (s) => {
      const el = document.querySelector(s.selector)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width * s.fx, y: r.top + r.height * s.fy, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
    },
    { selector, fx, fy },
  )
const cardSel = (wt) => `[data-worktree="${wt}"] .worktree-name`

async function mouse(type, p, extra = {}) {
  const params = { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: extra.buttons ?? (type === 'mouseReleased' ? 0 : 1), clickCount: type === 'mouseMoved' ? 0 : 1, ...extra }
  return cdp.send('Input.dispatchMouseEvent', params)
}
async function click(p) {
  if (p === null) throw new Error('click: 좌표 없음')
  await mouse('mouseMoved', p, { buttons: 0 })
  await mouse('mousePressed', p)
  await mouse('mouseReleased', p)
  await pause(200)
}
const clickSel = async (selector) => click(await pointOf(selector))
async function hover(selector) {
  const p = await pointOf(selector)
  if (p === null) throw new Error(`hover: ${selector} 없음`)
  await mouse('mouseMoved', p, { buttons: 0 })
  await pause(150)
}
async function drag(start, end, { steps = 12, during = null } = {}) {
  await mouse('mouseMoved', start, { buttons: 0 })
  await mouse('mousePressed', start)
  for (let index = 1; index <= steps; index++) {
    await mouse('mouseMoved', { x: start.x + ((end.x - start.x) * index) / steps, y: start.y + ((end.y - start.y) * index) / steps })
    await pause(16)
  }
  const mid = during ? await during() : null
  await mouse('mouseReleased', end)
  await pause(250)
  return mid
}
const KEYS = {
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  j: { code: 'KeyJ', vk: 74 },
  b: { code: 'KeyB', vk: 66 },
  w: { code: 'KeyW', vk: 87 },
  k: { code: 'KeyK', vk: 75 },
}
/** CDP 키 입력 — 이 인스턴스 페이지에만 간다. `meta` = ⌘. */
async function key(name, { meta = false } = {}) {
  const spec = KEYS[name]
  const modifiers = meta ? 4 : 0
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers })
  if (spec.text && !meta) await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: name, text: spec.text, modifiers })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers })
  await pause(150)
}
const settle = () => pause(400)
async function rebuild() {
  await rpc(control, { cmd: 'rebuild-tree' }, 30_000)
  await pause(800)
}
async function waitFor(fn, label, timeout = 30_000) {
  return until(async () => ((await fn()) ? true : null), label, timeout, 250)
}

// 메뉴 조작 — 마우스(CDP) 경로.
async function openMenu() {
  const snap = await snapshot()
  if (!snap.menuOpen) await clickSel('[data-sidebar-options]')
  await waitFor(async () => (await snapshot()).menuOpen, 'menu open', 5000)
}
async function closeMenu() {
  if ((await snapshot()).menuOpen) await key('Escape')
  await waitFor(async () => !(await snapshot()).menuOpen, 'menu closed', 5000)
}
async function pickRadio(submenu, value) {
  await openMenu()
  await hover(`[data-submenu-trigger="${submenu}"]`)
  await waitFor(async () => (await snapshot()).submenu === submenu, `submenu ${submenu}`, 5000)
  await clickSel(`[data-options-radio="${submenu === 'sort' ? 'sort' : 'project-order'}-${value}"]`)
}
async function setSort(value) {
  await pickRadio('sort', value)
  await closeMenu()
  await settle()
}
async function setGroup(value) {
  await openMenu()
  await clickSel(`[data-group-by="${value}"]`)
  await closeMenu()
  await settle()
}
async function setFilter(id, on) {
  await openMenu()
  const current = await cdp.evaluate((s) => document.querySelector(`[data-options-filter="${s}"]`)?.getAttribute('aria-checked'), id)
  if ((current === 'true') !== on) await clickSel(`[data-options-filter="${id}"]`)
  await closeMenu()
  await settle()
}
async function setProjects(roots) {
  await openMenu()
  await hover('[data-submenu-trigger="projects"]')
  await waitFor(async () => (await snapshot()).submenu === 'projects', 'projects submenu', 5000)
  const checked = await cdp.evaluate(() => [...document.querySelectorAll('[data-options-project]')].filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.getAttribute('data-options-project')))
  for (const root of new Set([...checked, ...roots])) if (checked.includes(root) !== roots.includes(root)) await clickSel(`[data-options-project="${root}"]`)
  await closeMenu()
  await settle()
}

// --- 본 실행 ------------------------------------------------------------------------------------------------
async function main() {
  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(reposDir, { recursive: true })
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })

  const alpha = makeRepo('alpha', [{ name: 'a-one' }, { name: 'a-two' }, { name: 'a-three' }, { name: 'a-det', detached: true }])
  const beta = makeRepo('beta', [{ name: 'b-one' }, { name: 'b-two' }])
  const solo = makeRepo('solo', [])
  const realRepos = fs.realpathSync(reposDir)
  const wtA = (name) => path.join(realRepos, 'alpha-wt', name)
  const wtB = (name) => path.join(realRepos, 'beta-wt', name)

  // K9ⓑ — 469 출고 직후 모양 ui-prefs(사용자 파일 키 구성 raw/claude/k9b-user-ui-prefs-keys.md 와 같은 칸, 값은 지어낸 것).
  // 469 사용자가 손으로 정한 순서: beta → alpha → solo, alpha 안은 a-two → 주 → a-one → a-three → a-det.
  const manualRepos = [beta, alpha, solo]
  const manualAlpha = [wtA('a-two'), alpha, wtA('a-one'), wtA('a-three'), wtA('a-det')]
  const manualBeta = [beta, wtB('b-one'), wtB('b-two')]
  const legacy = {
    version: 1,
    sidebarWidth: 300,
    sidebarCollapsed: false,
    collapsedRepos: [],
    collapsedGroups: ['/x/old'],
    expandedAgentGroups: ['/x/exp'],
    tabOrdinals: [{ tabId: 'w9:t1', groupId: 'w9', ordinal: 3 }],
    groupLayouts: [{ worktree: '/x/wt', v: 1 }],
    manualRepoOrder: manualRepos,
    manualWorktreeOrder: { [alpha]: manualAlpha, [beta]: manualBeta, [solo]: [solo] },
  }
  fs.writeFileSync(prefsFile, JSON.stringify(legacy, null, 2) + '\n')
  fs.writeFileSync(path.join(out, 'prefs-legacy-469.json'), JSON.stringify(legacy, null, 2))

  await startBackend()
  await launch('L1')
  for (const root of [alpha, beta, solo]) {
    const res = await rpc(control, { cmd: 'add-repo', root })
    if (!res.ok) throw new Error(`add-repo ${root}: ${JSON.stringify(res)}`)
  }
  await waitFor(async () => {
    await rebuild()
    const snap = await snapshot()
    return snap.groups.length === 3 && snap.groups.find((g) => g.root === alpha)?.worktrees.length === 5 && snap.groups.find((g) => g.root === beta)?.worktrees.length === 3
  }, 'fixture rendered', 90_000)
  await settle()

  // ── K9ⓑ 첫 기동 = 469 화면 그대로 · K9ⓒ 기존 칸 보존 ──
  let snap = await snapshot()
  const manualFlat = [...manualBeta, ...manualAlpha, solo]
  check('K9b-first-order', 'K9ⓑ 470 이전 prefs 첫 기동 — 레포·카드 순서 = 469 수동 순서(Manual 기본)', same(snap.groups.map((g) => g.root), manualRepos) && same(flat(snap), manualFlat), { got: snap.groups })
  check('K9b-first-title', 'K9ⓑ 기본 그룹 = Project → 헤더 제목 「프로젝트」, 배지 없음', snap.title === '프로젝트' && snap.badge === null, { title: snap.title, badge: snap.badge })
  const firstPrefs = readPrefs()
  fs.writeFileSync(path.join(out, 'prefs-after-first-launch.json'), JSON.stringify(firstPrefs, null, 2))
  check('K9c-first-keep', 'K9ⓒ 첫 기동 뒤 기존 칸 보존(전 칸 값 대조)', Object.entries(legacy).every(([k, v]) => same(firstPrefs?.[k], v)), { keys: Object.keys(firstPrefs ?? {}) })
  await shot('00-first-launch')

  // ── K10ⓐⓑ 헤더 줄 · K1ⓓ 검색 줄 ──
  const header = await cdp.evaluate(() => {
    const head = document.querySelector('[data-repos-header]')
    const kids = [...head.querySelectorAll('button, [data-sidebar-section-title]')].map((el) => el.getAttribute('data-sidebar-section-title') !== null ? 'title' : el.hasAttribute('data-sidebar-options') ? 'options' : el.hasAttribute('data-add-repo') ? 'add' : el.textContent)
    const r = head.getBoundingClientRect()
    const glyphs = [...head.querySelectorAll('.repos-header-glyph')].map((el) => el.textContent.trim())
    const search = document.querySelector('[data-sidebar-search]')
    const sr = search.getBoundingClientRect()
    return { kids, height: r.height, top: r.top, glyphText: glyphs, searchTag: search.tagName, searchText: search.querySelector('.sidebar-search-label')?.textContent, searchBox: { top: sr.top, height: sr.height }, disabledInput: document.querySelector('.sidebar input[disabled]') !== null }
  })
  check('K10a-header', 'K10ⓐ 헤더 줄 = 제목 + 옵션 + `+` (h 32)', same(header.kids, ['title', 'options', 'add']) && header.height === 32, header)
  check('K10b-no-bell', 'K10ⓑ `◍`·`⇅` 자리 제거, 벨 없음', !header.glyphText.some((text) => text.includes('◍') || text.includes('⇅')), header.glyphText)
  check('K1d-no-input', 'K1ⓓ disabled 입력이 사라지고 Search 줄은 버튼', header.searchTag === 'BUTTON' && !header.disabledInput && header.searchText === '검색', header)

  // ── K1ⓐ Search 줄 클릭 → 팔레트 · hover 키캡 ──
  await hover('[data-sidebar-search]')
  const keycap = await cdp.evaluate(() => {
    const kbd = document.querySelector('[data-sidebar-search-keys]')
    return kbd === null ? null : { text: kbd.textContent, display: getComputedStyle(kbd).display }
  })
  check('K1a-hover-keys', 'K1ⓐ hover 때 ⌘J 키캡이 보인다', keycap?.text === '⌘J' && keycap.display !== 'none', keycap)
  await mouse('mouseMoved', { x: 900, y: 500 }, { buttons: 0 })
  await pause(100)
  const keycapAway = await cdp.evaluate(() => getComputedStyle(document.querySelector('[data-sidebar-search-keys]')).display)
  check('K1a-keys-hidden', 'K1ⓐ hover 아니면 키캡 숨김', keycapAway === 'none', keycapAway)
  await clickSel('[data-sidebar-search]')
  await waitFor(async () => (await snapshot()).paletteOpen, 'palette via search row', 5000).catch(() => null)
  check('K1a-click', 'K1ⓐ Search 줄 클릭 → 391 팔레트', (await snapshot()).paletteOpen, null)
  await shot('01-palette-from-search')
  await key('Escape')
  await waitFor(async () => !(await snapshot()).paletteOpen, 'palette closed', 5000)

  // ── K1ⓑ ⌘J · K1ⓒ ⌘K (CDP 키 이벤트 — 이 인스턴스에만) ──
  await key('j', { meta: true })
  await waitFor(async () => (await snapshot()).paletteOpen, 'palette via cmd+j', 5000).catch(() => null)
  check('K1b-cmd-j', 'K1ⓑ ⌘J → 같은 팔레트', (await snapshot()).paletteOpen, null)
  await key('Escape')
  await waitFor(async () => !(await snapshot()).paletteOpen, 'palette closed', 5000)
  await key('k', { meta: true })
  await waitFor(async () => (await snapshot()).paletteOpen, 'palette via cmd+k', 5000).catch(() => null)
  check('K1c-cmd-k', 'K1ⓒ ⌘K 그대로 팔레트', (await snapshot()).paletteOpen, null)
  await key('Escape')
  await waitFor(async () => !(await snapshot()).paletteOpen, 'palette closed', 5000)

  // ── K2ⓐ 메뉴 틀 · 구획 순서 ──
  await openMenu()
  const structure = await cdp.evaluate(() =>
    [...document.querySelectorAll('[data-sidebar-options-menu] [data-menu-level="main"] > *')].map((el) =>
      el.classList.contains('options-menu-title')
        ? `title:${el.textContent}`
        : el.classList.contains('options-menu-section-label')
          ? `label:${el.textContent}`
          : el.hasAttribute('data-submenu-trigger')
            ? `sub:${el.getAttribute('data-submenu-trigger')}`
            : el.hasAttribute('data-options-group-by')
              ? 'group-toggle'
              : el.hasAttribute('data-options-filter')
                ? `filter:${el.getAttribute('data-options-filter')}`
                : el.getAttribute('role') === 'separator'
                  ? 'sep'
                  : el.tagName,
    ),
  )
  const wantStructure = ['title:워크스페이스 옵션', 'label:표시', 'sub:projects', 'sep', 'label:그룹', 'group-toggle', 'sep', 'sub:sort', 'sub:project-order', 'sep', 'label:필터', 'filter:hide-default-branch', 'filter:hide-detached-head']
  check('K2a-structure', 'K2ⓐ 구획 순서 = 198(라벨·Show·Group by·Sort by·Project order·Filters)', same(structure, wantStructure), { got: structure })
  const menuBox = await cdp.evaluate(() => {
    const r = document.querySelector('[data-sidebar-options-menu]').getBoundingClientRect()
    const b = document.querySelector('[data-sidebar-options]').getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, right: r.right, bottom: r.bottom, buttonRight: b.right, buttonTop: b.top, innerWidth: window.innerWidth, innerHeight: window.innerHeight }
  })
  check('K2a-placement', 'K2ⓐ 버튼 오른쪽 8px·위 맞춤·폭 288', Math.abs(menuBox.left - (menuBox.buttonRight + 8)) < 1 && Math.abs(menuBox.top - menuBox.buttonTop) < 1 && menuBox.width === 288, menuBox)
  await shot('02-menu-open')

  // ── K2ⓑ 마우스 — 서브메뉴 hover 열림, 라디오 선택 뒤 메뉴 유지 ──
  await hover('[data-submenu-trigger="sort"]')
  await waitFor(async () => (await snapshot()).submenu === 'sort', 'sort submenu', 5000).catch(() => null)
  check('K2b-hover-sub', 'K2ⓑ 트리거 hover → 서브메뉴', (await snapshot()).submenu === 'sort', null)
  await shot('03-sort-submenu')
  await clickSel('[data-options-radio="sort-name"]')
  snap = await snapshot()
  check('K2b-radio-stays', 'K2ⓑ 라디오 선택 뒤 메뉴·서브메뉴 열린 채 + 값 반영', snap.menuOpen && snap.submenu === 'sort' && readPrefs()?.sidebarSortBy === 'name', { menuOpen: snap.menuOpen, submenu: snap.submenu, sortBy: readPrefs()?.sidebarSortBy })
  await hover('[data-options-filter="hide-detached-head"]')
  check('K2b-hover-other-closes-sub', 'K2ⓑ 다른 항목 hover → 서브메뉴 닫힘', (await snapshot()).submenu === null, null)
  // ── K2ⓒ 바깥 클릭으로 닫힘 ──
  await click({ x: 900, y: 600 })
  check('K2c-outside', 'K2ⓒ 바깥 클릭 → 닫힘', !(await snapshot()).menuOpen, null)

  // ── K2ⓑ 키보드 ──
  await cdp.evaluate(() => document.querySelector('[data-sidebar-options]').focus())
  await key('Enter')
  snap = await snapshot()
  check('K2b-kbd-open', 'K2ⓑ 버튼 Enter → 열림, 첫 항목 포커스', snap.menuOpen && snap.active === 'projects', { active: snap.active })
  await key('ArrowDown')
  check('K2b-kbd-down', 'K2ⓑ ↓ → 다음 항목(그룹 없음)', (await snapshot()).active === 'none', null)
  await key('ArrowDown')
  await key('ArrowDown')
  check('K2b-kbd-down2', 'K2ⓑ ↓↓ → 정렬 트리거', (await snapshot()).active === 'sort', null)
  await key('ArrowRight')
  snap = await snapshot()
  check('K2b-kbd-right', 'K2ⓑ → → 서브메뉴 열고 첫 라디오', snap.submenu === 'sort' && snap.active === 'sort-name', { submenu: snap.submenu, active: snap.active })
  await key('ArrowDown')
  await key('ArrowDown')
  await key('Enter')
  snap = await snapshot()
  check('K2b-kbd-enter', 'K2ⓑ Enter → 최근 선택, 메뉴 유지', readPrefs()?.sidebarSortBy === 'recent' && snap.menuOpen && snap.submenu === 'sort', { sortBy: readPrefs()?.sidebarSortBy })
  await key('ArrowLeft')
  snap = await snapshot()
  check('K2b-kbd-left', 'K2ⓑ ← → 서브메뉴 닫고 트리거로', snap.submenu === null && snap.active === 'sort', { submenu: snap.submenu, active: snap.active })
  await key('ArrowUp')
  await key('ArrowUp')
  await key('ArrowUp')
  await key('ArrowUp')
  check('K2b-kbd-wrap', 'K2ⓑ ↑ 끝에서 돈다(첫 항목에서 ↑ → 마지막 스위치)', (await snapshot()).active === 'hide-detached-head', (await snapshot()).active)
  // 서브메뉴를 키보드로 다시 열어 그 안에서 Esc — 메뉴 전체가 닫히고 버튼으로(Radix 와 같다).
  for (let i = 0; i < 4; i++) await key('ArrowDown') // 마지막 스위치 → 프로젝트 → 없음 → 프로젝트(그룹) → 정렬
  await key('ArrowRight')
  const inSub = await snapshot()
  check('K2b-kbd-reopen-sub', 'K2ⓑ 다시 → 로 정렬 서브메뉴, 포커스 서브메뉴 안', inSub.submenu === 'sort' && String(inSub.active).startsWith('sort-'), { submenu: inSub.submenu, active: inSub.active })
  await key('Escape')
  snap = await snapshot()
  check('K2b-kbd-esc', 'K2ⓑ Esc(서브메뉴 안) → 메뉴 전체 닫고 버튼으로 포커스', !snap.menuOpen && snap.submenu === null && snap.active === 'trigger', { active: snap.active })

  // ── K2ⓑ 혼합 입력(수정 라운드 1 R1-07) — 마우스 hover 로 연 서브메뉴에 키보드 → 로 들어간다 ──
  await openMenu()
  await hover('[data-submenu-trigger="sort"]')
  await waitFor(async () => (await snapshot()).submenu === 'sort', 'hover sort submenu', 5000)
  for (let i = 0; i < 8 && (await snapshot()).active !== 'sort'; i++) await key('ArrowDown')
  const mixedBefore = await snapshot()
  await key('ArrowRight')
  const mixedRight = await snapshot()
  await key('ArrowDown')
  const mixedDown = await snapshot()
  check('K2b-mixed-hover-right', 'K2ⓑ hover 로 열린 정렬 서브메뉴 → 키보드로 트리거 → → = 첫 라디오, ↓ = 서브메뉴 안 다음 라디오(R1-07)', mixedBefore.submenu === 'sort' && mixedBefore.active === 'sort' && mixedRight.active === 'sort-name' && mixedDown.active === 'sort-smart' && mixedDown.submenu === 'sort', {
    before: { submenu: mixedBefore.submenu, active: mixedBefore.active },
    right: mixedRight.active,
    down: mixedDown.active,
  })
  await closeMenu()

  // ── K2ⓒ 화면 밖으로 넘치지 않는다 — 낮은 창 ──
  await setViewport(cdp, { width: 900, height: 380 })
  await openMenu()
  await hover('[data-submenu-trigger="sort"]')
  await pause(200)
  const clamp = await cdp.evaluate(() => {
    const boxes = [...document.querySelectorAll('[data-sidebar-options-menu], [data-options-submenu]')].map((el) => el.getBoundingClientRect())
    return { boxes: boxes.map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })), h: window.innerHeight, w: window.innerWidth }
  })
  check('K2c-clamp', 'K2ⓒ 낮은 창에서도 메뉴·서브메뉴가 화면 안', clamp.boxes.every((r) => r.top >= 0 && r.bottom <= clamp.h && r.left >= 0 && r.right <= clamp.w), clamp)
  await shot('04-menu-clamped')
  await closeMenu()
  await setViewport(cdp, viewport)
  await settle()

  // ── K2ⓔ 폭 220(최소) ──
  const widthBefore = await cdp.evaluate(() => {
    const sidebar = document.querySelector('[data-sidebar]')
    const before = sidebar.style.width
    sidebar.style.width = '220px'
    return before
  })
  await pause(200)
  const narrow = await cdp.evaluate(() => {
    const side = document.querySelector('[data-sidebar]').getBoundingClientRect()
    const buttons = [...document.querySelectorAll('[data-repos-header] button')].map((el) => el.getBoundingClientRect())
    return { sideRight: side.right, buttonsRight: Math.max(...buttons.map((r) => r.right)), widths: buttons.map((r) => r.width) }
  })
  check('K2e-narrow', 'K2ⓔ 폭 220 에서 옵션·+ 버튼이 사이드바 안(오버플로 메뉴 불필요)', narrow.buttonsRight <= narrow.sideRight && narrow.widths.every((w) => w === 24), narrow)
  await openMenu()
  await shot('05-narrow-220-menu')
  await closeMenu()
  // 하네스가 건 폭을 원래 인라인 값으로 되돌린다(run7: 속성을 지워 이후 캡처의 사이드바가 좁게 찍혔다 — 하네스 결함).
  await cdp.evaluate((w) => {
    document.querySelector('[data-sidebar]').style.width = w
  }, widthBefore)
  await setSort('manual')

  // ── 에이전트 준비 — a-one working, a-three blocked(질문), b-one 열기만 ──
  for (const wt of [wtA('a-one'), wtA('a-three'), wtB('b-one')]) {
    await clickSel(cardSel(wt))
    await waitFor(async () => (await snapshot()).open.includes(wt), `open ${wt}`, 30_000)
  }
  const backendRpc = async (method, params = {}) => {
    const res = await rpc(env.CORRAL_BACKEND_SOCKET, { id: `l470-${Date.now()}`, method, params })
    if (res.error) throw new Error(`${method}: ${JSON.stringify(res.error)}`)
    return res.result
  }
  const paneOf = async (wt) => {
    const st = (await rpc(control, { cmd: 'state' })).state
    for (const repo of st.repos) for (const row of repo.worktrees) if (row.path === wt) return row.workspace?.tabs?.[0]?.panes?.[0]?.paneId ?? null
    return null
  }
  const report = async (wt, state) => {
    const paneId = await paneOf(wt)
    if (paneId) await backendRpc('pane.report_agent', { pane_id: paneId, source: 'l470', agent: 'claude', state, message: `l470 ${state}` })
    return paneId
  }
  await report(wtA('a-one'), 'working')
  await report(wtA('a-three'), 'blocked')
  await pause(1500)
  snap = await snapshot()
  check('K7e-manual-activity', 'K7ⓔ Manual 에서 열기·선택·에이전트 상태 변화가 순서를 안 바꾼다(#13847)', same(flat(snap), manualFlat), { got: flat(snap) })
  await shot('06-manual-with-agents')

  // ── K5ⓔ 모드 × 그룹 화면 순서 ──
  const labelOf = (s, wt) => s.titles[wt]
  const sortedByName = (s, list) => [...list].sort((a, b) => labelOf(s, a).localeCompare(labelOf(s, b)))
  const repoOfWt = (wt) => (wt === alpha || wt.startsWith(path.join(realRepos, 'alpha-wt')) ? 'alpha' : wt === beta || wt.startsWith(path.join(realRepos, 'beta-wt')) ? 'beta' : 'solo')
  const modeChecks = {
    name: (s) => (s.all !== null ? same(s.all, stableSort(s.all, s, (a, b) => labelOf(s, a).localeCompare(labelOf(s, b)))) : s.groups.every((g) => same(g.worktrees, stableSort(g.worktrees, s, (a, b) => labelOf(s, a).localeCompare(labelOf(s, b)))))),
    repo: (s) => (s.all !== null ? s.all.every((wt, i) => i === 0 || repoOfWt(s.all[i - 1]).localeCompare(repoOfWt(wt)) <= 0) : s.groups.every((g) => same(g.worktrees, stableSort(g.worktrees, s, (a, b) => labelOf(s, a).localeCompare(labelOf(s, b)))))),
    manual: (s) => (s.all !== null ? same(s.all, manualFlat) : same(flat(s), manualFlat)),
    // smart: blocked(a-three) → working(a-one) → 나머지(최근 시각 → 이름). 같은 구획 안에서.
    smart: (s) => {
      const list = s.all !== null ? s.all : (s.groups.find((g) => g.root === alpha)?.worktrees ?? [])
      return list[0] === wtA('a-three') && list[1] === wtA('a-one')
    },
    // recent: 열린 워크트리(시각 있음)가 닫힌 것보다 앞, 닫힌 것은 이름순.
    recent: (s) => {
      const lists = s.all !== null ? [s.all] : s.groups.map((g) => g.worktrees)
      return lists.every((list) => {
        const openIdx = list.map((wt, i) => (s.open.includes(wt) ? i : -1)).filter((i) => i >= 0)
        const closed = list.filter((wt) => !s.open.includes(wt))
        return openIdx.every((i) => i < list.length - closed.length) && same(closed, sortedByName(s, closed))
      })
    },
  }
  function stableSort(list, s, cmp) {
    return list.map((v, i) => [v, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map((p) => p[0])
  }
  for (const group of ['repo', 'none']) {
    await setGroup(group)
    for (const mode of ['name', 'smart', 'recent', 'repo', 'manual']) {
      await setSort(mode)
      await pause(3500) // 지연 모드는 3초 뒤 자리를 잡는다.
      snap = await snapshot()
      const ok = modeChecks[mode](snap)
      check(`K5e-${group}-${mode}`, `K5ⓔ Group ${group} · Sort ${mode} 화면 순서가 규칙대로`, ok && (group === 'none' ? snap.all !== null && snap.groups.length === 0 : snap.all === null), { all: snap.all, groups: snap.groups.map((g) => [g.root, g.worktrees.map((wt) => snap.titles[wt])]) })
      await shot(`10-${group}-${mode}`)
    }
  }
  // K4ⓓ 준비(수정 라운드 1 R1-09) — 비어 있지 않은 접힘 데이터로 본다: solo 를 접어 두고 그룹을 왕복한다.
  // (K5ⓔ 반복이 None 으로 끝나 레포 헤더가 없다 — run10 하네스 결함, Project 로 돌려 놓고 접는다.)
  await setGroup('repo')
  await clickSel(`[data-repo="${solo}"] [data-repo-head] .repo-row-name`)
  await waitFor(async () => same(readPrefs()?.collapsedRepos, [solo]), 'solo collapsed', 5000).catch(() => null)
  const collapsedBefore = readPrefs()?.collapsedRepos
  // K4ⓑ None 헤더·제목
  await setGroup('none')
  snap = await snapshot()
  check('K4b-none', 'K4ⓑ None = 「전체」 단일 구획(개수), 레포 헤더 없음, 제목 「워크스페이스」', snap.all !== null && snap.groups.length === 0 && snap.allCount === String(snap.all.length) && snap.title === '워크스페이스', { allCount: snap.allCount, title: snap.title })
  await openMenu()
  const noProjectOrder = await cdp.evaluate(() => document.querySelector('[data-submenu-trigger="project-order"]') === null)
  check('K6a-hidden-in-none', 'K6ⓐ None 일 때 Project order 구획 없음', noProjectOrder, null)
  await closeMenu()
  await setGroup('repo')
  snap = await snapshot()
  check('K4c-project', 'K4ⓒ Project = 레포 헤더 화면, 제목 「프로젝트」', snap.all === null && snap.groups.length === 3 && snap.title === '프로젝트', { title: snap.title })
  const collapsedAfter = { prefs: readPrefs()?.collapsedRepos, soloCards: (await snapshot()).groups.find((g) => g.root === solo)?.worktrees.length ?? null }
  check('K4d-collapse', 'K4ⓓ 그룹 전환(None→Project) 뒤 레포 접힘 상태 보존 — 접어 둔 solo 가 그대로 접힘(198 초기화와 의도적 차이 — 사유 RESULT)', same(collapsedBefore, [solo]) && same(collapsedAfter.prefs, [solo]) && collapsedAfter.soloCards === 0, { collapsedBefore, collapsedAfter })
  await clickSel(`[data-repo="${solo}"] [data-repo-head] .repo-row-name`)
  await waitFor(async () => same(readPrefs()?.collapsedRepos, []), 'solo expanded', 5000).catch(() => null)

  // ── K5ⓓ 재정렬 지연 3초 — alpha: a-three(대기, 클래스 1) 맨 위 · a-one(working, 3) 둘째. a-one 을 blocked 로 → 같은 클래스 1 에서
  // 더 늦은 시각이라 a-one 이 맨 위로 와야 한다(run6: idle 보고는 herdr 가 done 으로 바꿔 클래스 2 — 위에 남는다).
  await setSort('smart')
  await pause(3500)
  const beforeSettle = await snapshot()
  const alphaBefore = beforeSettle.groups.find((g) => g.root === alpha)?.worktrees
  await report(wtA('a-one'), 'blocked')
  await pause(1200)
  const during = await snapshot()
  const alphaDuring = during.groups.find((g) => g.root === alpha)?.worktrees
  await pause(3000)
  const after = await snapshot()
  const alphaAfter = after.groups.find((g) => g.root === alpha)?.worktrees
  check(
    'K5d-settle',
    'K5ⓓ Agent Activity — 상태가 바뀌어도 3초 동안 자리 유지, 그 뒤 재정렬',
    alphaBefore?.[0] === wtA('a-three') && same(alphaDuring, alphaBefore) && alphaAfter?.[0] === wtA('a-one'),
    { alphaBefore: alphaBefore?.map((wt) => after.titles[wt]), alphaDuring: alphaDuring?.map((wt) => after.titles[wt]), alphaAfter: alphaAfter?.map((wt) => after.titles[wt]) },
  )
  await report(wtA('a-one'), 'working')
  await pause(3500)

  // ── K6 Project order · 헤더 드래그 게이트 ──
  await setSort('manual')
  await pickRadio('project-order', 'recent')
  await closeMenu()
  await pause(3500)
  snap = await snapshot()
  const recentHeads = snap.groups.map((g) => g.root)
  check('K6b-recent', 'K6ⓑ Project order Recent — 활동 있는 레포(alpha·beta) 먼저, 활동 없는 solo 뒤', recentHeads.at(-1) === solo && recentHeads.slice(0, 2).sort().join() === [alpha, beta].sort().join(), recentHeads)
  const headP = await pointOf(`[data-repo-toggle="${recentHeads[0]}"] .repo-row-name`, 0.4)
  const lastP = await pointOf(`[data-repo="${solo}"]`, 0.5, 0.9)
  const mid = await drag(headP, { x: headP.x, y: lastP.y + 20 }, { during: async () => snapshot() })
  snap = await snapshot()
  check('K6c-gate-recent', 'K6ⓒ Project order Recent 에서 헤더 드래그 시작 안 됨', !mid.reordering && same(snap.groups.map((g) => g.root), recentHeads), { during: mid.reordering })
  await pickRadio('project-order', 'manual')
  await closeMenu()
  await settle()
  snap = await snapshot()
  check('K6b-manual', 'K6ⓑ Project order Manual = 469 manualRepoOrder', same(snap.groups.map((g) => g.root), manualRepos), snap.groups.map((g) => g.root))
  const headP2 = await pointOf(`[data-repo-toggle="${beta}"] .repo-row-name`, 0.4)
  const mid2 = await drag(headP2, { x: headP2.x, y: headP2.y + 8 }, { during: async () => snapshot() })
  check('K6c-gate-manual', 'K6ⓒ Project·Manual 에서는 헤더 드래그가 시작된다(469 그대로)', mid2.reordering === true, { during: mid2.reordering })
  await settle()
  check('K6c-manual-unchanged', 'K6ⓒ 제자리 드롭은 순서 무변경', same((await snapshot()).groups.map((g) => g.root), manualRepos), null)

  // ── K7ⓐⓑⓒ 비-manual 에서 끌면 Manual ──
  await setSort('name')
  snap = await snapshot()
  const alphaByName = snap.groups.find((g) => g.root === alpha).worktrees
  // R2-01 — 끌지 않은 레포의 이름순 화면. 그중 저장된 수동 순서와 다른 레포가 있어야 대조가 의미 있다(전제).
  const othersByName = snap.groups.filter((g) => g.root !== alpha).map((g) => ({ root: g.root, worktrees: g.worktrees }))
  const storedBeforeDrop = readPrefs()?.manualWorktreeOrder ?? {}
  const othersDiffering = othersByName.filter((g) => !same(g.worktrees, (storedBeforeDrop[g.root] ?? []).filter((wt) => g.worktrees.includes(wt)))).map((g) => g.root)
  // 제자리 드래그(조금 끌다 원위치) → 모드 그대로
  const firstCard = await pointOf(cardSel(alphaByName[0]), 0.3)
  await drag(firstCard, { x: firstCard.x, y: firstCard.y + 2 }, { steps: 4 })
  await drag(firstCard, { x: firstCard.x + 30, y: firstCard.y + 6 }, { steps: 6 })
  await settle()
  check('K7b-noop', 'K7ⓑ 순서가 안 바뀐 드래그는 모드를 안 바꾼다', readPrefs()?.sidebarSortBy === 'name' && same((await snapshot()).groups.find((g) => g.root === alpha).worktrees, alphaByName), { sortBy: readPrefs()?.sidebarSortBy })
  // 마지막 카드를 맨 위로
  const lastCard = await pointOf(cardSel(alphaByName.at(-1)), 0.3)
  const topCard = await pointOf(`[data-worktree="${alphaByName[0]}"]`, 0.3, 0.1)
  await drag(lastCard, { x: topCard.x, y: topCard.y + 1 })
  await settle()
  snap = await snapshot()
  const wantDropped = [alphaByName.at(-1), ...alphaByName.slice(0, -1)]
  check('K7a-switch', 'K7ⓐ Sort name 에서 순서를 바꾸면 Sort → Manual, 놓인 순서 그대로', readPrefs()?.sidebarSortBy === 'manual' && same(snap.groups.find((g) => g.root === alpha).worktrees, wantDropped), { sortBy: readPrefs()?.sidebarSortBy, got: snap.groups.find((g) => g.root === alpha).worktrees.map((wt) => snap.titles[wt]), want: wantDropped.map((wt) => snap.titles[wt]) })
  const othersAfter = othersByName.map((g) => ({ root: g.root, got: snap.groups.find((h) => h.root === g.root)?.worktrees ?? [], want: g.worktrees }))
  check(
    'K7a-others-kept',
    'K7ⓐ(R2-01) Manual 로 바뀐 드롭 뒤 끌지 않은 레포도 이름순 화면 그대로(2개 이상 레포 대조, 저장 순서와 다른 레포 1개 이상 전제)',
    othersByName.length >= 1 && othersDiffering.length >= 1 && othersAfter.every((g) => same(g.got, g.want)),
    { groups: othersAfter.map((g) => ({ root: path.basename(g.root), got: g.got.map((wt) => snap.titles[wt]), want: g.want.map((wt) => snap.titles[wt]) })), differingFromStored: othersDiffering.map((root) => path.basename(root)) },
  )
  await shot('20-dragged-to-manual')
  const manualAfterDrag = flat(snap)
  for (const mode of ['smart', 'recent', 'manual']) await setSort(mode)
  await pause(500)
  check('K7c-roundtrip', 'K7ⓒ 모드 왕복 뒤 Manual 로 오면 이전 수동 순서', same(flat(await snapshot()), manualAfterDrag), null)

  // ── K12ⓑ 회귀 스모크 (Manual · Project 화면) ──
  await setSort('manual')
  await setGroup('repo')
  // 사이드바 접기(⌘B, CDP 키) → 펼치기
  await key('b', { meta: true })
  const collapsedNow = await cdp.evaluate(() => document.querySelector('[data-sidebar]') === null)
  await key('b', { meta: true })
  await waitFor(async () => cdp.evaluate(() => document.querySelector('[data-sidebar]') !== null), 'sidebar back', 5000).catch(() => null)
  check('K12b-collapse', 'K12ⓑ 사이드바 접기·펼치기(⌘B)', collapsedNow && (await cdp.evaluate(() => document.querySelector('[data-sidebar]') !== null)), { collapsedNow })
  // 폭 조절
  const w0 = await cdp.evaluate(() => document.querySelector('[data-sidebar]').getBoundingClientRect().width)
  const handle = await pointOf('[data-sidebar-resizer]')
  await drag(handle, { x: handle.x + 40, y: handle.y }, { steps: 6 })
  const w1 = await cdp.evaluate(() => document.querySelector('[data-sidebar]').getBoundingClientRect().width)
  const handle2 = await pointOf('[data-sidebar-resizer]')
  await drag(handle2, { x: handle2.x - 40, y: handle2.y }, { steps: 6 })
  const w2 = await cdp.evaluate(() => document.querySelector('[data-sidebar]').getBoundingClientRect().width)
  check('K12b-resize', 'K12ⓑ 폭 조절(+40 → -40)', Math.abs(w1 - w0 - 40) <= 1 && Math.abs(w2 - w0) <= 1, { w0, w1, w2 })
  // 레포 접기 → 펼치기
  await clickSel(`[data-repo-toggle="${beta}"] .repo-row-name`)
  const betaCollapsed = (await snapshot()).groups.find((g) => g.root === beta)?.worktrees.length
  await clickSel(`[data-repo-toggle="${beta}"] .repo-row-name`)
  const betaOpen = (await snapshot()).groups.find((g) => g.root === beta)?.worktrees.length
  check('K12b-repo-collapse', 'K12ⓑ 레포 접기·펼치기', betaCollapsed === 0 && betaOpen === 3, { betaCollapsed, betaOpen })
  // 카드 선택
  await clickSel(cardSel(wtA('a-one')))
  await waitFor(async () => (await snapshot()).selected[0] === wtA('a-one'), 'a-one selected', 15_000).catch(() => null)
  check('K12b-select', 'K12ⓑ 카드 선택', (await snapshot()).selected[0] === wtA('a-one'), (await snapshot()).selected)
  // 세션 열기(카드 hover + → 빈 탭) / 닫기(⌘W)
  const tabsBefore = await cdp.evaluate(() => document.querySelectorAll('[data-main-tab]').length)
  await hover(cardSel(wtA('a-one')))
  await clickSel(`[data-worktree="${wtA('a-one')}"] [data-create-row]`)
  await waitFor(async () => (await cdp.evaluate(() => document.querySelectorAll('[data-main-tab]').length)) === tabsBefore + 1, 'tab +1', 15_000).catch(() => null)
  const tabsOpened = await cdp.evaluate(() => document.querySelectorAll('[data-main-tab]').length)
  // 새 탭에 codex 에이전트 보고 → 에이전트 2개 = 묶음 알약
  const st = (await rpc(control, { cmd: 'state' })).state
  const aOneRow = st.repos.flatMap((r) => r.worktrees).find((row) => row.path === wtA('a-one'))
  const newPane = aOneRow?.workspace?.tabs?.at(-1)?.panes?.[0]?.paneId
  if (newPane) await backendRpc('pane.report_agent', { pane_id: newPane, source: 'l470', agent: 'codex', state: 'idle', message: 'l470 second' })
  await waitFor(async () => (await pointOf(`[data-agent-group="${wtA('a-one')}"]`)) !== null, 'agent pill', 20_000).catch(() => null)
  const rowsCollapsed = await cdp.evaluate((wt) => document.querySelector(`[data-worktree="${wt}"]`).querySelectorAll('[data-agent-row]').length, wtA('a-one'))
  const pill = await pointOf(`[data-agent-group="${wtA('a-one')}"]`)
  if (pill) await click(pill)
  const rowsExpanded = await cdp.evaluate((wt) => document.querySelector(`[data-worktree="${wt}"]`).querySelectorAll('[data-agent-row]').length, wtA('a-one'))
  check('K12b-agent-group', 'K12ⓑ 에이전트 묶음 알약 펼침', pill !== null && rowsExpanded > rowsCollapsed, { rowsCollapsed, rowsExpanded })
  if (pill) await click(pill)
  await key('w', { meta: true })
  await waitFor(async () => (await cdp.evaluate(() => document.querySelectorAll('[data-main-tab]').length)) === tabsBefore, 'tab -1', 15_000).catch(() => null)
  const tabsClosed = await cdp.evaluate(() => document.querySelectorAll('[data-main-tab]').length)
  check('K12b-session', 'K12ⓑ 세션 열기(+)·닫기(⌘W)', tabsOpened === tabsBefore + 1 && tabsClosed === tabsBefore, { tabsBefore, tabsOpened, tabsClosed })
  // 레포 ⋯ · 워크트리 ⋯ 메뉴
  await hover(`[data-repo-toggle="${alpha}"] .repo-row-name`)
  await clickSel(`[data-repo="${alpha}"] [data-repo-menu-toggle]`)
  const repoMenu = await cdp.evaluate(() => document.querySelector('[data-repo-menu]') !== null)
  await click({ x: 900, y: 700 })
  await hover(cardSel(wtA('a-one')))
  await clickSel(`[data-worktree-menu-toggle="${wtA('a-one')}"]`)
  const wtMenu = await cdp.evaluate(() => document.querySelector('.worktree-menu, [data-worktree-menu]') !== null)
  await click({ x: 900, y: 700 })
  check('K12b-menus', 'K12ⓑ 레포·워크트리 ⋯ 메뉴 열림', repoMenu && wtMenu, { repoMenu, wtMenu })
  // + 생성(레포 헤더 +) 모달 열고 취소, 헤더 + (레포 등록) 모달 열고 닫기
  await hover(`[data-repo-toggle="${alpha}"] .repo-row-name`)
  await clickSel(`[data-repo="${alpha}"] [data-create-worktree]`)
  const createModal = await cdp.evaluate(() => document.querySelector('[data-create-worktree-modal]') !== null)
  if (createModal) await clickSel('[data-create-worktree-cancel]')
  await clickSel('[data-add-repo]')
  const addModal = await cdp.evaluate(() => document.querySelector('[data-add-repo-modal]') !== null)
  if (addModal) await clickSel('[data-modal-close]')
  check('K12b-create', 'K12ⓑ `+` 워크트리 생성 모달·레포 등록 모달', createModal && addModal, { createModal, addModal })
  // sticky — 낮은 창에서 목록을 내리면 alpha 헤더가 목록 윗변에 붙는다
  await setViewport(cdp, { width: 1200, height: 420 })
  await cdp.evaluate((root) => {
    const list = document.querySelector('[data-repo-list]')
    const group = document.querySelector(`[data-repo="${root}"]`)
    list.scrollTop = group.offsetTop + 60
  }, alpha)
  await pause(200)
  const sticky = await cdp.evaluate((root) => {
    const list = document.querySelector('[data-repo-list]').getBoundingClientRect()
    const head = document.querySelector(`[data-repo="${root}"] [data-repo-head]`).getBoundingClientRect()
    return { listTop: list.top, headTop: head.top }
  }, alpha)
  await cdp.evaluate(() => {
    document.querySelector('[data-repo-list]').scrollTop = 0
  })
  await setViewport(cdp, viewport)
  check('K12b-sticky', 'K12ⓑ 레포 헤더 sticky', Math.abs(sticky.headTop - sticky.listTop) <= 2, sticky)
  // 469 드래그(Manual) — 카드 하나를 같은 레포 맨 아래로 옮겼다 되돌린다
  snap = await snapshot()
  const alphaNow = snap.groups.find((g) => g.root === alpha).worktrees
  const firstP = await pointOf(cardSel(alphaNow[0]), 0.3)
  const lastBox = await pointOf(`[data-worktree="${alphaNow.at(-1)}"]`, 0.3, 0.95)
  await drag(firstP, { x: lastBox.x, y: lastBox.y })
  await settle()
  const moved = (await snapshot()).groups.find((g) => g.root === alpha).worktrees
  check('K12b-469-drag', 'K12ⓑ Manual 에서 469 카드 드래그(맨 아래로) — 모드 Manual 유지', same(moved, [...alphaNow.slice(1), alphaNow[0]]) && readPrefs()?.sidebarSortBy === 'manual', { moved: moved.map((wt) => snap.titles[wt]) })
  const backFrom = await pointOf(cardSel(alphaNow[0]), 0.3)
  const topBox = await pointOf(`[data-worktree="${moved[0]}"]`, 0.3, 0.1)
  await drag(backFrom, { x: topBox.x, y: topBox.y + 1 })
  await settle()
  check('K12b-469-drag-back', 'K12ⓑ 되돌리기', same((await snapshot()).groups.find((g) => g.root === alpha).worktrees, alphaNow), null)
  await shot('25-smoke-done')

  // ── K3 Show › Projects · K8 Filters · K2ⓓ 배지 · K2ⓕ 빈 상태 ──
  await setProjects([alpha])
  snap = await snapshot()
  check('K3b-filter', 'K3ⓑ Projects = alpha → alpha 만', same(snap.groups.map((g) => g.root), [alpha]) && snap.badge === '1', { groups: snap.groups.map((g) => g.root), badge: snap.badge })
  await openMenu()
  const trig1 = await cdp.evaluate(() => document.querySelector('[data-submenu-trigger="projects"] .options-menu-value')?.textContent)
  await closeMenu()
  await setProjects([alpha, beta])
  await openMenu()
  const trig2 = await cdp.evaluate(() => document.querySelector('[data-submenu-trigger="projects"] .options-menu-value')?.textContent)
  await closeMenu()
  await setProjects([])
  await openMenu()
  const trig0 = await cdp.evaluate(() => document.querySelector('[data-submenu-trigger="projects"] .options-menu-value')?.textContent)
  await closeMenu()
  check('K3c-trigger', 'K3ⓒ 트리거 값 = 전체/이름/N개', trig0 === '전체 프로젝트' && trig1 === 'alpha' && trig2 === '2개 프로젝트', { trig0, trig1, trig2 })
  // K8ⓓ — 숨길 워크트리(alpha 주 체크아웃)를 활성으로 만든 뒤 숨긴다.
  await clickSel(cardSel(alpha))
  await waitFor(async () => (await snapshot()).selected[0] === alpha, 'alpha main selected', 30_000).catch(() => null)
  await clickSel(cardSel(alpha))
  await waitFor(async () => (await snapshot()).selected[0] === alpha, 'alpha main selected', 15_000).catch(() => null)
  const activeBefore = await cdp.evaluate(() => ({ tabs: document.querySelectorAll('[data-main-tab]').length, panes: document.querySelectorAll('[data-pane-grid] .xterm').length }))
  await setFilter('hide-default-branch', true)
  snap = await snapshot()
  const activeAfter = await cdp.evaluate(() => ({ tabs: document.querySelectorAll('[data-main-tab]').length, panes: document.querySelectorAll('[data-pane-grid] .xterm').length }))
  check('K8a-hide-default', 'K8ⓐ Hide default branch — 주 체크아웃 카드 숨김 + 배지 1', ![alpha, beta, solo].some((root) => flat(snap).includes(root)) && snap.badge === '1', { flat: flat(snap), badge: snap.badge })
  check('K8d-active-hidden', 'K8ⓓ 숨겨진 워크트리가 활성이어도 탭·pane 유지(앱이 깨지지 않는다)', activeAfter.tabs === activeBefore.tabs && activeAfter.panes === activeBefore.panes && activeBefore.panes > 0, { activeBefore, activeAfter })
  await shot('30-hide-default')
  await setFilter('hide-detached-head', true)
  snap = await snapshot()
  check('K8b-hide-detached', 'K8ⓑⓒ Hide detached HEAD — a-det 숨김 + 배지 2', !flat(snap).includes(wtA('a-det')) && snap.badge === '2', { badge: snap.badge })
  // K8ⓔ — 레포 추가가 필터 값을 바꾸지 않는다(#20394).
  const gamma = makeRepo('gamma', [{ name: 'g-one' }])
  const filterBefore = JSON.stringify({ d: readPrefs()?.sidebarHideDefaultBranch, h: readPrefs()?.sidebarHideDetachedHead, r: readPrefs()?.sidebarRepoFilter })
  await rpc(control, { cmd: 'add-repo', root: gamma })
  await waitFor(async () => {
    await rebuild()
    return (await snapshot()).groups.some((g) => g.root === gamma)
  }, 'gamma rendered', 60_000)
  snap = await snapshot()
  const filterAfter = JSON.stringify({ d: readPrefs()?.sidebarHideDefaultBranch, h: readPrefs()?.sidebarHideDetachedHead, r: readPrefs()?.sidebarRepoFilter })
  check('K8e-add-repo', 'K8ⓔ 레포 추가 뒤 필터 값·화면 필터 그대로(새 레포 주 체크아웃도 숨김)', filterBefore === filterAfter && !flat(snap).includes(gamma) && snap.badge === '2', { filterBefore, filterAfter, badge: snap.badge })
  // K2ⓕ — 필터로 비면 빈 상태 + 필터 지우기
  await setProjects([solo])
  snap = await snapshot()
  check('K2f-empty', 'K2ⓕ 필터로 목록이 비면 빈 상태 문구 + 「필터 지우기」, 배지 3', snap.emptyFiltered && snap.badge === '3', { emptyFiltered: snap.emptyFiltered, badge: snap.badge })
  await shot('31-empty-filtered')
  await clickSel('[data-clear-filters]')
  await settle()
  snap = await snapshot()
  const cleared = readPrefs()
  check('K2f-clear', 'K2ⓕ 필터 지우기 → 전체 보임·배지 없음·필터 칸 기본값', !snap.emptyFiltered && snap.badge === null && cleared?.sidebarHideDefaultBranch === false && cleared?.sidebarHideDetachedHead === false && same(cleared?.sidebarRepoFilter, []), { badge: snap.badge })

  // ── K9ⓐ 재시작 보존 — 회차마다 다른 값 ──
  const plans = [
    { group: 'none', sort: 'smart', projectOrder: 'recent', projects: [alpha, beta], hideDefault: true, hideDetached: false },
    { group: 'repo', sort: 'recent', projectOrder: 'recent', projects: [beta], hideDefault: false, hideDetached: true },
    { group: 'repo', sort: 'name', projectOrder: 'manual', projects: [], hideDefault: true, hideDetached: true },
    { group: 'none', sort: 'repo', projectOrder: 'manual', projects: [alpha], hideDefault: false, hideDetached: false },
  ].slice(0, Math.max(3, restarts))
  for (const [index, plan] of plans.entries()) {
    await setGroup('repo')
    await pickRadio('project-order', plan.projectOrder)
    await closeMenu()
    await setGroup(plan.group)
    await setSort(plan.sort)
    await setProjects(plan.projects)
    await setFilter('hide-default-branch', plan.hideDefault)
    await setFilter('hide-detached-head', plan.hideDetached)
    await pause(3500)
    const beforeQuit = await snapshot()
    const prefsBefore = readPrefs()
    await quit(`R${index + 1}`)
    await launch(`R${index + 1}`)
    await waitFor(async () => {
      const s = await snapshot()
      return flat(s).length === flat(beforeQuit).length && s.title === beforeQuit.title
    }, 'relaunch rendered', 90_000).catch(() => null)
    await pause(3500)
    const afterLaunch = await snapshot()
    const prefsAfter = readPrefs()
    const want = { sidebarGroupBy: plan.group, sidebarSortBy: plan.sort, sidebarProjectOrderBy: plan.projectOrder, sidebarRepoFilter: plan.projects, sidebarHideDefaultBranch: plan.hideDefault, sidebarHideDetachedHead: plan.hideDetached }
    const prefsOk = Object.entries(want).every(([k, v]) => same(prefsAfter?.[k], v))
    check(`K9a-restart-${index + 1}`, `K9ⓐ 재시작 ${index + 1}회차 — 옵션 값·화면 순서·배지·제목 그대로`, prefsOk && same(flat(afterLaunch), flat(beforeQuit)) && afterLaunch.badge === beforeQuit.badge && afterLaunch.title === beforeQuit.title, {
      want,
      prefsBefore: Object.fromEntries(Object.keys(want).map((k) => [k, prefsBefore?.[k]])),
      prefsAfter: Object.fromEntries(Object.keys(want).map((k) => [k, prefsAfter?.[k]])),
      flatSame: same(flat(afterLaunch), flat(beforeQuit)),
      badge: [beforeQuit.badge, afterLaunch.badge],
    })
    await shot(`40-restart-${index + 1}`)
  }

  // ── K9ⓓ 손상된 새 칸 → 칸마다 기본값, 다른 칸 생존 ──
  await quit('pre-corrupt')
  // R1-06 준비 — 레포 40개를 더 등록해 둔다(Projects 목록이 창보다 길어지게). K3ⓐ 단계가 레지스트리를 beta 하나로 줄인다.
  const manyReg = JSON.parse(fs.readFileSync(env.CORRAL_REGISTRY, 'utf8'))
  for (let i = 0; i < 40; i++) {
    const root = makeRepo(`many-${String(i).padStart(2, '0')}`, [])
    const id = crypto.randomUUID()
    manyReg.repos.push({ id, path: root, name: path.basename(root), projectId: `repo:${id}`, baseRef: null, method: 'imported-existing-folder' })
  }
  fs.writeFileSync(env.CORRAL_REGISTRY, JSON.stringify(manyReg, null, 2) + '\n')
  const good = readPrefs()
  fs.writeFileSync(prefsFile, JSON.stringify({ ...good, sidebarGroupBy: 'status', sidebarSortBy: 7, sidebarProjectOrderBy: 'recent', sidebarRepoFilter: 'nope', sidebarHideDefaultBranch: 'yes', sidebarHideDetachedHead: true }, null, 2))
  await launch('corrupt')
  await waitFor(async () => (await snapshot()).groups.length > 0, 'corrupt rendered', 60_000).catch(() => null)
  await settle()
  snap = await snapshot()
  await openMenu()
  const menuVals = await cdp.evaluate(() => ({
    sort: document.querySelector('[data-submenu-trigger="sort"] .options-menu-value')?.textContent,
    projectOrder: document.querySelector('[data-submenu-trigger="project-order"] .options-menu-value')?.textContent,
    groupOn: document.querySelector('[data-group-by][aria-checked="true"]')?.getAttribute('data-group-by'),
    detached: document.querySelector('[data-options-filter="hide-detached-head"]')?.getAttribute('aria-checked'),
    hideDefault: document.querySelector('[data-options-filter="hide-default-branch"]')?.getAttribute('aria-checked'),
  }))
  await closeMenu()
  check('K9d-corrupt', 'K9ⓓ 손상 칸(그룹·정렬·필터 목록·스위치)은 칸마다 기본값, 성한 칸(Project order Recent·detached 숨김)과 469 칸은 산다(469 레포 순서는 그대로 앞에 — R1-06 준비로 등록한 레포 40개는 정규화가 뒤에 붙인다)', menuVals.groupOn === 'repo' && menuVals.sort === '수동' && menuVals.projectOrder === '최근' && menuVals.detached === 'true' && menuVals.hideDefault === 'false' && same(readPrefs()?.manualRepoOrder?.slice(0, good.manualRepoOrder.length), good.manualRepoOrder), { menuVals, repoOrderKept: same(readPrefs()?.manualRepoOrder?.slice(0, good.manualRepoOrder.length), good.manualRepoOrder), repoOrderLength: [good.manualRepoOrder.length, readPrefs()?.manualRepoOrder?.length], groups: snap.groups.length })
  await shot('50-corrupt-defaults')

  // ── K2ⓒ·K3 많은 레포 + 낮은 창(수정 라운드 1 R1-06) — Projects 목록이 화면 안에서 스크롤되고, 키보드·마우스로 끝 항목을 고른다 ──
  await waitFor(async () => (await snapshot()).groups.length >= 40, 'many repos rendered', 90_000).catch(() => null)
  await setViewport(cdp, { width: 1100, height: 500 })
  await settle()
  await openMenu()
  for (let i = 0; i < 4 && (await snapshot()).active !== 'projects'; i++) await key('ArrowDown')
  await key('ArrowRight')
  await waitFor(async () => (await snapshot()).submenu === 'projects', 'projects submenu', 5000)
  await key('ArrowUp') // 첫 항목(지우기 — 비활성이면 첫 레포)에서 ↑ = 마지막 레포
  await pause(200)
  const many = await cdp.evaluate(() => {
    const panel = document.querySelector('[data-options-submenu="projects"]')
    const main = document.querySelector('[data-sidebar-options-menu]')
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
    const items = [...panel.querySelectorAll('[data-options-project]')]
    const active = document.activeElement
    return {
      h: window.innerHeight,
      w: window.innerWidth,
      panel: box(panel),
      main: box(main),
      items: items.length,
      scrollable: panel.scrollHeight > panel.clientHeight,
      activeIsLast: active === items[items.length - 1],
      activeBox: active && typeof active.getBoundingClientRect === 'function' ? box(active) : null,
      lastRoot: items[items.length - 1]?.getAttribute('data-options-project') ?? null,
    }
  })
  const inView = (r) => r.top >= 0 && r.bottom <= many.h && r.left >= 0 && r.right <= many.w
  const activeShown = many.activeBox !== null && many.activeBox.top >= many.panel.top && many.activeBox.bottom <= many.panel.bottom
  check('K2c-many-projects-keyboard', 'K2ⓒ 레포 43개·높이 500: Projects 패널·메뉴가 화면 안, 패널 안 스크롤, ↑ 로 고른 마지막 레포가 패널 안에 보인다(R1-06)', inView(many.panel) && inView(many.main) && many.scrollable && many.activeIsLast && activeShown, many)
  await shot('51-many-projects-keyboard')
  await key('Enter')
  await pause(300)
  const pickedByKey = readPrefs()?.sidebarRepoFilter
  // 마우스 — 패널을 맨 위로 되돌린 뒤 휠로 맨 아래까지 굴려 마지막 레포를 누른다(화면 안 좌표로).
  await cdp.evaluate(() => { document.querySelector('[data-options-submenu="projects"]').scrollTop = 0 })
  const wheelAt = await cdp.evaluate(() => { const r = document.querySelector('[data-options-submenu="projects"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  await mouse('mouseWheel', wheelAt, { deltaX: 0, deltaY: 4000, button: 'none', buttons: 0, clickCount: 0 })
  await pause(300)
  const lastPoint = await cdp.evaluate(() => {
    const items = [...document.querySelectorAll('[data-options-project]')]
    const r = items[items.length - 1].getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, inView: r.bottom <= window.innerHeight }
  })
  await click(lastPoint)
  await pause(300)
  const pickedByMouse = readPrefs()?.sidebarRepoFilter
  check('K2c-many-projects-select', 'K2ⓒ 마지막 레포를 키보드 Enter 로 고르고(필터 1개), 굴린 뒤 마우스로 눌러 해제(필터 0개)', same(pickedByKey, [many.lastRoot]) && lastPoint.inView && same(pickedByMouse, []), { pickedByKey: pickedByKey?.length, pickedByMouse: pickedByMouse?.length, lastInView: lastPoint.inView })
  await closeMenu()
  await setViewport(cdp, viewport)
  await settle()

  // ── K3ⓐ 레포 1개면 Show 구획 없음 ──
  await quit('pre-single')
  const reg = JSON.parse(fs.readFileSync(env.CORRAL_REGISTRY, 'utf8'))
  reg.repos = reg.repos.filter((row) => fs.realpathSync(row.path) === beta)
  fs.writeFileSync(env.CORRAL_REGISTRY, JSON.stringify(reg, null, 2) + '\n')
  await launch('single')
  await waitFor(async () => (await snapshot()).groups.length === 1 || (await snapshot()).all !== null, 'single rendered', 60_000).catch(() => null)
  await openMenu()
  const showVisible = await cdp.evaluate(() => document.querySelector('[data-submenu-trigger="projects"]') !== null)
  await closeMenu()
  check('K3a-single-repo', 'K3ⓐ 레포 1개면 Show › Projects 구획 없음', !showVisible, null)
  const prefsSingle = readPrefs()
  check('K8e-remove-repo', 'K8ⓔ 레포 제거 뒤에도 필터 값 그대로(제거된 id 는 화면에서만 무시)', same(prefsSingle?.sidebarHideDetachedHead, true) && same(prefsSingle?.sidebarProjectOrderBy, 'recent'), { hideDetached: prefsSingle?.sidebarHideDetachedHead })
  fs.writeFileSync(path.join(out, 'prefs-final.json'), JSON.stringify(readPrefs(), null, 2))
}

let exitCode = 0
try {
  await Promise.race([main(), pause(Number(args.limitMs ?? 900_000)).then(() => Promise.reject(new Error('하네스 시간 상한 초과')))])
} catch (error) {
  exitCode = 2
  checks.push({ id: 'harness', criterion: '하네스 완주', pass: false, observed: String(error?.stack ?? error) })
  log('ERROR', error)
  if (cdp) await shot('zz-error').catch(() => {})
} finally {
  await quit('final').catch(() => {})
  if (backend?.pid) {
    try {
      process.kill(backend.pid, 'SIGTERM')
    } catch {
      // 이미 끝났다.
    }
  }
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
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ work, port, spawned, aliveAfterCleanup: alive, total: checks.length, failed: failed.map((row) => row.id), exitCode, checks }, null, 2))
  log(`checks ${checks.length - failed.length}/${checks.length} pass; alive after cleanup: ${JSON.stringify(alive)}`)
  process.exit(exitCode)
}
