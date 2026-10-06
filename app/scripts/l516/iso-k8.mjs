/* global window, document, getComputedStyle -- eval 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-516 **격리** 실측 — K8ⓐ~ⓔ · K7ⓑ(상태별 캡처·클래스/문구 덤프) · K4ⓒ(워크트리 닫기) · K3ⓕ(메뉴 닫기 비활성 사유 문구).
// 격리 = launchCorral: /tmp/l516i* 아래 userData·herdr 세션(l443-gui-diff)·제어 소켓. 사용자 userData·herdr default 는 건드리지 않는다.
// provider 사용 0 — 「실행 중」 은 pane 셸의 `sleep 600`(셸 프로세스, 격리 규칙 4).
//
// **판정 걸음은 전부 제품 경로**다: 닫기 = 실제 ⌘W(sendInputEvent keyDown → main before-input-event)·탭 메뉴 「다른 탭 닫기」 실제 클릭 ·
// 체크박스·확인·취소 = 대화상자의 실제 클릭 · 토글·세그먼트 = 설정 화면의 실제 클릭 · 삭제 = 카드 우클릭 메뉴 「삭제」 실제 클릭 ·
// 핀 = 탭 우클릭 메뉴 「탭 고정」 실제 클릭 · 카드 레이아웃 = 설정 세그먼트·사이드바 옵션 메뉴 라디오 실제 클릭.
// **준비 걸음**(판정 아님, 제품 경로 우회 — RESULT 에 적는다): 레포 등록(add-repo) · worktree 열기 · 셸 탭 만들기(createRow IPC) ·
// `sleep 600` 입력(herdr pane.send_text) · 끝 정리(남은 탭 닫기 IPC). 저장소 직접 쓰기·닫기/삭제 IPC 직접 호출로 판정하는 걸음은 없다.
// 워크트리 삭제 대상은 /tmp/l516i* 아래 fixture 의 linked worktree 만 — 지우기 전 경로를 원자료에 적고 접두를 assert 한다(격리 규칙 8).
// 사용(저장소 루트): npx tsx app/scripts/l516/iso-k8.mjs --app app --work /tmp/l516iN --port 95NN --out <raw> --ledger <runs.md>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { backendRpc, launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { beginRun, finishRun } from '../gui-diff/lib/runs.mjs'
import { pause, requirements } from '../l497/lib.mjs'
import { finalExit, ledgerResult } from '../l512/final-exit.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l516i')) throw new Error('--work 는 /tmp/l516i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
const command = `npx tsx app/scripts/l516/iso-k8.mjs ${process.argv.slice(2).join(' ')}`
const criterion = 'K8ⓐ~ⓔ·K7ⓑ(캡처·덤프)·K4ⓒ·K3ⓕ (격리, 셸 sleep)'
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
  console.log('[k8] 504 가드: 같은 경로·세션을 쓰는 프로세스가 있다 — 멈춘다\n' + guard)
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: 3, raw: rawRel, result: '실패 — 504 가드(프로세스 있음)' })
  process.exit(3)
}
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
const git = (cwd, ...rest) => execFileSync('git', ['-c', 'user.name=fx', '-c', 'user.email=fx@local', ...rest], { cwd, encoding: 'utf8' })
const fixture = path.join(work, 'fx')
fs.mkdirSync(fixture)
git(fixture, 'init', '-q', '-b', 'main')
fs.writeFileSync(path.join(fixture, 'README.md'), 'fx\n')
git(fixture, 'add', '.')
git(fixture, 'commit', '-qm', 'init')
const wtRoot = path.join(work, 'fx-wt')
const WT = ['clean-a', 'clean-b', 'clean-c', 'dirty']
for (const name of WT) git(fixture, 'worktree', 'add', '-q', '-b', `l516-${name}`, path.join(wtRoot, name))
fs.writeFileSync(path.join(wtRoot, 'dirty', 'uncommitted.txt'), 'dirty\n')

const result = { app: path.resolve(args.app), work, startedAt: new Date().toISOString(), steps: {}, checks: null, notes: [], deletes: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-k8.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[k8] 필수 조건 실패', JSON.stringify(row).slice(0, 600)) })
result.checks = checks.results
const owned = []
let exitCode = 0

const killOwned = async () => {
  const pids = owned.filter((entry) => entry.pid).map((entry) => entry.pid)
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* 이미 끝남 */ } }
  await pause(2500)
  const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
  for (const pid of alive) { try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝남 */ } }
  return alive
}

try {
  let handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  const settingsFile = path.join(handle.paths.userData, 'settings.json')
  const uiPrefsFile = path.join(handle.paths.userData, 'ui-prefs.json')
  const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null)
  const settingsNow = () => {
    const file = readJson(settingsFile)
    if (file === null) return '(파일 없음)'
    return { confirmClosePinnedTab: file.confirmClosePinnedTab ?? '(칸 없음)', skipCloseTerminalWithRunningProcessConfirm: file.skipCloseTerminalWithRunningProcessConfirm ?? '(칸 없음)', skipDeleteWorktreeConfirm: file.skipDeleteWorktreeConfirm ?? '(칸 없음)' }
  }
  const control = (request) => rpc(handle.control, request, 20_000)
  const evaluate = async ({ fn, arg = null }) => (await rpc(handle.control, { cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  const until = async ({ label, probe, timeout = 10_000 }) => {
    const t0 = Date.now()
    for (;;) {
      const value = await probe()
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
    // run-2 에서 섹션 전환 직후 캡처가 `UnknownVizError` 로 한 번 실패했다 — 잠깐 쉬고 한 번 더 찍는다(판정 아님, 캡처).
    const first = await shotOnce({ name, selector })
    if (!first.startsWith('실패')) return first
    await pause(800)
    return shotOnce({ name, selector })
  }
  const shotOnce = async ({ name, selector }) => {
    try {
      const response = await control({ cmd: 'shot', name: `l516-${name}`, selector })
      if (response.ok && response.file && fs.existsSync(response.file)) {
        const dest = path.join(out, `${name}.png`)
        fs.copyFileSync(response.file, dest)
        return path.basename(dest)
      }
      return `실패: ${JSON.stringify(response).slice(0, 200)}`
    } catch (error) { return `실패: ${String(error).slice(0, 200)}` }
  }

  await seedCorralRepo(handle, fixture, { expectedWorktrees: 1 + WT.length })
  const real = fs.realpathSync(fixture)
  const realWt = (name) => fs.realpathSync(path.join(wtRoot, name))
  await evaluate({ fn: (root) => window.corral.openWorktree({ repoRoot: root, path: root, isLinked: false }), arg: real })
  const workspaceOf = async () => {
    const state = (await control({ cmd: 'state' })).state
    for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === real) return row.workspace ?? null
    return null
  }
  const ws = await until({ label: 'fixture workspace', probe: workspaceOf, timeout: 30_000 })
  const tabsOf = async () => (await workspaceOf())?.tabs ?? []
  const T0 = await evaluate({ fn: (input) => window.corral.createRow(input), arg: { workspaceId: ws.workspaceId, kind: 'shell' } })
  await click(`[data-worktree="${real}"] [data-worktree-card-surface]`)
  await pause(800)
  await click(`[data-main-tab="${T0.tabId}"]`)
  await until({ label: 'seed pane box', probe: () => evaluate({ fn: (id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, arg: T0.paneId }) })
  result.steps.window = await control({ cmd: 'window-visibility', action: 'show' })
  await pause(800)
  result.seed = { workspaceId: ws.workspaceId, T0 }
  result.settingsInitial = settingsNow()
  checks.require('k1-no-file-at-start', result.settingsInitial === '(파일 없음)', { settings: result.settingsInitial })

  // ── 도우미 ──────────────────────────────────────────────────────────────
  /** 준비 걸음 — 새 셸 탭(IPC) → 탭 클릭으로 활성 → (선택) `sleep 600` 입력 후 전경이 셸 아님이 될 때까지. */
  const newShellTab = async ({ name, running }) => {
    const before = (await tabsOf()).map((tab) => tab.tabId)
    const created = await evaluate({ fn: (input) => window.corral.createRow(input), arg: { workspaceId: ws.workspaceId, kind: 'shell' } })
    await until({ label: `${name} tab`, probe: async () => (await tabsOf()).some((tab) => tab.tabId === created.tabId && !before.includes(tab.tabId)), timeout: 15_000 })
    await click(`[data-main-tab="${created.tabId}"]`)
    await until({ label: `${name} pane box`, probe: () => evaluate({ fn: (id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, arg: created.paneId }) })
    await pause(500)
    if (running) {
      await backendRpc(handle, 'pane.send_text', { pane_id: created.paneId, text: 'sleep 600\r' })
      await until({ label: `${name} sleep running`, probe: async () => {
        const info = await backendRpc(handle, 'pane.process_info', { pane_id: created.paneId }).catch(() => null)
        const fg = info?.process_info?.foreground_processes ?? []
        return fg.some((proc) => String(proc.name ?? proc.cmdline ?? '').includes('sleep'))
      }, timeout: 10_000 })
    }
    return created
  }
  const activate = async (tabId) => { await click(`[data-main-tab="${tabId}"]`); await pause(300) }
  const pin = async (tabId) => {
    await rightClick(`[data-main-tab="${tabId}"]`)
    await until({ label: `tab menu ${tabId}`, probe: () => evaluate({ fn: (id) => document.querySelector(`[data-tab-menu-pin="${id}"]`) !== null, arg: tabId }), timeout: 5_000 })
    const menu = await evaluate({ fn: (id) => {
      const close = document.querySelector(`[data-tab-menu-close="${id}"]`)
      return { pinLabel: document.querySelector(`[data-tab-menu-pin="${id}"]`)?.textContent ?? null, closeDisabled: close?.getAttribute('aria-disabled') ?? close?.hasAttribute('disabled') ?? null, closeTitle: close?.getAttribute('title') ?? null }
    }, arg: tabId })
    await click(`[data-tab-menu-pin="${tabId}"]`)
    await pause(400)
    return menu
  }
  const tabMenuAfterPin = async (tabId) => {
    await rightClick(`[data-main-tab="${tabId}"]`)
    await until({ label: `tab menu ${tabId}`, probe: () => evaluate({ fn: (id) => document.querySelector(`[data-tab-menu-close="${id}"]`) !== null, arg: tabId }), timeout: 5_000 })
    const menu = await evaluate({ fn: (id) => {
      const close = document.querySelector(`[data-tab-menu-close="${id}"]`)
      return { closeText: close?.textContent ?? null, ariaDisabled: close?.getAttribute('aria-disabled') ?? null, disabled: close?.hasAttribute('disabled') ?? null, title: close?.getAttribute('title') ?? null, html: close?.outerHTML?.slice(0, 400) ?? null }
    }, arg: tabId })
    await key({ keyCode: 'Escape' })
    await pause(300)
    return menu
  }
  const modal = () => evaluate({ fn: () => {
    const el = document.querySelector('[data-confirm-close-modal]')
    if (!el) return null
    const box = el.querySelector('[data-dont-ask-again]')
    const input = el.querySelector('[data-dont-ask-again-input]')
    return {
      kind: el.getAttribute('data-confirm-close-kind'),
      title: el.querySelector('[data-confirm-close-title]')?.textContent ?? null,
      body: [...el.querySelectorAll('[data-confirm-close-body]')].map((p) => p.textContent),
      tabs: [...el.querySelectorAll('[data-confirm-close-tab]')].map((li) => li.getAttribute('data-confirm-close-tab')),
      fg: [...el.querySelectorAll('.modal-code-block')].map((li) => li.textContent),
      checkbox: box === null ? null : { label: box.textContent, checked: input?.checked ?? null, cls: box.className, font: getComputedStyle(box).fontSize, color: getComputedStyle(box).color, gap: getComputedStyle(box).gap },
      confirm: el.querySelector('[data-close-confirm-ok]')?.textContent ?? null,
      cancel: el.querySelector('[data-close-confirm-cancel]')?.textContent ?? null,
    }
  } })
  const tabGone = async (tabId) => until({ label: `tab ${tabId} gone`, probe: async () => !(await tabsOf()).some((tab) => tab.tabId === tabId), timeout: 15_000 }).then(() => true).catch(() => false)
  /** ⌘W 뒤 창이 뜨는지/탭이 닫히는지 둘 중 하나가 될 때까지(최대 6초). */
  const pressClose = async (tabId) => {
    await activate(tabId)
    const keyResponse = await key({ keyCode: 'w', modifiers: ['meta'] })
    const outcome = await until({ label: `⌘W ${tabId}`, probe: async () => {
      const m = await modal()
      if (m !== null) return { modal: m }
      if (!(await tabsOf()).some((tab) => tab.tabId === tabId)) return { closed: true }
      return null
    }, timeout: 6_000 }).catch(() => ({ timeout: true }))
    return { key: keyResponse, ...outcome }
  }
  const settingsState = () => evaluate({ fn: () => ({
    open: document.querySelector('[data-settings-page]') !== null,
    section: document.querySelector('[data-settings-section]')?.getAttribute('data-settings-section') ?? null,
    groups: [...document.querySelectorAll('[data-settings-group-title]')].map((el) => el.textContent),
    nav: [...document.querySelectorAll('[data-settings-nav-item]')].map((el) => el.getAttribute('data-settings-nav-item')),
    general: [...document.querySelectorAll('[data-settings-general-row]')].map((row) => ({
      id: row.getAttribute('data-settings-general-row'),
      label: row.querySelector('.settings-row-label')?.textContent ?? null,
      description: row.querySelector('.settings-row-description')?.textContent ?? null,
      checked: row.querySelector('[data-settings-switch]')?.getAttribute('aria-checked') ?? null,
      rowCls: row.querySelector('[data-settings-row]')?.className ?? null,
    })),
    subsections: [...document.querySelectorAll('[data-settings-section] [data-settings-subsection-header] h3')].map((el) => el.textContent),
    heading: document.querySelector('[data-settings-section] h2')?.textContent ?? null,
    sectionDescription: document.querySelector('[data-settings-section-header] p')?.textContent ?? null,
    windowCard: (() => {
      const card = document.querySelector('[data-settings-collapsible="window-sidebar"]')
      if (!card) return null
      return {
        title: card.querySelector('.settings-collapsible-title')?.textContent ?? null,
        label: card.querySelector('.settings-row-label')?.textContent ?? null,
        description: card.querySelector('.settings-row-description')?.textContent ?? null,
        segments: [...card.querySelectorAll('[data-segment-value]')].map((el) => ({ value: el.getAttribute('data-segment-value'), text: el.textContent, checked: el.getAttribute('aria-checked'), cls: el.className })),
      }
    })(),
  }) })
  const openSettings = async (section) => {
    if (!(await settingsState()).open) {
      await click('[data-settings-open]')
      await until({ label: 'settings open', probe: async () => (await settingsState()).open })
    }
    await click(`[data-settings-nav-item="${section}"]`)
    await until({ label: `${section} section`, probe: async () => (await settingsState()).section === section })
    return settingsState()
  }
  const closeSettings = async () => {
    await click('[data-settings-back]')
    await until({ label: 'settings closed', probe: async () => !(await settingsState()).open })
    await pause(400)
  }
  const toggleGeneral = async ({ id, expect }) => {
    await openSettings('general')
    const before = settingsNow()
    await click(`[data-settings-general-row="${id}"] [data-settings-switch]`)
    const after = await until({ label: `toggle ${id}`, probe: async () => { const s = await settingsState(); const row = s.general.find((r) => r.id === id); return row?.checked === expect ? s : null }, timeout: 5_000 })
    await pause(300)
    const step = { id, before, after: settingsNow(), screen: after.general }
    await closeSettings()
    return step
  }
  const cleanupTab = async (tabId) => {
    let closed = await evaluate({ fn: (id) => window.corral.closeTabs({ tabIds: [id], confirmed: true }), arg: tabId })
    if (closed?.outcome === 'needs-confirm') closed = await evaluate({ fn: (input) => window.corral.closeTabs(input), arg: { tabIds: [tabId], confirmed: true, confirmedPaneIds: closed.running.map((row) => row.paneId) } })
    await tabGone(tabId)
    return closed
  }

  // ── K8ⓐ 실행 중 확인 (핀 아님) ─────────────────────────────────────────────
  const T1 = await newShellTab({ name: 'T1', running: true })
  const a1 = await pressClose(T1.tabId)
  a1.shot = await shot({ name: 'k7-confirm-running', selector: '[data-confirm-close-modal]' })
  checks.require('k8a1-running-modal-checkbox', a1.modal?.kind === 'command' && a1.modal?.checkbox?.label === '실행 중인 터미널에 대해 다시 묻지 않기' && a1.modal?.checkbox?.checked === false, a1)
  await click('[data-confirm-close-modal] [data-dont-ask-again-input]')
  a1.checked = (await modal())?.checkbox?.checked
  await click('[data-close-confirm-ok]')
  a1.closed = await tabGone(T1.tabId)
  a1.settings = settingsNow()
  checks.require('k8a1-saved-and-closed', a1.checked === true && a1.closed && a1.settings.skipCloseTerminalWithRunningProcessConfirm === true && a1.settings.confirmClosePinnedTab === true, a1)
  result.steps.a1 = a1
  save()

  const T2 = await newShellTab({ name: 'T2', running: true })
  const a2 = await pressClose(T2.tabId)
  a2.closedNow = await tabGone(T2.tabId)
  checks.require('k8a2-running-no-confirm', a2.modal === undefined && a2.closedNow, a2)
  result.steps.a2 = a2

  result.steps.a3 = await toggleGeneral({ id: 'confirm-close-running-terminal', expect: 'true' })
  checks.require('k8a3-reenable-running', result.steps.a3.after.skipCloseTerminalWithRunningProcessConfirm === false, result.steps.a3)
  save()

  // ── K8ⓐ 핀 + 실행 중 한 창 · 체크박스는 실행 중만 ───────────────────────────
  const T3 = await newShellTab({ name: 'T3', running: true })
  result.steps.pinMenuT3 = await pin(T3.tabId)
  result.steps.k3f = await tabMenuAfterPin(T3.tabId)
  checks.require('k3f-menu-close-disabled-reason', result.steps.k3f.title === '고정된 탭이다 — 고정을 풀거나 ⌘W 로 닫는다', result.steps.k3f)
  const a4 = await pressClose(T3.tabId)
  a4.shot = await shot({ name: 'k7-confirm-pinned-running', selector: '[data-confirm-close-modal]' })
  checks.require('k8a4-one-window', a4.modal?.kind === 'command' && a4.modal?.body.includes('이 탭은 고정돼 있다.') && a4.modal?.checkbox?.label === '실행 중인 터미널에 대해 다시 묻지 않기', a4)
  await click('[data-confirm-close-modal] [data-dont-ask-again-input]')
  await click('[data-close-confirm-cancel]')
  a4.afterCancel = { modal: await modal(), exists: (await tabsOf()).some((tab) => tab.tabId === T3.tabId), settings: settingsNow() }
  checks.require('k8a4-cancel-no-save', a4.afterCancel.modal === null && a4.afterCancel.exists && a4.afterCancel.settings.skipCloseTerminalWithRunningProcessConfirm === false, a4.afterCancel)
  const a5 = await pressClose(T3.tabId)
  a5.reopenedChecked = a5.modal?.checkbox?.checked
  await click('[data-confirm-close-modal] [data-dont-ask-again-input]')
  await click('[data-close-confirm-ok]')
  a5.closed = await tabGone(T3.tabId)
  a5.settings = settingsNow()
  checks.require('k8a5-only-running-off', a5.reopenedChecked === false && a5.closed && a5.settings.skipCloseTerminalWithRunningProcessConfirm === true && a5.settings.confirmClosePinnedTab === true, a5)
  result.steps.a4 = a4
  result.steps.a5 = a5
  save()

  // ── K8ⓐ 핀(한가) → 핀 창 · 체크박스는 핀 설정 ───────────────────────────────
  const T4 = await newShellTab({ name: 'T4', running: false })
  await pin(T4.tabId)
  const a6 = await pressClose(T4.tabId)
  a6.shot = await shot({ name: 'k7-confirm-pinned', selector: '[data-confirm-close-modal]' })
  checks.require('k8a6-pinned-modal', a6.modal?.kind === 'pinned' && a6.modal?.checkbox?.label === '고정된 탭에 대해 다시 묻지 않기', a6)
  await click('[data-confirm-close-modal] [data-dont-ask-again-input]')
  await click('[data-close-confirm-ok]')
  a6.closed = await tabGone(T4.tabId)
  a6.settings = settingsNow()
  checks.require('k8a6-pinned-off', a6.closed && a6.settings.confirmClosePinnedTab === false && a6.settings.skipCloseTerminalWithRunningProcessConfirm === true, a6)
  result.steps.a6 = a6

  // 둘 다 꺼짐 — 핀 + 실행 중도 창 없이.
  const T5 = await newShellTab({ name: 'T5', running: true })
  await pin(T5.tabId)
  const a7 = await pressClose(T5.tabId)
  a7.closedNow = await tabGone(T5.tabId)
  checks.require('k8a7-both-off-no-confirm', a7.modal === undefined && a7.closedNow, a7)
  result.steps.a7 = a7
  save()

  // 설정에서 둘 다 다시 켜기 → 다시 확인.
  result.steps.a8pin = await toggleGeneral({ id: 'confirm-close-pinned-tab', expect: 'true' })
  result.steps.a8run = await toggleGeneral({ id: 'confirm-close-running-terminal', expect: 'true' })
  checks.require('k8a8-both-on', result.steps.a8run.after.confirmClosePinnedTab === true && result.steps.a8run.after.skipCloseTerminalWithRunningProcessConfirm === false, result.steps.a8run)
  const T6 = await newShellTab({ name: 'T6', running: false })
  await pin(T6.tabId)
  const a9 = await pressClose(T6.tabId)
  checks.require('k8a9-pinned-asks-again', a9.modal?.kind === 'pinned', a9)
  await click('[data-close-confirm-ok]')
  a9.closed = await tabGone(T6.tabId)
  result.steps.a9 = a9
  const T6b = await newShellTab({ name: 'T6b', running: true })
  const a10 = await pressClose(T6b.tabId)
  checks.require('k8a10-running-asks-again', a10.modal?.kind === 'command', a10)
  await click('[data-close-confirm-ok]')
  a10.closed = await tabGone(T6b.tabId)
  result.steps.a10 = a10
  save()

  // ── K8ⓑ bulk 「다른 탭 닫기」 ──────────────────────────────────────────────
  result.steps.b0 = await toggleGeneral({ id: 'confirm-close-running-terminal', expect: 'false' })
  const T7 = await newShellTab({ name: 'T7', running: true })
  const T8 = await newShellTab({ name: 'T8', running: false })
  await activate(T0.tabId)
  await rightClick(`[data-main-tab="${T0.tabId}"]`)
  await click(`[data-tab-menu-close-others="${T0.tabId}"]`)
  const b1 = { modal: await pause(800).then(modal), T7gone: await tabGone(T7.tabId), T8gone: await tabGone(T8.tabId) }
  checks.require('k8b1-bulk-off-no-confirm', b1.modal === null && b1.T7gone && b1.T8gone, b1)
  result.steps.b1 = b1
  result.steps.b2 = await toggleGeneral({ id: 'confirm-close-running-terminal', expect: 'true' })
  const T9 = await newShellTab({ name: 'T9', running: true })
  const T10 = await newShellTab({ name: 'T10', running: false })
  await activate(T0.tabId)
  await rightClick(`[data-main-tab="${T0.tabId}"]`)
  await click(`[data-tab-menu-close-others="${T0.tabId}"]`)
  const b3 = { modal: await until({ label: 'bulk modal', probe: modal, timeout: 6_000 }).catch(() => null) }
  b3.shot = await shot({ name: 'k8-bulk-confirm', selector: '[data-confirm-close-modal]' })
  checks.require('k8b3-bulk-on-one-window', b3.modal?.kind === 'command' && JSON.stringify(b3.modal?.tabs) === JSON.stringify([T9.tabId]), b3)
  await click('[data-close-confirm-ok]')
  b3.T9gone = await tabGone(T9.tabId)
  b3.T10gone = await tabGone(T10.tabId)
  checks.require('k8b3-bulk-closed-after-confirm', b3.T9gone && b3.T10gone, b3)
  result.steps.b3 = b3
  save()

  // ── K8ⓒ 워크트리 닫기는 설정 꺼짐에서도 확인 창(체크박스 없음, D3) ────────────────
  result.steps.c0 = await toggleGeneral({ id: 'confirm-close-running-terminal', expect: 'false' })
  const T11 = await newShellTab({ name: 'T11', running: true })
  // 행 액션 버튼은 hover 때만 드러난다(run-1 에서 가려져 클릭 실패) — 카드 위로 마우스를 옮긴 뒤 누른다.
  {
    const { rect } = await control({ cmd: 'rect', selector: `[data-worktree="${real}"] [data-worktree-card-surface]` })
    await control({ cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(rect.left + rect.width * 0.5), y: Math.round(rect.top + rect.height * 0.5) })
    await pause(400)
  }
  await click(`[data-worktree-menu-toggle="${real}"]`)
  await click(`[data-close-worktree="${real}"]`)
  const c1 = { modal: await until({ label: 'worktree close modal', probe: modal, timeout: 6_000 }).catch(() => null) }
  c1.shot = await shot({ name: 'k8-confirm-worktree', selector: '[data-confirm-close-modal]' })
  checks.require('k8c-worktree-close-still-asks', c1.modal?.kind === 'worktree' && c1.modal?.checkbox === null, c1)
  await click('[data-close-confirm-cancel]')
  c1.wsAlive = (await workspaceOf()) !== null
  checks.require('k8c-cancel-keeps-worktree', c1.wsAlive, c1)
  result.steps.c1 = c1
  result.steps.c2 = await toggleGeneral({ id: 'confirm-close-running-terminal', expect: 'true' })
  result.steps.c3 = await cleanupTab(T11.tabId)
  save()

  // ── K8ⓓ 워크트리 삭제 ──────────────────────────────────────────────────────
  const deleteSnap = () => evaluate({ fn: () => {
    const el = document.querySelector('[data-delete-worktree-dialog]')
    const box = el?.querySelector('[data-dont-ask-again]') ?? null
    return {
      dialog: el === null ? null : { path: el.getAttribute('data-delete-worktree-dialog'), decision: el.getAttribute('data-delete-decision'), confirm: el.querySelector('[data-delete-confirm]')?.textContent ?? null, checkbox: box === null ? null : { label: box.textContent, checked: box.querySelector('input')?.checked ?? null } },
      notice: document.querySelector('[data-add-notice] .inline-notice-text')?.textContent ?? null,
      cards: [...document.querySelectorAll('[data-worktree]')].map((card) => card.getAttribute('data-worktree')),
    }
  } })
  const requestDelete = async (wt) => {
    if (!wt.startsWith('/tmp/l516i') && !wt.startsWith('/private/tmp/l516i')) throw new Error(`격리 규칙 8 — /tmp/l516i 밖 삭제 시도: ${wt}`)
    result.deletes.push({ at: new Date().toISOString(), path: wt })
    save()
    await rightClick(`[data-worktree="${wt}"] [data-worktree-card-surface]`)
    await until({ label: `card menu ${wt}`, probe: () => evaluate({ fn: () => document.querySelector('[data-card-menu] [data-menu-action="delete"]') !== null }), timeout: 5_000 })
    await click('[data-card-menu] [data-menu-action="delete"]')
  }
  const waitDialog = (wt) => until({ label: `delete dialog ${wt}`, probe: async () => { const s = await deleteSnap(); return s.dialog !== null && s.dialog.decision !== 'loading' ? s : null }, timeout: 15_000 })
  const waitGone = (wt) => until({ label: `deleted ${wt}`, probe: async () => !(await deleteSnap()).cards.includes(wt) && !fs.existsSync(wt), timeout: 60_000 }).then(() => true).catch(() => false)

  const wA = realWt('clean-a')
  await requestDelete(wA)
  const d1 = { dialog: await waitDialog(wA) }
  d1.shot = await shot({ name: 'k7-delete-dialog-delete', selector: '[data-delete-worktree-dialog]' })
  checks.require('k8d1-checkbox-on-delete', d1.dialog.dialog.decision === 'delete' && d1.dialog.dialog.checkbox?.label === '깨끗한 워크트리는 다시 묻지 않기' && d1.dialog.dialog.checkbox?.checked === false, d1)
  await click('[data-delete-worktree-dialog] [data-dont-ask-again-input]')
  await click('[data-delete-confirm="delete"]')
  d1.gone = await waitGone(wA)
  await pause(500)
  d1.after = await deleteSnap()
  d1.settings = settingsNow()
  checks.require('k8d1-saved-deleted-notice', d1.gone && d1.settings.skipDeleteWorktreeConfirm === true && (d1.after.notice ?? '').includes('설정 › 일반에서 되돌릴 수 있습니다'), d1)
  result.steps.d1 = d1
  save()

  const wB = realWt('clean-b')
  await requestDelete(wB)
  let sawDialog = false
  const d2 = { gone: await until({ label: `skip delete ${wB}`, probe: async () => { const s = await deleteSnap(); if (s.dialog !== null) sawDialog = true; return !s.cards.includes(wB) && !fs.existsSync(wB) }, timeout: 60_000 }).then(() => true).catch(() => false) }
  d2.sawDialog = sawDialog
  d2.after = await deleteSnap()
  checks.require('k8d2-skip-clean-no-dialog', d2.gone && !d2.sawDialog, d2)
  result.steps.d2 = d2

  const wD = realWt('dirty')
  await requestDelete(wD)
  const d3 = { dialog: await waitDialog(wD) }
  d3.shot = await shot({ name: 'k8-delete-dialog-force', selector: '[data-delete-worktree-dialog]' })
  checks.require('k8d3-dirty-still-asks-force', d3.dialog.dialog.decision === 'force' && d3.dialog.dialog.checkbox === null, d3)
  await click('[data-delete-cancel]')
  d3.stillExists = fs.existsSync(wD)
  checks.require('k8d3-dirty-kept', d3.stillExists, d3)
  result.steps.d3 = d3

  result.steps.d4 = await toggleGeneral({ id: 'confirm-delete-worktree', expect: 'true' })
  checks.require('k8d4-reenable-delete', result.steps.d4.after.skipDeleteWorktreeConfirm === false, result.steps.d4)
  const wC = realWt('clean-c')
  await requestDelete(wC)
  const d5 = { dialog: await waitDialog(wC) }
  checks.require('k8d5-asks-again', d5.dialog.dialog.decision === 'delete' && d5.dialog.dialog.checkbox?.checked === false, d5)
  await click('[data-delete-cancel]')
  d5.stillExists = fs.existsSync(wC)
  result.steps.d5 = d5
  save()

  // ── K7 일반 섹션 캡처 · 덤프 (모두 켜짐 상태) ──────────────────────────────────
  const general = await openSettings('general')
  result.steps.k7general = { state: general, shot: await shot({ name: 'k7-settings-general' }) }
  checks.require('k2-general-section', JSON.stringify(general.groups) === JSON.stringify(['AI 기능', '설정 시작', '인터페이스']) && general.heading === '일반' && JSON.stringify(general.subsections) === JSON.stringify(['탐색', '워크스페이스']) && general.general.every((row) => row.checked === 'true'), general)

  // ── K8ⓔ 카드 레이아웃 설정 ↔ 메뉴 왕복 + 재시작 ─────────────────────────────────
  const cardLayoutDom = () => evaluate({ fn: () => [...new Set([...document.querySelectorAll('[data-card-layout]')].map((el) => el.getAttribute('data-card-layout')))] })
  const menuRadio = async () => {
    await click('[data-sidebar-options]')
    await click('[data-submenu-trigger="card-layout"]')
    const radios = await evaluate({ fn: () => [...document.querySelectorAll('[data-options-radio^="card-layout-"]')].map((el) => ({ key: el.getAttribute('data-options-radio'), checked: el.getAttribute('aria-checked'), text: el.textContent })) })
    return radios
  }
  const closeMenus = async () => { for (let i = 0; i < 3; i += 1) { await key({ keyCode: 'Escape' }); await pause(150) } }
  const appearance = await openSettings('appearance')
  const e0 = { settings: appearance.windowCard, dom: null, shot: await shot({ name: 'k7-window-sidebar-detailed', selector: '[data-settings-collapsible="window-sidebar"]' }) }
  await click('[data-settings-collapsible="window-sidebar"] [data-segment-value="compact"]')
  await pause(500)
  e0.afterSettings = (await settingsState()).windowCard
  e0.shotCompact = await shot({ name: 'k7-window-sidebar-compact', selector: '[data-settings-collapsible="window-sidebar"]' })
  e0.uiPrefs = (({ sidebarCardLayout, sidebarCardProperties }) => ({ sidebarCardLayout, sidebarCardProperties }))(readJson(uiPrefsFile) ?? {})
  await closeSettings()
  e0.dom = await cardLayoutDom()
  e0.menu = await menuRadio()
  e0.shotSidebar = await shot({ name: 'k8-sidebar-compact-menu' })
  await closeMenus()
  checks.require('k8e1-settings-to-sidebar-menu', e0.dom.length === 1 && e0.dom[0] === 'compact' && e0.menu.find((r) => r.key === 'card-layout-compact')?.checked === 'true' && e0.uiPrefs.sidebarCardLayout === 'compact' && JSON.stringify(e0.uiPrefs.sidebarCardProperties) === '[]', e0)
  result.steps.e0 = e0
  // 메뉴 → 자세히 → 설정이 같은 값
  const e1 = {}
  await click('[data-sidebar-options]')
  await click('[data-submenu-trigger="card-layout"]')
  await click('[data-options-radio="card-layout-detailed"]')
  await closeMenus()
  e1.dom = await cardLayoutDom()
  e1.settings = (await openSettings('appearance')).windowCard
  e1.uiPrefs = (({ sidebarCardLayout, sidebarCardProperties }) => ({ sidebarCardLayout, sidebarCardProperties }))(readJson(uiPrefsFile) ?? {})
  checks.require('k8e2-menu-to-settings', e1.dom[0] === 'detailed' && e1.settings.segments.find((s) => s.value === 'detailed')?.checked === 'true' && e1.uiPrefs.sidebarCardLayout === 'detailed' && JSON.stringify(e1.uiPrefs.sidebarCardProperties) === '["inline-agents"]', e1)
  // 재시작 검사를 위해 다시 간단히(설정에서)
  await click('[data-settings-collapsible="window-sidebar"] [data-segment-value="compact"]')
  await pause(500)
  await closeSettings()
  e1.uiPrefsBeforeRestart = (({ sidebarCardLayout, sidebarCardProperties }) => ({ sidebarCardLayout, sidebarCardProperties }))(readJson(uiPrefsFile) ?? {})
  result.steps.e1 = e1
  save()

  // 재시작 — 소유 프로세스를 끄고 같은 work 폴더로 다시 띄운다(userData 유지).
  result.steps.restartAlive = await killOwned()
  owned.length = 0
  await pause(1500)
  handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs2'), onSpawn: (entry) => owned.push(entry) })
  await until({ label: 'cards after restart', probe: async () => (await evaluate({ fn: () => document.querySelectorAll('[data-card-layout]').length })) > 0, timeout: 30_000 })
  const e2 = { dom: await cardLayoutDom(), menu: await menuRadio() }
  await closeMenus()
  e2.settings = (await openSettings('appearance')).windowCard
  e2.generalAfterRestart = (await openSettings('general')).general
  e2.settingsFile = settingsNow()
  await closeSettings()
  checks.require('k8e3-restart-both-compact', e2.dom.length === 1 && e2.dom[0] === 'compact' && e2.menu.find((r) => r.key === 'card-layout-compact')?.checked === 'true' && e2.settings.segments.find((s) => s.value === 'compact')?.checked === 'true', e2)
  checks.require('k2d-general-persists-restart', e2.generalAfterRestart.every((row) => row.checked === 'true'), e2)
  result.steps.e2 = e2
  result.finalSettingsFile = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '(파일 없음)'
  exitCode = checks.exitCode()
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[k8] 예외', result.error)
  exitCode = 2
} finally {
  result.owned = owned
  result.alive = await killOwned()
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
  console.log('[k8] exit', exitCode, failed)
  process.exit(exitCode)
}
