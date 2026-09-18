import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
process.env.LIFE353_SESSION ??= 'life373-codex-l389'
process.env.L353_RAW_DIR ??= path.resolve('../specs/LIFE-389-shortcut-system/raw/codex/fix1')
const { startApp, sleep, until, RAW_DIR, herdrRequest } = await import('../l353/lib.mjs')
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
const totalPanesCount = async () => (await app.state()).repos.flatMap(r => r.worktrees).flatMap(w => w.workspace?.tabs ?? []).flatMap(t => t.panes).length
const count = async (selector) => (await app.query(selector)).found.length
const key = async (keyCode, modifiers = [], type) => { await app.send({ cmd: 'key', keyCode, modifiers, ...type ? { type } : {} }); await sleep(180) }
const click = async (selector) => { const result = await app.click(selector); assert.equal(result.hit, true, `not hittable: ${selector}`); await sleep(180); return result }
const check = (id, observation, predicate) => {
  const pass = typeof predicate === 'function' && predicate(observation) === true
  results.push({ id, observation, pass })
  assert.equal(pass, true, `${id}: ${JSON.stringify(observation)}`)
  console.log('PASS', id, JSON.stringify(observation))
}
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
  check('R1-R3 D1', await app.query('[data-shortcut-action]'), o => o.found.length === 9)
  const record = '[data-record="sidebar.toggle"]'
  for (const plain of ['D', 'Tab', 'Enter']) {
    await click(record); await key(plain)
    check(`plain ${plain} ignored`, await count('[data-save-binding]'), n => n === 0)
    await key('Escape')
  }
  await click(record)
  await key('Shift', ['shift']); await key('Control', ['control']); await key('Alt', ['alt']); await key('Meta', ['meta'])
  assert.equal(await count('[data-save-binding]'), 0)
  assert.match(await ev(`document.querySelector('${record}').textContent`), /키 입력/)
  check('C2', await count('[data-save-binding]'), n => n === 0)
  await key('Escape')
  assert.equal(await count('[data-shortcut-settings]'), 1)
  assert.equal(await count('[data-save-binding]'), 0)
  check('C1-Escape', { settings: await count('[data-shortcut-settings]'), save: await count('[data-save-binding]') }, o => o.settings === 1 && o.save === 0)
  const panesBefore = (await app.state()).repos.flatMap(r => r.worktrees).flatMap(w => w.workspace?.tabs ?? []).flatMap(t => t.panes).length
  await click(record); await key('D', ['meta'])
  assert.equal(await count('[data-save-binding]'), 1)
  await click('[data-save-binding]')
  assert.match((await app.query('[role="status"]')).found.join(' '), /pane 분할.*충돌/)
  const panesAfter = (await app.state()).repos.flatMap(r => r.worktrees).flatMap(w => w.workspace?.tabs ?? []).flatMap(t => t.panes).length
  assert.equal(panesAfter, panesBefore)
  await app.shot('capture-d-conflict')
  check('C3 D4', { panesBefore, panesAfter, error: (await app.query('[role="status"]')).found }, o => o.panesBefore === o.panesAfter && /충돌/.test(o.error.join()))
  await click(record); await key('W', ['meta'])
  assert.match(await ev(`document.querySelector('${record}').textContent`), /⌘W/)
  await click('[data-save-binding]')
  assert.match((await app.query('[role="status"]')).found.join(' '), /pane \/ 탭 닫기.*충돌/)
  assert.equal((await app.state()).repos.flatMap(r => r.worktrees).flatMap(w => w.workspace?.tabs ?? []).flatMap(t => t.panes).length, panesBefore)
  await app.shot('capture-w-conflict')
  check('C3-b', { count: await totalPanesCount(), before: panesBefore, candidate: await ev(`document.querySelector('${record}').textContent`) }, o => o.count === o.before && o.candidate.includes('⌘W'))
  await click(record); await key('J', ['meta']); await click('[data-save-binding]')
  assert.match(await ev(`document.querySelector('${record}').textContent`), /⌘J/)
  await key('Escape')
  const beforeRect = (await app.send({ cmd: 'rect', selector: '[data-main-area]' })).rect
  await key('J', ['meta']); await waitCount('[data-sidebar]', 0)
  const collapsedRect = (await app.send({ cmd: 'rect', selector: '[data-main-area]' })).rect
  await app.shot('custom-sidebar-collapsed')
  check('D2 sidebar-collapse', { beforeRect, collapsedRect }, o => o.collapsedRect.width > o.beforeRect.width && o.collapsedRect.left < o.beforeRect.left)
  assert(fs.existsSync(path.join(data, 'keybindings.json')), 'userData must be isolated')
  fs.copyFileSync(path.join(data, 'keybindings.json'), path.join(RAW_DIR, 'keybindings-before-restart.json'))
  check('S1', JSON.parse(fs.readFileSync(path.join(data, 'keybindings.json'))), o => JSON.stringify(o) === JSON.stringify({'sidebar.toggle':['Mod+J']}))
  await app.stop(); app = null
  await launch('restart')
  await waitCount('[data-sidebar]', 0)
  await app.shot('restart-collapsed')
  await key('J', ['meta']); await waitCount('[data-sidebar]', 1)
  await app.shot('restart-restored')
  check('S2 sidebar-persistence', { file: JSON.parse(fs.readFileSync(path.join(data, 'keybindings.json'))), sidebar: await count('[data-sidebar]') }, o => o.sidebar === 1 && o.file['sidebar.toggle'][0] === 'Mod+J')
  await click('[data-shortcuts-open]'); await click('[data-reset="sidebar.toggle"]')
  assert.match(await ev(`document.querySelector('${record}').textContent`), /⌘B/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'keybindings.json'))), {})
  await key('Escape'); await key('B', ['meta']); await waitCount('[data-sidebar]', 0); await key('B', ['meta']); await waitCount('[data-sidebar]', 1)
  check('D3', { overrides: await ev('window.corral.getKeybindings()'), sidebar: await count('[data-sidebar]') }, o => Object.keys(o.overrides).length === 0 && o.sidebar === 1)
  // Two dispatches in one JS task must observe each other's state before React renders.
  await ev(`(() => { for(let i=0;i<2;i++) document.dispatchEvent(new KeyboardEvent('keydown', {key:'b',code:'KeyB',metaKey:true,bubbles:true})) })()`)
  await sleep(300)
  check('sidebar same-tick double toggle', { visible: await count('[data-sidebar]'), prefs: await ev('window.corral.getUiPrefs()') }, o => o.visible === 1 && o.prefs.sidebarCollapsed === false)
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
  check('sidebar-width', { width }, o => o.width === 393)
  // Regression: actual terminal-focused inputs and native menu route.
  await click('[data-worktree="/private/tmp/l389-codex-repo"]')
  let tabs = await count('[data-main-tab]')
  await key('T', ['meta']); await waitCount('[data-main-tab]', tabs + 1)
  check('G3 terminal.new', { before: tabs, after: await count('[data-main-tab]') }, o => o.after === o.before + 1)
  await sleep(800)
  let panes = await count('[data-term-pane-box]')
  await key('D', ['meta']); await waitCount('[data-term-pane-box]', panes + 1)
  await key('D', ['meta', 'shift']); await waitCount('[data-term-pane-box]', panes + 2)
  await app.shot('split-right-down')
  check('G3 terminal.split', { before: panes, after: await count('[data-term-pane-box]') }, o => o.after === o.before + 2)
  const selected = () => ev('document.querySelector(".term-pane.is-selected")?.dataset.termPaneBox')
  // Negative control: a deliberately swallowed focus key must make this run fail.
  if (process.env.L389_NEGATIVE_FOCUS === '1') {
    await ev(`window.addEventListener('keydown', e => { if (e.metaKey && e.altKey && e.key.startsWith('Arrow')) e.stopImmediatePropagation() }, true)`)
  }
  const neighborLog = []
  for (const direction of ['Left', 'Right', 'Up', 'Down']) {
    const before = await selected()
    const response = await herdrRequest('pane.neighbor', { pane_id: before, direction: direction.toLowerCase() })
    const expected = response.neighbor?.neighbor_pane_id || before
    await key(direction, ['meta', 'alt'])
    await until(async () => await selected() === expected, { timeoutMs: 3000 })
    const observation = { direction, before, expected, after: await selected() }
    check(`G3 terminal.focus ${direction}`, observation, o => o.after === o.expected)
    neighborLog.push(observation)
  }
  check('G3 terminal.focus', neighborLog, o => o.some(row => row.before !== row.after) && o.every(row => row.after === row.expected))
  await key('Z', ['meta', 'shift']); await sleep(350)
  const zoomed = (await app.state()).terminalGroups.some(g => g.zoomedPaneId !== null)
  assert(zoomed)
  await app.shot('zoom')
  await key('Z', ['meta', 'shift']); await sleep(350)
  assert((await app.state()).terminalGroups.every(g => g.zoomedPaneId === null))
  check('G3 terminal.zoom', { zoomed, restored: (await app.state()).terminalGroups.every(g => g.zoomedPaneId === null) }, o => o.zoomed && o.restored)
  const groupCount = await count('[data-tab-group]')
  await key('D', ['meta', 'alt']); await waitCount('[data-tab-group]', groupCount + 1)
  await app.shot('group-split')
  const afterSplit = await count('[data-tab-group]')
  await key('W', ['meta', 'alt']); await waitCount('[data-tab-group]', groupCount)
  check('G3 group.split group.close', { before: groupCount, afterSplit, afterClose: await count('[data-tab-group]') }, o => o.afterSplit === o.before + 1 && o.afterClose === o.before)
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
  check('F3-1 F3-2 F3-4 F3-5', { firstSelection, secondSelection, mruRows, beforeHold, afterCancel: await snap() }, o => o.firstSelection !== o.secondSelection && o.mruRows.length >= 2 && JSON.stringify(o.beforeHold) === JSON.stringify(o.afterCancel))
  const beforeRelease = await snap()
  await key('Tab', ['control'], 'keyDown')
  const releaseTarget = await ev('document.querySelector("[data-mru-selected=true]")?.dataset.mruRow')
  await key('Control', [], 'keyUp'); await waitCount('[data-mru]', 0)
  check('F3-3 Control release', { before: beforeRelease, target: releaseTarget, after: await snap() }, o => o.before.pane !== o.target && o.after.pane === o.target)
  const beforeEnter = await snap()
  await key('Tab', ['control'], 'keyDown')
  const enterTarget = await ev('document.querySelector("[data-mru-selected=true]")?.dataset.mruRow')
  await key('Enter'); await waitCount('[data-mru]', 0)
  check('F3-2 Enter', { before: beforeEnter, target: enterTarget, after: await snap() }, o => o.before.pane !== o.target && o.after.pane === o.target)
  const beforeTimeout = await snap()
  await key('Tab', ['control'], 'keyDown'); await sleep(10500); await waitCount('[data-mru]', 0)
  check('F3-3 timeout', { before: beforeTimeout, after: await snap(), open: await count('[data-mru]') }, o => JSON.stringify(o.before) === JSON.stringify(o.after) && o.open === 0)
  const beforeIntercept = await totalPanesCount()
  await key('Tab', ['control'], 'keyDown'); await key('W', ['meta']); await waitCount('[data-mru]', 0)
  check('M2 MRU intercepted Cmd+W', { before: beforeIntercept, after: await totalPanesCount(), open: await count('[data-mru]') }, o => o.before === o.after && o.open === 0)
  // Native close pane, then close last pane/tab.
  let totalPanes = (await app.state()).repos.flatMap(r=>r.worktrees).flatMap(w=>w.workspace?.tabs??[]).flatMap(t=>t.panes).length
  await key('W', ['meta']); await sleep(800)
  let afterPanes = (await app.state()).repos.flatMap(r=>r.worktrees).flatMap(w=>w.workspace?.tabs??[]).flatMap(t=>t.panes).length
  assert.equal(afterPanes, totalPanes - 1)
  check('G3 terminal.close M2', { totalPanes, afterPanes, windowAlive: await count('[data-shortcuts-open]') }, o => o.afterPanes === o.totalPanes - 1 && o.windowAlive === 1)
  await app.shot('after-close')
  await app.stop(); app = null
  fs.writeFileSync(path.join(data, 'keybindings.json'), '{ broken')
  await launch('corrupt-file'); assert.deepEqual(await ev('window.corral.getKeybindings()'), {}); await app.shot('corrupt-fallback'); await app.stop(); app = null
  fs.unlinkSync(path.join(data, 'keybindings.json'))
  await launch('missing-file'); assert.deepEqual(await ev('window.corral.getKeybindings()'), {}); await app.shot('missing-fallback')
  check('S4', await ev('window.corral.getKeybindings()'), o => Object.keys(o).length === 0)
} catch (error) {
  results.push({ id: 'run failed', pass: false, error: String(error) })
  throw error
} finally {
  fs.writeFileSync(path.join(RAW_DIR, 'ui-results.json'), JSON.stringify(results, null, 2))
  if (app) await app.stop()
}
