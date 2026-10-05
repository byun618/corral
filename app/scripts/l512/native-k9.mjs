/* global window, document, getComputedStyle */
// LIFE-512 K9 **네이티브 관문** — native-up.sh 가 띄운 사용자 userData + 구현 빌드 + herdr 정식 `default` 세션에서 돈다.
// 사용자 pane 에는 입력하지 않는다(설정 페이지 안의 클릭만). 입력 경로 = 제어 소켓 click(`webContents.sendInputEvent` — Chromium 입력
// 파이프라인, DOM 합성 이벤트 아님). l511 native-k9 의 틀(제어 소켓·ndjson 기준 길이·requirements)을 따른다.
//
// ⓐ ⚙ 실제 클릭 → 외관 → 테마 「Dracula」 실제 클릭 → 글꼴 크기 + 실제 클릭 → 돌아가기
//    → 열린 pane 마다 xterm 테마 배경·글꼴 크기가 바뀌고, 계산 배경(pane·영역 상자)이 테마색 · 격자 요청 수·cols/rows 관측
// ⓑ 앱 정상 종료(SIGTERM — native-app.sh 가 소유 확인 뒤 보낸다) → 같은 구성으로 재기동
//    → 값이 pane·설정 화면에 그대로 · 재기동 뒤 첫 비지 않은 격자 선언이 종료 직전 선언(저장값 셀)과 같고 변경 전(기본값 셀) 선언과 다르다(K2ⓔ)
// ⓒ 원복은 native-down.sh 가 한다(settings.json 은 백업에 없으면 rsync --delete 로 지워진다 → manifest 전=후).
// 관측 대상(pane·xterm)이 없으면 nonzero — 「관측 대상 0」 이 통과로 새지 않는다(l511 R1-08).
//
// 사용: node native-k9.mjs <ROOT=/tmp/l512n*> <raw 폴더>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { pause, requirements } from '../l497/lib.mjs'

const [root, rawd] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l512n')) throw new Error('ROOT 는 /tmp/l512n*')
fs.mkdirSync(rawd, { recursive: true })
const here = path.dirname(new URL(import.meta.url).pathname)
const UD = path.join(process.env.HOME, 'Library/Application Support/corral')
const SETTINGS = path.join(UD, 'settings.json')
const UI_PREFS = path.join(UD, 'ui-prefs.json')
const NDJSON = path.join(UD, 'corral.ndjson')
const ctl = path.join(root, 'ctl.sock')
const control = (request, timeout = 20_000) => rpc(ctl, request, timeout)
const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result

const result = { startedAt: new Date().toISOString(), appPid: Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8')), steps: [], input: 'control socket sendInputEvent (click)' }
const save = () => fs.writeFileSync(path.join(rawd, 'k9.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[k9] 필수 조건 실패', JSON.stringify(row).slice(0, 400)) })
result.requirements = checks.results

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null)
// corral.ndjson 은 수백 MB 다 — 기준 시점의 길이부터만 읽는다.
const syncRowsFrom = (offset) => {
  const size = fs.statSync(NDJSON).size
  if (size <= offset) return []
  const fd = fs.openSync(NDJSON, 'r')
  const buffer = Buffer.alloc(size - offset)
  fs.readSync(fd, buffer, 0, buffer.length, offset)
  fs.closeSync(fd)
  return buffer.toString('utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((row) => row && row.tag === 'stream.sync')
}
const until = async (label, fn, timeout = 10_000) => {
  const t0 = Date.now()
  for (;;) {
    const value = await fn().catch(() => false)
    if (value) return value
    if (Date.now() - t0 > timeout) throw new Error(`시간초과: ${label}`)
    await pause(150)
  }
}
const click = async (selector) => {
  const response = await control({ cmd: 'click', selector })
  checks.require(`click ${selector}`, response.ok === true, { response })
  await pause(250)
}

const observe = async (name) => {
  const counters = (await control({ cmd: 'counters' })).counters
  const dom = await evaluate(() => {
    const cs = (el, props) => (el ? Object.fromEntries(props.map((p) => [p, getComputedStyle(el).getPropertyValue(p)])) : null)
    return {
      panes: (window.corralPaneWrites?.() ?? []).map((pane) => ({ paneId: pane.paneId, cols: pane.cols, rows: pane.rows })),
      appearance: (window.corralPaneAppearance?.() ?? []).map((row) => ({ paneId: row.paneId, fontSize: row.options.fontSize, fontFamily: row.options.fontFamily, themeBackground: row.options.theme?.background ?? null, live: row.live })),
      paneBoxes: [...document.querySelectorAll('[data-term-pane-box]')].map((el) => ({ paneId: el.getAttribute('data-term-pane-box'), pane: cs(el, ['background-color', 'opacity']), xterm: el.querySelector('.xterm') !== null })),
      groups: [...document.querySelectorAll('[data-term-group]')].map((el) => cs(el, ['background-color'])),
      rootVars: Object.fromEntries(['--term-bg', '--term-inactive-opacity', '--term-divider-color', '--term-divider-w'].map((v) => [v, getComputedStyle(document.documentElement).getPropertyValue(v).trim()])),
      settingsOpen: document.querySelector('[data-settings-page]') !== null,
    }
  })
  const entry = { name, at: new Date().toISOString(), gridRequests: counters.reduce((sum, row) => sum + (row.gridRequests ?? 0), 0), ...dom }
  result.steps.push(entry)
  save()
  console.log('[k9]', name, JSON.stringify({ grid: entry.gridRequests, panes: dom.panes.map((p) => `${p.cols}x${p.rows}`), font: dom.appearance.map((a) => a.fontSize), bg: dom.rootVars['--term-bg'] }))
  return entry
}
const readScreen = async () => {
  await click('[data-settings-open]')
  await until('settings open', () => evaluate(() => document.querySelector('[data-settings-page]') !== null), 5_000)
  await click('[data-settings-nav-item="appearance"]')
  await until('appearance', () => evaluate(() => document.querySelector('[data-settings-section="appearance"]') !== null), 5_000)
  return evaluate(() => ({
    fontSize: document.querySelector('[data-settings-number="글꼴 크기"]')?.value ?? null,
    selectedTheme: document.querySelector('[data-settings-theme-selected]')?.textContent ?? null,
    selectedOption: document.querySelector('.settings-theme-option.is-selected')?.getAttribute('data-settings-theme-option') ?? null,
  }))
}
const closeSettings = async () => {
  await click('[data-settings-back]')
  await until('settings closed', () => evaluate(() => document.querySelector('[data-settings-page]') === null), 5_000)
}

let exitCode = 0
try {
  result.settingsFileBefore = readJson(SETTINGS)
  result.settingsFileExistedBefore = fs.existsSync(SETTINGS)
  result.uiPrefsKeysBefore = Object.keys(readJson(UI_PREFS) ?? {})
  await until('link live', async () => (await control({ cmd: 'state' })).state?.link?.phase === 'live', 60_000)
  await until('pane xterm', () => evaluate(() => document.querySelector('[data-term-pane-box] .xterm') !== null), 30_000)
  await pause(2500)
  const syncBase = fs.statSync(NDJSON).size
  const base = await observe('base')
  checks.require('base-has-panes', base.panes.length >= 1 && base.paneBoxes.every((p) => p.xterm), { panes: base.panes, boxes: base.paneBoxes })
  result.paneCount = base.panes.length
  const baseFont = base.appearance[0]?.fontSize
  // 변경 전 마지막 격자 선언(기본값 셀) — 기동 뒤 선언만 보면 된다. 파일 끝 4MB 만 읽는다(첫 줄이 잘려도 파싱 실패로 빠진다).
  const baseDecl = syncRowsFrom(Math.max(0, syncBase - 4_000_000)).filter((row) => (row.groups ?? '') !== '').at(-1)?.groups ?? null
  result.baseDeclaration = baseDecl

  // ⓐ 설정 변경 — 실제 클릭만.
  const screenBefore = await readScreen()
  result.screenBefore = screenBefore
  await click('[data-settings-theme-option="Dracula"]')
  await click('[data-settings-font-size-step="1"]')
  await pause(300)
  await closeSettings()
  await pause(2500)
  const after = await observe('after-change')
  const syncAfterChange = syncRowsFrom(syncBase).map((row) => row.groups)
  result.syncAfterChange = syncAfterChange
  result.settingsFileAfterChange = readJson(SETTINGS)
  checks.require('a-theme-on-every-pane', after.appearance.length === base.appearance.length && after.appearance.every((row) => row.themeBackground === '#282a36'), after.appearance)
  checks.require('a-font-on-every-pane', after.appearance.every((row) => row.fontSize === baseFont + 1), { baseFont, after: after.appearance.map((row) => row.fontSize) })
  checks.require('a-computed-bg', after.paneBoxes.every((p) => p.pane['background-color'] === 'rgb(40, 42, 54)') && after.groups.every((g) => g['background-color'] === 'rgb(40, 42, 54)'), { panes: after.paneBoxes, groups: after.groups })
  checks.require('a-grid-requested', after.gridRequests > base.gridRequests && syncAfterChange.some((g) => (g ?? '') !== ''), { before: base.gridRequests, after: after.gridRequests, sync: syncAfterChange })
  checks.require('a-cols-rows-changed', JSON.stringify(after.panes.map((p) => [p.cols, p.rows])) !== JSON.stringify(base.panes.map((p) => [p.cols, p.rows])), { before: base.panes, after: after.panes })
  checks.require('a-settings-file', result.settingsFileAfterChange?.terminalThemeDark === 'Dracula' && result.settingsFileAfterChange?.terminalFontSize === baseFont + 1, result.settingsFileAfterChange)
  const lastDeclBeforeQuit = syncRowsFrom(syncBase).filter((row) => (row.groups ?? '') !== '').at(-1)?.groups ?? null
  result.lastDeclarationBeforeQuit = lastDeclBeforeQuit

  // ⓑ 정상 종료 → 같은 구성으로 재기동(native-app.sh 가 app pid 소유 확인 뒤 SIGTERM).
  const app = fs.readFileSync(path.join(root, 'app.dir'), 'utf8')
  const quitAt = fs.statSync(NDJSON).size
  const relaunch = spawnSync('sh', [path.join(here, '../l470/native-app.sh'), root, app, rawd, 'second'], { encoding: 'utf8', timeout: 180_000 })
  result.relaunch = { status: relaunch.status, stdout: relaunch.stdout, stderr: relaunch.stderr }
  if (relaunch.status !== 0) throw new Error(`재기동 실패 ${relaunch.status}\n${relaunch.stdout}\n${relaunch.stderr}`)
  result.appPid2 = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
  await until('link live (재기동)', async () => (await control({ cmd: 'state' })).state?.link?.phase === 'live', 60_000)
  await until('pane xterm (재기동)', () => evaluate(() => document.querySelector('[data-term-pane-box] .xterm') !== null), 30_000)
  await pause(2500)
  const back = await observe('after-restart')
  const syncAfterRestart = syncRowsFrom(quitAt).map((row) => row.groups)
  result.syncAfterRestart = syncAfterRestart
  const firstDecl = syncAfterRestart.find((g) => (g ?? '') !== '') ?? null
  checks.require('b-theme-font-persist', back.appearance.length >= 1 && back.appearance.every((row) => row.themeBackground === '#282a36' && row.fontSize === baseFont + 1), back.appearance)
  checks.require('b-computed-bg', back.paneBoxes.every((p) => p.pane['background-color'] === 'rgb(40, 42, 54)'), back.paneBoxes)
  checks.require('b-first-sync-saved-cell', firstDecl !== null && firstDecl === lastDeclBeforeQuit && firstDecl !== baseDecl, { firstDecl, lastDeclBeforeQuit, baseDecl })
  const screenAfter = await readScreen()
  result.screenAfter = screenAfter
  checks.require('b-screen-values', screenAfter.fontSize === String(baseFont + 1) && screenAfter.selectedOption === 'Dracula', screenAfter)
  await closeSettings()
  result.settingsFileAfterRestart = readJson(SETTINGS)
  result.uiPrefsKeysAfter = Object.keys(readJson(UI_PREFS) ?? {})
  const settingKeys = Object.keys(result.settingsFileAfterRestart ?? {}).filter((k) => k !== 'version')
  checks.require('b-uiprefs-no-setting-keys', result.uiPrefsKeysAfter.every((k) => !settingKeys.includes(k)), { uiPrefs: result.uiPrefsKeysAfter, settings: settingKeys })
  exitCode = checks.exitCode()
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[k9] 예외', result.error)
  exitCode = 2
}
result.finishedAt = new Date().toISOString()
result.exitCode = exitCode
save()
console.log(`[k9] exit ${exitCode}`, JSON.stringify(checks.results.filter((row) => !row.pass).map((row) => row.name)))
process.exit(exitCode)
