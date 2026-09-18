import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
process.env.LIFE353_SESSION ??= 'life373-codex-l389'
process.env.L353_RAW_DIR ??= path.resolve('../specs/LIFE-389-shortcut-system/raw/codex/fix1')
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
const recordVerified = (id, observation) => { results.push({ id, observation }); console.log('VERIFIED', id, JSON.stringify(observation)) }
const waitCount = async (selector, expected) => assert((await until(async () => await count(selector) === expected, { timeoutMs: 9000, what: selector })).ok, `${selector} count != ${expected}`)
try {
  await launch('edge-cases')
  const snapshot = () => ev(`({pane:document.querySelector('.term-pane.is-selected')?.dataset.termPaneBox, groups:[...document.querySelectorAll('[data-tab-group]')].map(g=>({id:g.dataset.tabGroup,active:g.classList.contains('is-active-group'),tabs:[...g.querySelectorAll('[data-main-tab]')].map(t=>({id:t.dataset.mainTab,cls:t.className}))}))})`)
  await click('[data-worktree="/private/tmp/l389-codex-repo"]')
  let panes = await count('[data-term-pane-box]')
  let tabs = await count('[data-main-tab]')
  const tab = await ev('document.querySelector("[data-main-tab].is-active")?.dataset.mainTab')
  const double = await app.send({cmd:'dblclick',selector:`[data-main-tab="${tab}"]`}); assert.equal(double.hit,true)
  await sleep(200)
  assert.equal(await ev('document.activeElement.classList.contains("is-editing")'),true)
  const guardKeys = [['D',['meta']],['D',['meta','shift']],['D',['meta','alt']],['Left',['meta','alt']],['W',['meta','alt']],['Z',['meta','shift']],['T',['meta']],['Tab',['control']],['W',['meta']],['B',['meta']]]
  const initial = await snapshot()
  for(const [code,modifiers] of guardKeys) await key(code,modifiers)
  assert.deepEqual(await snapshot(),initial)
  assert.equal(await count('[data-main-tab]'),tabs)
  assert.equal(await count('[data-mru]'),0)
  assert.equal(await count('[data-sidebar]'),1)
  assert.equal(await count('[data-term-pane-box]'),panes)
  await app.shot('rename-guard')
  await key('Escape')
  recordVerified('M3 rename', {guardKeys,initial,after:await snapshot()})
  await click('.sidebar-search input')
  await key('D',['meta']); await waitCount('[data-term-pane-box]',panes+1)
  recordVerified('M3 other input', 'Sidebar search keeps pane split shortcut active')
  // Actual terminal textarea focus for Ctrl+Tab; wrapping, blur and cross-worktree scope.
  await click('.term-pane.is-selected .xterm-screen')
  assert.equal(await ev('document.activeElement.classList.contains("xterm-helper-textarea")'),true)
  await key('Tab',['control'],'keyDown'); await waitCount('[data-mru]',1)
  const secondaryPane = (await app.state()).repos.flatMap(r=>r.worktrees).find(w=>w.path==='/private/tmp/l389-codex-secondary').workspace.tabs[0].panes[0].paneId
  const rows = await ev('[...document.querySelectorAll("[data-mru-row]")].map(el=>({pane:el.dataset.mruRow,text:el.textContent}))')
  assert(rows.some(row=>row.pane===secondaryPane))
  const first = await ev('document.querySelector("[data-mru-selected=true]").dataset.mruRow')
  for(let i=0;i<rows.length;i++) await key('Tab',['control'],'keyDown')
  assert.equal(await ev('document.querySelector("[data-mru-selected=true]").dataset.mruRow'),first)
  await app.shot('mru-global-wrap')
  await key('Escape')
  recordVerified('F3-1 F3-2 wrap F3-4 global', {terminalFocused:true,rows,first,wrappedTo:first})
  const beforeBlur = await snapshot()
  await ev("window.__l389Blur = null; window.addEventListener('blur', () => { window.__l389Blur = Date.now() }, {once:true})")
  const blurStart = Date.now()
  await key('Tab',['control'],'keyDown')
  // A second real Electron window takes OS focus; no synthetic DOM blur.
  const second = await startApp({name:'blur-other-window',registryFile:registry,extraArgs:['--user-data-dir=/tmp/l389-codex-blur-data'],env:{CORRAL_UI_PREFS:'/tmp/l389-codex-blur-data/ui-prefs.json'}})
  await waitCount('[data-mru]',0)
  assert.deepEqual(await snapshot(),beforeBlur)
  const nativeBlurAt = await ev('window.__l389Blur')
  assert(nativeBlurAt >= blurStart && nativeBlurAt - blurStart < 5000, 'native blur must precede 10-second timeout')
  await second.stop()
  recordVerified('F3-2 F3-3 F3-5 native blur', {beforeBlur,afterBlur:await snapshot(),nativeBlurLatencyMs:nativeBlurAt-blurStart})
  await key('Tab',['control'],'keyDown')
  const targetSelector = `[data-mru-row="${secondaryPane}"]`
  await click(targetSelector)
  await waitCount('[data-mru]',0)
  assert.equal((await snapshot()).pane,secondaryPane)
  await app.shot('mru-cross-worktree')
  recordVerified('F3-4 cross-worktree commit', await snapshot())
  await click('[data-worktree="/private/tmp/l389-codex-repo"]')
  // Native Cmd+W can be reassigned, and reset cannot silently introduce a collision.
  await click('[data-shortcuts-open]')
  await click('[data-record="terminal.close"]'); await key('Y',['meta']); await click('[data-save-binding]')
  await click('[data-record="sidebar.toggle"]'); await key('W',['meta']); await click('[data-save-binding]')
  assert.match(await ev(`document.querySelector('[data-hint-key="close-pane"]').textContent`), /⌘Y/)
  const saved = JSON.parse(fs.readFileSync(path.join(data,'keybindings.json'),'utf8'))
  assert.deepEqual(saved,{'terminal.close':['Mod+Y'],'sidebar.toggle':['Mod+W']})
  await click('[data-reset="terminal.close"]')
  assert.match((await app.query('[role="status"]')).found.join(' '),/충돌/)
  await app.shot('reset-conflict')
  await key('Escape')
  const total = (await app.state()).repos.flatMap(r=>r.worktrees).flatMap(w=>w.workspace?.tabs??[]).flatMap(t=>t.panes).length
  await key('W',['meta']); await waitCount('[data-sidebar]',0)
  assert.equal((await app.state()).repos.flatMap(r=>r.worktrees).flatMap(w=>w.workspace?.tabs??[]).flatMap(t=>t.panes).length,total)
  await key('W',['meta']); await waitCount('[data-sidebar]',1)
  recordVerified('M2 custom reassignment D4 reset collision', {saved,total})
  await key('Y',['meta']); await sleep(500)
  assert.equal((await app.state()).repos.flatMap(r=>r.worktrees).flatMap(w=>w.workspace?.tabs??[]).flatMap(t=>t.panes).length,total-1)
  recordVerified('D2 custom close dispatch', 'Cmd+Y closes active pane after Cmd+W moved to sidebar')
  await click('[data-shortcuts-open]'); await click('[data-reset="sidebar.toggle"]'); await click('[data-reset="terminal.close"]'); await key('Escape')
  // The last pane closes its tab while the Electron window stays alive.
  tabs = await count('[data-main-tab]')
  await key('T',['meta']); await waitCount('[data-main-tab]',tabs+1); await sleep(600)
  await key('W',['meta']); await waitCount('[data-main-tab]',tabs)
  recordVerified('G3 last-pane closes tab', {tabsBefore:tabs+1,tabsAfter:tabs,windowAlive:await count('[data-shortcuts-open]')})
  await key('T',['meta']); await waitCount('[data-main-tab]',tabs+1); await sleep(800)
  await click('.term-pane.is-selected .xterm-screen')
  const byteFile = '/tmp/l389-codex-ctrl-bytes.txt'
  const readyFile = `${byteFile}.ready`
  fs.rmSync(byteFile,{force:true}); fs.rmSync(readyFile,{force:true})
  await app.type(`python3 -c 'import os,termios,tty; f=0; old=termios.tcgetattr(f); tty.setraw(f); open("${readyFile}","w").write("ready"); a=os.read(f,1); b=os.read(f,1); termios.tcsetattr(f,termios.TCSADRAIN,old); open("${byteFile}","w").write(repr(a+b))'`)
  await key('Enter')
  assert((await until(()=>fs.existsSync(readyFile),{timeoutMs:10000})).ok, 'PTY raw reader must be ready before sending Ctrl+D/T')
  const paneCountBeforeCtrl = await count('[data-term-pane-box]')
  await key('D',['control']); await key('T',['control'])
  assert((await until(()=>fs.existsSync(byteFile),{timeoutMs:5000})).ok)
  const bytes = fs.readFileSync(byteFile,'utf8')
  assert.equal(bytes,"b'\\x04\\x14'")
  assert.equal(await count('[data-term-pane-box]'),paneCountBeforeCtrl)
  assert.equal(await count('[data-main-tab]'),tabs+1)
  recordVerified('Coordinator Mod clarification: PTY Ctrl+D Ctrl+T', {bytes,paneCountBeforeCtrl,tabs:tabs+1})
  await key('W',['meta']); await waitCount('[data-main-tab]',tabs)

  const width = await ev('document.querySelector("[data-sidebar]").getBoundingClientRect().width')
  assert.equal(width,393)
  await key('B',['meta']); await waitCount('[data-sidebar]',0)
  await app.stop(); app=null
  await launch('width-restart'); await waitCount('[data-sidebar]',0)
  await key('B',['meta']); await waitCount('[data-sidebar]',1)
  assert.equal(await ev('document.querySelector("[data-sidebar]").getBoundingClientRect().width'),width)
  await app.shot('custom-width-restored')
  recordVerified('sidebar custom width restart', {width})
} catch (error) {
  results.push({ id: 'run failed', error: String(error) })
  throw error
} finally {
  fs.writeFileSync(path.join(RAW_DIR,'edge-results.json'),JSON.stringify(results,null,2))
  if(app) await app.stop()
}
