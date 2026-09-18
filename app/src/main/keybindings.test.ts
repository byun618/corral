import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KeybindingStore } from './keybindings.js'
const dirs: string[] = []
afterEach(() => { dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })); dirs.length = 0 })
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corral-keys-')); dirs.push(dir); return { dir, file: path.join(dir, 'keybindings.json') } }
describe('keybinding file', () => {
  it('persists flat overrides across new store instances and reset', () => {
    const { dir, file } = fixture(); const first = new KeybindingStore(dir); first.load()
    expect(first.get()).toEqual({})
    first.save({ 'sidebar.toggle': ['Mod+J'] })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ 'sidebar.toggle': ['Mod+J'] })
    const next = new KeybindingStore(dir); next.load(); expect(next.get()).toEqual(first.get())
    next.save({}); expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({})
    expect(fs.readdirSync(dir)).toEqual(['keybindings.json'])
  })
  it('falls back on syntax, shape, and collision corruption without crashing', () => {
    const { dir, file } = fixture()
    for (const content of ['{broken', 'null', '{"sidebar.toggle":["Mod+D"]}', '{"unknown":[]}', '{"terminal.split":["Mod+J"]}']) {
      fs.writeFileSync(file, content); const store = new KeybindingStore(dir); store.load(); expect(store.get()).toEqual({})
    }
  })
  it('rejects conflicting saves without replacing prior file or memory', () => {
    const { dir, file } = fixture(); const store = new KeybindingStore(dir)
    store.save({ 'sidebar.toggle': ['Mod+J'] }); const before = fs.readFileSync(file, 'utf8')
    expect(() => store.save({ 'sidebar.toggle': ['Mod+D'] })).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(before); expect(store.get()).toEqual({ 'sidebar.toggle': ['Mod+J'] })
  })
})
