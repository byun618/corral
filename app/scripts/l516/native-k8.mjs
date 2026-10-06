/* global document -- eval 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-515 K8 **네이티브 관문** — native-up.sh 가 띄운 사용자 userData + 구현 빌드 + herdr 정식 `default` 세션(LIFE-456 S9 B안).
// l513 native-k9 · l493 native-k5 의 틀(제어 소켓·ndjson 기준 길이·requirements·fixture 워크스페이스만 캡처)을 따른다.
//
// 입력 경로 — 판정 걸음은 전부 제품 경로: 클릭 = 제어 소켓 click(`webContents.sendInputEvent` 좌표), 키 = 제어 소켓 key(sendInputEvent keyDown/keyUp).
// 준비 걸음은 fixture 레포 등록(add-repo — 등록 핸들러)뿐이고 카드 열기는 실제 클릭이다. 저장소·IPC 를 직접 불러 기본값을 바꾸거나 탭을 만들지 않는다.
//
// **원자료 경계(사용자 데이터 비공개)**: 캡처는 설정 페이지·`+` 메뉴·fixture 영역(`[data-tab-group]`)만. 덤프는 fixture 워크스페이스의 탭만.
// 복구된 사용자 세션 pane(q2: claude 1·grok 2)에는 입력·포커스 조작을 하지 않는다 — 프로세스 목록만 남긴다.
// grok 화면 글자는 이메일을 가린 뒤 남긴다. trust 프롬프트가 나오면 **답하지 않는다**(q1 조건 2).
//
// ⓐ ⚙ → AI 기능 › 에이전트 → 「Grok」 pill 실제 클릭 → 사용자 settings.json defaultAgent grok(쓰기 1회) · 같은 pill 다시 = 쓰기 0
// ⓑ ⌘⌥T 실제 키 → fixture 영역에 grok 탭 · pane 에 grok(corral 로그 kind·process_info argv·화면) → 프롬프트 없이 ⌘W 실제 키(+ 확인 클릭)로 닫기 → grok 잔존 0
// ⓒ `+` 실제 클릭 → Grok 맨 앞·⌘⌥T 칩 캡처 → 「Agent 설정…」 실제 클릭 → 에이전트 섹션 캡처
// ⓓ 「agent 없음」 pill → ⌘⌥T → 셸 탭(agent.start 없음) → ⌘W 로 닫기
// ⓔ 정상 종료(native-app.sh 가 소유 확인 뒤 SIGTERM) → 재기동 → 설정 › 에이전트 「agent 없음」 활성 · settings.json blank
// ⓕ 원복은 native-down.sh(userData 바이트 복원 → settings.json 431B 원본 · manifest 전=후 · G6 전=후 · grok 런타임 목록)
// 사용(저장소 루트): node app/scripts/l515/native-k8.mjs <ROOT=/tmp/l516n*> <raw 폴더> <app 폴더>
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
const NDJSON = path.join(UD, 'corral.ndjson')
const HERDR_SOCK = path.join(HOME, '.config/herdr/herdr.sock')
const ctl = path.join(root, 'ctl.sock')
// 자체 도우미는 인자 하나(객체) — fix1 R1-03. rpc(소켓 공용 lib)는 그대로.
const control = (request) => rpc(ctl, request, 20_000)
const evaluate = async ({ fn, arg = null }) => (await rpc(ctl, { cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
const herdr = async ({ method, params }) => {
  const response = await rpc(HERDR_SOCK, { id: `l516-${Date.now()}`, method, params })
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`)
  return response.result
}
const maskEmail = (text) => String(text ?? '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')

const result = { startedAt: new Date().toISOString(), appPid: Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8')), input: 'control socket sendInputEvent (click·key)', steps: {}, notes: [] }
const save = () => fs.writeFileSync(path.join(rawd, 'k8.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[k8] 필수 조건 실패', JSON.stringify(row).slice(0, 500)) })
result.requirements = checks.results

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null)
// corral.ndjson 은 수백 MB 다 — 기준 시점의 길이부터만 읽는다.
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
  return response
}
const key = ({ keyCode, modifiers = [] }) => control({ cmd: 'key', keyCode, modifiers })
const shot = async ({ name, selector }) => {
  try {
    const response = await control({ cmd: 'shot', name: `l516n-${name}`, selector })
    if (response.ok && response.file && fs.existsSync(response.file)) {
      const dest = path.join(rawd, `${name}.png`)
      fs.copyFileSync(response.file, dest)
      fs.rmSync(response.file, { force: true })
      return path.basename(dest)
    }
    return `실패: ${JSON.stringify(response).slice(0, 200)}`
  } catch (error) { return `실패: ${String(error).slice(0, 200)}` }
}
const ps = () => execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' })
const descendants = (pid) => {
  const rows = ps().split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
  const out = []
  const walk = (parent) => { for (const row of rows.filter((r) => r.ppid === parent)) { out.push(row); walk(row.pid) } }
  walk(pid)
  return out
}

let exitCode = 0
const fixture = path.join(root, 'fx')
try {
  const backendPid = Number(fs.readFileSync(path.join(root, 'backend.pid'), 'utf8'))
  // q2 조건 1 — 복구된 사용자 세션의 프로세스 목록(입력·포커스 조작 없음).
  const restored = descendants(backendPid).filter((row) => /claude|grok|codex/.test(row.command)).map((row) => ({ pid: row.pid, ppid: row.ppid, command: maskEmail(row.command).slice(0, 200) }))
  result.restoredAgents = restored
  fs.writeFileSync(path.join(rawd, 'restored-agents.txt'), `${restored.map((row) => `${row.pid} ${row.ppid} ${row.command}`).join('\n')}\n`)
  save()

  // ── 준비: fixture 레포 등록(add-repo) → 카드 실제 클릭으로 연다 ─────────────────
  fs.mkdirSync(fixture, { recursive: true })
  execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })
  const real = fs.realpathSync(fixture)
  result.fixture = real
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
  const settingsState = () => evaluate({ fn: () => ({
    open: document.querySelector('[data-settings-page]') !== null,
    section: document.querySelector('[data-settings-section]')?.getAttribute('data-settings-section') ?? null,
    groups: [...document.querySelectorAll('[data-settings-group-title]')].map((el) => el.textContent),
    nav: [...document.querySelectorAll('[data-settings-nav-item]')].map((el) => ({ id: el.getAttribute('data-settings-nav-item'), current: el.getAttribute('aria-current') })),
    pills: [...document.querySelectorAll('[data-default-agent]')].map((el) => ({ value: el.getAttribute('data-default-agent'), text: el.textContent, pressed: el.getAttribute('aria-pressed') })),
  }) })
  const fileAgent = () => readJson(SETTINGS)?.defaultAgent ?? '(칸 없음)'
  const chooseDefault = async ({ value, name }) => {
    await click('[data-settings-open]')
    await until({ label: 'settings open', probe: async () => (await settingsState()).open })
    await click('[data-settings-nav-item="agents"]')
    await until({ label: 'agents section', probe: async () => (await settingsState()).section === 'agents' })
    const before = await settingsState()
    const offset = ndjsonSize()
    await click(`[data-default-agent="${value}"]`)
    await until({ label: `pill ${value}`, probe: async () => (await settingsState()).pills.find((pill) => pill.value === value)?.pressed === 'true', timeout: 5_000 })
    await pause(400)
    const writes = rowsFrom({ offset, tag: 'settings.changed' })
    const offsetAgain = ndjsonSize()
    await click(`[data-default-agent="${value}"]`)
    await pause(600)
    const writesAgain = rowsFrom({ offset: offsetAgain, tag: 'settings.changed' })
    const after = await settingsState()
    const step = { before, after, writes, writesAgain, fileValue: fileAgent(), screenshot: await shot({ name: `settings-${name}`, selector: '[data-settings-page]' }) }
    await click('[data-settings-back]')
    await until({ label: 'settings closed', probe: async () => !(await settingsState()).open })
    await pause(600)
    result.steps[`settings-${name}`] = step
    save()
    return step
  }
  const tabsNow = async () => (await fixtureWorkspace())?.tabs ?? []
  const domTabs = () => evaluate({ fn: () => [...document.querySelectorAll('[data-main-tab]')].map((el) => ({ tabId: el.getAttribute('data-main-tab'), active: el.hasAttribute('data-active') })) })
  const pressNewAgent = async (name) => {
    const before = (await tabsNow()).map((tab) => tab.tabId)
    const offset = ndjsonSize()
    const response = await key({ keyCode: 't', modifiers: ['meta', 'alt'] })
    const tab = await until({ label: `${name} 새 탭`, probe: async () => (await tabsNow()).find((row) => !before.includes(row.tabId)) ?? null, timeout: 20_000 })
    const paneId = tab.panes[0]?.paneId ?? null
    return { response, before, tab, paneId, offset }
  }
  const menuState = () => evaluate({ fn: () => {
    const rootEl = document.querySelector('[data-tab-create-menu]')
    if (!rootEl) return null
    return { items: [...rootEl.querySelectorAll('[data-tab-create-item]')].map((el) => ({ id: el.getAttribute('data-tab-create-item'), text: el.textContent, chip: el.querySelector('[data-tab-create-default-agent-shortcut]')?.textContent ?? null })) }
  } })
  const closeActiveTab = async ({ tabId, label }) => {
    const steps = []
    steps.push({ key: await key({ keyCode: 'w', modifiers: ['meta'] }) })
    const confirm = await until({ label: `${label} 닫기 확인`, probe: async () => ((await control({ cmd: 'query', selector: '[data-close-confirm-ok]' })).found ?? []).length > 0 || !(await tabsNow()).some((row) => row.tabId === tabId), timeout: 8_000 }).catch(() => false)
    if (confirm && ((await control({ cmd: 'query', selector: '[data-close-confirm-ok]' })).found ?? []).length > 0) steps.push({ confirm: await click('[data-close-confirm-ok]') })
    const closed = await until({ label: `${label} 닫힘`, probe: async () => !(await tabsNow()).some((row) => row.tabId === tabId), timeout: 15_000 }).then(() => true, () => false)
    return { steps, closed }
  }

  // ── ⓐ 「Grok」 pill ─────────────────────────────────────────────────────
  const sGrok = await chooseDefault({ value: 'grok', name: 'grok' })
  checks.require('k8a-settings-grok', sGrok.fileValue === 'grok' && sGrok.writes.length === 1 && sGrok.writesAgain.length === 0 && sGrok.before.groups[0] === 'AI 기능', { fileValue: sGrok.fileValue, writes: sGrok.writes.length, writesAgain: sGrok.writesAgain.length, groups: sGrok.before.groups })

  // ── ⓑ ⌘⌥T → grok 탭 ────────────────────────────────────────────────────
  const nGrok = await pressNewAgent('grok')
  const agentSeen = await until({ label: 'grok 감지(pane.agent)', probe: async () => { const row = (await tabsNow()).find((t) => t.tabId === nGrok.tab.tabId); return row?.panes[0]?.agent === 'grok' ? row.panes[0] : null }, timeout: 45_000 }).catch(() => null)
  await pause(1500)
  const started = rowsFrom({ offset: nGrok.offset, tag: 'lifecycle.agent_started' })
  let processInfo = null
  let screen = null
  try { processInfo = await herdr({ method: 'pane.process_info', params: { pane_id: nGrok.paneId } }) } catch (error) { processInfo = { error: String(error) } }
  try { screen = (await herdr({ method: 'pane.read', params: { pane_id: nGrok.paneId, source: 'visible', format: 'text', strip_ansi: true } })).read?.text ?? null } catch (error) { screen = `오류: ${error}` }
  const foreground = (processInfo?.process_info?.foreground_processes ?? []).map((row) => ({ pid: row.pid, name: row.name, cmdline: maskEmail(row.cmdline) }))
  const screenMasked = maskEmail(screen)
  fs.writeFileSync(path.join(rawd, 'grok-screen.txt'), `${screenMasked}\n`)
  const dom = await domTabs()
  const groupsAfter = await fixtureGroup()
  const grokStep = { key: nGrok.response, tab: { tabId: nGrok.tab.tabId, paneId: nGrok.paneId }, agentSeen: agentSeen?.agent ?? null, started, foreground, trustPrompt: /trust/i.test(screen ?? ''), dom, groupsAfter, screenshot: await shot({ name: 'grok-area', selector: `[data-tab-group="${groupsAfter.find((group) => group.tabs.includes(nGrok.tab.tabId))?.id ?? ''}"]` }) }
  result.steps['newagent-grok'] = grokStep
  save()
  checks.require('k8b-grok-tab-in-area', groupsAfter.some((group) => group.tabs.includes(nGrok.tab.tabId) && group.foreign === 0) && dom.some((row) => row.tabId === nGrok.tab.tabId && row.active), { groupsAfter, dom })
  checks.require('k8b-grok-kind', started.length === 1 && started[0].kind === 'grok', { started })
  checks.require('k8b-grok-process', foreground.some((row) => /grok/.test(`${row.name} ${row.cmdline}`)), { foreground })
  // 닫기 — 프롬프트를 보내지 않았다. ⌘W 실제 키 → 확인 창이면 확인 클릭.
  const grokClose = await closeActiveTab({ tabId: nGrok.tab.tabId, label: 'grok' })
  await pause(1500)
  const grokPids = foreground.filter((row) => /grok/.test(`${row.name} ${row.cmdline}`)).map((row) => row.pid)
  const grokAlive = grokPids.filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
  let pgrepGrok = ''
  try { pgrepGrok = execFileSync('pgrep', ['-fl', 'grok'], { encoding: 'utf8' }) } catch { pgrepGrok = '' }
  result.steps['close-grok'] = { ...grokClose, grokPids, grokAlive, pgrepGrok: maskEmail(pgrepGrok).split('\n').filter((line) => !line.includes('grok-bridge.js') && !line.includes('npm exec')).join('\n') }
  save()
  checks.require('k8b-grok-closed', grokClose.closed && grokAlive.length === 0, { closed: grokClose.closed, grokAlive })

  // ── ⓒ + 메뉴 · Agent 설정… ───────────────────────────────────────────────
  const groupId = (await fixtureGroup())[0]?.id
  await click(`[data-main-tabbar-add="${groupId}"]`)
  const menu = await until({ label: '+ 메뉴', probe: menuState, timeout: 5_000 })
  const menuShot = await shot({ name: 'menu-grok', selector: '[data-tab-create-menu]' })
  await click('[data-tab-create-item="agent-settings"]')
  const deep = await until({ label: '딥링크', probe: async () => { const s = await settingsState(); return s.open ? s : null }, timeout: 5_000 })
  const menuAfter = await menuState()
  result.steps['menu-deeplink'] = { menu, menuShot, settings: deep, menuAfter, screenshot: await shot({ name: 'deeplink-agents', selector: '[data-settings-page]' }) }
  checks.require('k8c-menu-grok-first-chip', menu.items[1]?.id === 'agent:grok' && menu.items[1]?.chip === '⌘⌥T' && menu.items.at(-1)?.id === 'agent-settings', menu)
  checks.require('k8c-deeplink-agents', deep.section === 'agents' && menuAfter === null, { section: deep.section })
  await click('[data-settings-back]')
  await until({ label: 'settings closed', probe: async () => !(await settingsState()).open })
  await pause(600)
  save()

  // ── ⓓ agent 없음 → ⌘⌥T → 셸 탭 ───────────────────────────────────────────
  const sBlank = await chooseDefault({ value: 'blank', name: 'blank' })
  checks.require('k8d-settings-blank', sBlank.fileValue === 'blank' && sBlank.writes.length === 1, { fileValue: sBlank.fileValue })
  const nBlank = await pressNewAgent('blank')
  await pause(2500)
  const blankStarted = rowsFrom({ offset: nBlank.offset, tag: 'lifecycle.agent_started' })
  const blankCreated = rowsFrom({ offset: nBlank.offset, tag: 'lifecycle.tab_created' })
  let blankInfo = null
  try { blankInfo = await herdr({ method: 'pane.process_info', params: { pane_id: nBlank.paneId } }) } catch (error) { blankInfo = { error: String(error) } }
  const blankFg = (blankInfo?.process_info?.foreground_processes ?? []).map((row) => ({ name: row.name, cmdline: maskEmail(row.cmdline) }))
  const blankClose = await closeActiveTab({ tabId: nBlank.tab.tabId, label: 'blank' })
  result.steps['newagent-blank'] = { key: nBlank.response, tab: nBlank.tab.tabId, started: blankStarted, created: blankCreated, foreground: blankFg, close: blankClose }
  checks.require('k8d-shell-tab', blankStarted.length === 0 && blankCreated.length === 1 && !blankFg.some((row) => /claude|codex|grok/.test(`${row.name} ${row.cmdline}`)), { blankStarted, blankCreated, blankFg })
  checks.require('k8d-shell-closed', blankClose.closed, blankClose)
  save()

  // ── ⓔ 정상 종료 → 재기동 → 마지막 값 유지 ───────────────────────────────────
  const fileBeforeRestart = fileAgent()
  const restart = spawnSync('sh', [path.join(here, '../l470/native-app.sh'), root, appDir, rawd, 'restart'], { encoding: 'utf8', timeout: 180_000 })
  result.steps.restart = { status: restart.status, stdout: restart.stdout.slice(-800), stderr: restart.stderr.slice(-800), newPid: Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8')) }
  checks.require('k8e-restart-ok', restart.status === 0 && result.steps.restart.newPid !== result.appPid, result.steps.restart)
  await until({ label: '재기동 뒤 제어 소켓', probe: async () => (await control({ cmd: 'state' })).ok !== false, timeout: 60_000 })
  await control({ cmd: 'window-visibility', action: 'show' })
  await pause(1500)
  await click('[data-settings-open]')
  await until({ label: 'settings open (restart)', probe: async () => (await settingsState()).open, timeout: 15_000 })
  await click('[data-settings-nav-item="agents"]')
  const afterRestart = await until({ label: 'agents (restart)', probe: async () => { const s = await settingsState(); return s.section === 'agents' ? s : null }, timeout: 10_000 })
  result.steps['after-restart'] = { fileBeforeRestart, fileAfterRestart: fileAgent(), settings: afterRestart, screenshot: await shot({ name: 'settings-after-restart', selector: '[data-settings-page]' }) }
  checks.require('k8e-persist', fileBeforeRestart === 'blank' && fileAgent() === 'blank' && afterRestart.pills.find((pill) => pill.value === 'blank')?.pressed === 'true', result.steps['after-restart'])
  await click('[data-settings-back]')
  // 끝 상태 — fixture 탭은 시작 때 그대로(⌘⌥T 로 생긴 탭은 닫았다).
  result.finalTabs = (await tabsNow()).map((tab) => tab.tabId)
  checks.require('k8-fixture-tabs-restored', JSON.stringify(result.finalTabs) === JSON.stringify(initialTabs), { finalTabs: result.finalTabs, initialTabs })
  exitCode = checks.exitCode()
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[k8] 예외', result.error)
  exitCode = 2
} finally {
  result.finishedAt = new Date().toISOString()
  result.exitCode = exitCode
  save()
  console.log('[k8] exit', exitCode, checks.failed().map((row) => row.name))
  process.exit(exitCode)
}
