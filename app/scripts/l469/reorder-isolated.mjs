// LIFE-469 격리 실행 — 사이드바 순서 옮기기 K1~K5 (+K3·K4ⓑ·K6 격리 쪽).
//
// 격리: 전용 work 폴더(--work, 기본 /tmp/l469i) 아래 userData·ui-prefs·herdr 세션·제어 소켓·fixture 레포.
// 사용자 기본 userData·herdr 기본 세션·설치본 Orca 는 건드리지 않는다. 입력은 **CDP Input**(이 인스턴스의 디버깅 포트
// 페이지에만 간다 — OS 커서를 움직이지 않는다). 네이티브 OS 입력(cliclick)은 K8 에서 따로 한다.
//
// 사용: node app/scripts/l469/reorder-isolated.mjs --out <raw 폴더> [--work /tmp/l469i] [--port 9469]
// 결과: <out>/result.json (검사 행 전부) · <out>/shots/*.png · <out>/prefs-*.json. 종료코드 0 = 전 검사 통과.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, pickTarget, until, setViewport, assertPortFree, pause } from '../gui-diff/lib/cdp.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '../..')
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]?.startsWith('--') ? true : (all[index + 1] ?? true)]] : pairs), []),
)
const work = path.resolve(String(args.work ?? '/tmp/l469i'))
const out = path.resolve(String(args.out ?? 'l469-iso-out'))
const port = Number(args.port ?? 9469)
const shots = path.join(out, 'shots')
fs.mkdirSync(shots, { recursive: true })

const checks = []
const t0 = Date.now()
const log = (...parts) => console.log(`[l469 +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)
function check(id, criterion, pass, observed) {
  checks.push({ id, criterion, pass: pass === true, observed })
  log(pass ? 'PASS' : 'FAIL', id, criterion, JSON.stringify(observed).slice(0, 300))
}

// --- fixture ------------------------------------------------------------------------------------------
const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const reposDir = path.join(work, 'repos')
function makeRepo(name, linked) {
  const root = path.join(reposDir, name)
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, '-c', 'user.email=l469@example.invalid', '-c', 'user.name=l469', 'commit', '-q', '--allow-empty', '-m', 'init')
  for (const spec of linked) addWorktree(root, spec)
  return fs.realpathSync(root)
}
function addWorktree(root, spec) {
  const target = path.join(reposDir, `${path.basename(root)}-wt`, spec.name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (spec.detached) git(root, 'worktree', 'add', '-q', '--detach', target)
  else git(root, 'worktree', 'add', '-q', '-b', spec.name, target)
  return fs.realpathSync(target)
}

// --- 앱 기동·종료 ---------------------------------------------------------------------------------------
const userData = path.join(work, 'corral-userdata')
const herdrHome = path.join(work, 'corral-herdr')
const prefsFile = path.join(work, 'ui-prefs.json')
const control = path.join(work, 'corral-control.sock')
const session = 'l469-iso'
const env = { ...process.env }
for (const key of ['CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'ELECTRON_RUN_AS_NODE']) delete env[key]
Object.assign(env, {
  CORRAL_USER_DATA: userData,
  CORRAL_UI_PREFS: prefsFile,
  // CORRAL_RUNTIME_SOCKET 는 비운다 — 지정하면 `open` 이 데스크톱을 띄우지 않는다(cli.ts:47). 기본값이 격리 userData 아래 runtime/rpc.sock 이다.
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

async function launch(label) {
  await assertPortFree(port, 'corral l469')
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
  // 창이 뒤에 있으면 Chromium 이 프레임을 늦춰 입력 한 번이 수백 ms 씩 걸린다(run3 실측: 33검사에 9분) — gui-diff 와 같이 포커스를 에뮬레이션한다.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await setViewport(cdp, { width: 1200, height: Number(args.height ?? 1500) })
  await until(() => cdp.evaluate(() => document.querySelector('[data-repo-list]') !== null), 'sidebar rendered', 30_000)
  log('launched', label, 'pid', desktopPid)
}

async function quit(label) {
  await cdp?.close().catch(() => {})
  cdp = null
  if (desktopPid !== null) {
    try {
      process.kill(desktopPid, 'SIGTERM')
    } catch {}
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

// --- 화면 읽기 ------------------------------------------------------------------------------------------
const snapshot = () =>
  cdp.evaluate(() => {
    const list = document.querySelector('[data-repo-list]')
    return {
      repos: [...list.querySelectorAll(':scope > [data-repo]')].map((group) => ({
        root: group.getAttribute('data-repo'),
        collapsed: group.querySelector('[data-repo-caret] .is-collapsed') !== null,
        error: group.querySelector('[data-repo-error]')?.textContent ?? null,
        worktrees: [...group.querySelectorAll('[data-worktree]')].map((row) => row.getAttribute('data-worktree')),
        selected: [...group.querySelectorAll('[data-worktree-card-active="primary"]')].map((el) => el.closest('[data-worktree]').getAttribute('data-worktree')),
        open: [...group.querySelectorAll('[data-chip-value="open"]')].map((el) => el.closest('[data-worktree]').getAttribute('data-worktree')),
        agentRows: Object.fromEntries([...group.querySelectorAll('[data-worktree]')].map((row) => [row.getAttribute('data-worktree'), row.querySelectorAll('[data-agent-row]').length])),
      })),
      reordering: document.querySelector('.sidebar.is-reordering') !== null,
      indicator: document.querySelector('[data-reorder-indicator]') !== null,
      selection: String(window.getSelection() ?? ''),
      scrollTop: list.scrollTop,
    }
  })
const repoOrder = (snap) => snap.repos.map((repo) => repo.root)
const wtOrder = (snap, root) => snap.repos.find((repo) => repo.root === root)?.worktrees ?? null
const readPrefs = () => (fs.existsSync(prefsFile) ? JSON.parse(fs.readFileSync(prefsFile, 'utf8')) : null)
const prefsHash = () => (fs.existsSync(prefsFile) ? crypto.createHash('sha256').update(fs.readFileSync(prefsFile)).digest('hex') : null)
const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}

/** 요소 중심(또는 상대 위치)의 화면 좌표. `match` 는 data 속성 값 비교(경로에 CSS 이스케이프가 필요 없게). */
const pointOf = (spec) =>
  cdp.evaluate((s) => {
    const all = [...document.querySelectorAll(`[${s.attr}]`)]
    const el = s.value === undefined ? all[0] : all.find((node) => node.getAttribute(s.attr) === s.value)
    const target = el && s.inner ? el.querySelector(s.inner) : el
    if (!target) return null
    const r = target.getBoundingClientRect()
    return { x: r.left + r.width * (s.fx ?? 0.5), y: r.top + r.height * (s.fy ?? 0.5), rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
  }, spec)
const headerPoint = (root, fx = 0.4) => pointOf({ attr: 'data-repo-toggle', value: root, inner: '.repo-row-name', fx })
const cardPoint = (wtPath) => pointOf({ attr: 'data-worktree', value: wtPath, inner: '.worktree-name', fx: 0.3 })

const mouse = (type, p, extra = {}) =>
  cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: extra.buttons ?? (type === 'mouseReleased' ? 0 : 1), clickCount: type === 'mouseMoved' ? 0 : 1, ...extra })

/** 실제 드래그 흉내 — 눌러서 여러 걸음 옮기고(중간 `during` 콜백) 놓는다. `end` 는 좌표 또는 좌표를 주는 함수. */
async function drag(start, end, { steps = 12, during = null, release = true, holdMs = 0 } = {}) {
  await mouse('mouseMoved', start, { buttons: 0 })
  await mouse('mousePressed', start)
  let target = typeof end === 'function' ? await end() : end
  for (let index = 1; index <= steps; index++) {
    const p = { x: start.x + ((target.x - start.x) * index) / steps, y: start.y + ((target.y - start.y) * index) / steps }
    await mouse('mouseMoved', p)
    await pause(16)
    if (typeof end === 'function' && index === Math.floor(steps / 2)) target = await end()
  }
  if (holdMs > 0) {
    const until = Date.now() + holdMs
    while (Date.now() < until) {
      await mouse('mouseMoved', target)
      await pause(50)
    }
  }
  const mid = during ? await during(target) : null
  if (release) await mouse('mouseReleased', target)
  await pause(150)
  return mid
}
async function click(p) {
  await mouse('mouseMoved', p, { buttons: 0 })
  await mouse('mousePressed', p)
  await mouse('mouseReleased', p)
  await pause(200)
}

/** 레포 경계 slot 을 겨냥하는 좌표 — 0 = 첫 헤더 윗부분, n = 마지막 묶음 아래, i = i 번째 헤더 윗부분. */
async function repoSlotPoint(slot) {
  const rects = await cdp.evaluate(() =>
    [...document.querySelectorAll('[data-repo-list] > [data-repo]')].map((group) => {
      const head = group.querySelector('[data-repo-head]').getBoundingClientRect()
      const box = group.getBoundingClientRect()
      return { top: head.top, headBottom: head.bottom, bottom: box.bottom, x: head.left + head.width * 0.4 }
    }),
  )
  if (slot >= rects.length) {
    const last = rects[rects.length - 1]
    return { x: last.x, y: last.bottom + 10 }
  }
  const rect = rects[slot]
  return { x: rect.x, y: rect.top + (rect.headBottom - rect.top) * 0.2 }
}
async function cardSlotPoint(repoRoot, slot) {
  const rects = await cdp.evaluate(
    (root) => {
      const group = [...document.querySelectorAll('[data-repo-list] > [data-repo]')].find((el) => el.getAttribute('data-repo') === root)
      return [...group.querySelectorAll('[data-reorder-card]')].map((card) => {
        const r = card.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, x: r.left + r.width * 0.3 }
      })
    },
    repoRoot,
  )
  if (slot >= rects.length) {
    const last = rects[rects.length - 1]
    return { x: last.x, y: last.bottom - 4 }
  }
  return { x: rects[slot].x, y: rects[slot].top + 4 }
}

const settle = () => pause(400)
async function rebuild() {
  await rpc(control, { cmd: 'rebuild-tree' }, 30_000)
  await pause(800)
}
async function waitFor(fn, label, timeout = 30_000) {
  return until(async () => ((await fn()) ? true : null), label, timeout, 250)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// --- 본 실행 ----------------------------------------------------------------------------------------------
async function main() {
  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(reposDir, { recursive: true })
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })

  const alpha = makeRepo('alpha', [{ name: 'a-one' }, { name: 'a-two' }, { name: 'a-three' }, { name: 'a-det', detached: true }])
  const beta = makeRepo('beta', [{ name: 'b-one' }, { name: 'b-two' }])
  const gamma = makeRepo('gamma', Array.from({ length: 7 }, (_, index) => ({ name: `g-${index + 1}` })))
  // 경로는 미리 정규화해 둔다 — 삭제 뒤(git worktree remove)에도 같은 키로 찾는다.
  const realRepos = fs.realpathSync(reposDir)
  const wtA = (name) => path.join(realRepos, 'alpha-wt', name)
  const wtB = (name) => path.join(realRepos, 'beta-wt', name)

  // K6 — 469 이전 모양 ui-prefs(사용자 파일 키 구성 k6-user-ui-prefs-keys.json 과 같은 칸, 값은 지어낸 것).
  const legacy = { version: 1, sidebarWidth: 300, sidebarCollapsed: false, collapsedRepos: [], collapsedGroups: ['/x/old'], expandedAgentGroups: ['/x/exp'], tabOrdinals: [{ tabId: 'w9:t1', groupId: 'w9', ordinal: 3 }], groupLayouts: [{ worktree: '/x/wt', v: 1 }] }
  fs.writeFileSync(prefsFile, JSON.stringify(legacy, null, 2) + '\n')
  const legacyHash = prefsHash()

  await startBackend()
  await launch('L1')
  for (const root of [gamma, alpha, beta]) {
    const res = await rpc(control, { cmd: 'add-repo', root })
    if (!res.ok) throw new Error(`add-repo ${root}: ${JSON.stringify(res)}`)
  }
  await waitFor(async () => {
    await rebuild()
    const snap = await snapshot()
    return snap.repos.length === 3 && wtOrder(snap, alpha)?.length === 5 && wtOrder(snap, gamma)?.length === 8 && wtOrder(snap, beta)?.length === 3
  }, 'fixture rendered', 90_000)
  await settle()

  // ── K6ⓐ·ⓑ·ⓒ — 첫 기동: 순서 = 이전 빌드 규칙, 기존 칸 보존, 첫 드래그 전 파일 쓰기 여부 ──
  let snap = await snapshot()
  const byName = [alpha, beta, gamma]
  const expectAlpha = [alpha, ...['(브랜치 없음)', 'a-one', 'a-three', 'a-two'].map((label) => wtA(label === '(브랜치 없음)' ? 'a-det' : label))]
  check('K6a-1', 'K6ⓐ 첫 기동 레포 순서 = 이름순', same(repoOrder(snap), byName), { got: repoOrder(snap), want: byName })
  check('K6a-2', 'K6ⓐ 첫 기동 워크트리 = 주 체크아웃 → 표시 이름순', same(wtOrder(snap, alpha), expectAlpha), { got: wtOrder(snap, alpha), want: expectAlpha })
  const firstPrefs = readPrefs()
  fs.writeFileSync(path.join(out, 'prefs-after-first-launch.json'), JSON.stringify(firstPrefs, null, 2))
  const legacyKept = Object.entries(legacy).every(([key, value]) => same(firstPrefs?.[key], value))
  check('K6b-1', 'K6ⓑ 첫 기동 뒤 기존 칸 7종+version 보존', legacyKept, { legacyHash, after: prefsHash() })
  check('K6c-1', 'K6ⓒ 첫 드래그 전 materialize 기록(파일을 쓴다)', same(firstPrefs?.manualRepoOrder, byName) && same(firstPrefs?.manualWorktreeOrder?.[alpha], expectAlpha.slice(1)), {
    manualRepoOrder: firstPrefs?.manualRepoOrder,
    alpha: firstPrefs?.manualWorktreeOrder?.[alpha],
  })
  await shot('00-first-launch')

  // 열린·선택·에이전트 카드 준비: a-three 열기 → a-one 열기(선택) → a-one 의 pane 에 에이전트 보고.
  for (const name of ['a-three', 'a-one']) {
    await click(await cardPoint(wtA(name)))
    await waitFor(async () => (await snapshot()).repos.find((repo) => repo.root === alpha)?.open.includes(wtA(name)), `open ${name}`, 30_000)
  }
  const backendRpc = async (method, params = {}) => {
    const res = await rpc(env.CORRAL_BACKEND_SOCKET, { id: `l469-${Date.now()}`, method, params })
    if (res.error) throw new Error(`${method}: ${JSON.stringify(res.error)}`)
    return res.result
  }
  const snapState = (await rpc(control, { cmd: 'state' })).state
  const aOne = snapState.repos.find((repo) => repo.root === alpha).worktrees.find((row) => row.path === wtA('a-one'))
  const paneId = aOne.workspace?.tabs?.[0]?.panes?.[0]?.paneId
  if (paneId) await backendRpc('pane.report_agent', { pane_id: paneId, source: 'l469', agent: 'claude', state: 'working', message: 'l469 agent' })
  await waitFor(async () => ((await snapshot()).repos.find((repo) => repo.root === alpha)?.agentRows?.[wtA('a-one')] ?? 0) > 0, 'agent row', 30_000).catch(() => null)
  // 새로 연 worktree 는 열기만 하고 활성으로 바꾸지 않는 경로가 있다(기존 동작) — 한 번 더 눌러 고른다.
  await click(await cardPoint(wtA('a-one')))
  await waitFor(async () => (await snapshot()).repos.find((repo) => repo.root === alpha)?.selected?.[0] === wtA('a-one'), 'a-one selected', 15_000).catch(() => null)
  snap = await snapshot()
  const alphaBefore = snap.repos.find((repo) => repo.root === alpha)
  check('prep', '준비: a-one 선택·열림·에이전트 행, a-three 열림', alphaBefore.selected[0] === wtA('a-one') && alphaBefore.open.includes(wtA('a-three')) && alphaBefore.agentRows[wtA('a-one')] > 0, alphaBefore)

  // ── K1ⓐ 레포 헤더 — 맨 위·맨 아래·가운데 ──
  await drag(await headerPoint(gamma), await repoSlotPoint(0))
  snap = await snapshot()
  check('K1a-top', 'K1ⓐ gamma 헤더 → 맨 위', same(repoOrder(snap), [gamma, alpha, beta]), repoOrder(snap))
  check('K1a-top-file', 'K1ⓐ 파일에도 같은 순서', same(readPrefs().manualRepoOrder, [gamma, alpha, beta]), readPrefs().manualRepoOrder)
  await drag(await headerPoint(alpha), await repoSlotPoint(3))
  snap = await snapshot()
  check('K1a-bottom', 'K1ⓐ alpha 헤더 → 맨 아래', same(repoOrder(snap), [gamma, beta, alpha]), repoOrder(snap))
  await drag(await headerPoint(alpha), await repoSlotPoint(1))
  snap = await snapshot()
  check('K1a-middle', 'K1ⓐ alpha 헤더 → 가운데', same(repoOrder(snap), [gamma, alpha, beta]), repoOrder(snap))
  // K1ⓓ — 레포를 옮겨도 카드·선택·열림·에이전트 행이 그대로 따라간다.
  const alphaAfter = snap.repos.find((repo) => repo.root === alpha)
  check('K1d-follow', 'K1ⓓ 옮긴 레포의 카드 순서·선택·열림·에이전트 행 유지', same(alphaAfter.worktrees, alphaBefore.worktrees) && same(alphaAfter.selected, alphaBefore.selected) && same(alphaAfter.open, alphaBefore.open) && same(alphaAfter.agentRows, alphaBefore.agentRows), { before: alphaBefore, after: alphaAfter })

  // ── K3ⓐ 임계 미만 = 클릭(접기), 임계 넘긴 드래그 뒤 = 클릭 없음 ──
  const betaHead = await headerPoint(beta)
  await drag(betaHead, { x: betaHead.x + 2, y: betaHead.y + 1 }, { steps: 2 })
  snap = await snapshot()
  check('K3a-subthreshold-header', 'K3ⓐ 헤더 3px 미만 이동 = 클릭 → beta 접힘, 순서 무변경', snap.repos.find((repo) => repo.root === beta).collapsed && same(repoOrder(snap), [gamma, alpha, beta]), { order: repoOrder(snap), collapsed: snap.repos.map((r) => r.collapsed) })
  // ── K1ⓑ 접힌 레포 헤더도 끌린다 + K1ⓓ 접힘 상태 따라감 + K3ⓐ 드래그 뒤 클릭 없음(접힘 토글 없음) ──
  await drag(await headerPoint(beta), await repoSlotPoint(0))
  snap = await snapshot()
  check('K1b-collapsed', 'K1ⓑ 접힌 beta 헤더 → 맨 위', same(repoOrder(snap), [beta, gamma, alpha]), repoOrder(snap))
  check('K3a-no-click-header', 'K3ⓐ·K1ⓓ 드래그 뒤 접힘 토글 없음 — beta 접힌 채', snap.repos.find((repo) => repo.root === beta).collapsed === true, snap.repos.map((r) => [r.root, r.collapsed]))
  await click(await headerPoint(beta)) // 다시 펼친다
  // 카드 임계 미만 = 선택(a-three 선택으로 바뀐다) → 다시 a-one 선택.
  const threeP = await cardPoint(wtA('a-three'))
  await drag(threeP, { x: threeP.x + 2, y: threeP.y + 1 }, { steps: 2 })
  snap = await snapshot()
  check('K3a-subthreshold-card', 'K3ⓐ 카드 3px 미만 이동 = 클릭 → a-three 선택', snap.repos.find((repo) => repo.root === alpha).selected[0] === wtA('a-three'), snap.repos.find((repo) => repo.root === alpha).selected)
  await click(await cardPoint(wtA('a-one')))

  // ── K2ⓐ 카드 — 맨 위·맨 아래·가운데. ⓒ 종류: detached(a-det)·닫힘(a-two)·열림 비선택(a-three)·선택+에이전트(a-one) ──
  const alphaWts = () => snapshot().then((s) => wtOrder(s, alpha))
  let before = await alphaWts()
  await drag(await cardPoint(wtA('a-two')), await cardSlotPoint(alpha, 0))
  let after = await alphaWts()
  check('K2a-top-closed', 'K2ⓐ·ⓒ 닫힌 카드 a-two → 맨 위(주 체크아웃 아래)', after[0] === alpha && after[1] === wtA('a-two'), { before, after })
  before = after
  await drag(await cardPoint(wtA('a-det')), await cardSlotPoint(alpha, 9))
  after = await alphaWts()
  check('K2a-bottom-detached', 'K2ⓐ·ⓒ detached 카드 a-det → 맨 아래', after[after.length - 1] === wtA('a-det') && after[0] === alpha, { before, after })
  before = after
  snap = await snapshot()
  const selBefore = snap.repos.find((repo) => repo.root === alpha).selected
  await drag(await cardPoint(wtA('a-one')), await cardSlotPoint(alpha, 3))
  after = await alphaWts()
  snap = await snapshot()
  const alphaNow = snap.repos.find((repo) => repo.root === alpha)
  check('K2a-middle-selected-agent', 'K2ⓐ·ⓒ 선택+에이전트 카드 a-one → 가운데', after.indexOf(wtA('a-one')) > 1 && after.indexOf(wtA('a-one')) < after.length - 1, { before, after })
  check('K2e-selected-kept', 'K2ⓔ 드래그 뒤 선택·열림·에이전트 행 유지', same(alphaNow.selected, selBefore) && alphaNow.open.includes(wtA('a-one')) && alphaNow.agentRows[wtA('a-one')] > 0, alphaNow)
  before = after
  await drag(await cardPoint(wtA('a-three')), await cardSlotPoint(alpha, 0))
  after = await alphaWts()
  snap = await snapshot()
  check('K2c-open-unselected', 'K2ⓒ 열린 비선택 카드 a-three → 맨 위, 드래그 뒤 선택 무변경(클릭 없음)', after[1] === wtA('a-three') && same(snap.repos.find((repo) => repo.root === alpha).selected, selBefore), { before, after, selected: snap.repos.find((repo) => repo.root === alpha).selected })
  const fileWt = readPrefs().manualWorktreeOrder[alpha]
  check('K2a-file', 'K2ⓐ 파일의 alpha 순서 = 화면(주 체크아웃 제외)', same(fileWt, after.slice(1)), { file: fileWt, screen: after })

  // ── K2ⓑ 주 체크아웃: 끌리지 않는다 · 그 위로 놓을 수 없다 ──
  before = await alphaWts()
  let hash = prefsHash()
  const mainP = await cardPoint(alpha)
  const mainMid = await drag(mainP, { x: mainP.x, y: mainP.y + 120 }, { during: async () => snapshot() })
  after = await alphaWts()
  check('K2b-main-no-drag', 'K2ⓑ 주 체크아웃 카드는 끌리지 않는다(드래그 상태·표시 줄 없음, 순서·파일 무변경)', !mainMid.reordering && !mainMid.indicator && same(before, after) && prefsHash() === hash, { during: { reordering: mainMid.reordering, indicator: mainMid.indicator }, before, after })
  await click(await cardPoint(wtA('a-one'))) // 주 체크아웃 클릭으로 선택이 바뀌었을 수 있다 — 되돌린다
  before = await alphaWts()
  const lastLinked = before[before.length - 1]
  const mainTop = await pointOf({ attr: 'data-worktree', value: alpha, fy: 0.2 })
  await drag(await cardPoint(lastLinked), mainTop)
  after = await alphaWts()
  check('K2b-not-above-main', 'K2ⓑ 주 체크아웃 위에 놓아도 주 체크아웃은 맨 위 그대로', after[0] === alpha, { before, after, dropped: lastLinked })

  // ── K2ⓓ 다른 레포 위에 놓기 = 취소 ──
  before = await alphaWts()
  hash = prefsHash()
  const betaCardP = await cardPoint(wtB('b-one'))
  const crossMid = await drag(await cardPoint(wtA('a-two')), betaCardP, { during: async () => snapshot() })
  after = await alphaWts()
  snap = await snapshot()
  check('K2d-cross-repo-cancel', 'K2ⓓ alpha 카드를 beta 위에 놓기 = 취소(표시 줄 없음, 순서·소속·파일 무변경)', !crossMid.indicator && same(before, after) && !wtOrder(snap, beta).includes(wtA('a-two')) && prefsHash() === hash, { duringIndicator: crossMid.indicator, before, after })

  // ── K3ⓐ 헤더 액션(셰브론·⋯·+)에서는 드래그가 시작되지 않는다 ──
  for (const [attr, label] of [['data-repo-caret', '셰브론'], ['data-repo-menu-toggle', '⋯'], ['data-create-worktree', '+']]) {
    const hp = await headerPoint(gamma)
    await mouse('mouseMoved', hp, { buttons: 0 })
    await pause(150)
    const p = await pointOf({ attr, value: gamma })
    before = repoOrder(await snapshot())
    hash = prefsHash()
    const mid = await drag(p, { x: p.x, y: p.y + 140 }, { during: async () => snapshot(), release: false })
    // 버튼 밖에서 놓아 클릭이 그 버튼에 가지 않게 한다.
    await mouse('mouseReleased', { x: p.x, y: p.y + 140 })
    await pause(200)
    snap = await snapshot()
    check(`K3a-action-${attr}`, `K3ⓐ 헤더 ${label} 에서 끌면 드래그 안 됨`, !mid.reordering && !mid.indicator && same(before, repoOrder(snap)) && prefsHash() === hash, { during: { reordering: mid.reordering, indicator: mid.indicator } })
  }
  await pause(200)
  // 모달이 열렸으면 닫는다(+ 는 버튼 밖에서 놓았으니 열리지 않아야 한다).
  await cdp.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

  // ── K3ⓑ 취소: Escape(헤더·카드) · 창 blur · 목록 밖 놓기 ──
  for (const kind of ['header', 'card']) {
    before = await snapshot()
    hash = prefsHash()
    const start = kind === 'header' ? await headerPoint(alpha) : await cardPoint(wtA('a-two'))
    const end = kind === 'header' ? await repoSlotPoint(0) : await cardSlotPoint(alpha, 0)
    const mid = await drag(start, end, {
      release: false,
      during: async () => {
        const s = await snapshot()
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await pause(100)
        return s
      },
    })
    await mouse('mouseReleased', end)
    await pause(200)
    after = await snapshot()
    check(`K3b-escape-${kind}`, `K3ⓑ ${kind === 'header' ? '헤더' : '카드'} Escape 취소 — 화면·파일 무변경`, mid.indicator && !after.reordering && same(repoOrder(before), repoOrder(after)) && same(wtOrder(before, alpha), wtOrder(after, alpha)) && prefsHash() === hash, { duringIndicator: mid.indicator })
  }
  before = await snapshot()
  hash = prefsHash()
  const blurMid = await drag(await headerPoint(alpha), await repoSlotPoint(0), {
    release: false,
    during: async () => {
      const s = await snapshot()
      await cdp.evaluate(() => window.dispatchEvent(new Event('blur')))
      await pause(100)
      return s
    },
  })
  await mouse('mouseReleased', await repoSlotPoint(0))
  after = await snapshot()
  check('K3b-blur', 'K3ⓑ 창 blur 취소 — 화면·파일 무변경', blurMid.indicator && !after.reordering && same(repoOrder(before), repoOrder(after)) && prefsHash() === hash, { duringIndicator: blurMid.indicator })
  for (const kind of ['header', 'card']) {
    before = await snapshot()
    hash = prefsHash()
    const start = kind === 'header' ? await headerPoint(alpha) : await cardPoint(wtA('a-two'))
    const mid = await drag(start, { x: 900, y: start.y - 40 }, { during: async () => snapshot() })
    after = await snapshot()
    check(`K3b-outside-${kind}`, `K3ⓑ ${kind === 'header' ? '헤더' : '카드'} 목록 밖 놓기 = 취소`, !mid.indicator && same(repoOrder(before), repoOrder(after)) && same(wtOrder(before, alpha), wtOrder(after, alpha)) && prefsHash() === hash, { duringIndicator: mid.indicator })
  }

  // ── K3ⓒ C4 SVG 아이콘에서 끌기 → 드래그 열림 + 글자 선택 없음 ──
  before = await snapshot()
  const iconP = await pointOf({ attr: 'data-repo-toggle', value: beta, inner: '.repo-row-icon-glyph' })
  const iconMid = await drag(iconP, await repoSlotPoint(3), { during: async () => snapshot() })
  after = await snapshot()
  check('K3c-svg-icon', 'K3ⓒ SVG 폴더 아이콘에서 끌어도 드래그가 열리고 놓인다, 글자 선택 없음', iconMid.reordering && iconMid.indicator && repoOrder(after)[2] === beta && iconMid.selection === '' && after.selection === '', { during: { reordering: iconMid.reordering, selection: iconMid.selection }, after: repoOrder(after), selection: after.selection })

  // ── K3ⓓ C5 펼친 레포의 카드 영역 위로 헤더를 끌어도 표시 유지, 가까운 경계에 들어간다 ──
  // 지금 순서 [gamma, alpha, beta]. beta 헤더를 alpha 카드 영역 아래쪽(마지막 카드 위)에 놓으면 alpha 아래 경계(slot 2) = 제자리,
  // alpha 카드 영역 위쪽(첫 연결 카드)에 놓으면 alpha 윗경계(slot 1) → [gamma, beta, alpha].
  snap = await snapshot()
  const alphaCards = wtOrder(snap, alpha)
  const upperCard = await cardPoint(alphaCards[1])
  const c5Mid = await drag(await headerPoint(beta), upperCard, { during: async () => snapshot() })
  after = await snapshot()
  check('K3d-c5', 'K3ⓓ C5 카드 영역 위에서 표시 줄 유지 → 놓으면 그 레포 윗경계', c5Mid.indicator && same(repoOrder(after), [gamma, beta, alpha]), { duringIndicator: c5Mid.indicator, after: repoOrder(after) })

  // ── K3ⓔ 드롭 표시 줄 값 + sticky 헤더에 가리지 않음 + 캡처 ──
  const indicatorProbe = await drag(await cardPoint(wtA('a-two')), await cardSlotPoint(alpha, 2), {
    release: false,
    during: async () => {
      await shot('k3e-card-drag-indicator')
      return cdp.evaluate(() => {
        const ind = document.querySelector('[data-reorder-indicator]')
        if (!ind) return null
        const dots = ind.querySelectorAll('.reorder-drop-dot')
        const bar = ind.querySelector('.reorder-drop-bar')
        const cs = (el) => getComputedStyle(el)
        const r = (el) => el.getBoundingClientRect()
        const list = document.querySelector('[data-repo-list]').getBoundingClientRect()
        const head = document.querySelector('.repo-row-head')
        return {
          z: cs(ind).zIndex,
          headZ: cs(head).zIndex,
          left: r(ind).left - list.left,
          rightGap: list.right - r(ind).right,
          height: r(ind).height,
          dot: { w: r(dots[0]).width, h: r(dots[0]).height, bg: cs(dots[0]).backgroundColor, radius: cs(dots[0]).borderRadius, shadow: cs(dots[0]).boxShadow },
          bar: { h: r(bar).height, bg: cs(bar).backgroundColor, shadow: cs(bar).boxShadow },
          sidebarBg: cs(document.querySelector('.sidebar')).backgroundColor,
          pointerEvents: cs(ind).pointerEvents,
          dotCount: dots.length,
        }
      })
    },
  })
  await mouse('mouseMoved', { x: 900, y: 300 })
  await mouse('mouseReleased', { x: 900, y: 300 })
  await pause(200)
  fs.writeFileSync(path.join(out, 'k3e-indicator-probe.json'), JSON.stringify(indicatorProbe, null, 2))
  check(
    'K3e-indicator-values',
    'K3ⓔ 표시 줄 = 198 값(점 6px 둥근·막대 2px·ring #737373·바탕 2px 그림자·z30>헤더 z20·left 12/right 8)',
    indicatorProbe !== null &&
      indicatorProbe.dotCount === 2 &&
      indicatorProbe.dot.w === 6 && indicatorProbe.dot.h === 6 && indicatorProbe.bar.h === 2 &&
      indicatorProbe.dot.bg === 'rgb(115, 115, 115)' && indicatorProbe.bar.bg === 'rgb(115, 115, 115)' &&
      indicatorProbe.dot.shadow.includes('0px 0px 0px 2px') && indicatorProbe.dot.shadow.includes(indicatorProbe.sidebarBg) &&
      Number(indicatorProbe.z) === 30 && Number(indicatorProbe.headZ) === 20 && indicatorProbe.pointerEvents === 'none' &&
      Math.abs(indicatorProbe.left - 12) < 0.5 && Math.abs(indicatorProbe.rightGap - 8) < 0.5,
    indicatorProbe,
  )

  // ── K3ⓕ 자동 스크롤 — 창을 낮춰 목록이 넘치게 하고, 화면 밖 자리에 놓는다 ──
  await setViewport(cdp, { width: 1200, height: 420 })
  await pause(300)
  await cdp.evaluate(() => {
    document.querySelector('[data-repo-list]').scrollTop = 0
  })
  await pause(200)
  snap = await snapshot()
  const gOrder = wtOrder(snap, gamma)
  const lastG = gOrder[gOrder.length - 1]
  // gamma 는 맨 위 레포. 첫 연결 카드(g-1)를 끌어 목록 아래 가장자리에 잡고 있으면 스크롤된다 → 그 레포 맨 아래 경계에 놓는다.
  const listRect = await cdp.evaluate(() => {
    const r = document.querySelector('[data-repo-list]').getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, scrollHeight: document.querySelector('[data-repo-list]').scrollHeight, clientHeight: document.querySelector('[data-repo-list]').clientHeight }
  })
  const lastGVisibleBefore = await cdp.evaluate(
    (p) => {
      const el = [...document.querySelectorAll('[data-worktree]')].find((node) => node.getAttribute('data-worktree') === p)
      const r = el.getBoundingClientRect()
      const l = document.querySelector('[data-repo-list]').getBoundingClientRect()
      return r.top < l.bottom && r.bottom > l.top
    },
    lastG,
  )
  const firstG = gOrder[1]
  // 목록 아래 가장자리를 잡고 있다가 마지막 g 카드가 가장자리 띠(56px) 위로 올라오면 그 카드 아랫부분으로 옮겨 놓는다 —
  // 끝까지 기다리면 그 카드가 위로 지나가 버린다(run4 실측).
  const lastGRect = () =>
    cdp.evaluate(
      (q) => {
        const el = [...document.querySelectorAll('[data-worktree]')].find((node) => node.getAttribute('data-worktree') === q)
        const r = el.getBoundingClientRect()
        return { x: r.left + 40, top: r.top, bottom: r.bottom }
      },
      lastG,
    )
  const scrollMid = await drag(await cardPoint(firstG), { x: listRect.left + 80, y: listRect.bottom - 6 }, {
    release: false,
    during: async (edge) => {
      const deadline = Date.now() + 8_000
      let rect = await lastGRect()
      while (rect.bottom > listRect.bottom - 60 && Date.now() < deadline) {
        await mouse('mouseMoved', edge)
        await pause(30)
        rect = await lastGRect()
      }
      const s0 = await snapshot()
      const p = { x: rect.x, y: rect.bottom - 4 }
      await mouse('mouseMoved', p)
      await pause(120)
      await shot('k3f-autoscroll-drag')
      const s1 = await snapshot()
      return { scrollTop: s0.scrollTop, scrollTopAtDrop: s1.scrollTop, indicator: s1.indicator, p }
    },
  })
  await mouse('mouseReleased', scrollMid.p)
  await pause(250)
  snap = await snapshot()
  const gAfter = wtOrder(snap, gamma)
  check('K3f-autoscroll', 'K3ⓕ 가장자리에서 자동 스크롤 → 화면 밖이던 자리(맨 아래)에 놓인다', listRect.scrollHeight > listRect.clientHeight && !lastGVisibleBefore && scrollMid.scrollTop > 0 && gAfter[gAfter.length - 1] === firstG, { listRect, lastGVisibleBefore, during: scrollMid, gBefore: gOrder, gAfter })
  // ── K3ⓔ 후반 — 표시 줄이 붙은(sticky) 레포 헤더와 겹치는 자리에서도 헤더 위에 그려진다 ──
  // gamma 의 주 체크아웃·g-1 경계가 붙은 gamma 헤더 한가운데 오도록 스크롤하고, 아래 카드를 끌어 그 경계(slot 0)를 가리킨다.
  const stickyGeo = await cdp.evaluate(
    (root) => {
      const list = document.querySelector('[data-repo-list]')
      const group = [...list.querySelectorAll(':scope > [data-repo]')].find((el) => el.getAttribute('data-repo') === root)
      const rows = [...group.querySelectorAll('[data-worktree]')]
      const lr = list.getBoundingClientRect()
      const boundary = (rows[0].getBoundingClientRect().bottom + rows[1].getBoundingClientRect().top) / 2 - lr.top + list.scrollTop
      const headH = group.querySelector('[data-repo-head]').getBoundingClientRect().height
      // 경계를 헤더 윗변에서 12px 아래에 둔다 — 포인터(아래)는 g-1 윗부분이어야 slot 0 이고, 그 자리는 위 가장자리 자동 스크롤
      // 띠(56px) 안이라 프레임마다 몇 px 씩 내려온다. 헤더(28px) 안에 남을 여유를 둔다(run6: 헤더 가운데로 맞췄더니 포인터가 g-1 아랫부분 → slot 1).
      list.scrollTop = boundary - 12
      return { boundary, headH, scrollTop: list.scrollTop }
    },
    gamma,
  )
  await pause(200)
  const stickyCard = wtOrder(await snapshot(), gamma)[3]
  const stickyStart = await cardPoint(stickyCard)
  await mouse('mouseMoved', stickyStart, { buttons: 0 })
  await mouse('mousePressed', stickyStart)
  const approach = { x: listRect.left + 80, y: listRect.top + 80 }
  for (let index = 1; index <= 6; index++) {
    await mouse('mouseMoved', { x: stickyStart.x + ((approach.x - stickyStart.x) * index) / 6, y: stickyStart.y + ((approach.y - stickyStart.y) * index) / 6 })
    await pause(16)
  }
  // 한 번에 헤더 바로 아래(g-1 윗부분)로 — 자동 스크롤이 표시 줄을 헤더 밖으로 밀기 전에 잰다.
  const stickyPoint = { x: listRect.left + 80, y: listRect.top + 36 }
  await mouse('mouseMoved', stickyPoint)
  const stickyProbe = await cdp.evaluate((root) => {
    const ind = document.querySelector('[data-reorder-indicator]')
    const group = [...document.querySelectorAll('[data-repo-list] > [data-repo]')].find((el) => el.getAttribute('data-repo') === root)
    const head = group.querySelector('[data-repo-head]')
    if (!ind) return { indicator: false }
    const ir = ind.querySelector('.reorder-drop-bar').getBoundingClientRect()
    const hr = head.getBoundingClientRect()
    ind.style.pointerEvents = 'auto'
    const hit = document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2)
    ind.style.pointerEvents = ''
    return { indicator: true, bar: { top: ir.top, bottom: ir.bottom }, head: { top: hr.top, bottom: hr.bottom }, overlap: ir.top < hr.bottom && ir.bottom > hr.top, onTop: ind.contains(hit), hit: hit?.className ?? null, headStuck: hr.top <= document.querySelector('[data-repo-list]').getBoundingClientRect().top + 1 }
  }, gamma)
  await shot('k3e-indicator-over-sticky-header')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await mouse('mouseReleased', stickyPoint)
  await pause(200)
  check('K3e-sticky', 'K3ⓔ 붙은 레포 헤더와 겹친 자리에서 표시 줄이 헤더 위에 그려진다', stickyProbe.indicator === true && stickyProbe.headStuck === true && stickyProbe.overlap === true && stickyProbe.onTop === true, { stickyGeo, ...stickyProbe })
  await setViewport(cdp, { width: 1200, height: Number(args.height ?? 1500) })
  await cdp.evaluate(() => {
    document.querySelector('[data-repo-list]').scrollTop = 0
  })
  await pause(300)

  // ── K3ⓖ 드래그 중 hover 액션·메뉴 — 열린 ⋯ 메뉴는 닫히고 액션은 숨는다 ──
  await mouse('mouseMoved', await headerPoint(gamma), { buttons: 0 })
  await pause(150)
  await click(await pointOf({ attr: 'data-repo-menu-toggle', value: gamma }))
  const menuOpen = await cdp.evaluate(() => document.querySelector('.repo-row-menu') !== null)
  const gMid = await drag(await headerPoint(beta), await headerPoint(alpha, 0.5), {
    release: false,
    during: async () =>
      cdp.evaluate(() => ({
        menu: document.querySelector('.repo-row-menu') !== null,
        actionsOpacity: [...document.querySelectorAll('.repo-row-actions')].map((el) => getComputedStyle(el).opacity),
        cardActionsOpacity: [...document.querySelectorAll('.worktree-block-actions')].map((el) => getComputedStyle(el).opacity),
      })),
  })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await mouse('mouseReleased', await headerPoint(alpha, 0.5))
  check('K3g-menu-hover', 'K3ⓖ 드래그 중 열린 메뉴 닫힘·hover 액션 opacity 0', menuOpen && !gMid.menu && gMid.actionsOpacity.every((v) => v === '0') && gMid.cardActionsOpacity.every((v) => v === '0'), { menuOpenBefore: menuOpen, ...gMid })

  // ── K1ⓑ 오류 표시 레포 헤더도 끌린다 ──
  const delta = makeRepo('delta', [{ name: 'd-one' }])
  await rpc(control, { cmd: 'add-repo', root: delta })
  await waitFor(async () => {
    await rebuild()
    return repoOrder(await snapshot()).includes(delta)
  }, 'delta added', 60_000)
  snap = await snapshot()
  check('K5b-new-repo-bottom', 'K5ⓑ 새 레포 delta → 맨 아래, 기존 상대 순서 무변경', same(repoOrder(snap), [gamma, beta, alpha, delta]), repoOrder(snap))
  fs.renameSync(path.join(delta, '.git'), path.join(delta, '.git.l469off'))
  await waitFor(async () => {
    await rebuild()
    return (await snapshot()).repos.find((repo) => repo.root === delta)?.error !== null
  }, 'delta error', 60_000)
  await drag(await headerPoint(delta), await repoSlotPoint(0))
  snap = await snapshot()
  check('K1b-error', 'K1ⓑ 오류 표시 레포 delta 헤더 → 맨 위', same(repoOrder(snap), [delta, gamma, beta, alpha]) && snap.repos[0].error !== null, { order: repoOrder(snap), error: snap.repos[0].error })
  fs.renameSync(path.join(delta, '.git.l469off'), path.join(delta, '.git'))
  await rebuild()
  await shot('k1b-error-repo-top')

  // ── K4ⓑ·K5ⓐ 앱 밖 git worktree add/remove · 세션 열기/닫기 · 새로고침 ──
  const alphaBeforeAdd = wtOrder(await snapshot(), alpha)
  const fresh = addWorktree(alpha, { name: 'a-aaa-new' })
  await waitFor(async () => {
    await rebuild()
    return wtOrder(await snapshot(), alpha)?.includes(fresh)
  }, 'fresh worktree', 60_000)
  snap = await snapshot()
  const alphaWithNew = wtOrder(snap, alpha)
  check('K5a-new-worktree-top', 'K5ⓐ 앱 밖 git worktree add → 주 체크아웃 바로 아래, 기존 상대 순서 무변경', alphaWithNew[1] === fresh && same(alphaWithNew.filter((p) => p !== fresh), alphaBeforeAdd), { before: alphaBeforeAdd, after: alphaWithNew })
  git(alpha, 'worktree', 'remove', '--force', wtA('a-two'))
  await waitFor(async () => {
    await rebuild()
    return !wtOrder(await snapshot(), alpha)?.includes(wtA('a-two'))
  }, 'a-two removed', 60_000)
  snap = await snapshot()
  check('K4b-git-remove', 'K4ⓑ 앱 밖 git worktree remove → 남은 상대 순서 그대로', same(wtOrder(snap, alpha), alphaWithNew.filter((p) => p !== wtA('a-two'))), { before: alphaWithNew, after: wtOrder(snap, alpha) })
  const orderBeforeSession = { repos: repoOrder(snap), alpha: wtOrder(snap, alpha), beta: wtOrder(snap, beta) }
  await click(await cardPoint(wtB('b-two')))
  await waitFor(async () => (await snapshot()).repos.find((repo) => repo.root === beta)?.open.includes(wtB('b-two')), 'b-two open', 30_000)
  snap = await snapshot()
  const afterOpen = { repos: repoOrder(snap), alpha: wtOrder(snap, alpha), beta: wtOrder(snap, beta) }
  const bTwoWs = (await rpc(control, { cmd: 'state' })).state.repos.find((repo) => repo.root === beta).worktrees.find((row) => row.path === wtB('b-two')).openWorkspaceId
  // 닫기는 제품 UI 경로 — 카드 ⋯ → 「worktree 닫기」. 확인 모달이 뜨면 확인을 누른다.
  await mouse('mouseMoved', await cardPoint(wtB('b-two')), { buttons: 0 })
  await pause(150)
  await click(await pointOf({ attr: 'data-worktree-menu-toggle', value: wtB('b-two') }))
  await click(await pointOf({ attr: 'data-close-worktree', value: wtB('b-two') }))
  await pause(400)
  const confirmP = await pointOf({ attr: 'data-close-confirm-ok' })
  if (confirmP) await click(confirmP)
  log('closed workspace', bTwoWs)
  await waitFor(async () => !(await snapshot()).repos.find((repo) => repo.root === beta)?.open.includes(wtB('b-two')), 'b-two closed', 30_000).catch(() => null)
  snap = await snapshot()
  const afterClose = { repos: repoOrder(snap), alpha: wtOrder(snap, alpha), beta: wtOrder(snap, beta), bTwoOpen: snap.repos.find((repo) => repo.root === beta).open.includes(wtB('b-two')) }
  check('K4b-session-open-close', 'K4ⓑ 세션 열기/닫기 뒤 순서 무변경', same(orderBeforeSession, afterOpen) && same(orderBeforeSession, { repos: afterClose.repos, alpha: afterClose.alpha, beta: afterClose.beta }), { orderBeforeSession, afterOpen, afterClose })
  await click(await pointOf({ attr: 'data-refresh-tree' }))
  await rebuild()
  snap = await snapshot()
  check('K4b-refresh', 'K4ⓑ 목록 새로고침 뒤 순서 무변경', same({ repos: repoOrder(snap), alpha: wtOrder(snap, alpha), beta: wtOrder(snap, beta) }, orderBeforeSession), { repos: repoOrder(snap) })

  // ── K4ⓐ 재시작 3회 — 순서 그대로 ──
  for (let round = 1; round <= 3; round++) {
    const beforeQuit = await snapshot()
    const want = { repos: repoOrder(beforeQuit), wts: Object.fromEntries(beforeQuit.repos.map((repo) => [repo.root, repo.worktrees])) }
    const fileBefore = prefsHash()
    await quit(`R${round}`)
    await launch(`L${round + 1}`)
    await waitFor(async () => (await snapshot()).repos.length === want.repos.length && (await snapshot()).repos.every((repo) => repo.worktrees.length > 0), 'relaunch rendered', 90_000)
    await settle()
    const got = await snapshot()
    check(`K4a-restart-${round}`, `K4ⓐ 재시작 ${round}회차 — 레포·카드 순서 그대로`, same(repoOrder(got), want.repos) && same(Object.fromEntries(got.repos.map((repo) => [repo.root, repo.worktrees])), want.wts), { want, got: { repos: repoOrder(got) }, fileUnchangedByRestart: prefsHash() === fileBefore })
    await shot(`k4a-restart-${round}`)
  }

  // ── K4ⓑ 레포 제거(앱 밖 레지스트리) + K1ⓒ 레포 1개면 드래그 안 됨 ──
  const reg = JSON.parse(fs.readFileSync(env.CORRAL_REGISTRY, 'utf8'))
  const remaining = repoOrder(await snapshot()).filter((root) => root !== gamma)
  await quit('pre-remove')
  reg.repos = reg.repos.filter((row) => fs.realpathSync(row.path) !== gamma)
  fs.writeFileSync(env.CORRAL_REGISTRY, JSON.stringify(reg, null, 2) + '\n')
  await launch('L-removed')
  await waitFor(async () => (await snapshot()).repos.length === remaining.length, 'after remove', 90_000)
  snap = await snapshot()
  check('K4b-repo-removed', 'K4ⓑ 레포 제거(gamma) 뒤 남은 레포 상대 순서 그대로', same(repoOrder(snap), remaining), { want: remaining, got: repoOrder(snap) })
  await quit('pre-single')
  const regSingle = JSON.parse(fs.readFileSync(env.CORRAL_REGISTRY, 'utf8'))
  regSingle.repos = regSingle.repos.filter((row) => fs.realpathSync(row.path) === beta)
  fs.writeFileSync(env.CORRAL_REGISTRY, JSON.stringify(regSingle, null, 2) + '\n')
  await launch('L-single')
  await waitFor(async () => (await snapshot()).repos.length === 1, 'single repo', 90_000)
  hash = prefsHash()
  const singleP = await headerPoint(beta)
  const singleMid = await drag(singleP, { x: singleP.x, y: singleP.y + 80 }, { during: async () => snapshot() })
  snap = await snapshot()
  check('K1c-single-repo', 'K1ⓒ 레포 1개면 헤더 드래그가 시작되지 않는다', !singleMid.reordering && !singleMid.indicator && prefsHash() === hash, { during: { reordering: singleMid.reordering, indicator: singleMid.indicator } })

  fs.writeFileSync(path.join(out, 'prefs-final.json'), JSON.stringify(readPrefs(), null, 2))
}

let exitCode = 0
try {
  // 멈춘 회차가 영영 안 끝나지 않게 — 상한을 넘기면 실패로 정리한다(run2 에서 화면 밖 좌표로 멈춘 전례).
  await Promise.race([main(), pause(Number(args.limitMs ?? 540_000)).then(() => Promise.reject(new Error('하네스 시간 상한 초과')))])
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
    } catch {}
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
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify({ work, port, spawned, aliveAfterCleanup: alive, total: checks.length, failed: failed.map((row) => row.id), exitCode, checks }, null, 2),
  )
  log(`checks ${checks.length - failed.length}/${checks.length} pass; alive after cleanup: ${JSON.stringify(alive)}`)
  process.exit(exitCode)
}
