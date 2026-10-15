// LIFE-593 빠른 확인 — 핵심 진입점 1회(격리 Electron, fixture 만). 01-criteria 「빠른 확인」:
//   ① 터미널 포커스에서 ⌘P → 대화상자(별도 — 팔레트 아님) → 질의 → Enter → 고정 탭 + 편집기 포커스, PTY 로 글자 0
//   ② 탐색기 트리 포커스에서 ⌥⌘F → 머리 입력칸 → 입력 → 트리가 걸러짐(맞은 항목 + 조상, 안 읽은 폴더 안도) → 입력칸 Enter = 이름 바꾸기 아님(첫 일치 선택 + 트리 포커스)
// 사용(app/ 에서, iso.sh 안): node scripts/l593/quick-entry.mjs <ROOT> <OUT.json>
// 입력은 제어 소켓(sendInputEvent) — OS 키 입력(CGEvent)·클립보드 아님. 창이 앞에 뜨면 L593_RETURN_APP 으로 앞 앱을 돌려준다(giveBack).
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog, herdr } from './lib.mjs'

const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: quick-entry.mjs /tmp/l593g-* OUT.json')
const result = { at: new Date().toISOString(), method: 'sendInputEvent (control socket) — not CGEvent', steps: [], checks: {} }
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log(`# ${name} ${JSON.stringify(data).slice(0, 400)}`)
}
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const termText = async () => ((await ctl(root, { cmd: 'term-read' })).term?.lines ?? []).join('\n')
let exitCode = 1
try {
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  const { paneId } = await repoPane(root)
  await sleep(1500)
  await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
  // 그 레포 pane 의 탭을 눌러 터미널을 보이고 xterm 포커스.
  const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab="${tabId}"]` })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '탭 클릭' })
  await until(async () => (await ctl(root, { cmd: 'state' })).state?.terminal?.phase === 'streaming', { timeoutMs: 15_000, label: 'streaming' })
  const termFocused = () => q(`document.activeElement?.classList?.contains('xterm-helper-textarea') === true`)
  await until(async () => {
    if (await termFocused()) return true
    await ctl(root, { cmd: 'term-click', fx: 0.5, fy: 0.5 })
    await sleep(150)
    return termFocused()
  }, { timeoutMs: 8_000, everyMs: 200, label: '터미널 포커스' })
  await giveBack()
  const termBefore = await termText()

  // ① ⌘P
  await ctl(root, { cmd: 'key', keyCode: 'Shift' })
  const openedAt = Date.now()
  await key('P', ['meta'])
  const ready = await until(() => q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState === 'ready' ? Date.now() : null`), { timeoutMs: 10_000, label: '⌘P 준비' })
  const dialog = await q(`(() => ({ quickOpen: !!document.querySelector('[data-quick-open]'), palette: !!document.querySelector('[data-command-palette]'), inputFocused: document.activeElement?.matches('[data-quick-open-input]') === true, bodyInert: document.querySelector('.app-body')?.inert === true, rows: [...document.querySelectorAll('[data-quick-open-row]')].length }))()`)
  step('quickOpen.open', { readyMs: ready.value - openedAt, ...dialog })
  await ctl(root, { cmd: 'type', text: 'l593 target' })
  const top = await until(() => q(`(() => { const rows = [...document.querySelectorAll('[data-quick-open-row]')].map((e) => e.dataset.quickOpenRow); return rows.length > 0 && rows[0] === 'src/deep/a/b/l593-target.ts' ? rows.slice(0, 5) : null })()`), { timeoutMs: 5_000, label: '질의 결과' })
  const marks = await q(`[...document.querySelectorAll('[data-quick-open-row] mark')].slice(0, 6).map((m) => m.textContent)`)
  step('quickOpen.query', { query: 'l593 target', top5: top.value, marks })
  await key('Return')
  const tab = await until(() => q(`(() => { const t = document.querySelector('[data-file-tab="src/deep/a/b/l593-target.ts"]'); return t === null ? null : { preview: t.dataset.tabPreview ?? null, active: t.dataset.active ?? null } })()`), { timeoutMs: 8_000, label: '파일 탭' })
  const editorFocus = await until(() => q(`document.activeElement?.closest('[data-file-editor]') !== null ? true : null`), { timeoutMs: 5_000, label: '편집기 포커스' }).then(() => true, () => false)
  const closed = await q(`!document.querySelector('[data-quick-open]')`)
  await sleep(300)
  const termAfter = await termText()
  const leaked = ['l593', 'target'].filter((word) => termAfter.split(word).length > termBefore.split(word).length)
  step('quickOpen.enter', { tab: tab.value, editorFocus, closed, ptyLeak: leaked })
  result.checks.quickOpen =
    dialog.quickOpen && !dialog.palette && dialog.inputFocused && dialog.bodyInert && tab.value.preview === 'false' && editorFocus && closed && leaked.length === 0

  // ② 이름 필터
  const panelOpen = async () => (await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
  if (!(await panelOpen())) await key('L', ['meta'])
  await until(panelOpen, { label: '탐색기' })
  await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '탐색기 행' })
  // auto reveal 이 연 탭 조상을 펼친다 — 그 행이 보일 때까지(reveal 끝) 기다린 뒤 모두 접어 「안 읽은·접힌 폴더 안도 찾는다」 를 본다.
  // (q02 실패: reveal 이 「모두 접기」 뒤에 끝나 조상이 펼쳐진 채 남았다 — 하네스 경합, 제품 판정과 무관)
  await until(() => q(`document.querySelector('[data-explorer-row="src/deep/a/b/l593-target.ts"]') !== null`), { timeoutMs: 8_000, label: 'auto reveal 끝' })
  const expandedBefore = (
    await until(async () => {
      await ctl(root, { cmd: 'click', selector: '[data-explorer-collapse-all]' })
      await sleep(300)
      const open = await q(`[...document.querySelectorAll('[data-explorer-row][aria-expanded="true"]')].map((e) => e.dataset.explorerRow)`)
      return open.length === 0 ? open : null
    }, { timeoutMs: 6_000, everyMs: 300, label: '모두 접기' })
  ).value
  await until(async () => {
    await ctl(root, { cmd: 'click', selector: '[data-explorer-row="README.md"]' })
    await sleep(200)
    return q(`document.activeElement === document.querySelector('[data-explorer-tree]')`)
  }, { timeoutMs: 6_000, label: '트리 포커스' })
  await giveBack()
  await key('F', ['meta', 'alt'])
  await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { timeoutMs: 5_000, label: '필터 입력칸 포커스' })
  await ctl(root, { cmd: 'type', text: 'needle' })
  const rows = await until(
    () => q(`(() => { const rows = [...document.querySelectorAll('[data-explorer-row]')].map((e) => e.dataset.explorerRow); return rows.includes('src/deep/a/b/l593-needle.md') ? rows : null })()`),
    { timeoutMs: 8_000, label: '걸러진 트리' },
  )
  const highlighted = await q(`[...document.querySelectorAll('.explorer-filter-hit')].map((m) => m.textContent)`)
  const status = await q(`document.querySelector('[data-explorer-filter-status]')?.textContent ?? null`)
  const expected = ['docs', 'docs/guide', 'docs/guide/l593-needle-guide.md', 'src', 'src/deep', 'src/deep/a', 'src/deep/a/b', 'src/deep/a/b/l593-needle.md']
  step('filter.type', { expandedBefore, rows: rows.value, highlighted, status })
  // 입력칸 Enter — 이름 바꾸기 입력이 뜨지 않고, 첫 일치 행 선택 + 트리 포커스.
  await key('Return')
  await sleep(300)
  const afterEnter = await q(`(() => ({ renameInput: !!document.querySelector('[data-explorer-input]'), treeFocused: document.activeElement === document.querySelector('[data-explorer-tree]'), selected: document.querySelector('[data-explorer-row].is-selected')?.dataset.explorerRow ?? null }))()`)
  step('filter.enter', afterEnter)
  result.checks.filter =
    JSON.stringify(rows.value) === JSON.stringify(expected) && expandedBefore.length === 0 && highlighted.every((text) => text.toLowerCase() === 'needle') && !afterEnter.renameInput && afterEnter.treeFocused && afterEnter.selected === 'docs/guide/l593-needle-guide.md'
  exitCode = Object.values(result.checks).every(Boolean) ? 0 : 1
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.error(result.error)
} finally {
  result.giveBack = giveBackLog
  result.exitCode = exitCode
  writeJson(path.resolve(out), result)
}
process.exit(exitCode)
