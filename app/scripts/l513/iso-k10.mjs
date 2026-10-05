/* global window, document, getComputedStyle -- eval 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-513 **격리** 실측 — K10ⓐⓑⓒⓓ · K6ⓒⓓ · K4ⓒ · K5ⓑ (격리 = launchCorral: /tmp/l513i* 아래 userData·herdr 세션·제어 소켓).
//
// Ghostty fixture 는 전부 작업 폴더 안이다(격리 규칙 3): launchCorral 이 `XDG_CONFIG_HOME=<work>/corral-herdr` 로 띄우므로 fixture 구성은
// `<work>/corral-herdr/ghostty/config`, 테마는 `GHOSTTY_RESOURCES_DIR=<work>/ghostty-res` 의 `themes/`. 사용자 Ghostty 파일에는 쓰지 않는다.
// macOS 경로(`~/Library/Application Support/com.mitchellh.ghostty`)는 실제 홈을 가리킨다 — 이 사용자는 0바이트 `config.ghostty` 뿐이라
// 읽지 않는 것이 정상이다(D3). 모달의 경로 목록으로 그것을 본다.
//
// 가져오기·테마 선택은 **전부 실제 클릭**이다(제어 소켓 click = sendInputEvent). 저장소·IPC 를 직접 불러 설정을 바꾸지 않는다.
// 관측(읽기)만 eval 로 한다: pane xterm 옵션(`corralPaneAppearance`)·계산 스타일·모달 DOM·`settings.json` 해시.
// 사용: npx tsx app/scripts/l513/iso-k10.mjs --app app --work /tmp/l513iX --port 95NN --out <raw> [--ledger <runs.md>]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { beginRun, finishRun } from '../gui-diff/lib/runs.mjs'
import { pause, requirements } from '../l497/lib.mjs'
import { finalExit, ledgerResult } from '../l512/final-exit.mjs'
import { DEFAULT_TERMINAL_THEME, TERMINAL_COLOR_OVERRIDE_KEYS, resolveTerminalTheme } from '../../src/shared/terminal-settings.ts'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l513i')) throw new Error('--work 는 /tmp/l513i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
const command = `npx tsx app/scripts/l513/iso-k10.mjs ${process.argv.slice(2).join(' ')}`
const criterion = 'K10ⓐⓑⓒⓓ·K6ⓒⓓ·K4ⓒ·K5ⓑ (격리 fixture)'
const ledger = args.ledger ? path.resolve(args.ledger) : null
const rawRel = ledger ? path.relative(path.resolve(ledger, '../../../../..'), out) : out
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
  console.log('[k10] 504 가드: 같은 경로·세션을 쓰는 프로세스가 있다 — 멈춘다\n' + guard)
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: 3, raw: rawRel, result: '실패 — 504 가드(프로세스 있음)' })
  process.exit(3)
}
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
const fixture = path.join(work, 'fx')
fs.mkdirSync(fixture)
execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })

// ── Ghostty fixture ────────────────────────────────────────────────────────
const ghosttyDir = path.join(work, 'corral-herdr', 'ghostty')
const resources = path.join(work, 'ghostty-res')
const themeName = 'L513 Night'
fs.mkdirSync(ghosttyDir, { recursive: true })
fs.mkdirSync(path.join(resources, 'themes'), { recursive: true })
const THEME = [
  'background = #000010', 'foreground = #d0d0ff', 'cursor-color = #ffcc00', 'cursor-text = #000000',
  'selection-background = #334455', 'selection-foreground = #eeeeee',
  ...Array.from({ length: 16 }, (_, i) => `palette = ${i}=#${(0x101010 * (i % 15) + 0x050505).toString(16).padStart(6, '0').slice(-6)}`),
  'font-size = 20', 'font-family = Smuggled', 'window-padding-x = 40',
].join('\n') + '\n'
fs.writeFileSync(path.join(resources, 'themes', themeName), THEME)
const CONFIG_A = [
  '# LIFE-513 K10ⓐ fixture — theme + palette + 색 키 + 거부될 키',
  `theme = ${themeName}`,
  'background = #101820',
  'palette = 1=#ff3355',
  'palette = 20=#123456',
  'font-family = Menlo',
  'font-family = Apple Color Emoji',
  'font-size = 13.5',
  'font-weight = 600',
  'background-opacity = 0.9',
  'cursor-style = bar',
  'selection-foreground = cell-foreground',
].join('\n') + '\n'
const configFile = path.join(ghosttyDir, 'config')
fs.writeFileSync(configFile, CONFIG_A)
process.env.GHOSTTY_RESOURCES_DIR = resources

const result = { app: path.resolve(args.app), work, startedAt: new Date().toISOString(), fixture: { configFile, config: CONFIG_A, themeFile: path.join(resources, 'themes', themeName), theme: THEME }, steps: {}, checks: null, notes: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-k10.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[k10] 필수 조건 실패', JSON.stringify(row).slice(0, 600)) })
result.checks = checks.results
const owned = []
let exitCode = 0
let handle = null
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '(없음)')
const pick = (theme) => Object.fromEntries(TERMINAL_COLOR_OVERRIDE_KEYS.map((key) => [key, theme?.[key] ?? null]))
const sameColors = (a, b) => TERMINAL_COLOR_OVERRIDE_KEYS.every((key) => String(a?.[key] ?? '').toLowerCase() === String(b?.[key] ?? '').toLowerCase())
const B_LINE = "printf '\\033[31mRED\\033[0m \\033[32mGREEN\\033[0m PLAIN\\n'"

try {
  handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  result.env = { XDG_CONFIG_HOME: handle.env.XDG_CONFIG_HOME, GHOSTTY_RESOURCES_DIR: handle.env.GHOSTTY_RESOURCES_DIR, HOME: handle.env.HOME }
  const settingsFile = path.join(handle.paths.userData, 'settings.json')
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  const logPath = path.join(handle.paths.userData, 'corral.ndjson')
  const logRows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) : [])
  const writesSince = (n) => logRows().slice(n).filter((row) => row.tag === 'settings.changed')
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
  const shot = async (name, selector) => {
    try {
      const response = await control({ cmd: 'shot', name: `l513-${name}`, selector })
      if (response.ok && response.file && fs.existsSync(response.file)) {
        const dest = path.join(out, `${name}.png`)
        fs.copyFileSync(response.file, dest)
        return path.basename(dest)
      }
      return `실패: ${JSON.stringify(response).slice(0, 200)}`
    } catch (error) { return `실패: ${String(error).slice(0, 200)}` }
  }
  const gridRequests = async () => (await control({ cmd: 'counters' })).counters.reduce((sum, row) => sum + (row.gridRequests ?? 0), 0)

  await seedCorralRepo(handle, fixture, { expectedWorktrees: 1 })
  const real = fs.realpathSync(fixture)
  await evaluate((root) => window.corral.openWorktree({ repoRoot: root, path: root, isLinked: false }), real)
  const workspaceOf = async () => {
    const state = (await control({ cmd: 'state' })).state
    for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === real) return row.workspace ?? null
    return null
  }
  const ws = await until('fixture workspace', workspaceOf, 30_000)
  const created = await evaluate((input) => window.corral.createRow(input), { workspaceId: ws.workspaceId, kind: 'shell' })
  const paneA = created.paneId
  await click(`[data-worktree="${real}"] [data-worktree-card-surface]`)
  await pause(800)
  await click(`[data-main-tab="${created.tabId}"]`)
  await until('pane A box', () => evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, paneA))
  await pause(1200)
  const split = await evaluate((id) => window.corral.splitPane({ paneId: id, direction: 'right' }), paneA)
  const paneB = split?.paneId
  if (!paneB) throw new Error(`split 실패: ${JSON.stringify(split)}`)
  await until('pane B box', () => evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, paneB))
  await pause(1200)
  result.panes = { A: paneA, B: paneB }
  await evaluate((input) => window.corral.termInput(input), { paneId: paneB, data: `clear; ${B_LINE}\r` })
  await pause(1200)

  /** 관측 — 열린 pane 전부의 xterm 옵션(테마 22칸·글꼴)·계산 배경·`--term-bg`·RED span 계산 색·main 설정(읽기)·settings.json 해시. */
  const observe = async (name) => {
    const dom = await evaluate((ids) => {
      const appearance = (window.corralPaneAppearance?.() ?? []).map((row) => ({ paneId: row.paneId, fontFamily: row.options.fontFamily, fontSize: row.options.fontSize, cursorStyle: row.options.cursorStyle, theme: row.options.theme, live: row.live }))
      const paneStyles = Object.fromEntries(ids.map((id) => {
        const box = document.querySelector(`[data-term-pane-box="${id}"]`)
        const red = box ? [...box.querySelectorAll('.xterm-rows span')].find((s) => s.textContent.trim() === 'RED') : null
        return [id, { paneBg: box ? getComputedStyle(box).backgroundColor : null, xtermBg: box?.querySelector('.xterm') ? getComputedStyle(box.querySelector('.xterm')).backgroundColor : null, red: red ? { cls: red.className, color: getComputedStyle(red).color } : null }]
      }))
      return { appearance, paneStyles, termBg: getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim(), mainSettings: window.corral.getSettingsSync() }
    }, [paneA, paneB])
    const entry = { at: new Date().toISOString(), gridRequests: await gridRequests(), logLength: logRows().length, settingsSha: sha(settingsFile), settingsFile: fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null, ...dom }
    result.steps[name] = entry
    save()
    console.log('[k10]', name, JSON.stringify({ panes: entry.appearance.length, bg: entry.appearance.map((a) => a.theme?.background), font: entry.appearance.map((a) => `${a.fontFamily}/${a.fontSize}`), sha: entry.settingsSha.slice(0, 12) }))
    return entry
  }
  const modalState = () => evaluate(() => {
    const modal = document.querySelector('[data-ghostty-import-modal]')
    if (!modal) return null
    return {
      state: modal.getAttribute('data-ghostty-import-modal'),
      text: modal.innerText,
      paths: modal.querySelector('[data-ghostty-import-paths]')?.textContent ?? null,
      rows: [...modal.querySelectorAll('[data-ghostty-import-row]')].map((row) => ({ key: row.getAttribute('data-ghostty-import-row'), text: row.textContent })),
      colors: Object.fromEntries([...modal.querySelectorAll('[data-ghostty-import-color]')].map((el) => [el.getAttribute('data-ghostty-import-color'), { text: el.textContent, swatch: getComputedStyle(el.querySelector('.ghostty-import-swatch')).backgroundColor }])),
      unsupported: [...modal.querySelectorAll('[data-ghostty-import-unsupported] li')].map((li) => li.textContent),
      error: modal.querySelector('[data-ghostty-import-error]')?.textContent ?? null,
    }
  })
  const openImport = async (name) => {
    await click('[data-settings-ghostty-import]')
    const state = await until(`modal ${name}`, async () => { const s = await modalState(); return s && s.state !== 'loading' ? s : null }, 10_000)
    state.screenshot = await shot(`modal-${name}`, '[data-ghostty-import-modal]')
    result.steps[`modal-${name}`] = state
    save()
    return state
  }

  const base = await observe('base')
  checks.require('two-panes', base.appearance.length === 2, { n: base.appearance.length })
  checks.require('base-no-settings-file', base.settingsSha === '(없음)', { sha: base.settingsSha })
  const defaultTheme = resolveTerminalTheme({ themeName: DEFAULT_TERMINAL_THEME })
  checks.require('base-panes-default-theme', base.appearance.every((a) => sameColors(a.theme, defaultTheme)), { panes: base.appearance.map((a) => pick(a.theme)) })

  // ── 설정 열기 → 외관(실제 클릭) ───────────────────────────────────────────
  await click('[data-settings-open]')
  await until('settings open', () => evaluate(() => document.querySelector('[data-settings-page]') !== null), 5_000)
  await click('[data-settings-nav-item="appearance"]')
  await until('appearance shown', () => evaluate(() => document.querySelector('[data-settings-ghostty-import]') !== null), 5_000)
  await pause(300)
  result.buttonPlacement = await evaluate(() => {
    const button = document.querySelector('[data-settings-ghostty-import]')
    const header = button?.closest('[data-settings-subsection-header]')
    return { text: button?.textContent, headerTitle: header?.querySelector('h3')?.textContent ?? null, inAction: button?.parentElement?.classList.contains('settings-subsection-action') ?? false }
  })
  checks.require('k8a-button-in-typography-action', result.buttonPlacement.headerTitle === 'Terminal 타이포그래피' && result.buttonPlacement.inAction, result.buttonPlacement)
  result.buttonShot = await shot('button-row', '[data-settings-block="typography"]')

  // ── K10ⓐ 미리보기(K4ⓒ — 아무것도 쓰지 않는다) ─────────────────────────────
  const prePreview = await observe('pre-preview')
  const mA = await openImport('a-preview')
  const postPreview = await observe('post-preview')
  checks.require('k4c-preview-writes-nothing', postPreview.settingsSha === prePreview.settingsSha && JSON.stringify(postPreview.mainSettings) === JSON.stringify(prePreview.mainSettings) && writesSince(prePreview.logLength).length === 0, { before: prePreview.settingsSha, after: postPreview.settingsSha })
  checks.require('k10a-modal-found', mA.state === 'found', mA)
  // 읽은 경로 = fixture 하나(AppSupport 0바이트 config.ghostty 는 읽지 않는다 — D3).
  checks.require('k10a-paths', mA.paths === `구성: ${configFile}`, { paths: mA.paths })
  // selection-foreground 는 구성이 `cell-foreground` 로 명시해 테마 값(#eeeeee)을 덮고, 그 값은 hex 가 아니라 거부된다 — override 없음이 맞다
  // (명시 키가 테마를 이긴다, Ghostty 와 같다). r1 은 이 기대값을 잘못 넣어 실패했다(RESULT 「실패 회차」).
  const expectedOverrides = { background: '#101820', foreground: '#d0d0ff', cursor: '#ffcc00', cursorAccent: '#000000', selectionBackground: '#334455' }
  for (let i = 0; i < 16; i += 1) expectedOverrides[TERMINAL_COLOR_OVERRIDE_KEYS[6 + i]] = `#${(0x101010 * (i % 15) + 0x050505).toString(16).padStart(6, '0').slice(-6)}`
  expectedOverrides.red = '#ff3355'
  result.expectedOverrides = expectedOverrides
  const modalColors = Object.fromEntries(Object.entries(mA.colors).map(([k, v]) => [k, v.text.split(': ')[1]]))
  checks.require('k10a-diff-overrides', JSON.stringify(Object.keys(modalColors).sort()) === JSON.stringify(Object.keys(expectedOverrides).sort()) && Object.entries(expectedOverrides).every(([k, v]) => modalColors[k] === v), { modalColors, expectedOverrides })
  checks.require('k10a-diff-rows', JSON.stringify(mA.rows.map((r) => r.key).sort()) === JSON.stringify(['terminalColorOverrides', 'terminalCursorStyle', 'terminalFontFamily']), { rows: mA.rows })
  const unsupportedKeys = mA.unsupported.map((line) => line.split(' — ')[0])
  for (const keyName of ['palette', 'font-family', 'font-size', 'font-weight', 'background-opacity', 'selection-foreground']) checks.require(`k10a-unsupported-${keyName}`, unsupportedKeys.includes(keyName), { unsupported: mA.unsupported })
  checks.require('k10a-theme-not-unsupported', !unsupportedKeys.includes('theme'), { unsupported: mA.unsupported })

  // ── K10ⓐ 적용(실제 클릭) → pane 계산 색 = 테마 + override ──────────────────
  const preApply = await observe('pre-apply')
  await click('[data-ghostty-import-apply]')
  await until('applied', async () => (await modalState())?.state === 'applied', 5_000)
  result.steps['modal-a-applied'] = { ...(await modalState()), screenshot: await shot('modal-a-applied', '[data-ghostty-import-modal]') }
  await pause(1500)
  const applied = await observe('applied')
  const applyWrites = writesSince(preApply.logLength)
  result.applyWrites = applyWrites
  checks.require('k5a-one-write', applyWrites.length === 1, { applyWrites })
  const expectedTheme = resolveTerminalTheme({ themeName: DEFAULT_TERMINAL_THEME, overrides: expectedOverrides })
  checks.require('k10a-panes-theme-eq-overrides', applied.appearance.length === 2 && applied.appearance.every((a) => sameColors(a.theme, expectedTheme)), { panes: applied.appearance.map((a) => pick(a.theme)), expected: pick(expectedTheme) })
  checks.require('k10a-term-bg', applied.termBg === '#101820', { termBg: applied.termBg })
  checks.require('k10a-font-menlo', applied.appearance.every((a) => String(a.fontFamily).startsWith('"Menlo"') && a.cursorStyle === 'bar'), { panes: applied.appearance.map((a) => [a.fontFamily, a.cursorStyle]) })
  checks.require('k5b-grid-le-1', applied.gridRequests - preApply.gridRequests <= 1, { before: preApply.gridRequests, after: applied.gridRequests })
  result.k5bGrid = { before: preApply.gridRequests, after: applied.gridRequests }
  checks.require('k10a-settings-file', JSON.stringify(applied.settingsFile?.terminalColorOverrides ?? null) !== 'null' && sameColors(applied.settingsFile.terminalColorOverrides, expectedOverrides), { file: applied.settingsFile?.terminalColorOverrides })
  await click('[data-ghostty-import-close]')
  await until('modal closed', async () => (await modalState()) === null, 5_000)
  // 미리보기도 같은 해석(테마 + override)을 쓰는가 — 설정 화면 미리보기 xterm 배경.
  result.previewBg = await evaluate(() => getComputedStyle(document.querySelector('[data-settings-preview-term]')).backgroundColor)
  checks.require('k5b-settings-preview-bg', result.previewBg === 'rgb(16, 24, 32)', { previewBg: result.previewBg })

  // ── K6ⓓ 같은 테마 재선택 → override 지워짐(쓰기 1회) ─────────────────────
  const preSame = await observe('pre-same-theme')
  await click(`[data-settings-theme-option="${DEFAULT_TERMINAL_THEME}"]`)
  await pause(1500)
  const same = await observe('same-theme-cleared')
  result.sameThemeWrites = writesSince(preSame.logLength)
  checks.require('k6a-same-theme-one-write', result.sameThemeWrites.length === 1, { writes: result.sameThemeWrites })
  checks.require('k6c-panes-eq-theme', same.appearance.length === 2 && same.appearance.every((a) => sameColors(a.theme, defaultTheme)), { panes: same.appearance.map((a) => pick(a.theme)), expected: pick(defaultTheme) })
  checks.require('k6-file-overrides-empty', JSON.stringify(same.settingsFile?.terminalColorOverrides) === '{}', { file: same.settingsFile?.terminalColorOverrides })
  // override 없이 같은 테마 → 쓰기 0(T2 동작 유지, K6ⓑ).
  const preSame2 = await observe('pre-same-theme-again')
  await click(`[data-settings-theme-option="${DEFAULT_TERMINAL_THEME}"]`)
  await pause(1000)
  const same2 = await observe('same-theme-again')
  checks.require('k6b-no-write', writesSince(preSame2.logLength).length === 0 && same2.settingsSha === preSame2.settingsSha, { writes: writesSince(preSame2.logLength) })
  // 다른 테마 → 그 테마 값 그대로.
  const preOther = await observe('pre-other-theme')
  await click('[data-settings-theme-option="Dracula"]')
  await pause(1500)
  const other = await observe('other-theme')
  const dracula = resolveTerminalTheme({ themeName: 'Dracula' })
  checks.require('k6c-other-theme-eq', other.appearance.every((a) => sameColors(a.theme, dracula)) && writesSince(preOther.logLength).length === 1, { panes: other.appearance.map((a) => pick(a.theme)), expected: pick(dracula) })

  // ── K6ⓓ 변형: 다시 가져오고 → **다른** 테마를 고르면 같은 쓰기에 비움 ──────────
  await openImport('a-again')
  await click('[data-ghostty-import-apply]')
  await until('applied again', async () => (await modalState())?.state === 'applied', 5_000)
  await click('[data-ghostty-import-close]')
  await pause(1200)
  const reimported = await observe('reimported')
  checks.require('k6d-reimport-overrides-on', reimported.appearance.every((a) => a.theme?.background === '#101820'), { bg: reimported.appearance.map((a) => a.theme?.background) })
  const preOther2 = await observe('pre-other-theme-2')
  await click(`[data-settings-theme-option="${DEFAULT_TERMINAL_THEME}"]`)
  await pause(1500)
  const other2 = await observe('other-theme-2')
  checks.require('k6d-other-theme-clears', other2.appearance.every((a) => sameColors(a.theme, defaultTheme)) && writesSince(preOther2.logLength).length === 1 && JSON.stringify(other2.settingsFile?.terminalColorOverrides) === '{}', { panes: other2.appearance.map((a) => pick(a.theme)) })

  // ── K10ⓒ 테마 해석 실패(리소스 폴더 없음) → 사유, 나머지 적용 ─────────────────
  fs.rmSync(resources, { recursive: true, force: true })
  fs.writeFileSync(configFile, `theme = ${themeName}\nfont-size = 16\n`)
  const mC = await openImport('c-theme-missing')
  checks.require('k10c-theme-reason', mC.state === 'found' && mC.unsupported.some((line) => line.startsWith('theme — 테마 파일을 찾을 수 없음')), { unsupported: mC.unsupported })
  checks.require('k10c-rest-in-diff', JSON.stringify(mC.rows.map((r) => r.key)) === JSON.stringify(['terminalFontSize']), { rows: mC.rows })
  const preC = await observe('pre-c-apply')
  await click('[data-ghostty-import-apply]')
  await until('applied c', async () => (await modalState())?.state === 'applied', 5_000)
  await click('[data-ghostty-import-close]')
  await pause(1500)
  const appliedC = await observe('c-applied')
  checks.require('k10c-font-16', appliedC.appearance.every((a) => a.fontSize === 16) && writesSince(preC.logLength).length === 1, { sizes: appliedC.appearance.map((a) => a.fontSize) })

  // ── K10ⓓ 설정 파일 없음 → 「이 시스템에는 Ghostty 구성이 없습니다」 ─────────────
  fs.rmSync(configFile)
  const mD = await openImport('d-not-found')
  checks.require('k10d-not-found', mD.state === 'not-found' && mD.text.includes('이 시스템에는 Ghostty 구성이 없습니다.'), mD)
  await click('[data-ghostty-import-cancel]')
  await until('modal closed d', async () => (await modalState()) === null, 5_000)
  await click('[data-settings-back]').catch(() => null)
  exitCode = checks.exitCode()
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[k10] 예외', result.error)
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
  console.log('[k10] exit', exitCode, failed)
  process.exit(exitCode)
}
