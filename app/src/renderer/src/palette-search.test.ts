import { expect, it } from 'vitest'
import { searchPalette, type PaletteEntry } from './palette-search.js'
const entries: PaletteEntry[] = [
  { id: 'terminal.new', title: '새 터미널', detail: '/repo/a', keywords: 'create shell', run() {} },
  { id: 'terminal', title: '터미널 전환', detail: '/repo/b', run() {} },
  { id: 'other', title: '새 에이전트', detail: '/repo/c', run() {} },
]
it('ranks exact then prefix then subsequence, stable across runs', () => {
  expect(searchPalette(entries, 'TERMINAL').map(row => row.id)).toEqual(['terminal', 'terminal.new'])
  expect(searchPalette(entries, 'tmnw').map(row => row.id)).toEqual(['terminal.new'])
  expect(searchPalette(entries, '새').map(row => row.id)).toEqual(['terminal.new', 'other'])
  expect(searchPalette(entries, 'shell')).toEqual([entries[0]])
  expect(searchPalette(entries, 'unmatched')).toEqual([])
  expect(searchPalette(entries, '  ')).toEqual(entries)
})
