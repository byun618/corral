/* global window, document */
// LIFE-511 K9 **네이티브 관문** — native-up.sh 가 띄운 사용자 userData + 구현 빌드 + herdr 정식 `default` 세션에서 돈다.
// 사용자 세션 pane 에는 입력하지 않는다(설정 페이지 안의 키·클릭만). 입력 경로 = 제어 소켓 click/key/type
// (`webContents.sendInputEvent` — Chromium 입력 파이프라인, DOM 합성 이벤트 아님). OS CGEvent 도우미(/tmp/l497b)는 정리돼 없다 — RESULT 에 적는다.
//
// ⓐ ⚙ 실제 클릭 → 설정 › 단축키 → 「사이드바 접기 / 펼치기」 첫 칸 기록 ⌃G → 저장 → keybindings.json 이 바뀐 것을 확인
//    → UI 「기본값」 → 남은 바이트를 원본(없었으면 없음)으로 복원 → 지문(존재·sha256) 원본과 일치
// ⓑ Esc 2단계로 닫기 → ⌘, 로 다시 열기 → Esc 2단계로 닫기
// ⓒ 내내: main counters 격자 요청 수 불변 · pane cols/rows 불변 · xterm 인스턴스 동일 · corral.ndjson 에 stream.sync 새 행 0
//
// 사용: node native-k9.mjs <ROOT=/tmp/l511n*> <raw 폴더>
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { pause, requirements } from '../l497/lib.mjs'

const [root, rawd] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l511n')) throw new Error('ROOT 는 /tmp/l511n*')
fs.mkdirSync(rawd, { recursive: true })
const UD = path.join(process.env.HOME, 'Library/Application Support/corral')
const KB = path.join(UD, 'keybindings.json')
const NDJSON = path.join(UD, 'corral.ndjson')
const ctl = path.join(root, 'ctl.sock')
const control = (request, timeout = 20_000) => rpc(ctl, request, timeout)
const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
const key = (keyCode, modifiers = []) => control({ cmd: 'key', keyCode, modifiers })

const result = { startedAt: new Date().toISOString(), appPid: Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8')), steps: [], input: 'control socket sendInputEvent (click/key)' }
const save = () => fs.writeFileSync(path.join(rawd, 'k9.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[k9] 필수 조건 실패', JSON.stringify(row).slice(0, 400)) })
result.requirements = checks.results

const fingerprint = () => {
  if (!fs.existsSync(KB)) return { exists: false, sha256: null, size: null, text: null }
  const bytes = fs.readFileSync(KB)
  return { exists: true, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length, text: bytes.toString('utf8') }
}
// corral.ndjson 은 수백 MB 다 — 기준 시점의 길이부터만 읽는다.
const ndjsonFrom = fs.statSync(NDJSON).size
const syncRowsSinceBase = () => {
  const size = fs.statSync(NDJSON).size
  if (size <= ndjsonFrom) return []
  const fd = fs.openSync(NDJSON, 'r')
  const buffer = Buffer.alloc(size - ndjsonFrom)
  fs.readSync(fd, buffer, 0, buffer.length, ndjsonFrom)
  fs.closeSync(fd)
  return buffer.toString('utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((row) => row && /^stream\.sync/.test(String(row.tag ?? '')))
}
const until = async (label, fn, timeout = 8_000) => {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > timeout) return false
    await pause(150)
  }
}
const snapshot = async (name) => {
  const counters = (await control({ cmd: 'counters' })).counters
  const dom = await evaluate(() => ({
    panes: (window.corralPaneWrites?.() ?? []).map((pane) => ({ paneId: pane.paneId, cols: pane.cols, rows: pane.rows })),
    xterms: [...document.querySelectorAll('[data-term-pane-box]')].map((box) => ({ pane: box.getAttribute('data-term-pane-box'), tag: box.querySelector('.xterm')?.__l511 ?? null })),
    focusPane: document.activeElement?.closest?.('[data-term-pane-box]')?.getAttribute('data-term-pane-box') ?? null,
    activeTag: document.activeElement ? `${document.activeElement.tagName}.${document.activeElement.className}`.slice(0, 80) : null,
    settingsOpen: document.querySelector('[data-settings-page]') !== null,
    settingsSection: document.querySelector('[data-settings-section]')?.getAttribute('data-settings-section') ?? null,
    covered: document.querySelector('.app-body')?.className ?? null,
    tabs: document.querySelectorAll('[data-main-tab]').length,
  }))
  const entry = { name, at: new Date().toISOString(), gridRequests: counters.reduce((sum, row) => sum + (row.gridRequests ?? 0), 0), ...dom }
  result.steps.push(entry)
  save()
  console.log('[k9]', name, JSON.stringify({ grid: entry.gridRequests, panes: dom.panes.length, settings: dom.settingsOpen, focus: dom.focusPane }))
  return entry
}
const click = async (selector) => {
  const response = await control({ cmd: 'click', selector })
  checks.require(`click ${selector}`, response.ok === true, { response })
}
const isOpen = () => evaluate(() => document.querySelector('[data-settings-page]') !== null)

let exitCode = 0
const original = fingerprint()
result.keybindings = { path: KB, original: { exists: original.exists, sha256: original.sha256, size: original.size } }
try {
  await evaluate(() => {
    for (const box of document.querySelectorAll('[data-term-pane-box]')) {
      const xterm = box.querySelector('.xterm')
      if (xterm) xterm.__l511 = `tag-${box.getAttribute('data-term-pane-box')}`
    }
    return true
  })
  const base = await snapshot('base')
  result.baseNote = base.panes.length === 0 ? '보이는 pane 0개 — 격자 관측 대상 없음(빈 워크스페이스)' : null

  // ⓐ ⚙ → 단축키 → 기록 → 저장
  await click('[data-settings-open]')
  checks.require('gear-opens', await until('open', isOpen))
  await pause(400)
  const open1 = await snapshot('gear-open')
  checks.require('gear-section-shortcuts', open1.settingsSection === 'shortcuts', { section: open1.settingsSection })
  checks.require('workspace-covered-not-unmounted', open1.covered === 'app-body is-covered' && open1.xterms.length === base.xterms.length, { covered: open1.covered })
  await evaluate(() => { document.activeElement?.blur?.(); return true })
  await click('[data-record="sidebar.toggle"][data-variant="0"]')
  await key('G', ['control'])
  await pause(300)
  checks.require('record-candidate', await until('save button', () => evaluate(() => document.querySelector('[data-save-binding]') !== null), 3_000))
  await click('[data-save-binding]')
  checks.require('file-changed', await until('keybindings.json 변경', () => fingerprint().sha256 !== original.sha256, 5_000))
  const changed = fingerprint()
  result.keybindings.afterSave = changed
  checks.require('file-has-binding', /"sidebar\.toggle"\s*:\s*\[\s*"Control\+G"/.test(changed.text ?? ''), { text: changed.text })
  await snapshot('after-save')

  // UI 「기본값」 → 남은 바이트를 원본으로
  await click('[data-reset="sidebar.toggle"]')
  await pause(600)
  const afterReset = fingerprint()
  result.keybindings.afterUiReset = afterReset
  checks.require('ui-reset-removes-override', !/sidebar\.toggle/.test(afterReset.text ?? ''), { text: afterReset.text })
  if (original.exists) fs.writeFileSync(KB, original.text)
  else if (fs.existsSync(KB)) fs.rmSync(KB)
  const restored = fingerprint()
  result.keybindings.restored = { exists: restored.exists, sha256: restored.sha256, size: restored.size, method: original.exists ? '원본 바이트 되쓰기' : '원본에 없던 파일 — 지움' }
  checks.require('keybindings-restored-hash', restored.exists === original.exists && restored.sha256 === original.sha256, result.keybindings.restored)

  // ⓑ Esc 2단계 → ⌘, → Esc 2단계
  await key('Escape')
  await pause(300)
  checks.require('esc1-keeps-open', await isOpen())
  checks.require('esc1-confirm', await evaluate(() => document.querySelector('[data-settings-escape-confirm]') !== null))
  await snapshot('esc1')
  await key('Escape')
  checks.require('esc2-closes', await until('closed', async () => !(await isOpen())))
  await pause(600)
  const closed1 = await snapshot('closed-1')
  checks.require('focus-back-1', closed1.focusPane === base.focusPane, { base: base.focusPane, now: closed1.focusPane, active: closed1.activeTag })

  await key(',', ['meta'])
  checks.require('cmd-comma-opens', await until('open', isOpen))
  await pause(400)
  await snapshot('comma-open')
  await key('Escape')
  await pause(300)
  await key('Escape')
  checks.require('comma-esc2-closes', await until('closed', async () => !(await isOpen())))
  await pause(600)
  const end = await snapshot('end')
  checks.require('focus-back-2', end.focusPane === base.focusPane, { base: base.focusPane, now: end.focusPane })

  // ⓒ
  const syncRows = syncRowsSinceBase()
  result.syncRows = syncRows
  checks.require('grid-requests-zero', result.steps.every((step) => step.gridRequests === base.gridRequests), { per: result.steps.map((step) => [step.name, step.gridRequests]) })
  checks.require('stream-sync-zero', syncRows.length === 0, { rows: syncRows.length })
  checks.require('cols-rows-unchanged', result.steps.every((step) => JSON.stringify(step.panes) === JSON.stringify(base.panes)), { base: base.panes })
  checks.require('xterm-same-instance', end.xterms.length === base.xterms.length && end.xterms.every((row) => row.tag === `tag-${row.pane}`), { end: end.xterms })
  checks.require('no-new-tab', end.tabs === base.tabs, { base: base.tabs, end: end.tabs })
  exitCode = checks.exitCode()
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[k9] 예외', result.error)
  exitCode = 2
} finally {
  // 어떤 경로로 끝나든 keybindings.json 은 원본으로 둔다(재확인).
  const now = fingerprint()
  if (now.sha256 !== original.sha256 || now.exists !== original.exists) {
    if (original.exists) fs.writeFileSync(KB, original.text)
    else if (fs.existsSync(KB)) fs.rmSync(KB)
  }
  const last = fingerprint()
  result.keybindings.final = { exists: last.exists, sha256: last.sha256, size: last.size, matchesOriginal: last.exists === original.exists && last.sha256 === original.sha256 }
  if (!result.keybindings.final.matchesOriginal) exitCode = 1
  result.finishedAt = new Date().toISOString()
  result.exitCode = exitCode
  save()
  console.log('[k9] exit', exitCode, checks.failed().map((row) => row.name))
  process.exit(exitCode)
}
