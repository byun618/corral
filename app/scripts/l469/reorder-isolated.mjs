// LIFE-469 격리 실행 — 사이드바 순서 옮기기 K1~K5 (+K3·K4ⓑ·K6 격리 쪽).
//
// 격리: 전용 work 폴더(--work, 기본 /tmp/l469i) 아래 userData·ui-prefs·herdr 세션·제어 소켓·fixture 레포.
// 사용자 기본 userData·herdr 기본 세션·설치본 Orca 는 건드리지 않는다. 입력은 **CDP Input**(이 인스턴스의 디버깅 포트
// 페이지에만 간다 — OS 커서를 움직이지 않는다). 네이티브 OS 입력(cliclick)은 K8 에서 따로 한다.
//
// 사용: node app/scripts/l469/reorder-isolated.mjs --out <raw 폴더> [--work /tmp/l469i] [--port 9469]
// 결과: <out>/result.json (검사 행 전부) · <out>/shots/*.png · <out>/prefs-*.json. 종료코드 0 = 전 검사 통과.
//
// 수정 라운드 1 옵션 —
//   --omit-drag <검사 id>   그 검사의 드래그를 빼먹는다(음성 대조 — 그 검사가 **실패해야** 판정이 살아 있다, R1-07)
//   --stop-after <검사 id>  그 검사까지만 돌고 정리한다(재현 시도용)
//   --no-focus-emulation    포커스 에뮬레이션을 끈다(run3 조건 재현)
//   --trace                 입력 이벤트(좌표·buttons·시각·표시 줄 위치·카드 경계)를 페이지 안팎에서 기록 → <out>/trace-<검사 id>.json
//
// LIFE-477 K9 옵션 —
//   --display detailed|compact|full  시작 prefs 에 카드 표시 칸을 싣는다(Detailed 기본 · Compact 카드 · Detailed+Full list).
//                                    Compact 카드는 에이전트 목록을 그리지 않으므로(198 F4) 「에이전트 행」 기대는 0 행으로,
//                                    Full list 는 알약이 없으므로 묶음 기대는 「알약 없이 행 2개」로 바뀐다. 그 밖의 검사는 같다.
//
// LIFE-478 K5ⓕ 옵션 —
//   --pin   gamma 에 워크트리 g-pin 을 하나 더 만들고 시작 prefs 에 고정(pinnedWorktrees)해 둔다. 고정 카드는 맨 위 「고정됨」 구획에만
//           있고(단일 위치) 끌기 대상이 아니므로 gamma 그룹 카드 수·순서 기대는 그대로다. 끝에 고정 구획이 그대로인지 검사를 더한다.
//           sticky 검사의 고정 스크롤 값(40px)은 고정 구획 높이만큼 더한다(구획이 맨 위에 하나 더 있다).
//
// 게이트 ① 사용자 수정 1 — 주 체크아웃도 옮긴다(K2ⓑ'): 카드 경계 번호는 **주 체크아웃 포함** 그 레포 카드 전체 기준이다.
// 옛 K2b-main-no-drag·K2b-not-above-main 은 K2b'-main-drag·K2b'-above-main 으로 바꿨다. K3ⓗ 미리 보기 검사를 더했다.

/* global document, window, getComputedStyle, KeyboardEvent, Event, DOMMatrixReadOnly -- CDP evaluate 로 페이지 안에서 도는 클로저가 쓴다 */
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
const display = String(args.display ?? 'detailed')
if (!['detailed', 'compact', 'full'].includes(display)) throw new Error(`--display ${display}`)
const DISPLAY_PREFS = {
  detailed: {},
  compact: { sidebarCardLayout: 'compact', sidebarCardProperties: [], sidebarAgentActivityLayout: 'compact' },
  full: { sidebarCardLayout: 'detailed', sidebarCardProperties: ['inline-agents'], sidebarAgentActivityLayout: 'full' },
}[display]
/** 에이전트 행 기대 — Compact 카드는 목록이 없다(0 행), 그 밖은 1 행 이상. */
const pinMode = args.pin === true
const agentRowsOk = (count) => (display === 'compact' ? count === 0 : count > 0)
const out = path.resolve(String(args.out ?? 'l469-iso-out'))
const port = Number(args.port ?? 9469)
const shots = path.join(out, 'shots')
fs.mkdirSync(shots, { recursive: true })

const checks = []
const t0 = Date.now()
const log = (...parts) => console.log(`[l469 +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)
class StopAfter extends Error {}
const cdpTrace = []
function check(id, criterion, pass, observed) {
  checks.push({ id, criterion, pass: pass === true, observed })
  log(pass ? 'PASS' : 'FAIL', id, criterion, JSON.stringify(observed).slice(0, 300))
  if (args['stop-after'] === id) throw new StopAfter(id)
}

/**
 * 기대 순서 — `slot` 은 제품과 같은 경계 번호(0 = 맨 앞, 길이 = 맨 뒤). 판정은 이 배열 **전체**와 대조한다(R1-07:
 * 「가운데에 있다」 같은 느슨한 조건은 움직이지 않아도 통과했다).
 */
function moveTo(list, key, slot) {
  const from = list.indexOf(key)
  if (from < 0) return null
  const bounded = Math.max(0, Math.min(list.length, slot))
  const to = bounded > from ? bounded - 1 : bounded
  const rest = list.filter((item) => item !== key)
  rest.splice(to, 0, key)
  return rest
}

/**
 * 미리 보기 기대값 — 제품(`buildReorderPreview`)과 따로 쓴 같은 규칙(198 `buildWorktreeDragPreviewOffsets`): 바뀐 순서를 밀리기
 * 전 높이와 각 항목 뒤 틈(마지막은 틈 중앙값)으로 첫 윗변부터 다시 쌓는다. `offsets[i]` = 새 윗변 − 지금 윗변(끄는 항목 0),
 * `landedTop` = 끄는 항목이 들어갈 윗변(제자리면 지금 윗변).
 */
function expectedPreview(rects, from, slot) {
  const order = moveTo(rects.map((_, index) => index), from, slot)
  const gaps = rects.slice(1).map((rect, index) => Math.max(0, rect.top - rects[index].bottom))
  const sorted = [...gaps].sort((a, b) => a - b)
  const fallback = sorted[Math.floor(sorted.length / 2)] ?? 0
  const offsets = rects.map(() => 0)
  let top = rects[0].top
  let landedTop = rects[from].top
  for (const index of order) {
    if (index === from) landedTop = top
    else offsets[index] = Math.abs(top - rects[index].top) < 0.5 ? 0 : top - rects[index].top
    top += rects[index].bottom - rects[index].top + (gaps[index] ?? fallback)
  }
  return { offsets, landedTop }
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
  if (args['no-focus-emulation'] !== true) await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  if (args.trace === true) await cdp.evaluate(installTrace)
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
    } catch {
      // 이미 끝났다 — 아래 대기가 확인한다.
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

// --- 계측(--trace, run3 재현 시도) ----------------------------------------------------------------------
// 페이지 쪽: 문서 capture 리스너(제품 hook 보다 먼저 등록돼 mouseup 때 표시 줄이 아직 있다)가 좌표·buttons·시각·표시 줄 y·
// 스크롤·(mouseup 때) 카드 경계를 남긴다. 하네스 쪽: CDP 로 보낸 입력의 보낸 시각·응답 시각.
function installTrace() {
  window.__l469trace = []
  const record = (event) => {
    const list = document.querySelector('[data-repo-list]')
    const indicator = document.querySelector('[data-reorder-indicator]')
    const row = { type: event.type, x: event.clientX, y: event.clientY, button: event.button, buttons: event.buttons, t: performance.now(), wall: Date.now(), indicatorTop: indicator ? parseFloat(indicator.style.top) : null, scrollTop: list?.scrollTop ?? null }
    if (event.type === 'mouseup' && list) {
      const top = list.getBoundingClientRect().top - list.scrollTop
      row.cards = [...document.querySelectorAll('[data-reorder-card]')].map((card) => {
        const r = card.getBoundingClientRect()
        return { path: card.getAttribute('data-reorder-card'), top: r.top - top, bottom: r.bottom - top }
      })
    }
    window.__l469trace.push(row)
  }
  for (const type of ['mousedown', 'mousemove', 'mouseup', 'click']) document.addEventListener(type, record, true)
  return true
}
async function traceDump(id) {
  if (args.trace !== true) return
  const page = await cdp.evaluate(() => {
    const rows = window.__l469trace ?? []
    window.__l469trace = []
    return rows
  })
  fs.writeFileSync(path.join(out, `trace-${id}.json`), JSON.stringify({ id, focusEmulation: args['no-focus-emulation'] !== true, cdp: cdpTrace.splice(0), page }, null, 1))
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

async function mouse(type, p, extra = {}) {
  const params = { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: extra.buttons ?? (type === 'mouseReleased' ? 0 : 1), clickCount: type === 'mouseMoved' ? 0 : 1, ...extra }
  const sent = Date.now()
  const result = await cdp.send('Input.dispatchMouseEvent', params)
  if (args.trace === true) cdpTrace.push({ type, x: p.x, y: p.y, buttons: params.buttons, sent, acked: Date.now() })
  return result
}

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
/** 순서를 바꾸는 드래그 — `--omit-drag <id>` 면 빼먹는다(음성 대조). */
async function dragFor(id, start, end, options) {
  if (args['omit-drag'] === id) {
    log('OMIT drag for', id, '(음성 대조)')
    return null
  }
  return drag(start, end, options)
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
  const gPin = pinMode ? addWorktree(gamma, { name: 'g-pin' }) : null
  // 경로는 미리 정규화해 둔다 — 삭제 뒤(git worktree remove)에도 같은 키로 찾는다.
  const realRepos = fs.realpathSync(reposDir)
  const wtA = (name) => path.join(realRepos, 'alpha-wt', name)
  const wtB = (name) => path.join(realRepos, 'beta-wt', name)

  // K6 — 469 이전 모양 ui-prefs(사용자 파일 키 구성 k6-user-ui-prefs-keys.json 과 같은 칸, 값은 지어낸 것).
  const legacy = { version: 1, sidebarWidth: 300, sidebarCollapsed: false, collapsedRepos: [], collapsedGroups: ['/x/old'], expandedAgentGroups: ['/x/exp'], tabOrdinals: [{ tabId: 'w9:t1', groupId: 'w9', ordinal: 3 }], groupLayouts: [{ worktree: '/x/wt', v: 1 }] }
  fs.writeFileSync(prefsFile, JSON.stringify({ ...legacy, ...DISPLAY_PREFS, ...(pinMode ? { pinnedWorktrees: [gPin] } : {}) }, null, 2) + '\n')
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
  check('K6c-1', 'K6ⓒ 첫 드래그 전 materialize 기록(파일을 쓴다 — 주 체크아웃 포함, 게이트 ① 수정 1)', same(firstPrefs?.manualRepoOrder, byName) && same(firstPrefs?.manualWorktreeOrder?.[alpha], expectAlpha), {
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
  if (display !== 'compact') await waitFor(async () => ((await snapshot()).repos.find((repo) => repo.root === alpha)?.agentRows?.[wtA('a-one')] ?? 0) > 0, 'agent row', 30_000).catch(() => null)
  // 새로 연 worktree 는 열기만 하고 활성으로 바꾸지 않는 경로가 있다(기존 동작) — 한 번 더 눌러 고른다.
  await click(await cardPoint(wtA('a-one')))
  await waitFor(async () => (await snapshot()).repos.find((repo) => repo.root === alpha)?.selected?.[0] === wtA('a-one'), 'a-one selected', 15_000).catch(() => null)
  snap = await snapshot()
  const alphaBefore = snap.repos.find((repo) => repo.root === alpha)
  check('prep', '준비: a-one 선택·열림·에이전트 행, a-three 열림', alphaBefore.selected[0] === wtA('a-one') && alphaBefore.open.includes(wtA('a-three')) && agentRowsOk(alphaBefore.agentRows[wtA('a-one')]), { display, ...alphaBefore })

  // ── K1ⓐ 레포 헤더 — 맨 위·맨 아래·가운데 ──
  await dragFor('K1a-top', await headerPoint(gamma), await repoSlotPoint(0))
  snap = await snapshot()
  await traceDump('K1a-top')
  check('K1a-top', 'K1ⓐ gamma 헤더 → 맨 위', same(repoOrder(snap), [gamma, alpha, beta]), repoOrder(snap))
  check('K1a-top-file', 'K1ⓐ 파일에도 같은 순서', same(readPrefs().manualRepoOrder, [gamma, alpha, beta]), readPrefs().manualRepoOrder)
  await dragFor('K1a-bottom', await headerPoint(alpha), await repoSlotPoint(3))
  snap = await snapshot()
  check('K1a-bottom', 'K1ⓐ alpha 헤더 → 맨 아래', same(repoOrder(snap), [gamma, beta, alpha]), repoOrder(snap))
  await dragFor('K1a-middle', await headerPoint(alpha), await repoSlotPoint(1))
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
  // 카드 경계 번호는 주 체크아웃 포함 — 1 = 주 체크아웃 바로 아래(연결 맨 위).
  let want = moveTo(before, wtA('a-two'), 1)
  await dragFor('K2a-top-closed', await cardPoint(wtA('a-two')), await cardSlotPoint(alpha, 1))
  let after = await alphaWts()
  await traceDump('K2a-top-closed')
  check('K2a-top-closed', 'K2ⓐ·ⓒ 닫힌 카드 a-two → 맨 위(주 체크아웃 아래) — 기대 배열 전체 대조', same(after, want) && !same(before, want), { before, want, after })
  before = after
  want = moveTo(before, wtA('a-det'), before.length)
  await dragFor('K2a-bottom-detached', await cardPoint(wtA('a-det')), await cardSlotPoint(alpha, 9))
  after = await alphaWts()
  check('K2a-bottom-detached', 'K2ⓐ·ⓒ detached 카드 a-det → 맨 아래 — 기대 배열 전체 대조', same(after, want) && !same(before, want), { before, want, after })
  before = after
  snap = await snapshot()
  const selBefore = snap.repos.find((repo) => repo.root === alpha).selected
  // 경계 4 = 셋째 연결 카드 앞(주 체크아웃 포함 번호). a-one 이 이미 가운데여도 자리는 바뀐다(run10: [two,one,three,det] → [two,three,one,det]).
  want = moveTo(before, wtA('a-one'), 4)
  await dragFor('K2a-middle-selected-agent', await cardPoint(wtA('a-one')), await cardSlotPoint(alpha, 4))
  after = await alphaWts()
  snap = await snapshot()
  const alphaNow = snap.repos.find((repo) => repo.root === alpha)
  check('K2a-middle-selected-agent', 'K2ⓐ·ⓒ 선택+에이전트 카드 a-one → 가운데 — 기대 배열 전체 대조(이동 없음이면 실패)', same(after, want) && !same(before, want), { before, want, after })
  check('K2e-selected-kept', 'K2ⓔ 드래그 뒤 선택·열림·에이전트 행 유지', same(alphaNow.selected, selBefore) && alphaNow.open.includes(wtA('a-one')) && agentRowsOk(alphaNow.agentRows[wtA('a-one')]), { display, ...alphaNow })
  before = after
  want = moveTo(before, wtA('a-three'), 1)
  await dragFor('K2c-open-unselected', await cardPoint(wtA('a-three')), await cardSlotPoint(alpha, 1))
  after = await alphaWts()
  snap = await snapshot()
  check('K2c-open-unselected', 'K2ⓒ 열린 비선택 카드 a-three → 연결 맨 위(주 체크아웃 아래, 기대 배열 전체), 드래그 뒤 선택 무변경(클릭 없음)', same(after, want) && !same(before, want) && same(snap.repos.find((repo) => repo.root === alpha).selected, selBefore), { before, want, after, selected: snap.repos.find((repo) => repo.root === alpha).selected })
  const fileWt = readPrefs().manualWorktreeOrder[alpha]
  check('K2a-file', 'K2ⓐ 파일의 alpha 순서 = 화면(주 체크아웃 포함 — 게이트 ① 수정 1)', same(fileWt, after), { file: fileWt, screen: after })

  // ── K2ⓑ' 주 체크아웃 이동(게이트 ① 사용자 수정 1 — K2ⓑ 고정 폐지). 옛 K2b-main-no-drag·K2b-not-above-main 을 바꿨다 ──
  // ① 다른 카드를 주 체크아웃 위(경계 0)에 놓는다 → 그 카드가 맨 위, 주 체크아웃이 둘째.
  before = await alphaWts()
  let hash = prefsHash()
  const lastLinked = before[before.length - 1]
  want = moveTo(before, lastLinked, 0)
  const aboveMid = await dragFor("K2b'-above-main", await cardPoint(lastLinked), await cardSlotPoint(alpha, 0), { during: async () => snapshot() })
  after = await alphaWts()
  check("K2b'-above-main", "K2ⓑ' 다른 카드를 주 체크아웃 위에 놓으면 맨 위로(주 체크아웃이 둘째) — 표시 줄 있음, 기대 배열 전체, 파일 = 화면", aboveMid?.indicator === true && same(after, want) && !same(before, want) && after[1] === alpha && same(readPrefs().manualWorktreeOrder[alpha], after), { before, want, after, dropped: lastLinked, file: readPrefs().manualWorktreeOrder[alpha], duringIndicator: aboveMid?.indicator ?? null })
  // ② 주 체크아웃 카드를 끌어 맨 아래로 → 재시작 뒤에도 맨 아래(K4ⓐ 에서 K2b'-restart 로 본다).
  before = after
  want = moveTo(before, alpha, before.length)
  const mainMid = await dragFor("K2b'-main-drag", await cardPoint(alpha), await cardSlotPoint(alpha, 99), { during: async () => snapshot() })
  after = await alphaWts()
  snap = await snapshot()
  check("K2b'-main-drag", "K2ⓑ' 주 체크아웃 카드가 끌린다 — 드래그 상태·표시 줄 있음, 맨 아래로(기대 배열 전체), 파일 = 화면, 선택 무변경", mainMid?.reordering === true && mainMid?.indicator === true && same(after, want) && !same(before, want) && same(readPrefs().manualWorktreeOrder[alpha], after) && same(snap.repos.find((repo) => repo.root === alpha).selected, selBefore), { before, want, after, file: readPrefs().manualWorktreeOrder[alpha], during: { reordering: mainMid?.reordering ?? null, indicator: mainMid?.indicator ?? null }, selected: snap.repos.find((repo) => repo.root === alpha).selected })
  const mainMovedOrder = after

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
  // ── R1-01 목록과 x 는 같고 y 만 위·아래 바깥 — 놓으면 취소(자동 스크롤 허용 띠 안이어도) ──
  for (const kind of ['header', 'card']) {
    for (const side of ['above', 'below']) {
      before = await snapshot()
      hash = prefsHash()
      const lr = await cdp.evaluate(() => {
        const r = document.querySelector('[data-repo-list]').getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, innerHeight: window.innerHeight }
      })
      const start = kind === 'header' ? await headerPoint(alpha) : await cardPoint(wtA('a-two'))
      const end = { x: start.x, y: side === 'above' ? lr.top - 20 : Math.min(lr.innerHeight - 2, lr.bottom + 20) }
      const mid = await drag(start, end, { during: async () => snapshot() })
      after = await snapshot()
      check(`K3b-outside-y-${kind}-${side}`, `K3ⓑ(R1-01) ${kind === 'header' ? '헤더' : '카드'} 목록 ${side === 'above' ? '위' : '아래'} 20px 바깥 놓기 = 취소(표시 줄 없음·화면·파일 무변경)`, !mid.indicator && same(repoOrder(before), repoOrder(after)) && same(wtOrder(before, alpha), wtOrder(after, alpha)) && prefsHash() === hash, { list: lr, end, duringIndicator: mid.indicator, before: repoOrder(before), after: repoOrder(after) })
    }
  }

  // ── R1-02 같은 헤더 안 6px → Escape → 100ms 뒤 놓기 = 접힘 무변경 · 그 뒤 정상 클릭 = 접힘 ──
  {
    before = await snapshot()
    hash = prefsHash()
    const hp = await headerPoint(beta)
    const collapsedBefore = before.repos.find((repo) => repo.root === beta).collapsed
    const moved = { x: hp.x + 6, y: hp.y }
    const mid = await drag(hp, moved, {
      steps: 3,
      release: false,
      during: async () => {
        const s = await snapshot()
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await pause(100)
        return s
      },
    })
    await mouse('mouseReleased', moved)
    await pause(250)
    const afterLate = await snapshot()
    const lateCollapsed = afterLate.repos.find((repo) => repo.root === beta).collapsed
    // 파일 대조는 정상 클릭 **전**에 한다 — 정상 클릭은 접힘 칸을 바꾼다(run11: 클릭 뒤에 대조해 실패로 셌다).
    const lateFileSame = prefsHash() === hash
    await click(await headerPoint(beta))
    const normalCollapsed = (await snapshot()).repos.find((repo) => repo.root === beta).collapsed
    check('K3b-escape-late-release', 'K3ⓑ(R1-02) 같은 헤더 6px → Escape → 100ms 뒤 놓기 = 접힘 무변경·순서·파일 무변경, 그 뒤 정상 클릭 = 접힘 토글', mid.reordering && lateCollapsed === collapsedBefore && same(repoOrder(before), repoOrder(afterLate)) && lateFileSame && normalCollapsed === !collapsedBefore, { duringReordering: mid.reordering, collapsedBefore, lateCollapsed, lateFileSame, normalCollapsed })
    await click(await headerPoint(beta)) // 되돌린다
  }

  // ── K3ⓒ C4 SVG 아이콘에서 끌기 → 드래그 열림 + 글자 선택 없음 ──
  before = await snapshot()
  const iconP = await pointOf({ attr: 'data-repo-toggle', value: beta, inner: '.repo-row-icon-glyph' })
  const iconWant = moveTo(repoOrder(before), beta, before.repos.length)
  const iconMid = await drag(iconP, await repoSlotPoint(3), { during: async () => snapshot() })
  after = await snapshot()
  check('K3c-svg-icon', 'K3ⓒ SVG 폴더 아이콘에서 끌어도 드래그가 열리고 놓인다(기대 배열 전체), 글자 선택 없음', iconMid.reordering && iconMid.indicator && same(repoOrder(after), iconWant) && !same(repoOrder(before), iconWant) && iconMid.selection === '' && after.selection === '', { during: { reordering: iconMid.reordering, selection: iconMid.selection }, want: iconWant, after: repoOrder(after), selection: after.selection })

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
  const k3eStart = await cardPoint(wtA('a-two'))
  const k3eEnd = await cardSlotPoint(alpha, 2)
  const indicatorProbe = await drag(k3eStart, k3eEnd, {
    release: false,
    during: async () => {
      await shot('k3e-card-drag-indicator')
      return cdp.evaluate(() => {
        const ind = document.querySelector('[data-reorder-indicator]')
        if (!ind) {
          // run11 에서 한 번 표시 줄이 없었다(원인 미확정) — 그때의 상태를 남긴다.
          const list = document.querySelector('[data-repo-list]')
          const lr = list.getBoundingClientRect()
          const src = document.querySelector('.is-reorder-source')
          return {
            missing: true,
            reordering: document.querySelector('.sidebar.is-reordering') !== null,
            bodyClass: document.body.className,
            hasFocus: document.hasFocus(),
            list: { top: lr.top, bottom: lr.bottom, left: lr.left, right: lr.right, scrollTop: list.scrollTop },
            source: src ? src.getAttribute('data-reorder-card') ?? src.getAttribute('data-repo') : null,
            cards: [...document.querySelectorAll('[data-reorder-card]')].map((card) => ({ path: card.getAttribute('data-reorder-card'), top: card.getBoundingClientRect().top, bottom: card.getBoundingClientRect().bottom })),
          }
        }
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
  fs.writeFileSync(path.join(out, 'k3e-indicator-probe.json'), JSON.stringify({ start: k3eStart, end: k3eEnd, probe: indicatorProbe }, null, 2))
  await traceDump('K3e-indicator-values')
  check(
    'K3e-indicator-values',
    'K3ⓔ 표시 줄 = 198 값(점 6px 둥근·막대 2px·ring #737373·바탕 2px 그림자·z30>헤더 z20·left 12/right 8)',
    indicatorProbe !== null && indicatorProbe.missing !== true &&
      indicatorProbe.dotCount === 2 &&
      indicatorProbe.dot.w === 6 && indicatorProbe.dot.h === 6 && indicatorProbe.bar.h === 2 &&
      indicatorProbe.dot.bg === 'rgb(115, 115, 115)' && indicatorProbe.bar.bg === 'rgb(115, 115, 115)' &&
      indicatorProbe.dot.shadow.includes('0px 0px 0px 2px') && indicatorProbe.dot.shadow.includes(indicatorProbe.sidebarBg) &&
      Number(indicatorProbe.z) === 30 && Number(indicatorProbe.headZ) === 20 && indicatorProbe.pointerEvents === 'none' &&
      Math.abs(indicatorProbe.left - 12) < 0.5 && Math.abs(indicatorProbe.rightGap - 8) < 0.5,
    indicatorProbe,
  )

  // ── K3ⓗ 드래그 미리 보기(게이트 ① 사용자 수정 1) — 사본·행 밀림(198 값)·밀리기 전 판정·표시 줄 = 결과·취소 잔존 없음·캡처 ──
  /** 드래그 중 미리 보기 상태. `kind` 'card' 면 `root` 레포의 카드, 'repo' 면 레포 묶음의 밀림을 읽는다. */
  const previewProbe = (query) =>
    cdp.evaluate((q) => {
      const list = document.querySelector('[data-repo-list]')
      const groups = [...list.querySelectorAll(':scope > [data-repo]')]
      const items = q.kind === 'card' ? [...groups.find((g) => g.getAttribute('data-repo') === q.root).querySelectorAll('[data-reorder-card]')] : groups
      const keyOf = (el) => el.getAttribute(q.kind === 'card' ? 'data-reorder-card' : 'data-repo')
      const m42 = (el) => {
        const t = getComputedStyle(el).transform
        return t === 'none' ? 0 : new DOMMatrixReadOnly(t).m42
      }
      const previews = [...document.querySelectorAll('[data-sidebar-drag-preview="true"]')]
      const p = previews[0]
      const ps = p ? getComputedStyle(p) : null
      const ind = document.querySelector('[data-reorder-indicator]')
      const ir = ind?.getBoundingClientRect()
      const src = list.querySelector('.is-reorder-source')
      return {
        previewCount: previews.length,
        preview: p
          ? {
              kind: p.getAttribute('data-sidebar-drag-preview-kind'),
              top: p.getBoundingClientRect().top,
              left: p.getBoundingClientRect().left,
              opacity: ps.opacity,
              filter: ps.filter,
              zIndex: ps.zIndex,
              transform: ps.transform,
              position: ps.position,
              pointerEvents: ps.pointerEvents,
              inSidebar: p.closest('.sidebar') !== null,
              text: p.textContent.slice(0, 80),
            }
          : null,
        shifts: Object.fromEntries(items.map((el) => [keyOf(el), m42(el)])),
        inlineShifts: [...list.querySelectorAll('[style*="transform"]')].length,
        transition: items[0] ? getComputedStyle(items[0]).transition : null,
        sourceOpacity: src ? getComputedStyle(src).opacity : null,
        shiftingClass: list.classList.contains('is-reorder-shifting'),
        indicatorY: ir ? ir.top + ir.height / 2 : null,
        scrollTop: list.scrollTop,
      }
    }, query)
  /** 밀리기 전(드래그 전) 사각형 — 화면 좌표. */
  const itemRects = (query) =>
    cdp.evaluate((q) => {
      const list = document.querySelector('[data-repo-list]')
      const groups = [...list.querySelectorAll(':scope > [data-repo]')]
      const items = q.kind === 'card' ? [...groups.find((g) => g.getAttribute('data-repo') === q.root).querySelectorAll('[data-reorder-card]')] : groups
      return items.map((el) => ({ key: el.getAttribute(q.kind === 'card' ? 'data-reorder-card' : 'data-repo'), top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }))
    }, query)
  /** 놓은 뒤 그 항목 윗변(화면). */
  const topOf = (query, key) => itemRects(query).then((rows) => rows.find((row) => row.key === key)?.top ?? null)
  const near = (a, b, tolerance = 1.5) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance
  const shiftsMatch = (got, rects, offsets) => rects.every((rect, index) => near(got[rect.key] ?? 0, offsets[index], 0.6))

  for (const kind of ['card', 'repo']) {
    const query = kind === 'card' ? { kind, root: alpha } : { kind }
    const rects = await itemRects(query)
    const keys = rects.map((rect) => rect.key)
    // 카드: 셋째 카드를 경계 1(첫 카드 아래)로. 레포: 마지막 레포를 경계 1 로(gamma 아래) — 둘 다 들어갈 자리가 화면 안이다.
    const moving = kind === 'card' ? keys[2] : keys[keys.length - 1]
    const slot = 1
    const from = keys.indexOf(moving)
    const wantOrder = moveTo(keys, moving, slot)
    const expected = expectedPreview(rects, from, slot)
    const start = kind === 'card' ? await cardPoint(moving) : await headerPoint(moving)
    const grabTop = kind === 'card' ? rects[from].top : (await pointOf({ attr: 'data-repo', value: moving, inner: '[data-repo-head]' })).rect.top
    const end = kind === 'card' ? await cardSlotPoint(alpha, slot) : await repoSlotPoint(slot)
    hash = prefsHash()
    const mid = await dragFor(`K3h-${kind}`, start, end, {
      release: false,
      holdMs: 400,
      during: async () => {
        // 같은 자리에 머무는 동안 여러 번 읽는다 — 밀린 행 위에서도 판정·표시 줄이 흔들리지 않는다(ⓒ).
        const samples = []
        for (let index = 0; index < 4; index++) {
          await mouse('mouseMoved', end)
          await pause(80)
          samples.push(await previewProbe(query))
        }
        await shot(`k3h-${kind}-drag-preview`)
        return samples
      },
    })
    await mouse('mouseReleased', end)
    await pause(300)
    const afterOrder = kind === 'card' ? wtOrder(await snapshot(), alpha) : repoOrder(await snapshot())
    const landedTop = await topOf(query, moving)
    const last = mid?.at(-1) ?? null
    const stable = mid !== null && mid.every((sample) => sample.indicatorY === last.indicatorY && same(sample.shifts, last.shifts))
    fs.writeFileSync(path.join(out, `k3h-${kind}-probe.json`), JSON.stringify({ rects, moving, slot, start, end, grabTop, expected, samples: mid, afterOrder, landedTop }, null, 2))
    check(
      `K3h-a-${kind}`,
      `K3ⓗⓐ ${kind === 'card' ? '카드' : '레포 헤더(묶음)'} 반투명 사본 1개가 커서를 따라온다 — 198 값(opacity .96·drop-shadow·z 2147483000·scale 1.015·fixed·포인터 무시), 잡은 점 유지, 원래 행 투명`,
      last !== null && last.previewCount === 1 && last.preview.kind === kind && last.preview.opacity === '0.96' && last.preview.filter.includes('drop-shadow') &&
        last.preview.zIndex === '2147483000' && last.preview.transform.startsWith('matrix(1.015') && last.preview.position === 'fixed' &&
        last.preview.pointerEvents === 'none' && last.preview.inSidebar && near(last.preview.top, end.y - (start.y - grabTop)) && last.sourceOpacity === '0',
      { preview: last?.preview ?? null, previewCount: last?.previewCount ?? null, sourceOpacity: last?.sourceOpacity ?? null, wantTop: end.y - (start.y - grabTop) },
    )
    check(
      `K3h-b-${kind}`,
      `K3ⓗⓑ 다른 행이 밀려 자리를 벌린다 — 이동량 = 바뀐 순서를 실측 높이·틈으로 다시 쌓은 값(198 buildWorktreeDragPreviewOffsets), 전환 transform 150ms ease-out`,
      last !== null && shiftsMatch(last.shifts, rects, expected.offsets) && expected.offsets.some((offset) => offset !== 0) && last.shiftingClass && String(last.transition).includes('transform 0.15s ease-out'),
      { got: last?.shifts ?? null, want: Object.fromEntries(rects.map((rect, index) => [rect.key, expected.offsets[index]])), transition: last?.transition ?? null },
    )
    check(
      `K3h-c-${kind}`,
      `K3ⓗⓒ 판정은 밀리기 전 기하 — 머무는 동안 표시 줄·밀림이 흔들리지 않고, 표시 줄 = 놓은 뒤 그 항목 윗변(= 기대 자리), 결과 = 기대 배열 전체`,
      stable && same(afterOrder, wantOrder) && !same(keys, wantOrder) && near(last.indicatorY, expected.landedTop) && near(landedTop, last.indicatorY),
      { stable, indicatorY: last?.indicatorY ?? null, expectedLandedTop: expected.landedTop, landedTop, before: keys, want: wantOrder, after: afterOrder },
    )
    const residue = await previewProbe(query)
    check(
      `K3h-d-drop-${kind}`,
      `K3ⓗⓓ 놓은 뒤 사본·밀림·밀림 class 잔존 없음`,
      residue.previewCount === 0 && residue.inlineShifts === 0 && !residue.shiftingClass && residue.sourceOpacity === null,
      residue,
    )
    // 되돌린다 — 뒤 검사(K3ⓕ 의 gamma 맨 위 등)가 기대는 순서.
    if (kind === 'repo') {
      await drag(await headerPoint(moving), await repoSlotPoint(keys.length))
      const restored = repoOrder(await snapshot())
      check('K3h-repo-restore', 'K3ⓗ 레포 순서 되돌리기', same(restored, keys), { want: keys, got: restored })
    }
  }

  // ── K3ⓗⓓ 취소 — Escape · blur · 목록 밖 놓기 · 드래그 중 목록 갱신으로 source 소멸: 사본 제거·행 원위치·잔존 없음 ──
  const cancelWays = {
    escape: async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    },
    blur: async () => cdp.evaluate(() => window.dispatchEvent(new Event('blur'))),
    outside: async () => {
      await mouse('mouseMoved', { x: 900, y: 300 })
    },
  }
  for (const [way, cancel] of Object.entries(cancelWays)) {
    const query = { kind: 'card', root: alpha }
    const before = wtOrder(await snapshot(), alpha)
    hash = prefsHash()
    const end = await cardSlotPoint(alpha, 1)
    const releaseAt = way === 'outside' ? { x: 900, y: 300 } : end
    const mid = await drag(await cardPoint(before[2]), end, {
      release: false,
      during: async () => {
        const during = await previewProbe(query)
        await cancel()
        await pause(250)
        return during
      },
    })
    await mouse('mouseReleased', releaseAt)
    await pause(250)
    const residue = await previewProbe(query)
    const after = wtOrder(await snapshot(), alpha)
    check(
      `K3h-d-${way}`,
      `K3ⓗⓓ ${way === 'escape' ? 'Escape' : way === 'blur' ? '창 blur' : '목록 밖 놓기'} 취소 — 드래그 중 사본·밀림 있었고, 취소 뒤 사본 제거·행 원위치(인라인 transform 0)·class 해제·원래 행 다시 보임, 순서·파일 무변경`,
      mid.previewCount === 1 && Object.values(mid.shifts).some((y) => y !== 0) && residue.previewCount === 0 && residue.inlineShifts === 0 && !residue.shiftingClass && residue.sourceOpacity === null && Object.values(residue.shifts).every((y) => y === 0) && same(before, after) && prefsHash() === hash,
      { during: { previewCount: mid.previewCount, shifts: mid.shifts }, residue, before, after },
    )
  }
  {
    // source 소멸 — 드래그 중 그 워크트리를 앱 밖에서 지우고 트리를 다시 받는다(목록 갱신).
    const vanish = addWorktree(beta, { name: 'b-vanish' })
    await waitFor(async () => {
      await rebuild()
      return wtOrder(await snapshot(), beta)?.includes(vanish)
    }, 'b-vanish rendered', 60_000)
    const query = { kind: 'card', root: beta }
    const before = wtOrder(await snapshot(), beta)
    const end = await cardSlotPoint(beta, before.length)
    const mid = await drag(await cardPoint(vanish), end, {
      release: false,
      during: async () => {
        const during = await previewProbe(query)
        git(beta, 'worktree', 'remove', '--force', vanish)
        await rebuild()
        await waitFor(async () => !wtOrder(await snapshot(), beta)?.includes(vanish), 'b-vanish gone', 30_000)
        await pause(200)
        const afterVanish = await previewProbe(query)
        await shot('k3h-cancel-vanish')
        return { during, afterVanish, reordering: (await snapshot()).reordering }
      },
    })
    await mouse('mouseReleased', end)
    await pause(250)
    const after = wtOrder(await snapshot(), beta)
    check(
      'K3h-d-vanish',
      'K3ⓗⓓ 드래그 중 목록 갱신으로 끄는 카드가 사라지면 취소 — 사본 제거·밀림 원위치·class 해제, 남은 순서 그대로',
      mid.during.previewCount === 1 && mid.afterVanish.previewCount === 0 && mid.afterVanish.inlineShifts === 0 && !mid.afterVanish.shiftingClass && mid.reordering === false && same(after, before.filter((p) => p !== vanish)),
      { ...mid, before, after },
    )
  }

  // ── R6-02 첫 레포가 바뀌는 이동 — 미리 보기(밀린 윗변·표시 줄) = 놓은 뒤 묶음 윗변 (리뷰 r6: 위치 의존 4px 간격) ──
  for (const [label, pick, slotOf] of [
    ['first-to-last', (keys) => keys[0], (keys) => keys.length],
    ['last-to-first', (keys) => keys[keys.length - 1], () => 0],
  ]) {
    const query = { kind: 'repo' }
    const rects = await itemRects(query)
    const keys = rects.map((rect) => rect.key)
    const moving = pick(keys)
    const slot = slotOf(keys)
    const from = keys.indexOf(moving)
    const wantOrder = moveTo(keys, moving, slot)
    const expected = expectedPreview(rects, from, slot)
    // 놓는 점은 누르기 전(밀리기 전)에 정한다 — 드래그 중 묶음 사각형은 밀려 있다.
    const end = await repoSlotPoint(slot)
    const mid = await dragFor(`R6-02-${label}`, await headerPoint(moving), end, {
      release: false,
      holdMs: 400,
      during: async () => {
        const probe = await previewProbe(query)
        await shot(`r6-02-${label}-drag`)
        return probe
      },
    })
    await mouse('mouseReleased', end)
    await pause(300)
    const afterRects = await itemRects(query)
    const afterOrder = afterRects.map((rect) => rect.key)
    // 미리 보기에서 각 묶음이 보인 윗변(밀리기 전 + 밀림, 끄는 묶음은 표시 줄) vs 놓은 뒤 실제 윗변.
    const shown = Object.fromEntries(rects.map((rect) => [rect.key, rect.key === moving ? mid?.indicatorY ?? null : rect.top + (mid?.shifts?.[rect.key] ?? 0)]))
    const landed = Object.fromEntries(afterRects.map((rect) => [rect.key, rect.top]))
    // 끄는 묶음의 표시 줄은 들어갈 윗변이되, 보이는 목록 끝이면 안쪽 5px 로 당긴다(수정 1 규칙 — 맨 위 슬롯은 목록 윗변 + 5).
    const view = await cdp.evaluate(() => {
      const r = document.querySelector('[data-repo-list]').getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    })
    const indicatorWant = Math.max(view.top + 5, Math.min(view.bottom - 5, landed[moving]))
    const errors = Object.fromEntries(keys.map((key) => [key, shown[key] === null ? null : Number((shown[key] - (key === moving ? indicatorWant : landed[key])).toFixed(2))]))
    fs.writeFileSync(path.join(out, `r6-02-${label}-probe.json`), JSON.stringify({ rects, moving, slot, expected, mid, afterRects, shown, landed, view, indicatorWant, errors }, null, 2))
    check(
      `R6-02-${label}`,
      `R6-02 첫 레포가 바뀌는 이동(${label === 'first-to-last' ? '맨 앞 → 맨 뒤' : '맨 뒤 → 맨 앞'}) — 밀린 윗변 = 놓은 뒤 묶음 윗변, 표시 줄 = 놓은 뒤 끄는 묶음 윗변(보이는 범위 끝이면 안쪽 5px), 각 1px 안 · 이동량 = 기대값 · 결과 = 기대 배열 전체`,
      mid !== null && same(afterOrder, wantOrder) && !same(keys, wantOrder) && Object.values(errors).every((error) => error !== null && Math.abs(error) <= 1) && shiftsMatch(mid.shifts, rects, expected.offsets),
      { before: keys, want: wantOrder, after: afterOrder, errors, shifts: mid?.shifts ?? null, wantShifts: Object.fromEntries(rects.map((rect, index) => [rect.key, expected.offsets[index]])) },
    )
  }

  // ── R6-01 열린 ⋯ 메뉴가 사본에 남지 않는다 — ⓐ 카드 메뉴를 연 채 그 카드 ⓑ 그 레포 카드 메뉴를 연 채 그 레포 헤더 ──
  const openCardMenu = async (wtPath) => {
    await mouse('mouseMoved', await cardPoint(wtPath), { buttons: 0 })
    await pause(150)
    await click(await pointOf({ attr: 'data-worktree-menu-toggle', value: wtPath }))
    return cdp.evaluate((p) => [...document.querySelectorAll('[data-worktree-menu]')].some((el) => el.getAttribute('data-worktree-menu') === p), wtPath)
  }
  const menuProbe = () =>
    cdp.evaluate(() => ({
      previewCount: document.querySelectorAll('[data-sidebar-drag-preview="true"]').length,
      previewMenus: document.querySelectorAll('[data-sidebar-drag-preview="true"] .repo-row-menu').length,
      previewMenuOpenHeads: document.querySelectorAll('[data-sidebar-drag-preview="true"] .is-menu-open').length,
      liveMenus: document.querySelectorAll('[data-repo-list] .repo-row-menu').length,
    }))
  {
    const before = wtOrder(await snapshot(), alpha)
    const card = before[2]
    const menuOpenBefore = await openCardMenu(card)
    const want = moveTo(before, card, 1)
    const end = await cardSlotPoint(alpha, 1)
    const mid = await dragFor('R6-01-card-own-menu', await cardPoint(card), end, {
      release: false,
      holdMs: 200,
      during: async () => {
        const probe = await menuProbe()
        await shot('r6-01-card-own-menu-drag')
        return probe
      },
    })
    await mouse('mouseReleased', end)
    await pause(300)
    const after = wtOrder(await snapshot(), alpha)
    const afterMenus = await menuProbe()
    check(
      'R6-01-card-own-menu',
      'R6-01ⓐ 카드 ⋯ 메뉴를 연 채 그 카드를 끌기 — 드래그 중 사본 1 · 사본 안 메뉴 0 · 라이브 메뉴 0, 놓은 뒤 기대 배열 전체·메뉴 0',
      menuOpenBefore && mid !== null && mid.previewCount === 1 && mid.previewMenus === 0 && mid.liveMenus === 0 && same(after, want) && !same(before, want) && afterMenus.liveMenus === 0 && afterMenus.previewCount === 0,
      { card, menuOpenBefore, during: mid, before, want, after, afterMenus },
    )
  }
  {
    const repos0 = repoOrder(await snapshot())
    const card = wtOrder(await snapshot(), alpha)[1]
    const menuOpenBefore = await openCardMenu(card)
    const want = moveTo(repos0, alpha, 1)
    const end = await repoSlotPoint(1)
    const mid = await dragFor('R6-01-repo-card-menu', await headerPoint(alpha), end, {
      release: false,
      holdMs: 200,
      during: async () => {
        const probe = await menuProbe()
        await shot('r6-01-repo-card-menu-drag')
        return probe
      },
    })
    await mouse('mouseReleased', end)
    await pause(300)
    const after = repoOrder(await snapshot())
    const afterMenus = await menuProbe()
    check(
      'R6-01-repo-card-menu',
      'R6-01ⓑ 같은 레포 카드 메뉴를 연 채 그 레포 헤더를 끌기 — 드래그 중 묶음 사본 1 · 사본 안 메뉴 0(열린 헤더 표식 0) · 라이브 메뉴 0, 놓은 뒤 기대 배열 전체·메뉴 0',
      menuOpenBefore && mid !== null && mid.previewCount === 1 && mid.previewMenus === 0 && mid.previewMenuOpenHeads === 0 && mid.liveMenus === 0 && same(after, want) && !same(repos0, want) && afterMenus.liveMenus === 0,
      { card, menuOpenBefore, during: mid, before: repos0, want, after, afterMenus },
    )
    // 되돌린다 — 뒤 검사가 기대는 레포 순서.
    await drag(await headerPoint(alpha), await repoSlotPoint(repos0.length))
    const restored = repoOrder(await snapshot())
    check('R6-01-repo-restore', 'R6-01 레포 순서 되돌리기', same(restored, repos0), { want: repos0, got: restored })
  }

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
  // ── K3ⓕ 위쪽 — 목록 위 가장자리를 잡고 있으면 위로 스크롤된다 → 화면 밖(위)이던 첫 연결 자리에 놓는다 ──
  {
    const geo = await cdp.evaluate((root) => {
      const list = document.querySelector('[data-repo-list]')
      const group = [...list.querySelectorAll(':scope > [data-repo]')].find((el) => el.getAttribute('data-repo') === root)
      const cards = [...group.querySelectorAll('[data-reorder-card]')]
      const lr = list.getBoundingClientRect()
      const content = (el) => el.getBoundingClientRect().bottom - lr.top + list.scrollTop
      // 첫 연결 카드가 위로 완전히 숨도록 내린다.
      list.scrollTop = content(cards[0]) + 20
      const visible = cards.filter((card) => {
        const r = card.getBoundingClientRect()
        return r.top >= lr.top + 60 && r.bottom <= lr.bottom - 60
      })
      const pick = visible[visible.length - 1] ?? cards[cards.length - 1]
      const r0 = cards[0].getBoundingClientRect()
      return { scrollTop: list.scrollTop, firstVisible: r0.bottom > lr.top && r0.top < lr.bottom, moving: pick.getAttribute('data-reorder-card'), first: cards[0].getAttribute('data-reorder-card') }
    }, gamma)
    await pause(200)
    const upBefore = wtOrder(await snapshot(), gamma)
    // 첫 카드 = gamma 주 체크아웃 — 그 윗부분에 놓으면 레포 맨 위(주 체크아웃 위, 게이트 ① 수정 1).
    const upWant = moveTo(upBefore, geo.moving, 0)
    // 밀리기 전 자리 — 드래그 중 다른 카드는 밀려 있다(K3ⓗ). 판정은 밀리기 전 기하라 겨냥도 거기에 한다.
    const firstRect = () =>
      cdp.evaluate((q) => {
        const el = [...document.querySelectorAll('[data-reorder-card]')].find((node) => node.getAttribute('data-reorder-card') === q)
        const r = el.getBoundingClientRect()
        const t = getComputedStyle(el).transform
        const shift = t === 'none' ? 0 : new DOMMatrixReadOnly(t).m42
        return { x: r.left + 40, top: r.top - shift, bottom: r.bottom - shift }
      }, geo.first)
    // 붙은 헤더(28px) 바로 아래, 위 가장자리 띠(56px) 안.
    const edge = { x: listRect.left + 80, y: listRect.top + 34 }
    const upMid = await drag(await cardPoint(geo.moving), edge, {
      release: false,
      during: async (edgePoint) => {
        const deadline = Date.now() + 8_000
        let rect = await firstRect()
        // 첫 연결 카드 윗변이 가장자리 띠 아래로 내려올 때까지 잡고 있는다.
        while (rect.top < listRect.top + 60 && Date.now() < deadline) {
          await mouse('mouseMoved', edgePoint)
          await pause(30)
          rect = await firstRect()
        }
        const s0 = await snapshot()
        const p = { x: rect.x, y: rect.top + 4 }
        await mouse('mouseMoved', p)
        await pause(120)
        await shot('k3f-autoscroll-up-drag')
        const s1 = await snapshot()
        return { scrollTopAtEdgeEnd: s0.scrollTop, scrollTopAtDrop: s1.scrollTop, indicator: s1.indicator, p }
      },
    })
    await mouse('mouseReleased', upMid.p)
    await pause(250)
    const upAfter = wtOrder(await snapshot(), gamma)
    check('K3f-autoscroll-up', 'K3ⓕ 위 가장자리에서 자동 스크롤(위로) → 화면 밖(위)이던 레포 맨 위 자리(주 체크아웃 위)에 놓인다 — 기대 배열 전체', !geo.firstVisible && upMid.scrollTopAtEdgeEnd < geo.scrollTop && upMid.indicator && same(upAfter, upWant) && !same(upBefore, upWant), { geo, during: upMid, before: upBefore, want: upWant, after: upAfter })
  }

  // ── R1-01 스크롤된 목록 — 보이는 헤더를 목록 위 80px(자동 스크롤 띠 48px 도 넘음)에 놓으면 취소(리뷰 재현) ──
  {
    await cdp.evaluate(() => {
      const list = document.querySelector('[data-repo-list]')
      list.scrollTop = list.scrollHeight
    })
    await pause(200)
    const scrolledBefore = await snapshot()
    hash = prefsHash()
    const lastRoot = repoOrder(scrolledBefore)[scrolledBefore.repos.length - 1]
    const hp = await headerPoint(lastRoot)
    // 창 안에 머문다(run2: 창 밖 좌표 입력으로 하네스가 멈춘 전례).
    const mid = await drag(hp, { x: hp.x, y: Math.max(2, listRect.top - 80) }, { during: async () => snapshot() })
    const scrolledAfter = await snapshot()
    check('K3b-outside-y-scrolled', 'K3ⓑ(R1-01) 스크롤된 목록에서 헤더를 목록 위 80px 에 놓기 = 취소(순서·파일 무변경)', scrolledBefore.scrollTop > 0 && listRect.top - Math.max(2, listRect.top - 80) > 48 && !mid.indicator && same(repoOrder(scrolledBefore), repoOrder(scrolledAfter)) && prefsHash() === hash, { scrollTop: scrolledBefore.scrollTop, moving: lastRoot, duringIndicator: mid.indicator, before: repoOrder(scrolledBefore), after: repoOrder(scrolledAfter) })
  }

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

  // ── R1-05 붙은 헤더 상반부에 다음 레포 헤더를 놓으면 = 그 레포 앞 (스크롤된 상태) ──
  {
    const order0 = repoOrder(await snapshot())
    const stuckRoot = order0[0]
    const mover = order0[1]
    const geo = await cdp.evaluate((root) => {
      const list = document.querySelector('[data-repo-list]')
      const group = [...list.querySelectorAll(':scope > [data-repo]')].find((el) => el.getAttribute('data-repo') === root)
      const lr = list.getBoundingClientRect()
      const groupBottom = group.getBoundingClientRect().bottom - lr.top + list.scrollTop
      // 첫 묶음 끝이 목록 아래쪽에 보이게 — 그 묶음 헤더는 위에 붙고, 다음 레포 헤더는 화면 안.
      list.scrollTop = Math.max(0, groupBottom - (lr.bottom - lr.top) + 90)
      return { scrollTop: list.scrollTop, groupBottom }
    }, stuckRoot)
    await pause(200)
    const headOf = (root) =>
      cdp.evaluate((r) => {
        const list = document.querySelector('[data-repo-list]')
        const group = [...list.querySelectorAll(':scope > [data-repo]')].find((el) => el.getAttribute('data-repo') === r)
        const h = group.querySelector('[data-repo-head]').getBoundingClientRect()
        const g = group.getBoundingClientRect()
        const lr = list.getBoundingClientRect()
        return { top: h.top, bottom: h.bottom, left: h.left, width: h.width, groupTop: g.top, listTop: lr.top, scrollTop: list.scrollTop }
      }, root)
    const stuckHead = await headOf(stuckRoot)
    const target = { x: stuckHead.left + stuckHead.width * 0.4, y: stuckHead.top + 6 }
    // ⓐ 표시 줄 확인(놓지 않음) — 앞 슬롯 경계는 화면 위로 숨었으니 붙은 헤더 윗변 안쪽에 보여야 한다.
    const probeStart = await headerPoint(mover)
    await mouse('mouseMoved', probeStart, { buttons: 0 })
    await mouse('mousePressed', probeStart)
    for (let index = 1; index <= 4; index++) {
      await mouse('mouseMoved', { x: probeStart.x + ((target.x - probeStart.x) * index) / 4, y: probeStart.y + ((target.y - probeStart.y) * index) / 4 })
      await pause(16)
    }
    const indicatorProbe = await cdp.evaluate(() => {
      const ind = document.querySelector('[data-reorder-indicator] .reorder-drop-bar')
      const lr = document.querySelector('[data-repo-list]').getBoundingClientRect()
      if (!ind) return null
      const r = ind.getBoundingClientRect()
      return { barTop: r.top, barBottom: r.bottom, listTop: lr.top, visible: r.top >= lr.top && r.bottom <= lr.bottom }
    })
    await shot('r1-05-sticky-head-indicator')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await mouse('mouseReleased', target)
    await pause(300)
    // ⓑ 실제 놓기 — 붙은 헤더가 가장자리 띠 안이라 자동 스크롤이 돈다. 걸음을 줄여 붙은 상태에서 바로 놓는다.
    await cdp.evaluate((top) => {
      document.querySelector('[data-repo-list]').scrollTop = top
    }, geo.scrollTop)
    await pause(200)
    hash = prefsHash()
    const dropStart = await headerPoint(mover)
    const stuckAtStart = await headOf(stuckRoot)
    await mouse('mouseMoved', dropStart, { buttons: 0 })
    await mouse('mousePressed', dropStart)
    for (let index = 1; index <= 4; index++) {
      await mouse('mouseMoved', { x: dropStart.x + ((target.x - dropStart.x) * index) / 4, y: dropStart.y + ((target.y - dropStart.y) * index) / 4 })
    }
    await mouse('mouseReleased', target)
    await pause(300)
    const stuckAtEnd = await headOf(stuckRoot)
    const dropWant = moveTo(order0, mover, 0)
    const dropAfter = repoOrder(await snapshot())
    await shot('r1-05-sticky-head-drop-after')
    // 놓은 뒤 스크롤이 0 보다 크면 놓는 순간 그 헤더는 아직 붙어 있었다(묶음 윗변이 화면 위).
    check('K1a-sticky-head-upper', 'K1ⓐ·K3(R1-05) 붙은 헤더 상반부에 다음 레포를 놓으면 그 레포 앞 — 기대 배열 전체, 표시 줄은 화면 안', stuckAtStart.groupTop < stuckAtStart.listTop - 20 && stuckAtEnd.scrollTop > 0 && indicatorProbe?.visible === true && same(dropAfter, dropWant) && prefsHash() !== hash, { geo, stuckAtStart, stuckAtEnd, target, indicatorProbe, before: order0, want: dropWant, after: dropAfter })
  }
  await setViewport(cdp, { width: 1200, height: Number(args.height ?? 1500) })
  await cdp.evaluate(() => {
    document.querySelector('[data-repo-list]').scrollTop = 0
  })
  await pause(300)
  // R1-05 가 바꾼 레포 순서를 되돌린다(뒤 검사들이 [gamma, beta, alpha] 를 전제한다) — 이것도 기대 배열 대조.
  {
    const now = repoOrder(await snapshot())
    const restoreWant = [gamma, beta, alpha]
    if (!same(now, restoreWant)) {
      const slot = restoreWant.indexOf(now[0])
      await drag(await headerPoint(now[0]), await repoSlotPoint(slot + 1))
    }
    const restored = repoOrder(await snapshot())
    check('K1a-restore-after-sticky', 'K1ⓐ R1-05 뒤 순서 되돌리기 = [gamma, beta, alpha]', same(restored, restoreWant), { before: now, after: restored })
  }

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
  check("K5a'-new-worktree-top", "K5ⓐ' 앱 밖 git worktree add → 그 레포 카드 목록 맨 위(주 체크아웃이 아래로 옮겨져 있어도 맨 위), 기존 상대 순서 무변경", alphaWithNew[0] === fresh && alphaBeforeAdd[0] !== alpha && same(alphaWithNew.filter((p) => p !== fresh), alphaBeforeAdd), { before: alphaBeforeAdd, after: alphaWithNew })
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

  // ── K9ⓑ 스모크 — S3 가 건드린 사이드바의 기존 동작 ──
  {
    const sb = () => cdp.evaluate(() => ({ present: document.querySelector('[data-sidebar]') !== null, width: document.querySelector('[data-sidebar]')?.getBoundingClientRect().width ?? null }))
    const w0 = await sb()
    await click(await pointOf({ attr: 'data-sidebar-toggle' }))
    const hidden = await sb()
    await click(await pointOf({ attr: 'data-sidebar-show' }))
    await waitFor(async () => (await sb()).present, 'sidebar back', 10_000).catch(() => null)
    const shown = await sb()
    check('K9b-sidebar-collapse', 'K9ⓑ 사이드바 접기·펼치기', w0.present && !hidden.present && shown.present, { w0, hidden, shown })
    const handle = await pointOf({ attr: 'data-sidebar-resizer' })
    await drag(handle, { x: handle.x + 60, y: handle.y }, { steps: 8 })
    const widened = await sb()
    check('K9b-sidebar-resize', 'K9ⓑ 사이드바 폭 조절(+60px 끌기 → 넓어짐)', widened.width > shown.width + 30, { before: shown.width, after: widened.width })
    await drag(await pointOf({ attr: 'data-sidebar-resizer' }), { x: handle.x, y: handle.y }, { steps: 8 })

    const caretBefore = (await snapshot()).repos.find((repo) => repo.root === gamma).collapsed
    await mouse('mouseMoved', await headerPoint(gamma), { buttons: 0 })
    await pause(120)
    await click(await pointOf({ attr: 'data-repo-caret', value: gamma }))
    const caretAfter = (await snapshot()).repos.find((repo) => repo.root === gamma).collapsed
    await click(await pointOf({ attr: 'data-repo-caret', value: gamma }))
    check('K9b-repo-collapse', 'K9ⓑ 레포 셰브론 접기/펼치기', caretBefore === false && caretAfter === true && (await snapshot()).repos.find((repo) => repo.root === gamma).collapsed === false, { caretBefore, caretAfter })

    // 에이전트 묶음 — a-one workspace 에 에이전트 탭을 하나 더 → 루트 2개 = 알약(기본 접힘) → 눌러 펼침.
    const st = (await rpc(control, { cmd: 'state' })).state
    const aOneRow = st.repos.find((repo) => repo.root === alpha).worktrees.find((row) => row.path === wtA('a-one'))
    const created = await backendRpc('tab.create', { workspace_id: aOneRow.openWorkspaceId })
    const snapshotTabs = await backendRpc('session.snapshot')
    const newPane = (snapshotTabs?.snapshot?.panes ?? []).find((pane) => pane.tab_id === created?.tab?.tab_id)?.pane_id
    if (newPane) await backendRpc('pane.report_agent', { pane_id: newPane, source: 'l469', agent: 'codex', state: 'idle', message: 'l469 second' })
    if (display === 'detailed') {
      const groupP = await waitFor(async () => pointOf({ attr: 'data-agent-group', value: wtA('a-one') }), 'agent group pill', 20_000).then(() => pointOf({ attr: 'data-agent-group', value: wtA('a-one') })).catch(() => null)
      const rowsCollapsed = (await snapshot()).repos.find((repo) => repo.root === alpha).agentRows[wtA('a-one')]
      if (groupP) await click(groupP)
      const rowsExpanded = (await snapshot()).repos.find((repo) => repo.root === alpha).agentRows[wtA('a-one')]
      check('K9b-agent-group', 'K9ⓑ 에이전트 묶음 알약 펼침(접힘 0행 → 펼침 2행)', groupP !== null && rowsCollapsed === 0 && rowsExpanded === 2, { groupP: groupP !== null, rowsCollapsed, rowsExpanded, newPane: newPane ?? null })
    } else {
      // LIFE-477 — Full list 는 알약 없이 루트마다 행(2행), Compact 카드는 목록 자체가 없다(0행·알약 없음).
      const want = display === 'full' ? 2 : 0
      await waitFor(async () => (await snapshot()).repos.find((repo) => repo.root === alpha).agentRows[wtA('a-one')] === want, 'agent rows (display)', 20_000).catch(() => null)
      const rows = (await snapshot()).repos.find((repo) => repo.root === alpha).agentRows[wtA('a-one')]
      const pill = (await pointOf({ attr: 'data-agent-group', value: wtA('a-one') })) !== null
      check('K9b-agent-group', `K9ⓑ(${display}) 에이전트 2개 — 알약 없음, 행 ${want}개`, !pill && rows === want, { display, pill, rows, newPane: newPane ?? null })
    }

    await mouse('mouseMoved', await cardPoint(wtA('a-one')), { buttons: 0 })
    await pause(150)
    await click(await pointOf({ attr: 'data-worktree-menu-toggle', value: wtA('a-one') }))
    const wtMenu = await cdp.evaluate(() => document.querySelector('[data-worktree-menu]') !== null)
    await click(await pointOf({ attr: 'data-worktree-menu-toggle', value: wtA('a-one') }))
    await mouse('mouseMoved', await headerPoint(beta), { buttons: 0 })
    await pause(150)
    await click(await pointOf({ attr: 'data-repo-menu-toggle', value: beta }))
    const repoMenu = await cdp.evaluate(() => document.querySelector('.repo-row-menu[data-repo-menu], .repo-row-menu:not([data-worktree-menu])') !== null)
    await click(await pointOf({ attr: 'data-repo-menu-toggle', value: beta }))
    check('K9b-menus', 'K9ⓑ 워크트리 ⋯ 메뉴·레포 ⋯ 메뉴 열림', wtMenu && repoMenu, { wtMenu, repoMenu })

    await mouse('mouseMoved', await headerPoint(beta), { buttons: 0 })
    await pause(150)
    await click(await pointOf({ attr: 'data-create-worktree', value: beta }))
    const modal = await waitFor(async () => cdp.evaluate(() => document.querySelector('[data-create-worktree-modal]') !== null), 'create modal', 5_000).then(() => true).catch(() => false)
    await click(await pointOf({ attr: 'data-create-worktree-cancel' }))
    const modalGone = await cdp.evaluate(() => document.querySelector('[data-create-worktree-modal]') === null)
    check('K9b-create-plus', 'K9ⓑ 레포 + → 워크트리 생성 모달 열림·취소', modal && modalGone, { modal, modalGone })

    check('K9b-session-close', 'K9ⓑ 세션 닫기(worktree 닫기) 실제로 닫힘', afterClose.bTwoOpen === false, { bTwoOpen: afterClose.bTwoOpen })

    // sticky — 스크롤해 붙은 헤더를 눌러도 접힌다(붙은 헤더가 클릭을 먹지 않는다, Orca #12532 결).
    await setViewport(cdp, { width: 1200, height: 420 })
    await pause(200)
    const top = repoOrder(await snapshot())[0]
    await cdp.evaluate(() => {
      // 맨 위 묶음 높이 안쪽으로만 스크롤한다 — 묶음 끝에 가까우면 다음 헤더가 밀어 올려 붙은 상태가 아니다(run8: 120px 은 delta 묶음 끝).
      const list = document.querySelector('[data-repo-list]')
      const pinned = list.querySelector(':scope > [data-pinned-section]')
      list.scrollTop = 40 + (pinned === null ? 0 : pinned.getBoundingClientRect().height)
    })
    await pause(200)
    const stuck = await cdp.evaluate((root) => {
      const list = document.querySelector('[data-repo-list]')
      const head = [...list.querySelectorAll(':scope > [data-repo]')].find((el) => el.getAttribute('data-repo') === root).querySelector('[data-repo-head]')
      return { stuck: Math.abs(head.getBoundingClientRect().top - list.getBoundingClientRect().top) <= 2, scrollTop: list.scrollTop }
    }, top)
    await click(await headerPoint(top))
    const stuckCollapsed = (await snapshot()).repos.find((repo) => repo.root === top).collapsed
    await cdp.evaluate(() => {
      document.querySelector('[data-repo-list]').scrollTop = 0
    })
    await pause(150)
    await click(await headerPoint(top))
    await setViewport(cdp, { width: 1200, height: Number(args.height ?? 1500) })
    await pause(200)
    check('K9b-sticky', 'K9ⓑ sticky 헤더(스크롤해 붙은 상태) 클릭 → 접힘', stuck.stuck && stuck.scrollTop > 0 && stuckCollapsed === true && (await snapshot()).repos.find((repo) => repo.root === top).collapsed === false, { stuck, stuckCollapsed })
  }

  // ── R1-04 GUI 로 레포 제거 → 새 레포 등록 → 같은 레포 재등록 = 맨 아래(옛 자리로 되살아나지 않는다) ──
  {
    const order0 = repoOrder(await snapshot())
    await mouse('mouseMoved', await headerPoint(beta), { buttons: 0 })
    await pause(150)
    await click(await pointOf({ attr: 'data-repo-menu-toggle', value: beta }))
    await click(await pointOf({ attr: 'data-repo-menu-remove', value: beta }))
    await waitFor(async () => (await pointOf({ attr: 'data-confirm-ok' })) !== null, 'remove confirm', 10_000)
    await click(await pointOf({ attr: 'data-confirm-ok' }))
    await waitFor(async () => !repoOrder(await snapshot()).includes(beta), 'beta removed', 30_000)
    await pause(600)
    const afterRemove = { screen: repoOrder(await snapshot()), file: readPrefs().manualRepoOrder }
    const epsilon = makeRepo('epsilon', [])
    await rpc(control, { cmd: 'add-repo', root: epsilon })
    await waitFor(async () => {
      await rebuild()
      return repoOrder(await snapshot()).includes(epsilon)
    }, 'epsilon added', 60_000)
    await rpc(control, { cmd: 'add-repo', root: beta })
    await waitFor(async () => {
      await rebuild()
      return repoOrder(await snapshot()).includes(beta)
    }, 'beta re-added', 60_000)
    await settle()
    const removedWant = order0.filter((root) => root !== beta)
    const readdWant = [...removedWant, epsilon, beta]
    const readd = { screen: repoOrder(await snapshot()), file: readPrefs().manualRepoOrder }
    check('K5b-gui-remove-readd', 'K5ⓑ(R1-04) GUI 제거 직후 파일·화면에서 빠짐 → 새 레포 → 같은 레포 재등록 = 맨 아래(기대 배열 전체)', same(afterRemove.screen, removedWant) && same(afterRemove.file, removedWant) && same(readd.screen, readdWant) && same(readd.file, readdWant), { before: order0, afterRemove, want: readdWant, readd })
    await shot('r1-04-gui-remove-readd')
  }

  // ── R2-01 GUI 제거 → **바로** 재등록(80ms 트리 예약 안) → 새 레포 = 재등록 레포는 맨 아래, 그 뒤 새 레포 ──
  // main 이 「epsilon 없는」 트리를 합쳐 건너뛰면 옛 구현은 대기 키를 영영 못 내렸다. 이 검사가 그 경합을 실제로 만들었는지는
  // 화면만으로는 모른다 — 옛 동작(변이)으로 빌드한 앱에서 이 검사가 실패하는지로 따로 본다(RESULT 수정 라운드 2).
  {
    const epsilon = fs.realpathSync(path.join(reposDir, 'epsilon'))
    const order0 = repoOrder(await snapshot())
    await mouse('mouseMoved', await headerPoint(epsilon), { buttons: 0 })
    await pause(150)
    await click(await pointOf({ attr: 'data-repo-menu-toggle', value: epsilon }))
    await click(await pointOf({ attr: 'data-repo-menu-remove', value: epsilon }))
    await waitFor(async () => (await pointOf({ attr: 'data-confirm-ok' })) !== null, 'remove confirm (epsilon)', 10_000)
    const ok = await pointOf({ attr: 'data-confirm-ok' })
    await mouse('mouseMoved', ok, { buttons: 0 })
    await mouse('mousePressed', ok)
    await mouse('mouseReleased', ok)
    const readdAt = Date.now()
    const readd = await rpc(control, { cmd: 'add-repo', root: epsilon })
    const readdMs = Date.now() - readdAt
    await waitFor(async () => repoOrder(await snapshot()).includes(epsilon), 'epsilon present after readd', 30_000)
    await pause(1_000)
    const afterReadd = { screen: repoOrder(await snapshot()), file: readPrefs().manualRepoOrder }
    const zeta = makeRepo('zeta', [])
    await rpc(control, { cmd: 'add-repo', root: zeta })
    await waitFor(async () => {
      await rebuild()
      return repoOrder(await snapshot()).includes(zeta)
    }, 'zeta added', 60_000)
    await settle()
    const want = [...order0.filter((root) => root !== epsilon), epsilon, zeta]
    const got = { screen: repoOrder(await snapshot()), file: readPrefs().manualRepoOrder }
    check('K5b-gui-remove-immediate-readd', 'K5ⓑ(R2-01) GUI 제거 직후 바로 재등록 → 새 레포 = 재등록 레포 맨 아래·그 뒤 새 레포, 화면·파일 같음(기대 배열 전체)', readd.ok === true && same(got.screen, want) && same(got.file, want), { before: order0, readdOk: readd.ok, readdMs, afterReadd, want, got })
  }

  // ── R3-01 GUI 제거 → **CLI `corral repo add`** 로 바로 재등록 → CLI 로 새 레포 = 재등록 레포 맨 아래·그 뒤 새 레포 ──
  // CLI 는 main `addRepo` 를 타지 않고 runtime `workspaceModule` 이 레지스트리 파일을 고친다(리뷰 r3). 제어 소켓 add-repo(위
  // 검사)와 다른 경로다.
  {
    const cliRun = (...argv) => {
      const started = Date.now()
      const res = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), ...argv, '--json'], { env, encoding: 'utf8', timeout: 60_000 })
      return { status: res.status, ms: Date.now() - started, stdout: res.stdout.slice(0, 400), stderr: res.stderr.slice(0, 400) }
    }
    const order0 = repoOrder(await snapshot())
    // 맨 위 레포를 쓴다 — 맨 아래 레포는 ⋯ 메뉴가 창 아래로 넘쳐 「제거」를 못 누른다(M061·M062 하네스 실패).
    await cdp.evaluate(() => {
      document.querySelector('[data-repo-list]').scrollTop = 0
    })
    await pause(200)
    const zeta = order0[0]
    await mouse('mouseMoved', await headerPoint(zeta), { buttons: 0 })
    await pause(150)
    await click(await pointOf({ attr: 'data-repo-menu-toggle', value: zeta }))
    await click(await pointOf({ attr: 'data-repo-menu-remove', value: zeta }))
    await waitFor(async () => (await pointOf({ attr: 'data-confirm-ok' })) !== null, 'remove confirm (zeta)', 10_000)
    const ok = await pointOf({ attr: 'data-confirm-ok' })
    await mouse('mouseMoved', ok, { buttons: 0 })
    await mouse('mousePressed', ok)
    await mouse('mouseReleased', ok)
    const readd = cliRun('repo', 'add', '--path', zeta)
    await waitFor(async () => repoOrder(await snapshot()).includes(zeta), 'zeta present after CLI readd', 30_000)
    await pause(1_000)
    const afterReadd = { screen: repoOrder(await snapshot()), file: readPrefs().manualRepoOrder }
    const eta = makeRepo('eta', [])
    const addEta = cliRun('repo', 'add', '--path', eta)
    await waitFor(async () => repoOrder(await snapshot()).includes(eta), 'eta added (CLI)', 60_000)
    await settle()
    const want = [...order0.filter((root) => root !== zeta), zeta, eta]
    const got = { screen: repoOrder(await snapshot()), file: readPrefs().manualRepoOrder }
    check('K5b-gui-remove-cli-readd', 'K5ⓑ(R3-01) GUI 제거 직후 CLI repo add 재등록 → CLI 새 레포 = 재등록 레포 맨 아래·그 뒤 새 레포, 화면·파일 같음(기대 배열 전체)', readd.status === 0 && addEta.status === 0 && same(got.screen, want) && same(got.file, want), { before: order0, readd, addEta, afterReadd, want, got })
  }

  // ── K4ⓐ 재시작 3회 — 순서 그대로 ──
  for (let round = 1; round <= 3; round++) {
    const beforeQuit = await snapshot()
    const want = { repos: repoOrder(beforeQuit), wts: Object.fromEntries(beforeQuit.repos.map((repo) => [repo.root, repo.worktrees])) }
    const fileBefore = prefsHash()
    await quit(`R${round}`)
    await launch(`L${round + 1}`)
    await waitFor(async () => {
      const got = await snapshot()
      return got.repos.length === want.repos.length && got.repos.every((repo) => repo.collapsed || repo.worktrees.length === want.wts[repo.root]?.length)
    }, 'relaunch rendered', 90_000)
    await settle()
    const got = await snapshot()
    check(`K4a-restart-${round}`, `K4ⓐ 재시작 ${round}회차 — 레포·카드 순서 그대로`, same(repoOrder(got), want.repos) && same(Object.fromEntries(got.repos.map((repo) => [repo.root, repo.worktrees])), want.wts), { want, got: { repos: repoOrder(got) }, fileUnchangedByRestart: prefsHash() === fileBefore })
    if (round === 1) {
      // K2ⓑ' 재시작 보존 — 맨 아래로 옮긴 주 체크아웃이 재시작 뒤에도 맨 아래(맨 위로 돌아가지 않는다).
      const gotAlpha = wtOrder(got, alpha)
      check("K2b'-restart", "K2ⓑ' 맨 아래로 옮긴 주 체크아웃이 재시작 뒤에도 맨 아래 — 재시작 전 화면과 같은 배열", gotAlpha.at(-1) === alpha && gotAlpha[0] !== alpha && same(gotAlpha, want.wts[alpha]), { mainMovedOrder, beforeQuit: want.wts[alpha], afterRestart: gotAlpha })
    }
    await shot(`k4a-restart-${round}`)
  }

  // ── K4ⓑ 레포 제거(앱 밖 레지스트리) + K1ⓒ 레포 1개면 드래그 안 됨 ──
  if (pinMode) {
    // LIFE-478 K5ⓕ — 끌기 검사 전부를 지난 뒤에도 고정 카드는 고정 구획에만, 끌기 표지 없음, prefs 그대로.
    const pinState = await cdp.evaluate(() => {
      const section = document.querySelector('[data-repo-list] > [data-pinned-section]')
      return {
        first: document.querySelector('[data-repo-list] > :first-child')?.hasAttribute('data-pinned-section') ?? false,
        cards: section === null ? null : [...section.querySelectorAll('[data-worktree]')].map((row) => ({ path: row.getAttribute('data-worktree'), reorder: row.hasAttribute('data-reorder-card') })),
      }
    })
    const inGroups = (await snapshot()).repos.some((repo) => repo.worktrees.includes(gPin))
    check('L478-K5f-pinned-kept', 'LIFE-478 K5ⓕ 끌기 검사 뒤에도 고정 카드는 맨 위 고정 구획에만(그룹에 없음) · 끌기 표지 없음 · prefs 그대로', pinState.first && same(pinState.cards, [{ path: gPin, reorder: false }]) && !inGroups && same(readPrefs().pinnedWorktrees, [gPin]), { pinState, inGroups, prefs: readPrefs().pinnedWorktrees })
  }
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
  if (error instanceof StopAfter) {
    log('stop-after', error.message)
  } else {
    exitCode = 2
    checks.push({ id: 'harness', criterion: '하네스 완주', pass: false, observed: String(error?.stack ?? error) })
    log('ERROR', error)
    if (cdp) await shot('zz-error').catch(() => {})
  }
} finally {
  await quit('final').catch(() => {})
  if (backend?.pid) {
    try {
      process.kill(backend.pid, 'SIGTERM')
    } catch {
      // 이미 끝났다 — aliveAfterCleanup 이 확인한다.
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
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify({ work, port, options: { omitDrag: args['omit-drag'] ?? null, stopAfter: args['stop-after'] ?? null, focusEmulation: args['no-focus-emulation'] !== true, trace: args.trace === true }, spawned, aliveAfterCleanup: alive, total: checks.length, failed: failed.map((row) => row.id), exitCode, checks }, null, 2),
  )
  log(`checks ${checks.length - failed.length}/${checks.length} pass; alive after cleanup: ${JSON.stringify(alive)}`)
  process.exit(exitCode)
}
