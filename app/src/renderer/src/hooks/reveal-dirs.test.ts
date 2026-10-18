// LIFE-590 E6ⓐⓓ — auto reveal 이 펼칠 조상 폴더 · 숨김 경로(`.git`·`node_modules` — F1 항상 숨김)는 reveal 하지 않는다.
import { describe, expect, it } from 'vitest'
import { revealDirs } from './useExplorer.js'

describe('E6 revealDirs', () => {
  it('조상 폴더를 바깥부터', () => {
    expect(revealDirs('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(revealDirs('top.md')).toEqual([])
  })
  it('항상 숨김 이름을 지나면 null(reveal 안 함)', () => {
    expect(revealDirs('node_modules/x/index.js')).toBeNull()
    expect(revealDirs('pkg/node_modules/x.js')).toBeNull()
    expect(revealDirs('.git/config')).toBeNull()
  })
  it('빈·`..`·빈 성분은 null', () => {
    expect(revealDirs('')).toBeNull()
    expect(revealDirs('../x')).toBeNull()
    expect(revealDirs('a//b')).toBeNull()
  })
})
