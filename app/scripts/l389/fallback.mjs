import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
process.env.LIFE353_SESSION ??= 'life373-codex-l389'
process.env.L353_RAW_DIR ??= path.resolve('../specs/LIFE-389-shortcut-system/raw/codex/fix1')
const { startApp, sleep, until, RAW_DIR } = await import('../l353/lib.mjs')
const data = '/tmp/l389-codex-fallback-data'
fs.mkdirSync(data, { recursive: true })
const registry = path.join(data, 'repos.json')
fs.writeFileSync(registry, JSON.stringify({ version: 1, repos: ['/private/tmp/l389-codex-repo'] }))
const file = path.join(data, 'keybindings.json')
const input = { 'sidebar.toggle': ['Mod+J'], unknown: [], 'terminal.split': ['Mod+K'], 'terminal.close': ['Mod+D'], 'mru.open': ['Tab', 'Enter'] }
fs.writeFileSync(file, JSON.stringify(input, null, 2))
fs.copyFileSync(file, path.join(RAW_DIR, 'partial-corruption-input.json'))
let app
try {
  app = await startApp({ name: 'partial-corruption', registryFile: registry, extraArgs: [`--user-data-dir=${data}`], env: { CORRAL_UI_PREFS: path.join(data, 'ui-prefs.json') } })
  assert(app.ready)
  assert((await until(async () => (await app.query('[data-shortcuts-open]')).found.length === 1)).ok)
  const ev = async code => (await app.send({ cmd: 'eval', code })).result
  const loaded = await ev('window.corral.getKeybindings()')
  assert.deepEqual(loaded, { 'sidebar.toggle': ['Mod+J'] })
  console.log('PASS partial file recovery', JSON.stringify({ input, loaded }))
  const before = fs.readFileSync(file, 'utf8')
  for (const key of ['D', 'Tab', 'Enter']) {
    const rejected = await ev(`window.corral.saveKeybindings({'sidebar.toggle':[${JSON.stringify(key)}]})`)
    assert.equal(rejected.ok, false)
    assert.deepEqual(await ev('window.corral.getKeybindings()'), loaded)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    console.log('PASS invalid IPC save preserved file and memory', key, JSON.stringify(rejected))
  }
  await app.send({ cmd: 'key', keyCode: 'J', modifiers: ['meta'] })
  await sleep(250)
  assert.equal((await app.query('[data-sidebar]')).found.length, 0)
  await app.shot('valid-override-survives-corrupt-peers')
  console.log('PASS retained custom Cmd+J hides sidebar after restart')
} finally { if (app) await app.stop() }
