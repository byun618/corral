// LIFE-589 E2ⓖ — Seti 아이콘 찾기 순서(VS Code 와 같다): 파일 이름 → 긴 확장자부터 → 언어 id → 기본.
import { describe, expect, it } from 'vitest'
import { extensionCandidates, glyphOf, readSetiTheme, setiGlyph, setiIconId } from './seti-icons.js'

const theme = readSetiTheme(
  {
    iconDefinitions: { _ts: { fontCharacter: '\\E099', fontColor: '#519aba' }, _karma: { fontCharacter: '\\E05C' }, _test: { fontCharacter: '\\E0A0' }, _json: { fontCharacter: '\\E060' }, _default: { fontCharacter: '\\E023' } },
    fileNames: { 'karma.conf.js': '_karma' },
    fileExtensions: { 'test.ts': '_test' },
    languageIds: { typescript: '_ts', jsonc: '_json' },
    file: '_default',
  },
  { extensions: { ts: 'typescript' }, filenames: { 'settings.json': 'jsonc' } },
)

describe('E2ⓖ Seti 찾기', () => {
  it('확장자 후보는 긴 것부터, 점 파일의 첫 점은 경계가 아니다', () => {
    expect(extensionCandidates('a.test.ts')).toEqual(['test.ts', 'ts'])
    expect(extensionCandidates('.eslintrc.json')).toEqual(['json'])
    expect(extensionCandidates('.env')).toEqual([])
  })
  it('파일 이름 → 긴 확장자 → 언어 → 기본', () => {
    expect(setiIconId(theme, 'Karma.conf.js')).toBe('_karma')
    expect(setiIconId(theme, 'a.test.ts')).toBe('_test')
    expect(setiIconId(theme, 'a.ts')).toBe('_ts')
    expect(setiIconId(theme, 'settings.json')).toBe('_json')
    expect(setiIconId(theme, 'README')).toBe('_default')
  })
  it('글리프 코드 — `\\E099` → U+E099', () => {
    expect(glyphOf('\\E099')).toBe('\u{E099}')
    expect(glyphOf('E099')).toBeNull()
  })
  it('실제 VS Code 테마 — .ts 는 파랑 TypeScript 글리프', () => {
    expect(setiGlyph('index.ts')).toEqual({ char: '\u{E099}', color: '#519aba' })
  })
})
