// LIFE-593 E4·E8ⓓ — git 출력 → 목록(순수).
import { describe, expect, it } from 'vitest'
import { isSafeRel, mergeFileLists, parseStagedListing, underExcludedDir } from './file-list.js'

describe('isSafeRel', () => {
  it('루트 상대·빈 성분/./.. 없음·NUL 없음만', () => {
    for (const ok of ['a', 'a/b.ts', '.github/x', '-rf', '--help', '한글/파일.md', 'with space/x']) expect(isSafeRel(ok)).toBe(true)
    for (const bad of ['', '/abs', 'a/', 'a//b', './a', 'a/./b', '../a', 'a/..', 'a\0b']) expect(isSafeRel(bad)).toBe(false)
  })
})

describe('mergeFileLists', () => {
  it('지워진 추적 파일은 빼고, 끝이 / 인 항목(중첩 저장소)·중복은 버린다', () => {
    const merged = mergeFileLists({ listed: 'a.ts\0gone.ts\0nested/\0a.ts\0', deleted: 'gone.ts\0', ignored: null, max: 10 })
    expect(merged).toEqual({ files: ['a.ts'], truncated: false })
  })
  it('무시 파일은 .git·node_modules 아래를 뺀다', () => {
    const merged = mergeFileLists({ listed: 'a.ts\0', deleted: '', ignored: 'build/x.js\0node_modules/p/i.js\0deep/node_modules/q.js\0x/.git/HEAD\0node_modules\0', max: 10 })
    expect(merged.files).toEqual(['a.ts', 'build/x.js', 'node_modules'])
  })
  it('E7ⓓ 상한에 걸리면 앞 것만 주고 truncated', () => {
    expect(mergeFileLists({ listed: 'a\0b\0c\0', deleted: '', ignored: null, max: 2 })).toEqual({ files: ['a', 'b'], truncated: true })
  })
  it('underExcludedDir', () => {
    expect(underExcludedDir('node_modules/x')).toBe(true)
    expect(underExcludedDir('a/.git/x')).toBe(true)
    expect(underExcludedDir('node_modules')).toBe(false)
  })
})

describe('parseStagedListing (수정 r1 R1-C-05)', () => {
  it('skip-worktree(S)·gitlink(160000)는 빼고, 링크(120000)는 links 로도 낸다. untracked(?)는 그대로', () => {
    const out = ['? untr.ts', 'H 100644 4bcf 0\tdel.ts', 'H 120000 e831 0\tld', 'S 100644 b478 0\tsp.ts', 'H 160000 1111 0\tsub', 'H 100644 7898 0\tsrc/a b.ts', 'M 100644 aaaa 1\tconf.ts', 'M 100644 bbbb 2\tconf.ts', ''].join('\0')
    expect(parseStagedListing(out)).toEqual({ listed: ['untr.ts', 'del.ts', 'ld', 'src/a b.ts', 'conf.ts', 'conf.ts'].join('\0'), links: ['ld'] })
  })
})
