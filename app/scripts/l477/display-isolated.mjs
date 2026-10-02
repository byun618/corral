// LIFE-477 격리 실행 — 카드 표시(Card layout · Show properties · Agent activity Full list) K1~K8.
//
// 격리: 전용 work 폴더(--work, 기본 /tmp/l477i) 아래 userData·ui-prefs·herdr 세션·제어 소켓·fixture 레포·**HOME**(transcript fixture).
// 사용자 기본 userData·herdr 기본 세션·설치본 Orca·사용자 HOME 의 세션 기록은 건드리지 않는다. 입력은 **CDP Input**(이 인스턴스
// 디버깅 포트의 페이지에만 간다 — OS 커서·OS 키 입력이 아니다). OS 입력은 K10 네이티브에서.
//
// Full list 2·3줄 재료(도구·마지막 말·모델)는 격리 HOME 에 둔 **transcript fixture**(claude·codex·grok 형식, 지어낸 글)를
// `pane.report_agent_session` 으로 붙여 채운다 — 상태 주입(`pane.report_agent`)만으로는 점만 생긴다(00-analysis U4).
//
// 사용: node app/scripts/l477/display-isolated.mjs --out <raw 폴더> [--work /tmp/l477i] [--port 9477] [--restarts 3]
// 결과: <out>/result.json · <out>/shots/*.png · <out>/prefs-*.json · <out>/heights.json. 종료코드 0 = 전 검사 통과.
// 기동·종료·CDP 도우미는 l470 `options-isolated.mjs` 와 같다(검증된 경로를 그대로 옮겼다).

/* global document, window, getComputedStyle -- CDP evaluate 로 페이지 안에서 도는 클로저가 쓴다 */
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
const work = path.resolve(String(args.work ?? '/tmp/l477i'))
const out = path.resolve(String(args.out ?? 'l477-iso-out'))
const port = Number(args.port ?? 9477)
const restarts = Number(args.restarts ?? 3)
const shots = path.join(out, 'shots')
fs.mkdirSync(shots, { recursive: true })

const checks = []
const t0 = Date.now()
const log = (...parts) => console.log(`[l477 +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)
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
  git(root, '-c', 'user.email=l477@example.invalid', '-c', 'user.name=l477', 'commit', '-q', '--allow-empty', '-m', 'init')
  for (const spec of linked) {
    const target = path.join(reposDir, `${name}-wt`, spec.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (spec.detached) git(root, 'worktree', 'add', '-q', '--detach', target)
    else git(root, 'worktree', 'add', '-q', '-b', spec.name, target)
    if (spec.dirty) fs.writeFileSync(path.join(target, 'l477-untracked.txt'), 'x\n')
  }
  return fs.realpathSync(root)
}

// transcript fixture — 지어낸 글만. 형식은 판독층 시험(`transcript-parse.test.ts`)·l366 하네스와 같다.
const home = path.join(work, 'home')
const SESSIONS = {
  claude: 'c4770000-0000-4000-8000-000000000001',
  codex: 'c4770000-0000-4000-8000-000000000002',
  grok: 'c4770000-0000-4000-8000-000000000003',
  claude2: 'c4770000-0000-4000-8000-000000000004',
}
const TEXT = {
  claudeTitle: 'Fixture claude task',
  claudeMsg: 'fixture claude last message',
  // 첫 발화는 판독층이 첫 글자를 대문자로 다듬는다(`cleanFirstPrompt`) — 기대값도 그 모양으로(run2).
  codexPrompt: 'Fixture codex prompt',
  codexMsg: 'fixture codex last message',
  grokPrompt: 'Fixture grok prompt',
  grokMsg: 'fixture grok last message',
}
function writeTranscripts() {
  const iso = (ms) => new Date(Date.now() - ms).toISOString()
  const claudeDir = path.join(home, '.claude', 'projects', 'l477-fixture')
  fs.mkdirSync(claudeDir, { recursive: true })
  const claudeLines = (id) => [
    { type: 'user', sessionId: id, timestamp: iso(120_000), message: { role: 'user', content: 'fixture claude prompt' } },
    { type: 'assistant', sessionId: id, timestamp: iso(90_000), message: { role: 'assistant', model: 'claude-fixture-1', content: [{ type: 'text', text: TEXT.claudeMsg }] } },
    { type: 'ai-title', sessionId: id, aiTitle: TEXT.claudeTitle, timestamp: iso(80_000) },
    { type: 'assistant', sessionId: id, timestamp: iso(60_000), message: { role: 'assistant', model: 'claude-fixture-1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: 'fixture tests' } }] } },
  ]
  fs.writeFileSync(path.join(claudeDir, `${SESSIONS.claude}.jsonl`), claudeLines(SESSIONS.claude).map((row) => JSON.stringify(row)).join('\n') + '\n')
  fs.writeFileSync(path.join(claudeDir, `${SESSIONS.claude2}.jsonl`), claudeLines(SESSIONS.claude2).slice(0, 3).map((row) => JSON.stringify(row)).join('\n') + '\n')
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '02')
  fs.mkdirSync(day, { recursive: true })
  const codex = [
    { timestamp: iso(120_000), type: 'session_meta', payload: { id: SESSIONS.codex, timestamp: iso(120_000), cwd: work } },
    { timestamp: iso(110_000), type: 'turn_context', payload: { model: 'codex-fixture-1' } },
    // 사람 발화는 `event_msg/user_message` 에만 있다(`parseCodexHead` 주석 — response_item/user 는 하네스 주입 자리).
    { timestamp: iso(100_000), type: 'event_msg', payload: { type: 'user_message', message: TEXT.codexPrompt } },
    { timestamp: iso(70_000), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: TEXT.codexMsg }] } },
  ]
  fs.writeFileSync(path.join(day, `rollout-2026-10-02T00-00-00-${SESSIONS.codex}.jsonl`), codex.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const grokDir = path.join(home, '.grok', 'sessions', encodeURIComponent(work), SESSIONS.grok)
  fs.mkdirSync(grokDir, { recursive: true })
  const grok = [
    { type: 'user', content: `<user_query>${TEXT.grokPrompt}</user_query>` },
    { type: 'assistant', content: TEXT.grokMsg, model_id: 'grok-fixture-1' },
  ]
  fs.writeFileSync(path.join(grokDir, 'chat_history.jsonl'), grok.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

// --- 앱 기동·종료 (l469 와 같다) -------------------------------------------------------------------------------
const userData = path.join(work, 'corral-userdata')
const herdrHome = path.join(work, 'corral-herdr')
const prefsFile = path.join(work, 'ui-prefs.json')
const control = path.join(work, 'corral-control.sock')
const session = 'l477-iso'
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
  await assertPortFree(port, 'corral l477')
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


// --- 관측 ---------------------------------------------------------------------------------------------------
const snapshot = () =>
  cdp.evaluate(() => {
    const list = document.querySelector('[data-repo-list]')
    const all = list.querySelector(':scope > [data-reorder-all]')
    const menu = document.querySelector('[data-sidebar-options-menu]')
    const cards = Object.fromEntries(
      [...list.querySelectorAll('[data-worktree]')].map((row) => {
        const surface = row.querySelector('[data-worktree-card-surface]')
        const cs = getComputedStyle(surface)
        return [
          row.getAttribute('data-worktree'),
          {
            layout: surface.getAttribute('data-card-layout'),
            height: surface.getBoundingClientRect().height,
            padTop: cs.paddingTop,
            padBottom: cs.paddingBottom,
            meta: row.querySelector('[data-worktree-card-meta-row]') !== null,
            branchInMeta: row.querySelector('[data-worktree-meta-branch]')?.textContent ?? null,
            primaryBadge: row.querySelector('[data-worktree-primary-badge]') !== null,
            star: row.querySelector('[data-worktree-primary-star]') !== null,
            repoChip: row.querySelector('[data-worktree-repo-chip]')?.textContent ?? null,
            mark: row.querySelector('.worktree-mark')?.textContent ?? null,
            statusSlot: row.querySelector('.worktree-status-slot') !== null,
            hoverTrigger: row.querySelector('[data-hover-card-trigger]') !== null,
            compactList: row.querySelector('[data-compact-agent-list]') !== null,
            fullList: row.querySelector('[data-full-agent-list]') !== null,
            pill: row.querySelector('[data-agent-group]') !== null,
            rows: row.querySelectorAll('[data-agent-row]').length,
            fullRows: row.querySelectorAll('[data-agent-full-row]').length,
          },
        ]
      }),
    )
    return {
      badge: document.querySelector('[data-sidebar-options-badge]')?.textContent ?? null,
      menuOpen: menu !== null,
      submenu: document.querySelector('[data-options-submenu]')?.getAttribute('data-options-submenu') ?? null,
      groups: [...list.querySelectorAll(':scope > [data-repo]')].map((group) => ({
        root: group.getAttribute('data-repo'),
        worktrees: [...group.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
      })),
      all: all === null ? null : [...all.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
      cards,
      hoverCard: (() => {
        const el = document.querySelector('[data-hover-card]')
        if (el === null) return null
        const r = el.getBoundingClientRect()
        return {
          for: el.getAttribute('data-hover-card'),
          text: el.textContent,
          branch: el.querySelector('.hover-card-branch')?.textContent ?? null,
          git: el.querySelector('[data-hover-git]')?.textContent ?? null,
          rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width },
          visibility: getComputedStyle(el).visibility,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }
      })(),
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      reordering: document.querySelector('.sidebar.is-reordering') !== null,
      active:
        document.activeElement?.getAttribute('data-options-radio') ??
        document.activeElement?.getAttribute('data-options-property') ??
        document.activeElement?.getAttribute('data-submenu-trigger') ??
        (document.activeElement?.hasAttribute('data-sidebar-options') ? 'trigger' : (document.activeElement?.tagName ?? null)),
    }
  })
const flat = (snap) => (snap.all !== null ? snap.all : snap.groups.flatMap((group) => group.worktrees))
const arrangement = (snap) => ({ groups: snap.groups.map((g) => g.root), all: snap.all, order: flat(snap) })

// 메뉴 조작 — 마우스(CDP) 경로.
async function openMenu() {
  if (!(await snapshot()).menuOpen) await clickSel('[data-sidebar-options]')
  await waitFor(async () => (await snapshot()).menuOpen, 'menu open', 5000)
}
async function closeMenu() {
  if ((await snapshot()).menuOpen) await key('Escape')
  await waitFor(async () => !(await snapshot()).menuOpen, 'menu closed', 5000)
}
async function openSub(id) {
  await openMenu()
  await hover(`[data-submenu-trigger="${id}"]`)
  await waitFor(async () => (await snapshot()).submenu === id, `submenu ${id}`, 5000)
}
async function setLayout(value) {
  await openSub('card-layout')
  await clickSel(`[data-options-radio="card-layout-${value}"]`)
  await closeMenu()
  await settle()
}
async function setAgentLayout(value) {
  await openSub('card-properties')
  await clickSel(`[data-options-radio="agent-layout-${value}"]`)
  await closeMenu()
  await settle()
}
async function setAgentActivity(on) {
  await openSub('card-properties')
  const current = await cdp.evaluate(() => document.querySelector('[data-options-property="inline-agents"]')?.getAttribute('aria-checked'))
  if ((current === 'true') !== on) await clickSel('[data-options-property="inline-agents"]')
  await closeMenu()
  await settle()
}
async function setGroup(value) {
  await openMenu()
  await clickSel(`[data-group-by="${value}"]`)
  await closeMenu()
  await settle()
}
const triggerValue = (id) => cdp.evaluate((s) => document.querySelector(`[data-submenu-trigger="${s}"] .options-menu-value`)?.textContent ?? null, id)
const displayPrefs = () => {
  const prefs = readPrefs()
  return { layout: prefs?.sidebarCardLayout, props: prefs?.sidebarCardProperties, agentLayout: prefs?.sidebarAgentActivityLayout }
}

// --- 본 실행 ------------------------------------------------------------------------------------------------
async function main() {
  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true, mode: 0o700 })
  fs.chmodSync(work, 0o700) // 제어·런타임 소켓의 부모 — 「Socket and parent must be private」 로 재기동 open 이 깨진 회차가 있다(run2)
  fs.mkdirSync(reposDir, { recursive: true })
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  env.HOME = home
  writeTranscripts()

  const alpha = makeRepo('alpha', [{ name: 'a-one' }, { name: 'a-dirty', dirty: true }, { name: 'a-det', detached: true }])
  const others = ['beta', 'gamma', 'delta', 'eps', 'zeta'].map((name) => makeRepo(name, [{ name: `${name[0]}-one` }]))
  const [beta, gamma] = others
  const repos = [alpha, ...others]
  const realRepos = fs.realpathSync(reposDir)
  const wtA = (name) => path.join(realRepos, 'alpha-wt', name)
  const cardCount = 4 + others.length * 2

  // K7ⓑ — 470 출고 직후 모양 ui-prefs(사용자 파일 키 구성 raw/claude/k7b-user-ui-prefs-keys.md 17칸, 값은 지어낸 것).
  const legacy = {
    version: 1,
    sidebarWidth: 300,
    sidebarCollapsed: false,
    collapsedRepos: [],
    collapsedGroups: ['/x/old'],
    expandedAgentGroups: ['/x/exp'],
    tabOrdinals: [{ tabId: 'w9:t1', groupId: 'w9', ordinal: 3 }],
    groupLayouts: [{ worktree: '/x/wt', v: 1 }],
    manualRepoOrder: repos,
    // 469 정규화가 첫 기동에 채우는 값과 같게(주 체크아웃 → 이름순) — 빈 값이면 앱이 채워 「기존 칸 보존」 대조가 하네스 탓으로 깨진다(run1).
    manualWorktreeOrder: Object.fromEntries(
      [alpha, ...others].map((root) => [root, root === alpha ? [alpha, wtA('a-det'), wtA('a-dirty'), wtA('a-one')] : [root, path.join(realRepos, `${path.basename(root)}-wt`, `${path.basename(root)[0]}-one`)]]),
    ),
    manualFlatOrder: [],
    sidebarGroupBy: 'repo',
    sidebarSortBy: 'manual',
    sidebarProjectOrderBy: 'manual',
    sidebarRepoFilter: [],
    sidebarHideDefaultBranch: false,
    sidebarHideDetachedHead: false,
  }
  fs.writeFileSync(prefsFile, JSON.stringify(legacy, null, 2) + '\n')
  fs.writeFileSync(path.join(out, 'prefs-legacy-470.json'), JSON.stringify(legacy, null, 2))

  await startBackend()
  await launch('L1')
  for (const root of repos) {
    const res = await rpc(control, { cmd: 'add-repo', root })
    if (!res.ok) throw new Error(`add-repo ${root}: ${JSON.stringify(res)}`)
  }
  await waitFor(async () => {
    await rebuild()
    return Object.keys((await snapshot()).cards).length === cardCount
  }, 'fixture rendered', 90_000)
  await settle()

  // ── K7ⓑ 첫 기동 = 기본값(Detailed · 에이전트 활동 켬 · Compact 에이전트) · K7ⓒ 기존 칸 보존 ──
  let snap = await snapshot()
  const layouts = new Set(Object.values(snap.cards).map((card) => card.layout))
  check('K7b-first-default', 'K7ⓑ 477 이전 prefs 첫 기동 — 전 카드 Detailed·메타 줄·「기본」 칩(지금 화면)', same([...layouts], ['detailed']) && snap.cards[alpha].meta && snap.cards[alpha].primaryBadge && !snap.cards[alpha].star, { layouts: [...layouts], alpha: snap.cards[alpha] })
  const firstPrefs = readPrefs()
  fs.writeFileSync(path.join(out, 'prefs-after-first-launch.json'), JSON.stringify(firstPrefs, null, 2))
  check('K7c-first-keep', 'K7ⓒ 첫 기동 뒤 기존 칸 보존(전 칸 값 대조)', Object.entries(legacy).every(([k, v]) => same(firstPrefs?.[k], v)), { keys: Object.keys(firstPrefs ?? {}) })
  await openMenu()
  check('K7b-first-menu', 'K7ⓑ 첫 기동 메뉴 값 = 자세히 · 표시 속성 1', (await triggerValue('card-layout')) === '자세히' && (await triggerValue('card-properties')) === '1', { layout: await triggerValue('card-layout'), props: await triggerValue('card-properties') })
  await closeMenu()
  await shot('00-first-launch')

  // ── 에이전트 준비 — alpha 주 체크아웃 = claude(working, 도구) · codex(working) · grok(idle), beta 주 = claude(idle) ──
  const openWorkspace = async (wt) => {
    await clickSel(`[data-worktree="${wt}"] .worktree-name`)
    await waitFor(async () => (await rpc(control, { cmd: 'state' })).state.repos.flatMap((r) => r.worktrees).find((w) => w.path === wt)?.openWorkspaceId != null, `workspace ${wt}`, 30_000)
    return (await rpc(control, { cmd: 'state' })).state.repos.flatMap((r) => r.worktrees).find((w) => w.path === wt).openWorkspaceId
  }
  const backendRpc = async (method, params = {}) => {
    const response = await rpc(env.CORRAL_BACKEND_SOCKET, { id: `l477-${Date.now()}-${Math.random()}`, method, params })
    if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`)
    return response.result
  }
  const attachAgent = async ({ workspaceId, agent, state, sessionId }) => {
    const created = await backendRpc('tab.create', { workspace_id: workspaceId })
    const tabId = created?.tab?.tab_id
    const snapshotTabs = await backendRpc('session.snapshot')
    const paneId = (snapshotTabs?.snapshot?.panes ?? []).find((pane) => pane.tab_id === tabId)?.pane_id
    if (!paneId) throw new Error(`no pane for tab ${tabId}`)
    await backendRpc('pane.report_agent', { pane_id: paneId, source: 'l477-harness', agent, state, seq: Date.now() })
    await backendRpc('pane.report_agent_session', { pane_id: paneId, source: `herdr:${agent}`, agent, seq: Date.now(), agent_session_id: sessionId })
    return paneId
  }
  const wsAlpha = await openWorkspace(alpha)
  const panes = {
    claude: await attachAgent({ workspaceId: wsAlpha, agent: 'claude', state: 'working', sessionId: SESSIONS.claude }),
    codex: await attachAgent({ workspaceId: wsAlpha, agent: 'codex', state: 'working', sessionId: SESSIONS.codex }),
    grok: await attachAgent({ workspaceId: wsAlpha, agent: 'grok', state: 'idle', sessionId: SESSIONS.grok }),
  }
  const wsBeta = await openWorkspace(beta)
  panes.claude2 = await attachAgent({ workspaceId: wsBeta, agent: 'claude', state: 'idle', sessionId: SESSIONS.claude2 })
  await rpc(control, { cmd: 'resync', reason: 'l477-agents' }, 20_000)
  log('agents', panes)
  // 재료가 화면에 오기까지(판독 폴링 1.5s) — Full list 에서 세 provider 의 3줄 글이 다 서야 한다.
  await setAgentLayout('full')
  const fullReady = await waitFor(
    async () =>
      cdp.evaluate((want) => {
        const texts = [...document.querySelectorAll('[data-agent-full-row] .agent-full-message-text')].map((el) => el.textContent)
        return want.every((text) => texts.includes(text))
      }, [TEXT.claudeMsg, TEXT.codexMsg, TEXT.grokMsg]),
    'full list digests',
    60_000,
  )
    .then(() => true)
    .catch(() => false)

  // ── K6 Full list — 루트마다 3줄 행, 알약 없음, 2줄 provider 규칙, 3줄 메시지 ──
  const fullRows = await cdp.evaluate((paneIds) => {
    const rowOf = (paneId) => document.querySelector(`[data-agent-full-row][data-pane="${paneId}"]`)
    return Object.fromEntries(
      Object.entries(paneIds).map(([name, paneId]) => {
        const row = rowOf(paneId)
        if (row === null) return [name, null]
        const lines = [...row.children].map((el) => {
          const r = el.getBoundingClientRect()
          return { cls: el.className, height: Math.round(r.height * 100) / 100, top: Math.round(r.top * 100) / 100 }
        })
        const rr = row.getBoundingClientRect()
        const cs = getComputedStyle(row)
        return [
          name,
          {
            label: row.querySelector('[data-agent-full-label]')?.textContent ?? null,
            model: row.querySelector('.agent-row-model')?.textContent ?? null,
            time: row.querySelector('.agent-full-time')?.textContent ?? null,
            icon: row.querySelector('[data-agent-kind]')?.getAttribute('data-agent-kind') ?? null,
            toolSlot: row.querySelector('[data-agent-row-tool-slot]') !== null,
            toolHeader: row.querySelector('[data-agent-row-tool-header]')?.textContent ?? null,
            toolPlaceholder: row.querySelector('[data-agent-row-tool-placeholder]') !== null,
            message: row.querySelector('.agent-full-message-text')?.textContent ?? null,
            emptyMessage: row.querySelector('[data-agent-row-message="empty"]') !== null,
            height: Math.round(rr.height * 100) / 100,
            padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
            lines,
          },
        ]
      }),
    )
  }, panes)
  fs.writeFileSync(path.join(out, 'full-rows.json'), JSON.stringify({ fullReady, fullRows }, null, 2))
  snap = await snapshot()
  check('K6a-full-rows', 'K6ⓐ Full list — alpha 주 카드에 루트 3개 = 3줄 행 3개, 묶음 알약 없음(펼침 영속 없이)', snap.cards[alpha].fullRows === 3 && !snap.cards[alpha].pill && snap.cards[alpha].fullList && !snap.cards[alpha].compactList, snap.cards[alpha])
  check('K6c-claude-tool', 'K6ⓒ claude working + 도구 → 2줄 렌치·Bash·입력', fullReady && /Bash/.test(fullRows.claude?.toolHeader ?? '') && fullRows.claude?.toolPlaceholder === false, fullRows.claude)
  check('K6c-codex-placeholder', 'K6ⓒ codex working(도구 구조적 null) → 2줄 자리만', fullRows.codex?.toolSlot === true && fullRows.codex?.toolPlaceholder === true && fullRows.codex?.toolHeader === null, fullRows.codex)
  check('K6c-grok-none', 'K6ⓒ grok idle → 2줄 없음', fullRows.grok?.toolSlot === false, fullRows.grok)
  check('K6d-messages', 'K6ⓓ 3줄 = 각 provider 의 마지막 어시스턴트 메시지', fullRows.claude?.message === TEXT.claudeMsg && fullRows.codex?.message === TEXT.codexMsg && fullRows.grok?.message === TEXT.grokMsg, { claude: fullRows.claude?.message, codex: fullRows.codex?.message, grok: fullRows.grok?.message })
  check('K6b-line1', 'K6ⓑ 1줄 = 라벨(claude ai-title·codex/grok 첫 발화)·모델·「…전」 시간·아이콘', fullRows.claude?.label === TEXT.claudeTitle && fullRows.codex?.label === TEXT.codexPrompt && fullRows.grok?.label === TEXT.grokPrompt && fullRows.claude?.model === 'claude-fixture-1' && fullRows.codex?.model === 'codex-fixture-1' && fullRows.grok?.model === 'grok-fixture-1' && /(방금|분 전)$/.test(fullRows.claude?.time ?? '') && fullRows.grok?.icon === 'grok', { claude: fullRows.claude, codex: fullRows.codex?.label, grok: fullRows.grok?.label })
  // hover → 시간 자리에 닫기
  const claudeRowSel = `[data-agent-full-row][data-pane="${panes.claude}"]`
  await hover(claudeRowSel)
  const hoverClose = await cdp.evaluate((sel) => {
    const row = document.querySelector(sel)
    return { time: getComputedStyle(row.querySelector('.agent-full-time')).opacity, close: getComputedStyle(row.querySelector('.agent-full-close')).opacity }
  }, claudeRowSel)
  await pause(200)
  const hoverClose2 = await cdp.evaluate((sel) => {
    const row = document.querySelector(sel)
    return { time: getComputedStyle(row.querySelector('.agent-full-time')).opacity, close: getComputedStyle(row.querySelector('.agent-full-close')).opacity }
  }, claudeRowSel)
  check('K6b-hover-close', 'K6ⓑ hover 시 시간 자리에 닫기(시간 opacity 0 · 닫기 1)', hoverClose2.time === '0' && hoverClose2.close === '1', { early: hoverClose, settled: hoverClose2 })
  await mouse('mouseMoved', { x: 900, y: 600 }, { buttons: 0 })
  await shot('10-full-list')
  // 빈 3줄 실측 — 198 공백 1자 div 와 같은 모양의 높이(F7·U3). 셸 탭 없이 메시지 없는 에이전트 행을 하나 만든다.
  const emptyPane = await attachAgent({ workspaceId: wsAlpha, agent: 'claude', state: 'idle', sessionId: 'c4770000-0000-4000-8000-0000000000ff' })
  // 상태 보고 뒤 세션 참조가 따로 온다 — 참조 전에는 「통합 미설치」 통지가 3줄에 선다(run1). 빈 자리가 될 때까지 기다린다.
  await waitFor(async () => cdp.evaluate((p) => document.querySelector(`[data-agent-full-row][data-pane="${p}"] [data-agent-row-message="empty"]`) !== null, emptyPane), 'empty row', 20_000).catch(() => null)
  const emptyRow = await cdp.evaluate((p) => {
    const row = document.querySelector(`[data-agent-full-row][data-pane="${p}"]`)
    const msg = row.querySelector('[data-agent-row-message]')
    const r = msg.getBoundingClientRect()
    return { kind: msg.getAttribute('data-agent-row-message'), messageHeight: r.height, marginTop: getComputedStyle(msg).marginTop, rowHeight: row.getBoundingClientRect().height, text: JSON.stringify(msg.textContent) }
  }, emptyPane)
  fs.writeFileSync(path.join(out, 'empty-message.json'), JSON.stringify(emptyRow, null, 2))
  check('K6d-empty', 'K6ⓓ 3줄 빈 경우 = 공백 1자 블록 · 실측 높이 0(+ mt 2px) — 198 F7 추정 확정', emptyRow.kind === 'empty' && emptyRow.messageHeight === 0 && emptyRow.marginTop === '2px', emptyRow)
  await backendRpc('pane.close', { pane_id: emptyPane }).catch(async () => backendRpc('tab.close', { tab_id: (await backendRpc('session.snapshot')).snapshot.panes.find((pane) => pane.pane_id === emptyPane)?.tab_id }))
  await waitFor(async () => cdp.evaluate((p) => document.querySelector(`[data-pane="${p}"]`) === null, emptyPane), 'empty row gone', 20_000).catch(() => null)

  // ── K2ⓒ 카드 높이 실측표 — Detailed(compact 에이전트·Full list)·Compact × 에이전트 0·1·3 ──
  const heights = {}
  const measure = async (label) => {
    const s = await snapshot()
    heights[label] = { agents0: s.cards[gamma].height, agents1: s.cards[beta].height, agents3: s.cards[alpha].height, padding0: [s.cards[gamma].padTop, s.cards[gamma].padBottom] }
  }
  await measure('detailed-full')
  await setAgentLayout('compact')
  await measure('detailed-compactAgents')
  await setLayout('compact')
  await measure('compact')
  fs.writeFileSync(path.join(out, 'heights.json'), JSON.stringify(heights, null, 2))
  check('K2c-heights', 'K2ⓒ 카드 높이 실측(Compact 는 에이전트 수와 무관하게 같다)', heights.compact.agents0 === heights.compact.agents1 && heights.compact.agents1 === heights.compact.agents3, heights)

  // ── K2ⓐⓑ Compact 카드 외관 ──
  snap = await snapshot()
  const alphaCard = snap.cards[alpha]
  const dirtyCard = snap.cards[wtA('a-dirty')]
  check('K2a-compact-surface', 'K2ⓐ Compact — 메타 줄 없음 · ★(주) · 「기본」 칩 없음 · 세로 패딩 8px', Object.values(snap.cards).every((card) => card.layout === 'compact' && !card.meta && card.padTop === '8px' && card.padBottom === '8px') && alphaCard.star && !alphaCard.primaryBadge && !snap.cards[wtA('a-one')].star, { alphaCard, aOne: snap.cards[wtA('a-one')] })
  check('K2a-compact-gitmark', 'K2ⓐ Compact — git 마크는 제목 줄에 없다(hover 로)', dirtyCard.mark === null && dirtyCard.hoverTrigger && !alphaCard.hoverTrigger, { dirtyCard, alphaCard })
  check('K2b-compact-no-agents', 'K2ⓑ Compact 카드는 에이전트 목록이 없고 상태 점은 남는다', alphaCard.rows === 0 && !alphaCard.pill && alphaCard.statusSlot, alphaCard)
  await openMenu()
  const compactValues = { layout: await triggerValue('card-layout'), props: await triggerValue('card-properties') }
  await closeMenu()
  check('K1c-trigger-hover-word', 'K1ⓑⓒ 트리거 값 = 간단히 · hover 시', compactValues.layout === '간단히' && compactValues.props === 'hover 시', compactValues)
  check('K5a-compact-preset', 'K5ⓐ Compact 선택 → 에이전트 활동 꺼짐(prefs []) · 에이전트 레이아웃 그대로', same(displayPrefs(), { layout: 'compact', props: [], agentLayout: 'compact' }), displayPrefs())
  await shot('20-compact')

  // ── K3 hover 카드 ──
  const dirtyTitle = `[data-worktree="${wtA('a-dirty')}"] .worktree-name`
  const cleanTitle = `[data-worktree="${wtA('a-one')}"] .worktree-name`
  await hover(cleanTitle)
  await pause(400)
  check('K3a-clean-none', 'K3ⓐ git 마크 없는 카드(제목=브랜치) — hover 해도 카드 없음', (await snapshot()).hoverCard === null, null)
  const dp = await pointOf(dirtyTitle)
  await mouse('mouseMoved', dp, { buttons: 0 })
  await pause(40)
  const early = (await snapshot()).hoverCard
  await pause(260)
  const opened = (await snapshot()).hoverCard
  check('K3a-dirty-open', 'K3ⓐ git 마크 있는 카드 — openDelay 뒤 열림, 내용 = 브랜치·git 상태', early === null && opened?.for === wtA('a-dirty') && opened.branch === 'a-dirty' && /변경 1/.test(opened.git ?? ''), { early, opened })
  check('K3e-in-viewport', 'K3ⓔ 화면 안(오른쪽 side, 넘치지 않음)', opened !== null && opened.rect.left >= dp.rect.right && opened.rect.right <= opened.viewport.width && opened.rect.bottom <= opened.viewport.height && opened.rect.top >= 0, opened?.rect)
  await shot('30-hover-card')
  // 내용 위로 옮겨 가면 유지, 떠나면 closeDelay 뒤 닫힘
  await mouse('mouseMoved', { x: opened.rect.left + 20, y: opened.rect.top + 10 }, { buttons: 0 })
  await pause(250)
  const kept = (await snapshot()).hoverCard !== null
  await mouse('mouseMoved', { x: 1100, y: 650 }, { buttons: 0 })
  await pause(40)
  const lingering = (await snapshot()).hoverCard !== null
  await pause(250)
  const closed = (await snapshot()).hoverCard === null
  check('K3a-close', 'K3ⓐ 카드 위로 옮기면 유지 · 떠나면 closeDelay(120) 뒤 닫힘', kept && lingering && closed, { kept, lingering, closed })
  // ⓑ 키보드 포커스(CDP 페이지 안 focus — 탭 순서 이동)
  await cdp.evaluate((sel) => document.querySelector(sel)?.focus(), dirtyTitle)
  await pause(80)
  const focused = (await snapshot()).hoverCard
  await cdp.evaluate(() => document.activeElement?.blur())
  await pause(80)
  check('K3b-focus', 'K3ⓑ 제목 포커스로 열리고 blur 로 닫힌다(tabIndex 0)', focused?.for === wtA('a-dirty') && (await snapshot()).hoverCard === null, { focused: focused?.for ?? null })
  // ⓓ 옵션 메뉴 열림 중 — 뜨지 않는다
  await openMenu()
  await mouse('mouseMoved', dp, { buttons: 0 })
  await pause(350)
  const withMenu = (await snapshot()).hoverCard
  await closeMenu()
  await mouse('mouseMoved', { x: 1100, y: 650 }, { buttons: 0 })
  await pause(250)
  check('K3d-menu', 'K3ⓓ 옵션 메뉴가 열려 있으면 뜨지 않는다', withMenu === null, withMenu)
  // ⓓ 드래그 중 — 뜨지 않는다(다른 카드를 끌며 dirty 제목 위를 지난다)
  const orderBeforeDragProbe = arrangement(await snapshot())
  const dragFrom = await pointOf(`[data-worktree="${wtA('a-one')}"] .worktree-name`, 0.3)
  await mouse('mouseMoved', dragFrom, { buttons: 0 })
  await pause(150)
  await mouse('mousePressed', dragFrom)
  for (let i = 1; i <= 8; i++) {
    await mouse('mouseMoved', { x: dragFrom.x, y: dragFrom.y + (dp.y - dragFrom.y) * (i / 8) })
    await pause(30)
  }
  await pause(350)
  const duringDrag = await snapshot()
  await key('Escape')
  await mouse('mouseReleased', { x: 1100, y: 650 })
  await pause(400)
  check('K3d-drag', 'K3ⓓ 드래그 중 제목 위를 지나도 뜨지 않는다', duringDrag.reordering && duringDrag.hoverCard === null, { reordering: duringDrag.reordering, hover: duringDrag.hoverCard })
  const orderAfterDragProbe = arrangement(await snapshot())
  // ⓓ 스크롤에 남지 않는다 — Compact 는 카드가 낮아 1000px 창에선 목록이 안 넘친다(run2). 창을 낮춰 넘치게 한다.
  await setViewport(cdp, { width: viewport.width, height: 520 })
  await settle()
  await mouse('mouseMoved', await pointOf(dirtyTitle), { buttons: 0 })
  await pause(300)
  const beforeScroll = (await snapshot()).hoverCard !== null
  const scrollTop0 = (await snapshot()).scrollTop
  // 휠 — 목록 위 한 점에서(CDP mouseWheel, 이 페이지에만).
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 40, y: 300, deltaX: 0, deltaY: 80 })
  await pause(250)
  const afterScrollSnap = await snapshot()
  const afterScroll = afterScrollSnap.hoverCard
  await cdp.evaluate(() => {
    document.querySelector('[data-repo-list]').scrollTop = 0
  })
  await setViewport(cdp, viewport)
  await settle()
  await mouse('mouseMoved', { x: 1100, y: 650 }, { buttons: 0 })
  await pause(250)
  check('K3d-scroll', 'K3ⓓ 열린 카드가 스크롤(휠)에 닫힌다', beforeScroll && afterScrollSnap.scrollTop !== scrollTop0 && afterScroll === null, { beforeScroll, scrollTop0, scrollTop1: afterScrollSnap.scrollTop, scrollMax: afterScrollSnap.scrollHeight - afterScrollSnap.clientHeight, afterScroll })
  // ⓓ 사이드바 접기에 남지 않는다
  await mouse('mouseMoved', await pointOf(dirtyTitle), { buttons: 0 })
  await pause(300)
  const beforeCollapse = (await snapshot()).hoverCard !== null
  await clickSel('[data-sidebar-toggle]').catch(() => null)
  await pause(300)
  const afterCollapse = await cdp.evaluate(() => ({ hover: document.querySelector('[data-hover-card]') !== null, sidebar: document.querySelector('[data-sidebar]') !== null }))
  await clickSel('[data-sidebar-show]').catch(() => null)
  await waitFor(async () => cdp.evaluate(() => document.querySelector('[data-repo-list]') !== null), 'sidebar back', 10_000)
  await settle()
  check('K3d-collapse', 'K3ⓓ 사이드바 접기 뒤 카드가 남지 않는다', afterCollapse.hover === false && afterCollapse.sidebar === false, { beforeCollapse, afterCollapse })
  // ⓔ 아래쪽 카드 — 위로 밀려 화면 안
  await setViewport(cdp, { width: viewport.width, height: 460 })
  await settle()
  const lowP = await cdp.evaluate((sel) => {
    const el = document.querySelector(sel)
    el.scrollIntoView({ block: 'end' })
    return null
  }, dirtyTitle)
  void lowP
  await pause(200)
  const lowPoint = await pointOf(dirtyTitle)
  await mouse('mouseMoved', lowPoint, { buttons: 0 })
  await pause(300)
  const lowCard = (await snapshot()).hoverCard
  check('K3e-clamp', 'K3ⓔ 낮은 창에서도 카드가 화면 안', lowCard !== null && lowCard.rect.bottom <= lowCard.viewport.height && lowCard.rect.top >= 0, { lowCard, lowPoint })
  await shot('31-hover-clamped')
  await mouse('mouseMoved', { x: 1100, y: 400 }, { buttons: 0 })
  await setViewport(cdp, viewport)
  await cdp.evaluate(() => {
    document.querySelector('[data-repo-list]').scrollTop = 0
  })
  await settle()

  // ── K4ⓒ Compact 에서 에이전트 활동 체크 — 값은 바뀌나 목록은 없다 ──
  await setAgentActivity(true)
  snap = await snapshot()
  check('K4c-compact-check', 'K4ⓒ Compact 에서 에이전트 활동을 켜도 목록 없음(prefs 는 켜짐)', same(displayPrefs().props, ['inline-agents']) && snap.cards[alpha].rows === 0, { prefs: displayPrefs(), alpha: snap.cards[alpha] })

  // ── K5ⓐⓑ Detailed 선택 → 켜짐 프리셋, 접힘·스크롤·펼침 영속 무변경 ──
  await setAgentActivity(false)
  await clickSel(`[data-repo-caret="${gamma}"]`).catch(() => null)
  await settle()
  const collapsedBefore = readPrefs()?.collapsedRepos ?? null
  await cdp.evaluate(() => {
    document.querySelector('[data-repo-list]').scrollTop = 60
  })
  await pause(100)
  const scrollBefore = (await snapshot()).scrollTop
  const prefsBefore = readPrefs()
  await setLayout('detailed')
  const afterDetailed = await snapshot()
  const prefsAfter = readPrefs()
  check('K5a-detailed-preset', 'K5ⓐ Detailed 선택 → 에이전트 활동 켜짐(prefs [inline-agents])', same(displayPrefs(), { layout: 'detailed', props: ['inline-agents'], agentLayout: 'compact' }), displayPrefs())
  check('K5b-untouched', 'K5ⓑ 레이아웃 전환이 에이전트 레이아웃·레포 접힘·펼침 영속·스크롤을 안 바꾼다', same(prefsBefore.sidebarAgentActivityLayout, prefsAfter.sidebarAgentActivityLayout) && same(prefsBefore.collapsedRepos, prefsAfter.collapsedRepos) && same(prefsBefore.expandedAgentGroups, prefsAfter.expandedAgentGroups) && Math.abs(afterDetailed.scrollTop - scrollBefore) < 1, { scrollBefore, scrollAfter: afterDetailed.scrollTop, collapsedBefore, collapsedAfter: prefsAfter.collapsedRepos })
  await clickSel(`[data-repo-caret="${gamma}"]`).catch(() => null)
  await cdp.evaluate(() => {
    document.querySelector('[data-repo-list]').scrollTop = 0
  })
  await settle()

  // ── K4ⓐ Detailed 에서 에이전트 활동 끄기/켜기 ──
  await setAgentActivity(false)
  snap = await snapshot()
  const offAlpha = snap.cards[alpha]
  await openMenu()
  const offValue = await triggerValue('card-properties')
  await closeMenu()
  await shot('40-agents-off')
  check('K4a-off', 'K4ⓐ 끄면 목록(알약·행) 사라짐 · 상태 점·메타 줄 남음 · 트리거 값 없음(0)', offAlpha.rows === 0 && !offAlpha.pill && !offAlpha.compactList && offAlpha.statusSlot && offAlpha.meta && offValue === '', { offAlpha, offValue })
  // K5ⓒ 같은 레이아웃 다시 고르기 → 프리셋 재적용(198 Radix 동작)
  await setLayout('detailed')
  snap = await snapshot()
  check('K5c-reselect', 'K5ⓒ Detailed 를 다시 고르면 프리셋이 다시 적용 — 꺼 둔 에이전트 활동이 켜진다(198 대로)', same(displayPrefs().props, ['inline-agents']) && snap.cards[alpha].pill, { prefs: displayPrefs(), alpha: snap.cards[alpha] })
  await setAgentActivity(false)
  await setAgentActivity(true)
  snap = await snapshot()
  check('K4a-on', 'K4ⓐ 다시 켜면 목록이 돌아온다(알약)', snap.cards[alpha].pill && snap.cards[alpha].compactList, snap.cards[alpha])

  // ── K1 메뉴 구획·서브메뉴·메뉴 유지·키보드 ──
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
  const wantStructure = ['title:워크스페이스 옵션', 'label:표시', 'sub:projects', 'sep', 'label:그룹', 'group-toggle', 'sep', 'sub:sort', 'sub:project-order', 'sub:card-layout', 'sub:card-properties', 'sep', 'label:필터', 'filter:hide-default-branch', 'filter:hide-detached-head']
  check('K1a-structure', 'K1ⓐ 구획 순서 = … 정렬 · 프로젝트 순서 · 카드 레이아웃 · 표시 속성 · 구분선 · 필터', same(structure, wantStructure), { got: structure })
  const subDump = () =>
    cdp.evaluate(() => {
      const panel = document.querySelector('[data-options-submenu]')
      return {
        width: panel?.getBoundingClientRect().width ?? null,
        items: [...(panel?.children ?? [])].map((el) =>
          el.getAttribute('role') === 'separator'
            ? 'sep'
            : el.hasAttribute('data-options-agent-layout-label')
              ? `label:${el.textContent}`
              : `${el.getAttribute('role')}:${el.getAttribute('data-options-radio') ?? el.getAttribute('data-options-property')}:${el.getAttribute('aria-checked')}:${el.textContent}`,
        ),
      }
    })
  await hover('[data-submenu-trigger="card-layout"]')
  await waitFor(async () => (await snapshot()).submenu === 'card-layout', 'layout sub', 5000)
  const layoutSub = await subDump()
  check('K1b-layout-sub', 'K1ⓑ 카드 레이아웃 = 라디오 자세히/간단히(w-44 176px), 오른쪽 현재값', same(layoutSub.items, ['menuitemradio:card-layout-detailed:true:자세히', 'menuitemradio:card-layout-compact:false:간단히']) && layoutSub.width === 176 && (await triggerValue('card-layout')) === '자세히', layoutSub)
  await shot('50-layout-sub')
  await hover('[data-submenu-trigger="card-properties"]')
  await waitFor(async () => (await snapshot()).submenu === 'card-properties', 'props sub', 5000)
  const propsSub = await subDump()
  check('K1c-props-sub', 'K1ⓒ 표시 속성 = 체크 「에이전트 활동」 · 구분선 · 라벨 · 라디오 간단히/전체 목록(w-48 192px), 트리거 값 1', same(propsSub.items, ['menuitemcheckbox:inline-agents:true:에이전트 활동', 'sep', 'label:에이전트 활동 레이아웃', 'menuitemradio:agent-layout-compact:true:간단히', 'menuitemradio:agent-layout-full:false:전체 목록']) && propsSub.width === 192 && (await triggerValue('card-properties')) === '1', propsSub)
  await shot('51-props-sub')
  // ⓓ 마우스 — 고른 뒤 메뉴·서브메뉴 유지
  await clickSel('[data-options-radio="agent-layout-full"]')
  const keptAfterRadio = await snapshot()
  await clickSel('[data-options-property="inline-agents"]')
  const keptAfterCheck = await snapshot()
  await clickSel('[data-options-property="inline-agents"]')
  await clickSel('[data-options-radio="agent-layout-compact"]')
  check('K1d-stay-open-mouse', 'K1ⓓ 라디오·체크를 눌러도 메뉴·서브메뉴 유지', keptAfterRadio.menuOpen && keptAfterRadio.submenu === 'card-properties' && keptAfterCheck.menuOpen && keptAfterCheck.submenu === 'card-properties', { keptAfterRadio: [keptAfterRadio.menuOpen, keptAfterRadio.submenu], keptAfterCheck: [keptAfterCheck.menuOpen, keptAfterCheck.submenu] })
  check('K1e-badge', 'K1ⓔ 표시 속성을 바꿔도 필터 배지 없음', keptAfterCheck.badge === null && (await snapshot()).badge === null, { badge: keptAfterCheck.badge })
  await closeMenu()
  // ⓓ 키보드 — 버튼 포커스 · ↓ 열기 · ↓ 이동 · → 진입 · Enter 선택(유지) · ← 복귀 · → · Enter 체크 · Esc 전체 닫기
  await cdp.evaluate(() => document.querySelector('[data-sidebar-options]')?.focus())
  await key('ArrowDown')
  await waitFor(async () => (await snapshot()).menuOpen, 'kbd menu', 5000)
  let guard = 0
  while ((await snapshot()).active !== 'card-layout' && guard++ < 20) await key('ArrowDown')
  const atLayout = (await snapshot()).active
  await key('ArrowRight')
  await waitFor(async () => (await snapshot()).active === 'card-layout-detailed', 'kbd sub focus', 5000).catch(() => null)
  const inSub = (await snapshot()).active
  await key('ArrowDown')
  const onCompact = (await snapshot()).active
  await key('Enter')
  await settle()
  const afterEnter = await snapshot()
  await key('ArrowLeft')
  const backToTrigger = (await snapshot()).active
  await key('ArrowDown')
  await key('ArrowRight')
  await waitFor(async () => (await snapshot()).active === 'inline-agents', 'kbd props focus', 5000).catch(() => null)
  const inProps = (await snapshot()).active
  await key('Enter')
  await settle()
  const afterCheckKey = await snapshot()
  const propsAfterKey = displayPrefs()
  await key('Escape')
  await settle()
  const afterEsc = await snapshot()
  check('K1d-keyboard', 'K1ⓓ 키보드 ↓·→·Enter·←·Esc — 새 서브메뉴 → 진입, Enter 선택 뒤 유지, Esc 전체 닫고 버튼으로', atLayout === 'card-layout' && inSub === 'card-layout-detailed' && onCompact === 'card-layout-compact' && afterEnter.menuOpen && afterEnter.submenu === 'card-layout' && Object.values(afterEnter.cards).every((card) => card.layout === 'compact') && backToTrigger === 'card-layout' && inProps === 'inline-agents' && afterCheckKey.menuOpen && same(propsAfterKey.props, ['inline-agents']) && !afterEsc.menuOpen && afterEsc.active === 'trigger', { atLayout, inSub, onCompact, afterEnterOpen: [afterEnter.menuOpen, afterEnter.submenu], backToTrigger, inProps, propsAfterKey, afterEsc: [afterEsc.menuOpen, afterEsc.active] })
  await setLayout('detailed')

  // ── K8 정렬·구획 무간섭 — Group Project·None, 레포 6개, 스크롤된 상태 ──
  for (const groupBy of ['repo', 'none']) {
    await setGroup(groupBy)
    await cdp.evaluate(() => {
      const list = document.querySelector('[data-repo-list]')
      list.scrollTop = Math.floor((list.scrollHeight - list.clientHeight) / 2)
    })
    await pause(150)
    const base = await snapshot()
    const combos = [
      ['layout-compact', () => setLayout('compact')],
      ['layout-detailed', () => setLayout('detailed')],
      ['agents-off', () => setAgentActivity(false)],
      ['agents-on', () => setAgentActivity(true)],
      ['agent-full', () => setAgentLayout('full')],
      ['agent-compact', () => setAgentLayout('compact')],
    ]
    const seen = []
    for (const [label, act] of combos) {
      await act()
      const s = await snapshot()
      seen.push({ label, same: same(arrangement(s), arrangement(base)), groups: s.groups.length, cards: Object.keys(s.cards).length })
    }
    check(`K8a-${groupBy}`, `K8ⓐ Group ${groupBy} — 표시 옵션 6회 전환 뒤 구획 구성·카드 순서 그대로(스크롤 ${base.scrollTop}/${base.scrollHeight - base.clientHeight})`, base.scrollHeight > base.clientHeight && seen.every((row) => row.same && row.cards === cardCount), { base: arrangement(base), seen })
  }
  await setGroup('repo')
  check('K3d-drag-noop', 'K3ⓓ 드래그 탐침(Esc 취소)이 순서를 바꾸지 않았다', same(orderAfterDragProbe, orderBeforeDragProbe), { before: orderBeforeDragProbe, after: orderAfterDragProbe }) // r1 R4: 개수가 아니라 배열 전체

  // ── K7ⓐ 영속 — 재시작 3회(조합을 바꿔 가며) ──
  const combosRestart = [
    { name: 'compact', apply: async () => setLayout('compact'), want: { layout: 'compact', props: [], agentLayout: 'compact' } },
    { name: 'detailed-full-off', apply: async () => { await setLayout('detailed'); await setAgentLayout('full'); await setAgentActivity(false) }, want: { layout: 'detailed', props: [], agentLayout: 'full' } },
    { name: 'detailed-full-on', apply: async () => setAgentActivity(true), want: { layout: 'detailed', props: ['inline-agents'], agentLayout: 'full' } },
  ]
  for (let index = 0; index < Math.max(restarts, combosRestart.length); index++) {
    const combo = combosRestart[index % combosRestart.length]
    await combo.apply()
    const before = displayPrefs()
    const beforeSnap = await snapshot()
    await quit(`R${index + 1}`)
    await launch(`R${index + 1}`)
    await waitFor(async () => Object.keys((await snapshot()).cards).length === cardCount, 'restart rendered', 60_000)
    await settle()
    const s = await snapshot()
    const after = displayPrefs()
    const layoutsAfter = [...new Set(Object.values(s.cards).map((card) => card.layout))]
    const alphaAfter = s.cards[alpha]
    const viewOk =
      same(layoutsAfter, [combo.want.layout]) &&
      (combo.want.layout === 'compact' ? alphaAfter.rows === 0 : combo.want.props.length === 0 ? !alphaAfter.compactList && !alphaAfter.fullList : combo.want.agentLayout === 'full' ? alphaAfter.fullList : alphaAfter.compactList)
    fs.writeFileSync(path.join(out, `prefs-restart-${index + 1}.json`), JSON.stringify(readPrefs(), null, 2))
    check(`K7a-restart-${index + 1}`, `K7ⓐ 재시작 ${index + 1}회차(${combo.name}) — prefs 와 화면이 그대로`, same(before, combo.want) && same(after, combo.want) && viewOk && same(arrangement(s), arrangement(beforeSnap)), { before, after, layoutsAfter, alphaAfter })
    await shot(`60-restart-${index + 1}`)
  }
  // 끝 — 기본으로 돌려 둔다(다음 회차 영향 없음 — work 는 매번 지운다).
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
