// LIFE-593 E2·E5ⓑ·E7ⓑ — ⌘P 퍼지 검색(순수). 규칙 + E2 질의 표(코디 고정 — 작업 commit fd1664c4d 의 corral 레포 트리).
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildFileIndex, matchTerm, narrows, QUICK_OPEN_LIMIT, queryTerms, searchFiles } from './quick-open-search.js'

const top = (files: string[], query: string, recent: string[] = []): string[] => searchFiles({ index: buildFileIndex(files), query, recent }).rows.map((row) => row.rel)

describe('E2ⓐ 규칙', () => {
  it('대소문자 무시 · 공백 단어 AND', () => {
    const files = ['src/FileTabs.ts', 'src/file.ts', 'src/tabs.ts']
    expect(top(files, 'FILETABS')).toEqual(['src/FileTabs.ts'])
    expect(top(files, 'file tabs')).toEqual(['src/FileTabs.ts'])
  })
  it('구분자 / 를 넣은 경로 일부 질의', () => {
    expect(top(['app/src/main/index.ts', 'app/src/renderer/index.ts', 'main.ts'], 'main/index')[0]).toBe('app/src/main/index.ts')
  })
  it('파일명 일치가 경로만 일치보다 위', () => {
    expect(top(['explorer/zzz.ts', 'src/explorer.ts'], 'explorer')).toEqual(['src/explorer.ts', 'explorer/zzz.ts'])
  })
  it('연속 일치가 흩어진 일치보다 위', () => {
    expect(top(['a/b_u_i_l_d.ts', 'a/build.ts'], 'build')).toEqual(['a/build.ts', 'a/b_u_i_l_d.ts'])
  })
  it('맞은 글자 위치(강조)를 돌려준다', () => {
    const row = searchFiles({ index: buildFileIndex(['src/explorer-fs.ts']), query: 'fs', recent: [] }).rows[0]
    expect(row?.positions).toEqual([13, 14])
    expect(row?.display.slice(13, 15)).toBe('fs')
  })
  it('matchTerm — 안 맞으면 null', () => {
    expect(matchTerm('src/a.ts', 4, 'zz')).toBeNull()
  })
})

describe('E2ⓒ 한글 NFC·NFD', () => {
  it('NFD 디스크 이름이 NFC 질의로, NFC 이름이 NFD 질의로 찾아진다 — 여는 경로는 원래 문자열', () => {
    const nfd = '문서/한글파일.md'.normalize('NFD')
    const nfc = '메모/한글메모.md'
    expect(top([nfd, 'x.ts'], '한글파일')).toEqual([nfd])
    expect(top([nfc, 'x.ts'], '한글메모'.normalize('NFD'))).toEqual([nfc])
  })
})

describe('E2ⓓ 표시 상한', () => {
  it(`${QUICK_OPEN_LIMIT}개를 넘으면 total 이 표시 수보다 크다(「더 있음」)`, () => {
    const files = Array.from({ length: 120 }, (_value, index) => `src/file${index}.ts`)
    const result = searchFiles({ index: buildFileIndex(files), query: 'file', recent: [] })
    expect(result.rows).toHaveLength(QUICK_OPEN_LIMIT)
    expect(result.total).toBe(120)
  })
})

describe('E5ⓑ 최근 연 파일 (Q6)', () => {
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'docs/a-guide.md']
  it('빈 입력 = 최근 순 → 경로 순, 목록에 없는 최근 파일은 보이지 않는다', () => {
    const rows = searchFiles({ index: buildFileIndex(files), query: '', recent: ['src/c.ts', 'gone.ts', 'src/a.ts'] }).rows
    expect(rows.map((row) => [row.rel, row.group])).toEqual([
      ['src/c.ts', 'recent'],
      ['src/a.ts', 'recent'],
      ['docs/a-guide.md', 'file'],
      ['src/b.ts', 'file'],
    ])
  })
  it('질의가 있으면 맞는 최근 파일이 최근 순으로 먼저, 나머지는 점수 순', () => {
    const rows = searchFiles({ index: buildFileIndex(files), query: 'a', recent: ['docs/a-guide.md', 'src/b.ts'] }).rows
    expect(rows[0]).toMatchObject({ rel: 'docs/a-guide.md', group: 'recent' })
    expect(rows.slice(1).every((row) => row.group === 'file')).toBe(true)
    expect(rows.map((row) => row.rel)).not.toContain('src/b.ts')
  })
})

describe('수정 r1 R1-C-02 — 최근 기록은 NFC 로 맞춘다', () => {
  it('목록은 디스크 이름(NFD)·최근 기록은 NFC(또는 반대)여도 같은 파일이 최근 묶음에 한 번', () => {
    const nfd = 'nfd/' + '노트'.normalize('NFD') + '.md'
    const index = buildFileIndex(['a.ts', nfd])
    for (const recent of [['nfd/노트.md'], [nfd]]) {
      const rows = searchFiles({ index, query: '', recent }).rows
      expect(rows.map((row) => [row.rel, row.group])).toEqual([
        [nfd, 'recent'],
        ['a.ts', 'file'],
      ])
      expect(searchFiles({ index, query: '노트', recent }).rows.map((row) => [row.rel, row.group])).toEqual([[nfd, 'recent']])
    }
  })
})

describe('E7ⓑ 좁혀 찾기', () => {
  it('narrows — 마지막 단어를 늘리거나 단어를 더하면 좁힘', () => {
    expect(narrows('exp', 'expl')).toBe(true)
    expect(narrows('exp', 'exp fs')).toBe(true)
    expect(narrows('expl', 'exp')).toBe(false)
    expect(narrows('a b', 'ab')).toBe(false)
    expect(narrows('', 'a')).toBe(false)
  })
  it('앞 결과로 좁혀 찾아도 처음부터 찾은 것과 같다', () => {
    const files = Array.from({ length: 2000 }, (_value, index) => `dir${index % 37}/name${index}_${(index * 7919) % 1000}.ts`)
    const index = buildFileIndex(files)
    let previous = null
    for (const query of ['n', 'na', 'nam', 'name1', 'name1 dir3']) {
      const narrowed = searchFiles({ index, query, recent: [], previous })
      const fresh = searchFiles({ index, query, recent: [] })
      expect(narrowed.rows.map((row) => row.rel)).toEqual(fresh.rows.map((row) => row.rel))
      expect(narrowed.total).toBe(fresh.total)
      previous = narrowed
    }
  })
  it('queryTerms', () => {
    expect(queryTerms('  Foo   bar ')).toEqual(['foo', 'bar'])
  })
})

// 코디 고정 질의 표(01-criteria 「E2 질의 표」) — 기준 트리는 게이트 ⓪ 승인 뒤 작업 브랜치 HEAD fd1664c4d. 그 commit 이 없는 체크아웃이면 건너뛴다.
const BASE = 'fd1664c4d'
const baseFiles = ((): string[] | null => {
  try {
    return execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', '--name-only', BASE], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter((rel) => rel !== '')
  } catch {
    return null
  }
})()
const TABLE: { id: string; query: string; expected: string; within: number }[] = [
  { id: 'q1', query: 'explorer-fs', expected: 'app/src/main/explorer-fs.ts', within: 3 },
  { id: 'q2', query: 'shared/keybindings', expected: 'app/src/shared/keybindings.ts', within: 1 },
  { id: 'q3', query: 'main/index', expected: 'app/src/main/index.ts', within: 3 },
  { id: 'q4', query: 'CommandPalette', expected: 'app/src/renderer/src/components/CommandPalette.tsx', within: 1 },
  { id: 'q5', query: 'cmdpal', expected: 'app/src/renderer/src/components/CommandPalette.tsx', within: 5 },
  { id: 'q6', query: 'AGENTS.md', expected: 'AGENTS.md', within: 3 },
  { id: 'q7', query: 'file tabs', expected: 'app/src/renderer/src/file-tabs.ts', within: 3 },
  { id: 'q8', query: 'uiprefs', expected: 'app/src/main/ui-prefs.ts', within: 5 },
  { id: 'q9', query: 'Explorer.tsx', expected: 'app/src/renderer/src/components/Explorer.tsx', within: 1 },
  { id: 'q10', query: 'electron-builder', expected: 'app/electron-builder.yml', within: 3 },
  { id: 'q11', query: '00-project', expected: 'specs/00-project.md', within: 2 },
  { id: 'q12', query: 'EXPLORER-FS', expected: 'app/src/main/explorer-fs.ts', within: 3 },
]
// 수정 r1 R1-C-11 — 기준 commit 이 없는 체크아웃에서 조용히 건너뛰지 않는다: 실패로 알린다. 일부러 건너뛸 때만 L593_ALLOW_NO_E2_TABLE=1(사유를 크게 남긴다).
describe(`E2ⓑ 질의 표 (corral 레포 ${BASE})`, () => {
  if (baseFiles === null) {
    if (process.env.L593_ALLOW_NO_E2_TABLE === '1') {
      console.warn(`[E2ⓑ 건너뜀] 기준 commit ${BASE} 이 이 체크아웃에 없다 — L593_ALLOW_NO_E2_TABLE=1 로 건너뛴다. 판정 회차로 세지 않는다.`)
      it.skip(`기준 commit ${BASE} 없음 — 건너뜀(L593_ALLOW_NO_E2_TABLE=1)`, () => undefined)
    } else
      it(`기준 commit ${BASE} 이 있어야 한다`, () => {
        throw new Error(`E2ⓑ 질의 표의 기준 트리 ${BASE} 를 읽지 못했다 — 작업 브랜치를 fetch 하거나(L593_ALLOW_NO_E2_TABLE=1 로만 건너뛴다)`)
      })
    return
  }
  const index = buildFileIndex(baseFiles)
  for (const row of TABLE) {
    it(`${row.id} ${row.query} → ${row.expected} 상위 ${row.within}`, () => {
      const rels = searchFiles({ index, query: row.query, recent: [] }).rows.map((item) => item.rel)
      expect(rels.slice(0, row.within)).toContain(row.expected)
    })
  }
})
