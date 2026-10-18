// LIFE-589 E5 — porcelain v2 -z 파싱·폴더 우선순위·ignored 판정. 입력은 fixture 레포에서 뜬 실제 출력 모양(raw/claude/r0-dev).
import { describe, expect, it } from 'vitest'
import { folderMarks, isIgnoredPath, parsePorcelainV2 } from './explorer-git.js'

const SAMPLE = [
  '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 19d9cc8584ac2c7dcf57d2680375e80f099dc481 lib/added.ts',
  '2 R. N... 100644 100644 100644 4286f428e3b19fe84de503916ce0e7dc8deefea1 4286f428e3b19fe84de503916ce0e7dc8deefea1 R100 lib/renamed.txt',
  'lib/rename-me.txt',
  '1 .M N... 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 78981922613b2afb6025042ff6bd878ac1994e85 src/a.ts',
  '1 .D N... 100644 100644 000000 78981922613b2afb6025042ff6bd878ac1994e85 78981922613b2afb6025042ff6bd878ac1994e85 src/b.ts',
  'u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 src/conflict with space.ts',
  '? src/untracked.ts',
  '! debug.log',
  '! ignored-dir/',
  '',
].join('\0')

describe('E5ⓐ porcelain v2 -z', () => {
  const snapshot = parsePorcelainV2(SAMPLE)
  it('상태 글자 — 수정·추가·이름 바뀜(새 경로)·삭제·충돌·추적 안 함', () => {
    expect(Object.fromEntries(snapshot.marks)).toEqual({
      'lib/added.ts': 'A',
      'lib/renamed.txt': 'R',
      'src/a.ts': 'M',
      'src/b.ts': 'D',
      'src/conflict with space.ts': '!',
      'src/untracked.ts': 'U',
    })
  })
  it('이름 바뀜의 원래 경로 칸을 경로로 읽지 않는다', () => {
    expect(snapshot.marks.has('lib/rename-me.txt')).toBe(false)
  })
  it('ignored — 폴더는 끝 / 를 뗀다', () => {
    expect([...snapshot.ignored].sort()).toEqual(['debug.log', 'ignored-dir'])
  })
  it('인덱스·작업 트리 둘 다 바뀌면 작업 트리 쪽', () => {
    const both = parsePorcelainV2('1 AM N... 000000 100644 100644 0 0 x.ts\0')
    expect(both.marks.get('x.ts')).toBe('M')
  })
})

describe('E5ⓑ 폴더 전파 — 우선순위 충돌 > 수정 > 이름 바뀜 > 추가 > 추적 안 함, 삭제·ignored 는 전파 안 함', () => {
  it('하위 최고 우선순위', () => {
    const folders = folderMarks(parsePorcelainV2(SAMPLE).marks)
    expect(folders.get('src')).toBe('!')
    expect(folders.get('lib')).toBe('R')
  })
  it('삭제만 있는 폴더는 색이 없다(VS Code propagate = !DELETED)', () => {
    const folders = folderMarks(new Map([['gone/x.ts', 'D']]))
    expect(folders.has('gone')).toBe(false)
  })
  it('깊은 경로는 조상 전부에 오른다', () => {
    const folders = folderMarks(new Map([['a/b/c/d.ts', 'U'], ['a/x.ts', 'M']]))
    expect(Object.fromEntries(folders)).toEqual({ 'a/b/c': 'U', 'a/b': 'U', a: 'M' })
  })
})

describe('E2ⓓ ignored 판정', () => {
  const ignored = new Set(['ignored-dir', 'debug.log'])
  it('자신 또는 조상이 ignored', () => {
    expect(isIgnoredPath(ignored, 'ignored-dir/deep/i.txt')).toBe(true)
    expect(isIgnoredPath(ignored, 'debug.log')).toBe(true)
    expect(isIgnoredPath(ignored, 'ignored-dirx/a')).toBe(false)
    expect(isIgnoredPath(ignored, '')).toBe(false)
  })
})
