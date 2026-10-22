// LIFE-689 K1·K2 — 파일 탭 같은 이름 구분(VS Code `workbench.editor.labelFormat: default`)의 순수 함수.
// 출처: microsoft/vscode 4df8bb183f0e — `src/vs/base/common/labels.ts` `shorten`(214–324행) · `src/vs/base/test/common/labels.test.ts` 'shorten - not windows'(72–128행)
// · `multiEditorTabsControl.ts` `shortenTabLabels`. 사본은 specs/LIFE-689-file-tab-label/raw/coordinator/vscode/.
import { describe, expect, it } from 'vitest'
import { fileTabDescriptions, shorten } from './file-tabs.js'

/**
 * labels.test.ts 'shorten - not windows' 74–115행 — URL 사례(116–127행)를 뺀 전 사례, 입력·기대값 그대로(`null!` → `null`).
 * 원문 줄에서 기계적으로 옮겼다(sed — 수작업 전사 없음).
 */
const VSCODE_NOT_WINDOWS: [(string | null)[], (string | null)[]][] = [
  [['a'], ['a']],
  [['a', 'b'], ['a', 'b']],
  [['/a', '/b'], ['/a', '/b']],
  [['~/a/b/c', '~/a/b/c'], ['~/a/b/c', '~/a/b/c']],
  [['a', 'b', 'c'], ['a', 'b', 'c']],
  [['a/b', 'c/d', 'e/f'], ['…/b', '…/d', '…/f']],
  [['a', 'a/b'], ['a', '…/b']],
  [['a/b', 'a/b/c'], ['…/b', '…/c']],
  [['a', 'a/b', 'a/b/c'], ['a', '…/b', '…/c']],
  [['/a/b', '/a/c'], ['/a/b', '/a/c']],
  [['a', 'b/a'], ['a', 'b/…']],
  [['a/b/c', 'd/b/c'], ['a/…', 'd/…']],
  [['a/b/c/d', 'f/b/c/d'], ['a/…', 'f/…']],
  [['d/e/a/b/c', 'd/b/c'], ['…/a/…', 'd/b/…']],
  [['a/b/c/d', 'a/f/b/c/d'], ['a/b/…', '…/f/…']],
  [['a/b/a', 'b/b/a'], ['a/b/…', 'b/b/…']],
  [['d/f/a/b/c', 'h/d/b/c'], ['…/a/…', 'h/…']],
  [['/x/b', '/y/b'], ['/x/…', '/y/…']],
  [['a/b', 'a/c', 'a/e-b'], ['…/b', '…/c', '…/e-b']],
  [['a/b/c', 'd/b/e'], ['…/c', '…/e']],
  [['a/b/c', 'd/b/C'], ['…/c', '…/C']],
  [['', null], ['./', null]],
  [['a', 'a/b', 'a/b/c', 'd/b/c', 'd/b'], ['a', 'a/b', 'a/b/c', 'd/b/c', 'd/b']],
  [['a', 'a/b', 'b'], ['a', 'a/b', 'b']],
  [['', 'a', 'b', 'b/c', 'a/c'], ['./', 'a', 'b', 'b/c', 'a/c']],
]

describe('K1 shorten — VS Code labels.test.ts not-windows (URL 제외)', () => {
  it.each(VSCODE_NOT_WINDOWS)('%j', (input, expected) => {
    expect(shorten(input)).toEqual(expected)
  })
  it('일감 예시 2개', () => {
    expect(shorten(['src/app', 'src/push'])).toEqual(['…/app', '…/push'])
    expect(shorten(['app', 'src/app'])).toEqual(['app', 'src/…'])
  })
})

const entries = (map: Map<string, string>): [string, string][] => [...map]

describe('K2 fileTabDescriptions — 한 영역의 파일 탭 → 탭별 설명 (L1–L3)', () => {
  it('ⓐ 이름이 안 겹치면 전부 없음', () => {
    expect(entries(fileTabDescriptions(['src/a.ts', 'src/b.ts', 'README.md']))).toEqual([])
  })
  it('ⓑ 같은 이름 두 탭 → 부모 폴더 shorten, 다른 이름 탭은 없음', () => {
    expect(entries(fileTabDescriptions(['src/app/app.service.ts', 'src/main.ts', 'src/push/app.service.ts']))).toEqual([
      ['src/app/app.service.ts', '…/app'],
      ['src/push/app.service.ts', '…/push'],
    ])
  })
  it('ⓑ′ 일감 예시 — app/x.ts · src/app/x.ts', () => {
    expect(entries(fileTabDescriptions(['app/x.ts', 'src/app/x.ts']))).toEqual([['app/x.ts', 'app'], ['src/app/x.ts', 'src/…']])
  })
  it('ⓒ 루트 파일 → ./', () => {
    expect(entries(fileTabDescriptions(['README.md', 'docs/README.md']))).toEqual([['README.md', './'], ['docs/README.md', 'docs']])
  })
  it('ⓓ 셋 이상 묶음 — 기대값은 VS Code shorten 원문 실행값(raw/claude/r1-vscode-shorten-expected.txt)', () => {
    expect(entries(fileTabDescriptions(['a/x.ts', 'b/x.ts', 'a/b/x.ts']))).toEqual([['a/x.ts', 'a'], ['b/x.ts', 'b'], ['a/b/x.ts', 'a/b']])
    expect(entries(fileTabDescriptions(['a/b/x.ts', 'c/b/x.ts', 'b/x.ts']))).toEqual([['a/b/x.ts', 'a/…'], ['c/b/x.ts', 'c/…'], ['b/x.ts', 'b']])
  })
  it('ⓔ 터미널 탭은 부르는 쪽이 빼고 넘긴다 — 파일 탭 rel 만으로 같은 결과', () => {
    // MainTabBar 는 영역 shown(터미널·파일 섞임)에서 파일 탭 rel 만 뽑아 넘긴다 — 섞인 목록의 DOM 계약은 MainTabBar.file-label.test.tsx
    const shown = [{ kind: 'terminal', id: 'w1:t1' }, { kind: 'file', id: 'src/app/app.service.ts' }, { kind: 'terminal', id: 'w1:t2' }, { kind: 'file', id: 'src/push/app.service.ts' }]
    const rels = shown.flatMap((item) => (item.kind === 'file' ? [item.id] : []))
    expect(entries(fileTabDescriptions(rels))).toEqual([['src/app/app.service.ts', '…/app'], ['src/push/app.service.ts', '…/push']])
  })
  it('ⓕ 겹침 묶음 둘이 동시에 — 묶음마다 따로 shorten', () => {
    expect(entries(fileTabDescriptions(['src/app/index.ts', 'lib/index.ts', 'src/app/app.service.ts', 'src/push/app.service.ts', 'only.ts']))).toEqual([
      ['src/app/index.ts', '…/app'],
      ['lib/index.ts', 'lib'],
      ['src/app/app.service.ts', '…/app'],
      ['src/push/app.service.ts', '…/push'],
    ])
  })
  it('L3 부모 폴더가 1종이면 없음 (같은 rel 이 둘 들어와도)', () => {
    expect(entries(fileTabDescriptions(['src/x.ts', 'src/x.ts']))).toEqual([])
  })
  it('L1 다른 영역은 따로 부른다 — 한 영역에 하나뿐이면 없음', () => {
    expect(entries(fileTabDescriptions(['src/app/app.service.ts']))).toEqual([])
    expect(entries(fileTabDescriptions(['src/push/app.service.ts', 'src/main.ts']))).toEqual([])
  })
})
