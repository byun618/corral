/* global window, document, getComputedStyle */
// LIFE-513 K9 **네이티브 관문** — native-up.sh 가 띄운 사용자 userData + 구현 빌드 + herdr 정식 `default` 세션 + **사용자의 실제 Ghostty 설정**.
// l512 native-k9 의 틀(제어 소켓·ndjson 기준 길이·requirements)을 따른다. 사용자 pane 에는 입력하지 않는다(설정 페이지 안의 클릭만).
// 입력 경로 = 제어 소켓 click(`webContents.sendInputEvent` — Chromium 입력 파이프라인). 저장소·IPC 를 직접 불러 설정을 바꾸지 않는다.
//
// ⓐ ⚙ → 외관 → 「Ghostty에서 가져오기」 실제 클릭 → 모달: 읽은 경로(~/.config/ghostty/config 하나 — 0바이트 config.ghostty 는 건너뛴다)·
//    바뀔 값(글꼴군 Menlo — 크기 14 는 기본값과 같아 빠진다)·지원되지 않는 키 캡처
// ⓑ 「변경 사항 적용」 실제 클릭 → 열린 pane 마다 xterm fontFamily 첫 글꼴 Menlo·fontSize 14 · 셀 재측정(live·measured) · 격자 요청 수·선언 원자료 ·
//    settings.json 쓰기 1회(settings.changed 로그)
// ⓒ 정상 종료(native-app.sh 가 소유 확인 뒤 SIGTERM) → 재기동 → Menlo 14 유지(pane·설정 화면)
// ⓓ 원복은 native-down.sh(새로 생긴 settings.json 은 rsync --delete 로 지워진다 → manifest 전=후 · G6 해시 전=후)
// 사용: node native-k9.mjs <ROOT=/tmp/l513n*> <raw 폴더>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { pause, requirements } from '../l497/lib.mjs'

const [root, rawd] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l513n')) throw new Error('ROOT 는 /tmp/l513n*')
fs.mkdirSync(rawd, { recursive: true })
const here = path.dirname(new URL(import.meta.url).pathname)
const HOME = os.homedir()
const UD = path.join(HOME, 'Library/Application Support/corral')
const SETTINGS = path.join(UD, 'settings.json')
const NDJSON = path.join(UD, 'corral.ndjson')
const GHOSTTY_CONFIG = path.join(HOME, '.config/ghostty/config')
const ctl = path.join(root, 'ctl.sock')
const control = (request, timeout = 20_000) => rpc(ctl, request, timeout)
const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result

const result = { startedAt: new Date().toISOString(), appPid: Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8')), steps: [], input: 'control socket sendInputEvent (click)', ghosttyConfig: fs.readFileSync(GHOSTTY_CONFIG, 'utf8') }
const save = () => fs.writeFileSync(path.join(rawd, 'k9.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[k9] 필수 조건 실패', JSON.stringify(row).slice(0, 500)) })
result.requirements = checks.results

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null)
// corral.ndjson 은 수백 MB 다 — 기준 시점의 길이부터만 읽는다.
const rowsFrom = (offset, tag) => {
  const size = fs.statSync(NDJSON).size
  if (size <= offset) return []
  const fd = fs.openSync(NDJSON, 'r')
  const buffer = Buffer.alloc(size - offset)
  fs.readSync(fd, buffer, 0, buffer.length, offset)
  fs.closeSync(fd)
  return buffer.toString('utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((row) => row && row.tag === tag)
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
const shot = async (name, selector) => {
  try {
    const response = await control({ cmd: 'shot', name: `l513-native-${name}`, selector })
    if (response.ok && response.file && fs.existsSync(response.file)) { fs.copyFileSync(response.file, path.join(rawd, `${name}.png`)); return `${name}.png` }
    return `실패: ${JSON.stringify(response).slice(0, 200)}`
  } catch (error) { return `실패: ${String(error).slice(0, 200)}` }
}
const observe = async (name) => {
  const counters = (await control({ cmd: 'counters' })).counters
  const dom = await evaluate(() => ({
    panes: (window.corralPaneWrites?.() ?? []).map((pane) => ({ paneId: pane.paneId, cols: pane.cols, rows: pane.rows })),
    appearance: (window.corralPaneAppearance?.() ?? []).map((row) => ({ paneId: row.paneId, fontSize: row.options.fontSize, fontFamily: row.options.fontFamily, themeBackground: row.options.theme?.background ?? null, live: row.live })),
    probeCell: window.corralTermProbe?.cell?.() ?? null,
    groups: document.querySelectorAll('[data-term-group]').length,
    paneBoxes: [...document.querySelectorAll('[data-term-pane-box]')].map((el) => ({ paneId: el.getAttribute('data-term-pane-box'), xterm: el.querySelector('.xterm') !== null, xtermFont: el.querySelector('.xterm') ? getComputedStyle(el.querySelector('.xterm-rows') ?? el.querySelector('.xterm')).fontFamily : null })),
    settingsOpen: document.querySelector('[data-settings-page]') !== null,
  }))
  const entry = { name, at: new Date().toISOString(), gridRequests: counters.reduce((sum, row) => sum + (row.gridRequests ?? 0), 0), ...dom }
  result.steps.push(entry)
  save()
  console.log('[k9]', name, JSON.stringify({ grid: entry.gridRequests, panes: dom.panes.map((p) => `${p.cols}x${p.rows}`), font: dom.appearance.map((a) => `${String(a.fontFamily).split(',')[0]}/${a.fontSize}`) }))
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
    unsupported: [...modal.querySelectorAll('[data-ghostty-import-unsupported] li')].map((li) => li.textContent),
  }
})
const openAppearance = async () => {
  await click('[data-settings-open]')
  await until('settings open', () => evaluate(() => document.querySelector('[data-settings-page]') !== null), 5_000)
  await click('[data-settings-nav-item="appearance"]')
  await until('appearance', () => evaluate(() => document.querySelector('[data-settings-ghostty-import]') !== null), 5_000)
}
const closeSettings = async () => {
  await click('[data-settings-back]')
  await until('settings closed', () => evaluate(() => document.querySelector('[data-settings-page]') === null), 5_000)
}
const firstFont = (family) => String(family ?? '').split(',')[0].trim()

let exitCode = 0
try {
  result.settingsFileExistedBefore = fs.existsSync(SETTINGS)
  result.settingsFileBefore = readJson(SETTINGS)
  await until('link live', async () => (await control({ cmd: 'state' })).state?.link?.phase === 'live', 60_000)
  await until('pane xterm', () => evaluate(() => document.querySelector('[data-term-pane-box] .xterm') !== null), 30_000)
  await pause(2500)
  const logBase = fs.statSync(NDJSON).size
  const base = await observe('base')
  checks.require('base-has-panes', base.panes.length >= 1 && base.paneBoxes.every((p) => p.xterm), { panes: base.panes, boxes: base.paneBoxes })
  result.paneCount = base.panes.length

  // ⓐ 모달 — 실제 클릭.
  await openAppearance()
  await click('[data-settings-ghostty-import]')
  const modal = await until('modal ready', async () => { const s = await modalState(); return s && s.state !== 'loading' ? s : null }, 10_000)
  modal.screenshot = await shot('a-modal-preview', '[data-ghostty-import-modal]')
  result.modalPreview = modal
  save()
  checks.require('a-found', modal.state === 'found', modal)
  checks.require('a-paths-one', modal.paths === `구성: ${GHOSTTY_CONFIG}`, { paths: modal.paths })
  checks.require('a-diff-menlo-only', JSON.stringify(modal.rows) === JSON.stringify([{ key: 'terminalFontFamily', text: '글꼴군Menlo' }]), { rows: modal.rows })
  result.unsupported = modal.unsupported

  // ⓑ 적용 — 실제 클릭.
  const beforeApply = await evaluate(() => (window.corralPaneAppearance?.() ?? []).map((row) => ({ paneId: row.paneId, live: row.live })))
  const gridBefore = (await control({ cmd: 'counters' })).counters.reduce((sum, row) => sum + (row.gridRequests ?? 0), 0)
  const logBeforeApply = fs.statSync(NDJSON).size
  await click('[data-ghostty-import-apply]')
  await until('applied', async () => (await modalState())?.state === 'applied', 5_000)
  result.modalApplied = { ...(await modalState()), screenshot: await shot('b-modal-applied', '[data-ghostty-import-modal]') }
  await click('[data-ghostty-import-close]')
  await until('modal closed', async () => (await modalState()) === null, 5_000)
  await closeSettings()
  await pause(2500)
  const applied = await observe('after-import')
  result.applyWrites = rowsFrom(logBeforeApply, 'settings.changed')
  result.syncAfterImport = rowsFrom(logBeforeApply, 'stream.sync').map((row) => row.groups)
  result.cellBeforeAfter = { before: beforeApply, after: applied.appearance.map((row) => ({ paneId: row.paneId, live: row.live })), probe: applied.probeCell }
  result.gridDelta = { before: gridBefore, after: applied.gridRequests, groups: applied.groups }
  result.settingsFileAfterImport = readJson(SETTINGS)
  checks.require('b-one-write', result.applyWrites.length === 1, result.applyWrites)
  checks.require('b-menlo-every-pane', applied.appearance.length === base.appearance.length && applied.appearance.every((row) => firstFont(row.fontFamily) === '"Menlo"' && row.fontSize === 14), applied.appearance.map((row) => [row.fontFamily, row.fontSize]))
  checks.require('b-settings-file', result.settingsFileExistedBefore === false && result.settingsFileAfterImport?.terminalFontFamily === 'Menlo' && result.settingsFileAfterImport?.terminalFontSize === 14, result.settingsFileAfterImport)
  checks.require('b-grid-le-groups', applied.gridRequests - gridBefore <= Math.max(1, applied.groups), result.gridDelta)
  checks.require('b-live-eq-measured', applied.probeCell?.measured !== undefined && applied.appearance.every((row) => row.live && Math.abs(row.live.width - applied.probeCell.measured.width) < 0.05 && row.live.height === applied.probeCell.measured.height), { appearance: applied.appearance.map((row) => row.live), probe: applied.probeCell })
  // 1회 복사(K5ⓓ) — 가져오기 뒤 Ghostty 파일을 다시 보지 않는다: 이 회차는 Ghostty 파일을 쓰지 않으므로 관측은 「적용 뒤 추가 쓰기 0」 으로 본다.
  await pause(1500)
  checks.require('b-no-later-writes', rowsFrom(logBeforeApply, 'settings.changed').length === 1, { writes: rowsFrom(logBeforeApply, 'settings.changed').length })

  // ⓒ 정상 종료 → 재기동.
  const app = fs.readFileSync(path.join(root, 'app.dir'), 'utf8')
  const relaunch = spawnSync('sh', [path.join(here, '../l470/native-app.sh'), root, app, rawd, 'second'], { encoding: 'utf8', timeout: 180_000 })
  result.relaunch = { status: relaunch.status, stdout: relaunch.stdout, stderr: relaunch.stderr }
  if (relaunch.status !== 0) throw new Error(`재기동 실패 ${relaunch.status}\n${relaunch.stdout}\n${relaunch.stderr}`)
  result.appPid2 = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
  await until('link live (재기동)', async () => (await control({ cmd: 'state' })).state?.link?.phase === 'live', 60_000)
  await until('pane xterm (재기동)', () => evaluate(() => document.querySelector('[data-term-pane-box] .xterm') !== null), 30_000)
  await pause(2500)
  const back = await observe('after-restart')
  checks.require('c-menlo-persists', back.appearance.length >= 1 && back.appearance.every((row) => firstFont(row.fontFamily) === '"Menlo"' && row.fontSize === 14), back.appearance.map((row) => [row.fontFamily, row.fontSize]))
  await openAppearance()
  result.screenAfterRestart = await evaluate(() => ({ fontFamily: document.querySelector('[data-settings-font-family]')?.value ?? null, fontSize: document.querySelector('[data-settings-number="font-size"]')?.value ?? null }))
  result.screenShot = await shot('c-settings-after-restart', '[data-settings-block="typography"]')
  checks.require('c-screen-values', result.screenAfterRestart.fontFamily === 'Menlo' && result.screenAfterRestart.fontSize === '14', result.screenAfterRestart)
  // 재기동 뒤 다시 미리보기 — 이미 같은 값이라 「새 설정 없음」(diff 가 현재와 다른 칸만, K4ⓑ 네이티브 확인).
  await click('[data-settings-ghostty-import]')
  const again = await until('modal ready again', async () => { const s = await modalState(); return s && s.state !== 'loading' ? s : null }, 10_000)
  again.screenshot = await shot('c-modal-no-changes', '[data-ghostty-import-modal]')
  result.modalAfterRestart = again
  checks.require('c-no-new-settings', again.state === 'found' && again.rows.length === 0 && again.text.includes('가져올 새 설정이 없습니다.'), again)
  await click('[data-ghostty-import-cancel]')
  await closeSettings()
  result.logRowsSettingsChanged = rowsFrom(logBase, 'settings.changed')
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
