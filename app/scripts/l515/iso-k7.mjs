/* global window, document, getComputedStyle -- eval 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-515 **격리** 실측 — K7ⓐ~ⓔ · K5ⓓ(캡처) · K3ⓔ(실행 중 앱 메뉴 accelerator 덤프) · K6ⓑ(상태별 캡처).
// 격리 = launchCorral: /tmp/l515i* 아래 userData·herdr 세션(l443-gui-diff)·제어 소켓. 사용자 userData·herdr default 는 건드리지 않는다.
//
// provider 사용 0(격리 규칙 4): herdr 서버를 띄우기 전에 PATH 앞에 **가짜 claude·codex·grok**(이름을 찍고 대기하는 셸 스크립트)를 둔다.
// herdr `agent.start` 가 pane 셸에서 그 이름을 실행하면 가짜가 뜬다 — kind 는 ① corral 로그 `lifecycle.agent_started.kind`
// ② herdr `pane.process_info` 전경 argv(가짜 경로) ③ `pane.read` 화면 글자(`L515-FAKE-AGENT <이름>`) 셋으로 본다. 실제 에이전트는 실행하지 않는다.
//
// **판정 걸음은 전부 제품 경로**다: 기본값 선택 = 설정 화면 pill 의 실제 클릭(제어 소켓 click = sendInputEvent 좌표 클릭),
// ⌘⌥T = 실제 키 입력(제어 소켓 key = sendInputEvent keyDown/keyUp), 「Agent 설정…」 = 메뉴 항목의 실제 클릭.
// 준비 걸음(레포 등록·worktree 열기·첫 셸 탭)과 정리 걸음(생긴 탭 닫기)만 IPC 를 직접 부른다 — 판정에 세지 않는다.
// 사용(저장소 루트): npx tsx app/scripts/l515/iso-k7.mjs --app app --work /tmp/l515iN --port 95NN --out <raw> --ledger <runs.md>
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { backendRpc, launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { beginRun, finishRun } from '../gui-diff/lib/runs.mjs'
import { pause, requirements } from '../l497/lib.mjs'
import { finalExit, ledgerResult } from '../l512/final-exit.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l515i')) throw new Error('--work 는 /tmp/l515i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
const command = `npx tsx app/scripts/l515/iso-k7.mjs ${process.argv.slice(2).join(' ')}`
const criterion = 'K7ⓐ~ⓔ·K5ⓓ·K3ⓔ(메뉴 덤프)·K6ⓑ(캡처) (격리, 가짜 실행 파일)'
const ledger = args.ledger ? path.resolve(args.ledger) : null
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const rawRel = path.relative(repoRoot, out)
const runId = ledger ? beginRun(ledger, { criterion, command, expectedExit: 0, raw: rawRel }) : null

const ancestors = (() => {
  const set = new Set([process.pid])
  let pid = process.ppid
  for (let i = 0; i < 20 && pid > 1; i += 1) {
    set.add(pid)
    try { pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()) } catch { break }
  }
  return set
})()
const pgrep = (pattern) => { try { return execFileSync('pgrep', ['-fl', pattern], { encoding: 'utf8' }).trim().split('\n').filter((line) => line !== '' && !ancestors.has(Number(line.split(' ')[0]))).join('\n') } catch { return '' } }
// 504 가드 — 같은 격리 경로·herdr 세션(l443-gui-diff)을 쓰는 프로세스가 있으면 측정하지 않는다.
const guard = pgrep(`${work}|l443-gui-diff`)
fs.writeFileSync(path.join(out, 'guard-before.txt'), `pgrep -fl "${work}|l443-gui-diff" → ${guard === '' ? '(없음)' : `\n${guard}`}\n`)
if (guard !== '') {
  console.log('[k7] 504 가드: 같은 경로·세션을 쓰는 프로세스가 있다 — 멈춘다\n' + guard)
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: 3, raw: rawRel, result: '실패 — 504 가드(프로세스 있음)' })
  process.exit(3)
}
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
const fixture = path.join(work, 'fx')
fs.mkdirSync(fixture)
execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })

// ── 가짜 에이전트 실행 파일 ─────────────────────────────────────────────────
const fakeBin = path.join(work, 'fakebin')
fs.mkdirSync(fakeBin)
for (const name of ['claude', 'codex', 'grok']) {
  fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n# LIFE-515 K7 가짜 ${name} — 이름을 찍고 대기한다(provider 사용 0).\necho "L515-FAKE-AGENT ${name} argv=[$*]"\nwhile :; do sleep 5; done\n`, { mode: 0o755 })
}
process.env.PATH = `${fakeBin}:${process.env.PATH}`

const result = { app: path.resolve(args.app), work, fakeBin, startedAt: new Date().toISOString(), steps: {}, checks: null, notes: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-k7.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[k7] 필수 조건 실패', JSON.stringify(row).slice(0, 600)) })
result.checks = checks.results
const owned = []
let exitCode = 0
let handle = null
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '(없음)')

try {
  handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  result.env = { PATH_head: handle.env.PATH.split(':').slice(0, 2), SHELL: handle.env.SHELL }
  const settingsFile = path.join(handle.paths.userData, 'settings.json')
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  const logPath = path.join(handle.paths.userData, 'corral.ndjson')
  const logRows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) : [])
  const rowsSince = (n, tag) => logRows().slice(n).filter((row) => row.tag === tag)
  const until = async (label, fn, timeout = 10_000) => {
    const t0 = Date.now()
    for (;;) {
      const value = await fn()
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
  const key = (keyCode, modifiers = []) => control({ cmd: 'key', keyCode, modifiers })
  const shot = async (name, selector) => {
    try {
      const response = await control({ cmd: 'shot', name: `l515-${name}`, selector })
      if (response.ok && response.file && fs.existsSync(response.file)) {
        const dest = path.join(out, `${name}.png`)
        fs.copyFileSync(response.file, dest)
        return path.basename(dest)
      }
      return `실패: ${JSON.stringify(response).slice(0, 200)}`
    } catch (error) { return `실패: ${String(error).slice(0, 200)}` }
  }

  await seedCorralRepo(handle, fixture, { expectedWorktrees: 1 })
  const real = fs.realpathSync(fixture)
  await evaluate((root) => window.corral.openWorktree({ repoRoot: root, path: root, isLinked: false }), real)
  const workspaceOf = async () => {
    const state = (await control({ cmd: 'state' })).state
    for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === real) return row.workspace ?? null
    return null
  }
  const ws = await until('fixture workspace', workspaceOf, 30_000)
  const seedTab = await evaluate((input) => window.corral.createRow(input), { workspaceId: ws.workspaceId, kind: 'shell' })
  await click(`[data-worktree="${real}"] [data-worktree-card-surface]`)
  await pause(800)
  await click(`[data-main-tab="${seedTab.tabId}"]`)
  await until('seed pane box', () => evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, seedTab.paneId))
  await pause(800)
  result.seed = { workspaceId: ws.workspaceId, tab: seedTab }
  const initialTabs = ((await workspaceOf())?.tabs ?? []).map((tab) => tab.tabId)
  result.initialTabs = initialTabs

  // ── K3ⓔ 실행 중 앱 메뉴 accelerator 덤프 ──────────────────────────────────
  const menu = await control({ cmd: 'menu-dump' })
  fs.writeFileSync(path.join(out, 'menu-dump.json'), `${JSON.stringify(menu, null, 1)}\n`)
  const flat = []
  const walk = (items, trail) => { for (const item of items ?? []) { flat.push({ path: [...trail, item.label].join(' › '), role: item.role, accelerator: item.accelerator, roleAccelerator: item.roleAccelerator }); walk(item.items, [...trail, item.label]) } }
  for (const top of menu.menu ?? []) walk(top.items, [top.label])
  const norm = (value) => (value ?? '').toLowerCase().replaceAll('cmdorctrl', 'command').replaceAll('cmd', 'command').replaceAll('option', 'alt').replaceAll(' ', '')
  const optT = flat.filter((row) => [row.accelerator, row.roleAccelerator].some((value) => { const n = norm(value); return n.includes('command') && n.includes('alt') && /\+t$/.test(n) && !n.includes('shift') && !n.includes('control') }))
  result.menu = { items: flat.length, withAccelerator: flat.filter((row) => row.accelerator || row.roleAccelerator).length, cmdOptT: optT }
  checks.require('k3e-menu-dump', menu.ok === true && flat.length > 10, { items: flat.length })
  checks.require('k3e-menu-no-cmd-opt-t', optT.length === 0, { optT })
  save()

  // ── 단계 도우미 ──────────────────────────────────────────────────────────
  const settingsState = () => evaluate(() => ({
    open: document.querySelector('[data-settings-page]') !== null,
    section: document.querySelector('[data-settings-section]')?.getAttribute('data-settings-section') ?? null,
    groups: [...document.querySelectorAll('[data-settings-group-title]')].map((el) => el.textContent),
    nav: [...document.querySelectorAll('[data-settings-nav-item]')].map((el) => ({ id: el.getAttribute('data-settings-nav-item'), current: el.getAttribute('aria-current') })),
    pills: [...document.querySelectorAll('[data-default-agent]')].map((el) => ({ value: el.getAttribute('data-default-agent'), text: el.textContent, pressed: el.getAttribute('aria-pressed'), cls: el.className, bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, border: getComputedStyle(el).borderTopColor, weight: getComputedStyle(el).fontWeight, children: [...el.childNodes].map((node) => (node.nodeType === 3 ? `text:${node.textContent}` : node.nodeName.toLowerCase() + (node.querySelector?.('path')?.getAttribute('d') === 'M20 6 9 17l-5-5' ? ':check' : ''))) })),
    heading: document.querySelector('[data-settings-section] h2')?.textContent ?? null,
    sectionDescription: document.querySelector('[data-settings-section-header] p')?.textContent ?? null,
    subsection: document.querySelector('[data-settings-subsection-header] h3')?.textContent ?? null,
    subsectionDescription: document.querySelector('[data-settings-subsection-header] p')?.textContent ?? null,
  }))
  const chooseDefault = async (value, name) => {
    await click('[data-settings-open]')
    await until('settings open', async () => (await settingsState()).open)
    await click('[data-settings-nav-item="agents"]')
    await until('agents section', async () => (await settingsState()).section === 'agents')
    const before = await settingsState()
    const logBefore = logRows().length
    await click(`[data-default-agent="${value}"]`)
    await until(`pill ${value}`, async () => (await settingsState()).pills.find((pill) => pill.value === value)?.pressed === 'true', 5_000)
    await pause(300)
    const after = await settingsState()
    const writes = rowsSince(logBefore, 'settings.changed')
    // 이미 선택된 pill 을 다시 누른다 — 쓰기 0(K2ⓒ).
    const logAgain = logRows().length
    await click(`[data-default-agent="${value}"]`)
    await pause(500)
    const writesAgain = rowsSince(logAgain, 'settings.changed')
    const fileValue = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')).defaultAgent ?? '(칸 없음)' : '(파일 없음)'
    const screenshot = await shot(`settings-${name}`)
    await click('[data-settings-back]')
    await until('settings closed', async () => !(await settingsState()).open)
    await pause(500)
    const step = { before, after, writes, writesAgain, fileValue, settingsSha: sha(settingsFile), screenshot }
    result.steps[`settings-${name}`] = step
    save()
    return step
  }
  const tabsOf = async () => (await workspaceOf())?.tabs ?? []
  const domTabs = () => evaluate(() => [...document.querySelectorAll('[data-main-tab]')].map((el) => ({ tabId: el.getAttribute('data-main-tab'), active: el.hasAttribute('data-active') || el.getAttribute('aria-selected') === 'true', group: el.closest('[data-tab-group]')?.getAttribute('data-tab-group') ?? null })))
  const pressNewAgent = async (name) => {
    const tabsBefore = (await tabsOf()).map((tab) => tab.tabId)
    const logBefore = logRows().length
    const response = await key('t', ['meta', 'alt'])
    const newTab = await until(`${name} new tab`, async () => (await tabsOf()).find((tab) => !tabsBefore.includes(tab.tabId)) ?? null, 15_000)
    const paneId = newTab.panes[0]?.paneId ?? null
    await pause(2500)
    const started = rowsSince(logBefore, 'lifecycle.agent_started')
    const created = rowsSince(logBefore, 'lifecycle.tab_created')
    let processInfo = null
    let screen = null
    try { processInfo = await backendRpc(handle, 'pane.process_info', { pane_id: paneId }) } catch (error) { processInfo = { error: String(error) } }
    try { screen = (await backendRpc(handle, 'pane.read', { pane_id: paneId, source: 'visible', format: 'text', strip_ansi: true })).read?.text ?? null } catch (error) { screen = `오류: ${error}` }
    const dom = await domTabs()
    const focus = await evaluate(() => ({ active: document.activeElement?.className ?? null, inTerm: document.activeElement?.closest?.('[data-term-pane-box]')?.getAttribute('data-term-pane-box') ?? null }))
    const fakeLine = (screen ?? '').split('\n').find((line) => line.includes('L515-FAKE-AGENT')) ?? null
    const argv = JSON.stringify(processInfo?.process_info?.foreground_processes ?? processInfo)
    const step = { key: response, tabsBefore, newTab: { tabId: newTab.tabId, paneId, agent: newTab.panes[0]?.agent ?? null }, created, started, fakeLine, foregroundArgv: argv, dom, focus, screenshot: await shot(`newagent-${name}`) }
    result.steps[`newagent-${name}`] = step
    save()
    return step
  }
  const closeTab = async (tabId) => {
    let closed = await evaluate((id) => window.corral.closeTabs({ tabIds: [id], confirmed: true }), tabId)
    // 가짜 에이전트가 전경에 있으면 확인이 필요하다 — 그 pane 들을 확인한 것으로 다시 보낸다(정리 걸음, 판정 아님).
    if (closed?.outcome === 'needs-confirm') closed = { first: closed, second: await evaluate((input) => window.corral.closeTabs(input), { tabIds: [tabId], confirmed: true, confirmedPaneIds: closed.running.map((row) => row.paneId) }) }
    await until(`tab ${tabId} closed`, async () => !(await tabsOf()).some((tab) => tab.tabId === tabId), 15_000).catch(() => null)
    return closed
  }
  const menuState = () => evaluate(() => {
    const root = document.querySelector('[data-tab-create-menu]')
    if (!root) return null
    return {
      items: [...root.querySelectorAll('[data-tab-create-item]')].map((el) => ({ id: el.getAttribute('data-tab-create-item'), text: el.textContent, chip: el.querySelector('[data-tab-create-default-agent-shortcut]')?.textContent ?? null, color: getComputedStyle(el).color, cls: el.className })),
    }
  })
  const openPlusMenu = async () => {
    const groupId = await evaluate(() => document.querySelector('[data-main-tabbar-add]')?.getAttribute('data-main-tabbar-add') ?? null)
    await click(`[data-main-tabbar-add="${groupId}"]`)
    return until('+ menu', menuState, 5_000)
  }
  const escapeMenu = async () => {
    await key('Escape')
    await until('+ menu closed', async () => (await menuState()) === null, 5_000)
  }

  // ── 시작 상태(자동) — 섹션·메뉴 캡처 (K6ⓑ 상태 1) ───────────────────────────
  const plusAuto = await openPlusMenu()
  result.steps['menu-auto'] = { ...plusAuto, screenshot: await shot('menu-auto', '[data-tab-create-menu]') }
  checks.require('k4-auto-order', JSON.stringify(plusAuto.items.map((item) => item.id)) === JSON.stringify(['new-terminal', 'agent:claude', 'agent:codex', 'agent:grok', 'agent-settings']) && plusAuto.items.every((item) => item.chip === null), plusAuto)
  await escapeMenu()

  // ── K7ⓐ Codex → ⌘⌥T → codex 종류 탭 → + 메뉴 Codex 맨 앞·칩 ─────────────────
  const sCodex = await chooseDefault('codex', 'codex')
  checks.require('k7a-settings-codex', sCodex.fileValue === 'codex' && sCodex.writes.length === 1 && sCodex.writesAgain.length === 0, { fileValue: sCodex.fileValue, writes: sCodex.writes.length, writesAgain: sCodex.writesAgain.length })
  checks.require('k2-section', sCodex.before.groups[0] === 'AI 기능' && sCodex.before.heading === '에이전트' && sCodex.before.subsection === '기본 Agent' && JSON.stringify(sCodex.before.pills.map((pill) => pill.value)) === JSON.stringify(['auto', 'blank', 'claude', 'codex', 'grok']), sCodex.before)
  const nCodex = await pressNewAgent('codex')
  checks.require('k7a-codex-kind', nCodex.started.length === 1 && nCodex.started[0].kind === 'codex' && (nCodex.fakeLine ?? '').includes('L515-FAKE-AGENT codex'), { started: nCodex.started, fakeLine: nCodex.fakeLine, argv: nCodex.foregroundArgv })
  checks.require('k3c-new-tab-active', nCodex.dom.some((tab) => tab.tabId === nCodex.newTab.tabId && tab.active), { dom: nCodex.dom, newTab: nCodex.newTab })
  const plusCodex = await openPlusMenu()
  result.steps['menu-codex'] = { ...plusCodex, screenshot: await shot('menu-codex', '[data-tab-create-menu]') }
  checks.require('k7a-menu-codex-first-chip', plusCodex.items[1]?.id === 'agent:codex' && plusCodex.items[1]?.chip === '⌘⌥T' && plusCodex.items.filter((item) => item.chip !== null).length === 1, plusCodex)
  await escapeMenu()
  result.steps['close-codex'] = await closeTab(nCodex.newTab.tabId)

  // ── K7ⓑ agent 없음 → ⌘⌥T → 셸 탭 ───────────────────────────────────────
  const sBlank = await chooseDefault('blank', 'blank')
  checks.require('k7b-settings-blank', sBlank.fileValue === 'blank' && sBlank.writes.length === 1 && sBlank.writesAgain.length === 0, { fileValue: sBlank.fileValue })
  const nBlank = await pressNewAgent('blank')
  checks.require('k7b-shell-tab', nBlank.started.length === 0 && nBlank.created.length === 1 && nBlank.fakeLine === null, { started: nBlank.started, created: nBlank.created, fakeLine: nBlank.fakeLine })
  const plusBlank = await openPlusMenu()
  result.steps['menu-blank'] = { ...plusBlank, screenshot: await shot('menu-blank', '[data-tab-create-menu]') }
  checks.require('k4-blank-order-nochip', plusBlank.items[1]?.id === 'agent:claude' && plusBlank.items.every((item) => item.chip === null), plusBlank)
  await escapeMenu()
  result.steps['close-blank'] = await closeTab(nBlank.newTab.tabId)

  // ── K7ⓒ 자동 → ⌘⌥T → claude 종류 탭 ─────────────────────────────────────
  const sAuto = await chooseDefault('auto', 'auto')
  checks.require('k7c-settings-auto', sAuto.fileValue === 'auto' && sAuto.writes.length === 1, { fileValue: sAuto.fileValue })
  const nAuto = await pressNewAgent('auto')
  checks.require('k7c-claude-kind', nAuto.started.length === 1 && nAuto.started[0].kind === 'claude' && (nAuto.fakeLine ?? '').includes('L515-FAKE-AGENT claude'), { started: nAuto.started, fakeLine: nAuto.fakeLine })
  result.steps['close-auto'] = await closeTab(nAuto.newTab.tabId)

  // ── K7ⓓ 「Agent 설정…」 → 에이전트 섹션 (설정이 닫힌 상태 · 다른 섹션을 보다 닫은 상태) ───
  await openPlusMenu()
  await click('[data-tab-create-item="agent-settings"]')
  const deep1 = await until('deeplink 1', async () => { const s = await settingsState(); return s.open ? s : null }, 5_000)
  const menuAfter1 = await menuState()
  result.steps['deeplink-closed'] = { settings: deep1, menuAfter: menuAfter1, screenshot: await shot('deeplink-agents') }
  checks.require('k7d-deeplink-from-closed', deep1.section === 'agents' && deep1.nav.find((row) => row.id === 'agents')?.current === 'page' && menuAfter1 === null, deep1)
  await click('[data-settings-nav-item="shortcuts"]')
  await until('shortcuts', async () => (await settingsState()).section === 'shortcuts')
  await click('[data-settings-back]')
  await until('settings closed 2', async () => !(await settingsState()).open)
  // 키보드 걸음은 창이 앞에 있어야 한다 — 뒤 창에서는 rAF 가 멈춰 메뉴가 입력창에 포커스를 못 준다(사람이 키를 치는 창은 늘 앞이다).
  result.steps['window-show'] = await control({ cmd: 'window-visibility', action: 'show' })
  await pause(500)
  await openPlusMenu()
  // 키보드 — ↓ 로 정적 항목을 돌아 「Agent 설정…」 에서 Enter(K5ⓒ).
  const focusProbe = () => evaluate(() => ({ input: document.activeElement?.getAttribute('data-tab-create-input') ?? null, tag: document.activeElement?.tagName ?? null, cls: String(document.activeElement?.className ?? ''), menu: document.querySelector('[data-tab-create-menu]') !== null, hasFocus: document.hasFocus() }))
  const input = await until('menu input focus', async () => (await focusProbe()).input, 5_000).catch(async (error) => { result.steps['deeplink-focus-debug'] = await focusProbe(); save(); throw error })
  const trail = []
  for (let i = 0; i < 5; i += 1) {
    trail.push(await key('Down'))
    trail.push(await evaluate(() => document.activeElement?.getAttribute('data-tab-create-item') ?? document.activeElement?.tagName ?? null))
  }
  const focused = await evaluate(() => document.activeElement?.getAttribute('data-tab-create-item') ?? null)
  result.steps['deeplink-after-other-section'] = { inputFocused: input, trail, focusedBeforeEnter: focused }
  save()
  // 실제 Enter 한 번 = keyDown → char('\r') → keyUp. Blink 는 버튼을 keypress(char)에서 누른다 — keyDown·keyUp 만으로는 안 눌린다.
  result.steps['deeplink-after-other-section'].enter = [
    await control({ cmd: 'key', keyCode: 'Return', type: 'keyDown' }),
    await control({ cmd: 'type', text: '\r' }),
    await control({ cmd: 'key', keyCode: 'Return', type: 'keyUp' }),
  ]
  const deep2 = await until('deeplink 2', async () => { const s = await settingsState(); return s.open ? s : null }, 5_000)
  result.steps['deeplink-after-other-section'].settings = deep2
  checks.require('k7d-deeplink-keyboard-after-other', focused === 'agent-settings' && deep2.section === 'agents', { focused, section: deep2.section })
  await click('[data-settings-back]')
  await until('settings closed 3', async () => !(await settingsState()).open)

  // 상태별 캡처(K6ⓑ) — 명시 1개(Grok)의 설정 섹션·메뉴.
  const sGrok = await chooseDefault('grok', 'grok')
  const plusGrok = await openPlusMenu()
  result.steps['menu-grok'] = { ...plusGrok, screenshot: await shot('menu-grok', '[data-tab-create-menu]') }
  checks.require('k4-grok-first-chip', plusGrok.items[1]?.id === 'agent:grok' && plusGrok.items[1]?.chip === '⌘⌥T', plusGrok)
  await escapeMenu()
  result.steps['settings-grok-file'] = sGrok.fileValue

  // 끝 상태 — 탭은 시작 때의 탭만 남는다(⌘⌥T 로 생긴 탭은 측정 직후 닫았다, K7ⓔ).
  result.finalTabs = (await tabsOf()).map((tab) => ({ tabId: tab.tabId, agent: tab.panes[0]?.agent ?? null }))
  checks.require('k7e-agent-tabs-closed', JSON.stringify(result.finalTabs.map((tab) => tab.tabId)) === JSON.stringify(initialTabs), { finalTabs: result.finalTabs, initialTabs })
  exitCode = checks.exitCode()
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[k7] 예외', result.error)
  exitCode = 2
} finally {
  const pids = owned.filter((entry) => entry.pid).map((entry) => entry.pid)
  result.owned = owned
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* 이미 끝남 */ } }
  await pause(2000)
  result.alive = pids.filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
  for (const pid of result.alive) { try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝남 */ } }
  const leftover = pgrep(work)
  result.leftover = leftover
  for (const line of leftover.split('\n').filter(Boolean)) { try { process.kill(Number(line.split(' ')[0]), 'SIGTERM') } catch { /* 이미 끝남 */ } }
  await pause(1000)
  const left = pgrep(`${work}|l443-gui-diff`)
  fs.writeFileSync(path.join(out, 'guard-after.txt'), `pgrep -fl "${work}|l443-gui-diff" → ${left === '' ? '(없음)' : `\n${left}`}\nowned=${JSON.stringify(owned)}\n`)
  const final = finalExit({ exitCode, left })
  exitCode = final.exitCode
  result.finishedAt = new Date().toISOString()
  result.exitCode = exitCode
  save()
  const failed = checks.failed().map((row) => row.name)
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: exitCode, raw: rawRel, result: ledgerResult({ exitCode, leftover: final.leftover, error: result.error, failed }) })
  console.log('[k7] exit', exitCode, failed)
  process.exit(exitCode)
}
