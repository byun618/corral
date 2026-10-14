// LIFE-592 수정 r1 R1-D — 감시 push 붙잡기: 붙잡은 동안 온 외부 변경을 버리지 않고 풀 때 돌려준다.
import { describe, expect, it } from 'vitest'
import { createWatchHold } from './watch-hold.js'

const push = (rel: string, stamp: string | null, root = '/wt') => ({ root, rel, exists: stamp !== null, stamp })

describe('watch hold', () => {
  it('붙잡은 경로의 push 는 들고, 풀 때 경로별 마지막 것만 돌려준다 — 밖 경로·다른 worktree 는 그대로 통과', () => {
    const watch = createWatchHold()
    const release = watch.hold({ root: '/wt', prefixes: ['a.txt', 'b.txt'] })
    expect(watch.intercept(push('a.txt', null))).toBe(true)
    expect(watch.intercept(push('b.txt', 's1'))).toBe(true)
    expect(watch.intercept(push('b.txt', 's2'))).toBe(true)
    expect(watch.intercept(push('c.txt', 's1'))).toBe(false)
    expect(watch.intercept(push('b.txt', 's1', '/other'))).toBe(false)
    expect(release()).toEqual([push('a.txt', null), push('b.txt', 's2')])
    expect(watch.intercept(push('b.txt', 's3'))).toBe(false)
  })
  it('폴더 접두사 — 그 밑 경로도 붙잡는다', () => {
    const watch = createWatchHold()
    watch.hold({ root: '/wt', prefixes: ['src'] })
    expect(watch.intercept(push('src/x.ts', 's'))).toBe(true)
    expect(watch.intercept(push('src2/x.ts', 's'))).toBe(false)
  })
  it('겹친 붙잡기 — 먼저 푼 쪽의 push 는 아직 쥔 쪽으로 넘어가고, 마지막에 풀 때 나온다', () => {
    const watch = createWatchHold()
    const first = watch.hold({ root: '/wt', prefixes: ['a.txt'] })
    const second = watch.hold({ root: '/wt', prefixes: ['a.txt'] })
    expect(watch.intercept(push('a.txt', 's1'))).toBe(true)
    expect(second()).toEqual([])
    expect(watch.intercept(push('a.txt', 's2'))).toBe(true)
    expect(first()).toEqual([push('a.txt', 's2')])
  })
})
