import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
process.env.LIFE353_SESSION = 'life373-codex-l389'
process.env.L353_RAW_DIR = path.resolve('../specs/LIFE-389-shortcut-system/raw/codex')
const { startApp, sleep, until, RAW_DIR } = await import('../l353/lib.mjs')
const data = '/tmp/l389-codex-data'
fs.mkdirSync(data, { recursive: true })
const registry = path.join(data, 'repos.json')
fs.writeFileSync(registry, JSON.stringify({ version: 1, repos: ['/private/tmp/l389-codex-repo'] }))
const results = []
let app
const launch = async (name) => {
  app = await startApp({ name, registryFile: registry, extraArgs: [`--user-data-dir=${data}`], env: { CORRAL_UI_PREFS: path.join(data, 'ui-prefs.json') } })
  assert(app.ready)
  assert((await until(async () => (await app.query('[data-shortcuts-open]')).found.length === 1)).ok)
  await sleep(700)
}
const ev = async (code) => (await app.send({ cmd: 'eval', code })).result
const count = async (selector) => (await app.query(selector)).found.length
const key = async (keyCode, modifiers = [], type) => { await app.send({ cmd: 'key', keyCode, modifiers, ...type ? { type } : {} }); await sleep(180) }
const click = async (selector) => { const result = await app.click(selector); assert.equal(result.hit, true, `not hittable: ${selector}`); await sleep(180); return result }
const check = (id, observation) => { results.push({ id, observation, pass: true }); console.log('PASS', id, JSON.stringify(observation)) }
const waitCount = async (selector, expected) => assert((await until(async () => await count(selector) === expected, { timeoutMs: 9000, what: selector })).ok, `${selector} count != ${expected}`)
try {
  fs.writeFileSync(path.join(data, 'ui-prefs.json'), JSON.stringify({sidebarWidth:322,sidebarCollapsed:false}))
  fs.rmSync(path.join(data, 'keybindings.json'), {force:true})
  await launch('ui')
  await click('[data-worktree="/private/tmp/l389-codex-repo"]')
  await app.shot('initial')
  await click('[data-shortcuts-open]')
  assert.equal(await count('[data-shortcut-action]'), 9)
  await app.shot('nine-actions')
  check('R1-R3 D1', await app.query('[data-shortcut-action]'))
  const record = '[data-record="sidebar.toggle"]'
  await click(record)
  await key('Shift', ['shift']); await key('Control', ['control']); await key('Alt', ['alt']); await key('Meta', ['meta'])
  assert.equal(await count('[data-save-binding]'), 0)
  assert.match(await ev(`document.querySelector('${record}').textContent`), /키 입력/)
  check('C2', 'All four standalone modifiers ignored')
  await key('Escape')
  assert.equal(await count('[data-shortcut-settings]'), 1)
  assert.equal(await count('[data-save-binding]'), 0)
  check('C1-Escape', 'Recording cancelled; settings stays open')
  const panesBefore = (await app.state()).repos.flatMap(r => r.worktrees).flatMap(w => w.workspace?.tabs ?? []).flatMap(t => t.panes).length
  await click(record); await key('D', ['meta'])
  assert.equal(await count('[data-save-binding]'), 1)
  await click('[data-save-binding]')
  assert.match((await app.query('[role="status"]')).found.join(' '), /pane 분할.*충돌/)
  const panesAfter = (await app.state()).repos.flatMap(r => r.worktrees).flatMap(w => w.workspace?.tabs ?? []).flatMap(t => t.panes).length
  assert.equal(panesAfter, panesBefore)
  await app.shot('capture-d-conflict')
  check('C3 D4', { panesBefore, panesAfter, error: (await app.query('[role="status"]')).found })
  await click(record); await key('W', ['meta'])
  assert.match(await ev(`document.querySelector('${record}').textContent`), /⌘W/)
  await click('[data-save-binding]')
  assert.match((await app.query('[role="status"]')).found.join(' '), /pane \/ 탭 닫기.*충돌/)
  assert.equal((await app.state()).repos.flatMap(r => r.worktrees).flatMap(w => w.workspace?.tabs ?? []).flatMap(t => t.panes).length, panesBefore)
  await app.shot('capture-w-conflict')
  check('C3-b', 'Native before-input-event Cmd+W captured; pane count unchanged; conflict rejected')
  await click(record); await key('J', ['meta']); await click('[data-save-binding]')
  assert.match(await ev(`document.querySelector('${record}').textContent`), /⌘J/)
  await key('Escape')
  const beforeRect = (await app.send({ cmd: 'rect', selector: '[data-main-area]' })).rect
  await key('J', ['meta']); await waitCount('[data-sidebar]', 0)
  const collapsedRect = (await app.send({ cmd: 'rect', selector: '[data-main-area]' })).rect
  await app.shot('custom-sidebar-collapsed')
  check('D2 sidebar-collapse', { beforeRect, collapsedRect })
  assert(fs.existsSync(path.join(data, 'keybindings.json')), 'userData must be isolated')
  fs.copyFileSync(path.join(data, 'keybindings.json'), path.join(RAW_DIR, 'keybindings-before-restart.json'))
  check('S1', JSON.parse(fs.readFileSync(path.join(data, 'keybindings.json'))))
  await app.stop(); app = null
  await launch('restart')
  await waitCount('[data-sidebar]', 0)
  await app.shot('restart-collapsed')
  await key('J', ['meta']); await waitCount('[data-sidebar]', 1)
  await app.shot('restart-restored')
  check('S2 sidebar-persistence', { file: JSON.parse(fs.readFileSync(path.join(data, 'keybindings.json'))), sidebar: await count('[data-sidebar]') })
  await click('[data-shortcuts-open]'); await click('[data-reset="sidebar.toggle"]')
  assert.match(await ev(`document.querySelector('${record}').textContent`), /⌘B/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'keybindings.json'))), {})
  await key('Escape'); await key('B', ['meta']); await waitCount('[data-sidebar]', 0); await key('B', ['meta']); await waitCount('[data-sidebar]', 1)
  check('D3', 'Reset removes override from disk and restores Cmd+B immediately')
  // Persist a dragged custom width, not the default width.
  const handle = (await app.send({ cmd: 'rect', selector: '[data-sidebar-resizer]' })).rect
  console.log('HANDLE', handle)
  await app.send({ cmd: 'raw-mouse', type: 'mouseDown', x: Math.round(handle.left + handle.width / 2), y: Math.round(handle.top + 150), button: 'left' })
  await app.send({ cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(handle.left + 77), y: Math.round(handle.top + 150), button: 'left' })
  await app.send({ cmd: 'raw-mouse', type: 'mouseUp', x: Math.round(handle.left + 77), y: Math.round(handle.top + 150), button: 'left' })
  await sleep(300)
  const width = await ev('document.querySelector("[data-sidebar]").getBoundingClientRect().width')
  await key('B', ['meta']); await key('B', ['meta'])
  assert.equal(await ev('document.querySelector("[data-sidebar]").getBoundingClientRect().width'), width)
  check('sidebar-width', { width })
  // Regression: actual terminal-focused inputs and native menu route.
  await click('[data-worktree="/private/tmp/l389-codex-repo"]')
  let tabs = await count('[data-main-tab]')
  await key('T', ['meta']); await waitCount('[data-main-tab]', tabs + 1)
  check('G3 terminal.new', { before: tabs, after: await count('[data-main-tab]') })
  await sleep(800)
  let panes = await count('[data-term-pane-box]')
  await key('D', ['meta']); await waitCount('[data-term-pane-box]', panes + 1)
  await key('D', ['meta', 'shift']); await waitCount('[data-term-pane-box]', panes + 2)
  await app.shot('split-right-down')
  check('G3 terminal.split', { before: panes, after: await count('[data-term-pane-box]') })
  const selected = () => ev('document.querySelector(".term-pane.is-selected")?.dataset.termPaneBox')
  const neighborLog = []
  for (const direction of ['Left', 'Right', 'Up', 'Down']) {
    const before = await selected(); await key(direction, ['meta', 'alt']); neighborLog.push({ direction, before, after: await selected() })
  }
  check('G3 terminal.focus', neighborLog)
  await key('Z', ['meta', 'shift']); await sleep(350)
  assert((await app.state()).terminalGroups.some(g => g.zoomedPaneId !== null))
  await app.shot('zoom')
  await key('Z', ['meta', 'shift']); await sleep(350)
  assert((await app.state()).terminalGroups.every(g => g.zoomedPaneId === null))
  check('G3 terminal.zoom', 'toggle on then off')
  const groupCount = await count('[data-tab-group]')
  await key('D', ['meta', 'alt']); await waitCount('[data-tab-group]', groupCount + 1)
  await app.shot('group-split')
  await key('W', ['meta', 'alt']); await waitCount('[data-tab-group]', groupCount)
  check('G3 group.split group.close', { before: groupCount, afterSplit: groupCount + 1, afterClose: await count('[data-tab-group]') })
  // MRU hold/cancel snapshots use visible pane, group and tab identities.
  const snap = () => ev(`({pane: document.querySelector('.term-pane.is-selected')?.dataset.termPaneBox, groups: [...document.querySelectorAll('[data-tab-group]')].map(g=>({id:g.dataset.tabGroup, active:g.classList.contains('is-active-group'), tabs:[...g.querySelectorAll('[data-main-tab]')].map(t=>({id:t.dataset.mainTab,cls:t.className}))}))})`)
  const beforeHold = await snap()
  await key('Tab', ['control'], 'keyDown'); await waitCount('[data-mru]', 1)
  const firstSelection = await ev('document.querySelector("[data-mru-selected=true]")?.dataset.mruRow')
  await key('Tab', ['control'], 'keyDown')
  const secondSelection = await ev('document.querySelector("[data-mru-selected=true]")?.dataset.mruRow')
  await key('Tab', ['control', 'shift'], 'keyDown')
  assert.equal(await ev('document.querySelector("[data-mru-selected=true]")?.dataset.mruRow'), firstSelection)
  await app.shot('mru-hold')
  const mruRows = (await app.query('[data-mru-row]')).found
  await key('Escape'); await waitCount('[data-mru]', 0)
  assert.deepEqual(await snap(), beforeHold)
  check('F3-1 F3-2 F3-4 F3-5', { firstSelection, secondSelection, mruRows, beforeHold, afterCancel: await snap() })
  await key('Tab', ['control'], 'keyDown'); await key('Control', [], 'keyUp'); await waitCount('[data-mru]', 0)
  check('F3-3 Control release', await snap())
  await key('Tab', ['control'], 'keyDown'); await key('Enter'); await waitCount('[data-mru]', 0)
  check('F3-2 Enter', await snap())
  await key('Tab', ['control'], 'keyDown'); await sleep(10500); await waitCount('[data-mru]', 0)
  check('F3-3 timeout', '10-second lost-keyup fallback closes hold')
  await key('Tab', ['control'], 'keyDown'); await key('W', ['meta']); await waitCount('[data-mru]', 0)
  check('M2 MRU intercepted Cmd+W', 'Cancels hold without closing pane')
  // Native close pane, then close last pane/tab.
  let totalPanes = (await app.state()).repos.flatMap(r=>r.worktrees).flatMap(w=>w.workspace?.tabs??[]).flatMap(t=>t.panes).length
  await key('W', ['meta']); await sleep(800)
  let afterPanes = (await app.state()).repos.flatMap(r=>r.worktrees).flatMap(w=>w.workspace?.tabs??[]).flatMap(t=>t.panes).length
  assert.equal(afterPanes, totalPanes - 1)
  check('G3 terminal.close M2', { totalPanes, afterPanes, windowAlive: await count('[data-shortcuts-open]') })
  await app.shot('after-close')
  await app.stop(); app = null
  fs.writeFileSync(path.join(data, 'keybindings.json'), '{ broken')
  await launch('corrupt-file'); assert.deepEqual(await ev('window.corral.getKeybindings()'), {}); await app.shot('corrupt-fallback'); await app.stop(); app = null
  fs.unlinkSync(path.join(data, 'keybindings.json'))
  await launch('missing-file'); assert.deepEqual(await ev('window.corral.getKeybindings()'), {}); await app.shot('missing-fallback')
  check('S4', 'Both malformed JSON and missing file booted with defaults')
} finally {
  fs.writeFileSync(path.join(RAW_DIR, 'ui-results.json'), JSON.stringify(results, null, 2))
  if (app) await app.stop()
}
