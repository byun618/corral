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
  it.each([
    { unknown: [] },
    { 'terminal.split': ['Mod+K'] },
    { 'terminal.close': ['D'] },
    { 'terminal.close': ['Mod+D'] },
    { 'terminal.split': ['Mod+K', 'Mod+K'] },
  ])('discards only damaged entries while retaining unrelated overrides: %j', (bad) => {
    const { dir, file } = fixture()
    fs.writeFileSync(file, JSON.stringify({ 'sidebar.toggle': ['Mod+J'], ...bad }))
    const store = new KeybindingStore(dir); store.load()
    expect(store.get()).toEqual({ 'sidebar.toggle': ['Mod+J'] })
  })
  it('resolves fallback cascades and keeps valid swaps independent of file order', () => {
    const { dir, file } = fixture()
    const store = new KeybindingStore(dir)
    fs.writeFileSync(file, JSON.stringify({ 'sidebar.toggle': ['Mod+J'], 'terminal.close': ['Mod+D'], 'terminal.split': ['Mod+W', 'Mod+Shift+D'] }))
    store.load()
    expect(store.get()).toEqual({ 'sidebar.toggle': ['Mod+J'], 'terminal.close': ['Mod+D'], 'terminal.split': ['Mod+W', 'Mod+Shift+D'] })
    fs.writeFileSync(file, JSON.stringify({ 'sidebar.toggle': ['Mod+J'], 'terminal.close': ['Mod+K'], 'terminal.split': ['Mod+W', 'Mod+K'] }))
    store.load() // duplicate K drops close, restored W then drops split
    expect(store.get()).toEqual({ 'sidebar.toggle': ['Mod+J'] })
  })
  it('rejects unmodified saves without changing disk or memory', () => {
    const { dir, file } = fixture(); const store = new KeybindingStore(dir)
    store.save({ 'sidebar.toggle': ['Mod+J'] })
    const before = fs.readFileSync(file, 'utf8')
    for (const key of ['D', 'Tab', 'Enter']) {
      expect(() => store.save({ 'sidebar.toggle': [key] })).toThrow()
      expect(store.get()).toEqual({ 'sidebar.toggle': ['Mod+J'] })
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
    }
  })
  it('rejects conflicting saves without replacing prior file or memory', () => {
    const { dir, file } = fixture(); const store = new KeybindingStore(dir)
    store.save({ 'sidebar.toggle': ['Mod+J'] }); const before = fs.readFileSync(file, 'utf8')
    expect(() => store.save({ 'sidebar.toggle': ['Mod+D'] })).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(before); expect(store.get()).toEqual({ 'sidebar.toggle': ['Mod+J'] })
  })
})

describe('LIFE-495 K7ⓘ — 옛 모양 파일 픽스처(terminal.new 두 칸)', () => {
  it('파일을 읽으면 고친 조합이 새 칸으로 옮겨 실리고, 다른 재정의는 그대로다', () => {
    const { dir, file } = fixture()
    fs.writeFileSync(file, JSON.stringify({ 'terminal.new': ['Mod+J', 'Mod+Shift+T'], 'sidebar.toggle': ['Mod+Alt+B'] }))
    const store = new KeybindingStore(dir)
    store.load()
    expect(store.get()).toEqual({ 'terminal.new': ['Mod+J'], 'sidebar.toggle': ['Mod+Alt+B'] })
  })
})
