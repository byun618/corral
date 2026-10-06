/* global document -- eval 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-516 K9 **네이티브 관문** — native-up.sh 가 띄운 사용자 userData + 구현 빌드 + herdr 정식 `default` 세션(LIFE-456 S9 B안).
// l515 native-k8 의 틀(제어 소켓·ndjson 기준 길이·requirements·fixture 영역만 캡처)을 따른다.
//
// 입력 경로 — 판정 걸음은 전부 제품 경로: 클릭 = 제어 소켓 click(`webContents.sendInputEvent` 좌표), 우클릭 = raw-mouse(right),
// 키 = 제어 소켓 key(⌘T·⌘W — main before-input-event 를 지난다), 글자 = 제어 소켓 type(포커스된 터미널에 char 이벤트 → PTY).
// 준비 걸음은 fixture 레포 등록(add-repo — 등록 핸들러)뿐이다. 설정 저장소·닫기/삭제 IPC 를 직접 부르지 않는다.
// 「실행 중」 = fixture 셸 탭에 실제로 친 `sleep 600`(provider 를 띄우지 않는다, 킥오프 격리 4).
//
// **원자료 경계(사용자 데이터 비공개)**: 캡처는 설정 페이지·대화상자·fixture 탭 영역만. 사이드바는 캡처하지 않고 `data-card-layout` 값만 센다.
// 복구된 사용자 세션 pane 에는 입력·포커스 조작을 하지 않는다 — 프로세스 목록만 남긴다(provider 이름만, 명령줄은 가린다).
// 워크트리 삭제는 ROOT(/tmp/l516n*) 아래 fixture 의 linked worktree 만 — 지우기 전 경로를 원자료에 적고 접두를 assert 한다(격리 규칙 8).
//
// ⓐ ⚙ → 설정 시작 › 일반 → 세 토글 「켜짐」(기존 settings.json 에 칸 없음 = 기본값)
// ⓑ ⌘T 셸 탭 → `sleep 600` → ⌘W → 실행 중 확인 창 → 체크 + 「멈추고 닫기」 → 닫힘 → 사용자 settings.json 에 skip 칸
// ⓒ ⌘T → sleep → ⌘W → 창 없이 닫힘 → 설정에서 다시 켜기 → ⌘T → sleep → ⌘W → 창 → 취소(닫지 않음) → 그 탭은 ⌘W + 확인으로 정리
// ⓒ' ⌘T 한가한 셸 → 탭 메뉴 「탭 고정」 → ⌘W → 핀 창 → 체크 + 「닫기」 → 다음 핀 탭 ⌘W 무확인 → 설정에서 다시 켜기
// ⓓ fixture 깨끗한 워크트리 카드 메뉴 「삭제」 → 체크 + 「삭제」 → 다음 깨끗한 워크트리 무확인 삭제 → 설정에서 켜기
// ⓔ 외관 › 창 및 사이드바 「간단히」 → 사이드바 카드·메뉴 같은 값 → 정상 종료 → 재시작 → 두 곳 유지
// 원복은 native-down.sh(userData 바이트 복원 → settings.json·ui-prefs.json·repos.json 원본 · manifest 전=후 · G6 전=후)
// 사용(저장소 루트): node app/scripts/l516/native-k9.mjs <ROOT=/tmp/l516n*> <raw 폴더> <app 폴더>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { pause, requirements } from '../l497/lib.mjs'

const [root, rawd, appDir] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l516n')) throw new Error('ROOT 는 /tmp/l516n*')
if (!appDir) throw new Error('app 폴더 필요')
fs.mkdirSync(rawd, { recursive: true })
const here = path.dirname(new URL(import.meta.url).pathname)
const HOME = os.homedir()
const UD = path.join(HOME, 'Library/Application Support/corral')
const SETTINGS = path.join(UD, 'settings.json')
const UI_PREFS = path.join(UD, 'ui-prefs.json')
const NDJSON = path.join(UD, 'corral.ndjson')
const HERDR_SOCK = path.join(HOME, '.config/herdr/herdr.sock')
const ctl = path.join(root, 'ctl.sock')
const control = (request) => rpc(ctl, request, 20_000)
const evaluate = async ({ fn, arg = null }) => (await rpc(ctl, { cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
const herdr = async ({ method, params }) => {
  const response = await rpc(HERDR_SOCK, { id: `l516-${Date.now()}`, method, params })
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`)
  return response.result
}

const result = { startedAt: new Date().toISOString(), appPid: Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8')), input: 'control socket sendInputEvent (click·raw-mouse·key·type)', steps: {}, deletes: [], notes: [] }
const save = () => fs.writeFileSync(path.join(rawd, 'k9.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[k9] 필수 조건 실패', JSON.stringify(row).slice(0, 500)) })
result.requirements = checks.results

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null)
const ndjsonSize = () => fs.statSync(NDJSON).size
const rowsFrom = ({ offset, tag }) => {
  const size = ndjsonSize()
  if (size <= offset) return []
  const fd = fs.openSync(NDJSON, 'r')
  const buffer = Buffer.alloc(size - offset)
  fs.readSync(fd, buffer, 0, buffer.length, offset)
  fs.closeSync(fd)
  return buffer.toString('utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((row) => row && row.tag === tag)
}
const until = async ({ label, probe, timeout = 10_000 }) => {
  const t0 = Date.now()
  for (;;) {
    const value = await probe().catch(() => false)
    if (value) return value
    if (Date.now() - t0 > timeout) throw new Error(`시간초과: ${label}`)
    await pause(150)
  }
}
const click = async (selector) => {
  const response = await control({ cmd: 'click', selector })
  checks.require(`click ${selector}`, response.ok === true, { response })
  await pause(250)
  return response
}
const rightClick = async (selector) => {
  const { rect } = await control({ cmd: 'rect', selector })
  if (rect === null) throw new Error(`rightClick: 없음 ${selector}`)
  const x = Math.round(rect.left + rect.width * 0.4)
  const y = Math.round(rect.top + rect.height * 0.5)
  await control({ cmd: 'raw-mouse', type: 'mouseMove', x, y })
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x, y, button: 'right' })
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x, y, button: 'right' })
  await pause(300)
}
const key = ({ keyCode, modifiers = [] }) => control({ cmd: 'key', keyCode, modifiers })
const shot = async ({ name, selector }) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await control({ cmd: 'shot', name: `l516n-${name}`, selector })
      if (response.ok && response.file && fs.existsSync(response.file)) {
        const dest = path.join(rawd, `${name}.png`)
        fs.copyFileSync(response.file, dest)
        fs.rmSync(response.file, { force: true })
        return path.basename(dest)
      }
      if (attempt === 1) return `실패: ${JSON.stringify(response).slice(0, 200)}`
    } catch (error) { if (attempt === 1) return `실패: ${String(error).slice(0, 200)}` }
    await pause(800)
  }
  return '실패'
}
const ps = () => execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' })
const descendants = (pid) => {
  const rows = ps().split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
  const out = []
  const walk = (parent) => { for (const row of rows.filter((r) => r.ppid === parent)) { out.push(row); walk(row.pid) } }
  walk(pid)
  return out
}
const confirmKeys = () => {
  const file = readJson(SETTINGS)
  if (file === null) return '(파일 없음)'
  return { confirmClosePinnedTab: file.confirmClosePinnedTab ?? '(칸 없음)', skipCloseTerminalWithRunningProcessConfirm: file.skipCloseTerminalWithRunningProcessConfirm ?? '(칸 없음)', skipDeleteWorktreeConfirm: file.skipDeleteWorktreeConfirm ?? '(칸 없음)' }
}
const cardPrefs = () => { const prefs = readJson(UI_PREFS) ?? {}; return { sidebarCardLayout: prefs.sidebarCardLayout, sidebarCardProperties: prefs.sidebarCardProperties } }

let exitCode = 0
const fixture = path.join(root, 'fx')
const wtRoot = path.join(root, 'fx-wt')
try {
  const backendPid = Number(fs.readFileSync(path.join(root, 'backend.pid'), 'utf8'))
  const restored = descendants(backendPid).filter((row) => /claude|grok|codex/.test(row.command)).map((row) => ({ pid: row.pid, ppid: row.ppid, provider: (row.command.match(/claude|grok|codex/) ?? ['?'])[0] }))
  result.restoredAgents = restored
  fs.writeFileSync(path.join(rawd, 'restored-agents.txt'), `${restored.map((row) => `${row.pid} ${row.ppid} ${row.provider}`).join('\n')}\n`)
  result.settingsAtStart = { keys: Object.keys(readJson(SETTINGS) ?? {}), confirm: confirmKeys() }
  result.cardPrefsAtStart = cardPrefs()
  save()

  // ── 준비: fixture 레포(깨끗한 linked worktree 2개) 등록(add-repo) → 카드 실제 클릭으로 연다 ─────────────────
  const git = ({ cwd, args }) => execFileSync('git', ['-c', 'user.name=fx', '-c', 'user.email=fx@local', ...args], { cwd, encoding: 'utf8' })
  fs.mkdirSync(fixture, { recursive: true })
  git({ cwd: fixture, args: ['init', '-q', '-b', 'main'] })
  fs.writeFileSync(path.join(fixture, 'README.md'), 'fx\n')
  git({ cwd: fixture, args: ['add', '.'] })
  git({ cwd: fixture, args: ['commit', '-qm', 'init'] })
  for (const name of ['clean-a', 'clean-b']) git({ cwd: fixture, args: ['worktree', 'add', '-q', '-b', `l516n-${name}`, path.join(wtRoot, name)] })
  const real = fs.realpathSync(fixture)
  const realWt = (name) => fs.realpathSync(path.join(wtRoot, name))
  result.fixture = { real, worktrees: ['clean-a', 'clean-b'].map(realWt) }
  await control({ cmd: 'window-visibility', action: 'show' })
  const added = await control({ cmd: 'add-repo', root: real })
  await until({ label: 'fixture 카드', probe: async () => ((await control({ cmd: 'query', selector: `[data-worktree="${real}"]` })).found ?? []).length > 0, timeout: 30_000 })
  const fixtureWorkspace = async () => {
    const res = await control({ cmd: 'state' })
    for (const repo of res.state.repos) for (const row of repo.worktrees) if (row.path === real) return row.workspace ?? null
    return null
  }
  await click(`[data-worktree="${real}"] [data-worktree-card-surface]`)
  const ws = await until({ label: 'fixture 워크스페이스 열림', probe: async () => ((await fixtureWorkspace())?.tabs.length ?? 0) > 0 && (await fixtureWorkspace()), timeout: 30_000 })
  const fixtureGroup = async () => evaluate({ fn: (ids) => {
    const groups = [...document.querySelectorAll('[data-tab-group]')]
    return groups.map((group) => ({ id: group.getAttribute('data-tab-group'), tabs: [...group.querySelectorAll('[data-main-tab]')].map((el) => el.getAttribute('data-main-tab')), foreign: [...group.querySelectorAll('[data-main-tab]')].filter((el) => !ids.includes(el.getAttribute('data-main-tab'))).length }))
  }, arg: ((await fixtureWorkspace())?.tabs ?? []).map((tab) => tab.tabId) })
  let cardClicks = 1
  for (;;) {
    const groups = await fixtureGroup()
    if (groups.length > 0 && groups.every((group) => group.foreign === 0 && group.tabs.length > 0)) break
    if (cardClicks >= 4) throw new Error(`카드 ${cardClicks}번 눌러도 fixture 화면이 아니다`)
    await pause(1000)
    await click(`[data-worktree="${real}"] [data-worktree-card-surface]`)
    cardClicks += 1
  }
  const initialTabs = ((await fixtureWorkspace())?.tabs ?? []).map((tab) => tab.tabId)
  result.steps.open = { added: added.ok ?? null, workspace: ws.workspaceId, cardClicks, initialTabs }
  checks.require('setup-existing-pane', initialTabs.length >= 1, { initialTabs })
  save()

  // ── 도우미 ─────────────────────────────────────────────────────────────
  const tabsNow = async () => (await fixtureWorkspace())?.tabs ?? []
  const settingsState = () => evaluate({ fn: () => ({
    open: document.querySelector('[data-settings-page]') !== null,
    section: document.querySelector('[data-settings-section]')?.getAttribute('data-settings-section') ?? null,
    groups: [...document.querySelectorAll('[data-settings-group-title]')].map((el) => el.textContent),
    general: [...document.querySelectorAll('[data-settings-general-row]')].map((row) => ({ id: row.getAttribute('data-settings-general-row'), label: row.querySelector('.settings-row-label')?.textContent ?? null, checked: row.querySelector('[data-settings-switch]')?.getAttribute('aria-checked') ?? null })),
    segments: [...document.querySelectorAll('[data-settings-collapsible="window-sidebar"] [data-segment-value]')].map((el) => ({ value: el.getAttribute('data-segment-value'), checked: el.getAttribute('aria-checked') })),
  }) })
  const openSettings = async (section) => {
    if (!(await settingsState()).open) {
      await click('[data-settings-open]')
      await until({ label: 'settings open', probe: async () => (await settingsState()).open, timeout: 15_000 })
    }
    await click(`[data-settings-nav-item="${section}"]`)
    return until({ label: `${section}`, probe: async () => { const s = await settingsState(); return s.section === section ? s : null }, timeout: 10_000 })
  }
  const closeSettings = async () => {
    await click('[data-settings-back]')
    await until({ label: 'settings closed', probe: async () => !(await settingsState()).open })
    await pause(500)
  }
  const toggleGeneral = async ({ id, expect }) => {
    await openSettings('general')
    const offset = ndjsonSize()
    await click(`[data-settings-general-row="${id}"] [data-settings-switch]`)
    const screen = await until({ label: `toggle ${id}`, probe: async () => { const s = await settingsState(); return s.general.find((r) => r.id === id)?.checked === expect ? s.general : null }, timeout: 5_000 })
    await pause(400)
    const step = { id, expect, screen, writes: rowsFrom({ offset, tag: 'settings.changed' }).length, file: confirmKeys() }
    await closeSettings()
    return step
  }
  const modal = () => evaluate({ fn: () => {
    const el = document.querySelector('[data-confirm-close-modal]')
    if (!el) return null
    const box = el.querySelector('[data-dont-ask-again]')
    return { kind: el.getAttribute('data-confirm-close-kind'), title: el.querySelector('[data-confirm-close-title]')?.textContent ?? null, body: [...el.querySelectorAll('[data-confirm-close-body]')].map((p) => p.textContent), checkbox: box === null ? null : { label: box.textContent, checked: box.querySelector('input')?.checked ?? null } }
  } })
  const tabGone = (tabId) => until({ label: `tab ${tabId} gone`, probe: async () => !(await tabsNow()).some((tab) => tab.tabId === tabId), timeout: 15_000 }).then(() => true, () => false)
  /** ⌘T 실제 키 → fixture 영역 새 셸 탭 → 그 pane 을 눌러 포커스 → (running) `sleep 600⏎` 를 실제로 친다. */
  const newShellTab = async ({ name, running }) => {
    const before = (await tabsNow()).map((tab) => tab.tabId)
    const keyResponse = await key({ keyCode: 't', modifiers: ['meta'] })
    const tab = await until({ label: `${name} 새 탭`, probe: async () => (await tabsNow()).find((row) => !before.includes(row.tabId)) ?? null, timeout: 20_000 })
    const paneId = tab.panes[0]?.paneId ?? null
    await until({ label: `${name} pane box`, probe: () => evaluate({ fn: (id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, arg: paneId }), timeout: 10_000 })
    await pause(1200)
    if (running) {
      await click(`[data-term-pane-box="${paneId}"]`)
      await control({ cmd: 'type', text: 'sleep 600\r' })
      await until({ label: `${name} sleep`, probe: async () => {
        const info = await herdr({ method: 'pane.process_info', params: { pane_id: paneId } })
        return (info?.process_info?.foreground_processes ?? []).some((proc) => String(`${proc.name} ${proc.cmdline ?? ''}`).includes('sleep'))
      }, timeout: 15_000 })
    }
    return { key: keyResponse, tabId: tab.tabId, paneId }
  }
  const pressClose = async (tabId) => {
    await click(`[data-main-tab="${tabId}"]`)
    await pause(300)
    const keyResponse = await key({ keyCode: 'w', modifiers: ['meta'] })
    const outcome = await until({ label: `⌘W ${tabId}`, probe: async () => {
      const m = await modal()
      if (m !== null) return { modal: m }
      if (!(await tabsNow()).some((tab) => tab.tabId === tabId)) return { closed: true }
      return null
    }, timeout: 8_000 }).catch(() => ({ timeout: true }))
    return { key: keyResponse, ...outcome }
  }
  const pin = async (tabId) => {
    await rightClick(`[data-main-tab="${tabId}"]`)
    await until({ label: `tab menu ${tabId}`, probe: () => evaluate({ fn: (id) => document.querySelector(`[data-tab-menu-pin="${id}"]`) !== null, arg: tabId }), timeout: 5_000 })
    await click(`[data-tab-menu-pin="${tabId}"]`)
    await pause(400)
  }

  // ── ⓐ 설정 시작 › 일반 — 세 토글 「켜짐」 ─────────────────────────────────────
  const general = await openSettings('general')
  result.steps.a = { general, shot: await shot({ name: 'a-settings-general', selector: '[data-settings-page]' }), file: confirmKeys() }
  checks.require('k9a-three-on', general.general.length === 3 && general.general.every((row) => row.checked === 'true') && result.steps.a.file !== '(파일 없음)' && Object.values(result.steps.a.file).every((value) => value === '(칸 없음)'), result.steps.a)
  await closeSettings()
  save()

  // ── ⓑ 실행 중 → 체크 + 확인 ───────────────────────────────────────────────
  const b1 = await newShellTab({ name: 'b1', running: true })
  const bClose = await pressClose(b1.tabId)
  bClose.shot = await shot({ name: 'b-confirm-running', selector: '[data-confirm-close-modal]' })
  checks.require('k9b-running-modal', bClose.modal?.kind === 'command' && bClose.modal?.checkbox?.label === '실행 중인 터미널에 대해 다시 묻지 않기', bClose)
  await click('[data-confirm-close-modal] [data-dont-ask-again-input]')
  const offB = ndjsonSize()
  await click('[data-close-confirm-ok]')
  bClose.closed = await tabGone(b1.tabId)
  bClose.writes = rowsFrom({ offset: offB, tag: 'settings.changed' })
  bClose.file = confirmKeys()
  checks.require('k9b-saved-closed', bClose.closed && bClose.file.skipCloseTerminalWithRunningProcessConfirm === true && bClose.writes.length === 1, bClose)
  result.steps.b = { tab: b1, ...bClose }
  save()

  // ── ⓒ 다음 ⌘W 무확인 → 설정에서 켜기 → 다시 창 → 취소 → 정리 ──────────────────────
  const c1 = await newShellTab({ name: 'c1', running: true })
  const c1Close = await pressClose(c1.tabId)
  c1Close.closedNow = await tabGone(c1.tabId)
  checks.require('k9c-no-confirm', c1Close.modal === undefined && c1Close.closedNow, c1Close)
  const cToggle = await toggleGeneral({ id: 'confirm-close-running-terminal', expect: 'true' })
  checks.require('k9c-reenabled', cToggle.file.skipCloseTerminalWithRunningProcessConfirm === false && cToggle.writes === 1, cToggle)
  const c2 = await newShellTab({ name: 'c2', running: true })
  const c2Close = await pressClose(c2.tabId)
  checks.require('k9c-asks-again', c2Close.modal?.kind === 'command' && c2Close.modal?.checkbox?.checked === false, c2Close)
  await click('[data-close-confirm-cancel]')
  c2Close.afterCancel = { modal: await modal(), exists: (await tabsNow()).some((tab) => tab.tabId === c2.tabId) }
  checks.require('k9c-cancel-keeps', c2Close.afterCancel.modal === null && c2Close.afterCancel.exists, c2Close.afterCancel)
  const c2Cleanup = await pressClose(c2.tabId)
  if (c2Cleanup.modal) await click('[data-close-confirm-ok]')
  c2Cleanup.closed = await tabGone(c2.tabId)
  checks.require('k9c-cleanup-closed', c2Cleanup.closed && confirmKeys().skipCloseTerminalWithRunningProcessConfirm === false, c2Cleanup)
  result.steps.c = { c1, c1Close, cToggle, c2, c2Close, c2Cleanup }
  save()

  // ── ⓒ' 핀 탭 ──────────────────────────────────────────────────────────────
  const p1 = await newShellTab({ name: 'p1', running: false })
  await pin(p1.tabId)
  const p1Close = await pressClose(p1.tabId)
  p1Close.shot = await shot({ name: 'c2-confirm-pinned', selector: '[data-confirm-close-modal]' })
  checks.require('k9c2-pinned-modal', p1Close.modal?.kind === 'pinned' && p1Close.modal?.checkbox?.label === '고정된 탭에 대해 다시 묻지 않기', p1Close)
  await click('[data-confirm-close-modal] [data-dont-ask-again-input]')
  await click('[data-close-confirm-ok]')
  p1Close.closed = await tabGone(p1.tabId)
  p1Close.file = confirmKeys()
  checks.require('k9c2-pinned-off', p1Close.closed && p1Close.file.confirmClosePinnedTab === false, p1Close)
  const p2 = await newShellTab({ name: 'p2', running: false })
  await pin(p2.tabId)
  const p2Close = await pressClose(p2.tabId)
  p2Close.closedNow = await tabGone(p2.tabId)
  checks.require('k9c2-next-pinned-no-confirm', p2Close.modal === undefined && p2Close.closedNow, p2Close)
  const pToggle = await toggleGeneral({ id: 'confirm-close-pinned-tab', expect: 'true' })
  checks.require('k9c2-reenabled', pToggle.file.confirmClosePinnedTab === true, pToggle)
  result.steps.cPin = { p1, p1Close, p2, p2Close, pToggle }
  save()

  // ── ⓓ fixture 워크트리 삭제 ────────────────────────────────────────────────
  const deleteSnap = () => evaluate({ fn: () => {
    const el = document.querySelector('[data-delete-worktree-dialog]')
    const box = el?.querySelector('[data-dont-ask-again]') ?? null
    return {
      dialog: el === null ? null : { path: el.getAttribute('data-delete-worktree-dialog'), decision: el.getAttribute('data-delete-decision'), checkbox: box === null ? null : { label: box.textContent, checked: box.querySelector('input')?.checked ?? null } },
      notice: document.querySelector('[data-add-notice] .inline-notice-text')?.textContent ?? null,
      cards: [...document.querySelectorAll('[data-worktree]')].map((card) => card.getAttribute('data-worktree')),
    }
  } })
  const requestDelete = async (wt) => {
    if (!wt.startsWith('/tmp/l516n') && !wt.startsWith('/private/tmp/l516n')) throw new Error(`격리 규칙 8 — /tmp/l516n 밖 삭제 시도: ${wt}`)
    result.deletes.push({ at: new Date().toISOString(), path: wt })
    save()
    await rightClick(`[data-worktree="${wt}"] [data-worktree-card-surface]`)
    await until({ label: `card menu ${wt}`, probe: () => evaluate({ fn: () => document.querySelector('[data-card-menu] [data-menu-action="delete"]') !== null }), timeout: 5_000 })
    await click('[data-card-menu] [data-menu-action="delete"]')
  }
  const wA = realWt('clean-a')
  await requestDelete(wA)
  const d1 = { dialog: await until({ label: 'delete dialog a', probe: async () => { const s = await deleteSnap(); return s.dialog !== null && s.dialog.decision !== 'loading' ? s.dialog : null }, timeout: 15_000 }) }
  d1.shot = await shot({ name: 'd-delete-dialog', selector: '[data-delete-worktree-dialog]' })
  checks.require('k9d-checkbox', d1.dialog.decision === 'delete' && d1.dialog.checkbox?.label === '깨끗한 워크트리는 다시 묻지 않기', d1)
  await click('[data-delete-worktree-dialog] [data-dont-ask-again-input]')
  await click('[data-delete-confirm="delete"]')
  d1.gone = await until({ label: 'a gone', probe: async () => !(await deleteSnap()).cards.includes(wA) && !fs.existsSync(wA), timeout: 60_000 }).then(() => true, () => false)
  await pause(400)
  d1.notice = (await deleteSnap()).notice
  d1.file = confirmKeys()
  checks.require('k9d-saved-deleted', d1.gone && d1.file.skipDeleteWorktreeConfirm === true && (d1.notice ?? '').includes('설정 › 일반'), d1)
  const wB = realWt('clean-b')
  await requestDelete(wB)
  let sawDialog = false
  const d2 = { gone: await until({ label: 'b gone', probe: async () => { const s = await deleteSnap(); if (s.dialog !== null) sawDialog = true; return !s.cards.includes(wB) && !fs.existsSync(wB) }, timeout: 60_000 }).then(() => true, () => false) }
  d2.sawDialog = sawDialog
  checks.require('k9d-skip-no-dialog', d2.gone && !d2.sawDialog, d2)
  const dToggle = await toggleGeneral({ id: 'confirm-delete-worktree', expect: 'true' })
  checks.require('k9d-reenabled', dToggle.file.skipDeleteWorktreeConfirm === false, dToggle)
  result.steps.d = { d1, d2, dToggle }
  save()

  // ── ⓔ 카드 레이아웃 간단히 → 두 곳 → 재시작 ─────────────────────────────────────
  const cardLayoutDom = () => evaluate({ fn: () => [...new Set([...document.querySelectorAll('[data-card-layout]')].map((el) => el.getAttribute('data-card-layout')))] })
  const menuRadio = async () => {
    await click('[data-sidebar-options]')
    await click('[data-submenu-trigger="card-layout"]')
    const radios = await evaluate({ fn: () => [...document.querySelectorAll('[data-options-radio^="card-layout-"]')].map((el) => ({ key: el.getAttribute('data-options-radio'), checked: el.getAttribute('aria-checked') })) })
    for (let i = 0; i < 3; i += 1) { await key({ keyCode: 'Escape' }); await pause(150) }
    return radios
  }
  const appearance = await openSettings('appearance')
  const e = { before: appearance.segments, shotDetailed: await shot({ name: 'e-window-sidebar-detailed', selector: '[data-settings-collapsible="window-sidebar"]' }) }
  await click('[data-settings-collapsible="window-sidebar"] [data-segment-value="compact"]')
  await pause(600)
  e.after = (await settingsState()).segments
  e.shotCompact = await shot({ name: 'e-window-sidebar-compact', selector: '[data-settings-collapsible="window-sidebar"]' })
  e.prefs = cardPrefs()
  await closeSettings()
  e.dom = await cardLayoutDom()
  e.menu = await menuRadio()
  checks.require('k9e-both-compact', e.dom.length === 1 && e.dom[0] === 'compact' && e.menu.find((r) => r.key === 'card-layout-compact')?.checked === 'true' && e.prefs.sidebarCardLayout === 'compact', e)
  const restart = spawnSync('sh', [path.join(here, '../l470/native-app.sh'), root, appDir, rawd, 'restart'], { encoding: 'utf8', timeout: 180_000 })
  e.restart = { status: restart.status, stdout: restart.stdout.slice(-800), stderr: restart.stderr.slice(-800), newPid: Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8')) }
  checks.require('k9e-restart-ok', restart.status === 0 && e.restart.newPid !== result.appPid, e.restart)
  await until({ label: '재기동 뒤 제어 소켓', probe: async () => (await control({ cmd: 'state' })).ok !== false, timeout: 60_000 })
  await control({ cmd: 'window-visibility', action: 'show' })
  await until({ label: 'cards after restart', probe: async () => (await cardLayoutDom()).length > 0, timeout: 30_000 })
  await pause(1500)
  e.afterRestart = { dom: await cardLayoutDom(), menu: await menuRadio(), prefs: cardPrefs() }
  e.afterRestart.settings = (await openSettings('appearance')).segments
  e.afterRestart.general = (await openSettings('general')).general
  e.afterRestart.shot = await shot({ name: 'e-window-sidebar-after-restart', selector: '[data-settings-page]' })
  await closeSettings()
  checks.require('k9e-restart-both-compact', e.afterRestart.dom.length === 1 && e.afterRestart.dom[0] === 'compact' && e.afterRestart.menu.find((r) => r.key === 'card-layout-compact')?.checked === 'true' && e.afterRestart.settings.find((s) => s.value === 'compact')?.checked === 'true', e.afterRestart)
  checks.require('k9-general-all-on-after-restart', e.afterRestart.general.every((row) => row.checked === 'true'), e.afterRestart.general)
  result.steps.e = e
  result.settingsAtEnd = { keys: Object.keys(readJson(SETTINGS) ?? {}), confirm: confirmKeys() }
  result.finalTabs = (await tabsNow()).map((tab) => tab.tabId)
  checks.require('k9-fixture-tabs-restored', JSON.stringify(result.finalTabs) === JSON.stringify(initialTabs), { finalTabs: result.finalTabs, initialTabs })
  exitCode = checks.exitCode()
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[k9] 예외', result.error)
  exitCode = 2
} finally {
  result.finishedAt = new Date().toISOString()
  result.exitCode = exitCode
  save()
  console.log('[k9] exit', exitCode, checks.failed().map((row) => row.name))
  process.exit(exitCode)
}
