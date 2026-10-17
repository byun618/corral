// LIFE-592 수정 r1 R1-D — 감시 push 붙잡기: 붙잡은 동안 온 외부 변경을 버리지 않고 풀 때 돌려준다.
import { describe, expect, it } from 'vitest'
import { createWatchHold, forgetMissing } from './watch-hold.js'

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

describe('R2-I 겹친 붙잡기 — 해제 순서와 무관하게 경로별 가장 늦게 받은 push', () => {
  const setup = () => {
    const watch = createWatchHold()
    const older = watch.hold({ root: '/wt', prefixes: ['a.txt'] })
    expect(watch.intercept(push('a.txt', 'old'))).toBe(true)
    const newer = watch.hold({ root: '/wt', prefixes: ['a.txt'] })
    expect(watch.intercept(push('a.txt', 'new'))).toBe(true)
    return { older, newer }
  }
  it('오래된 것부터 풀기 → 마지막에 최신(new)', () => {
    const { older, newer } = setup()
    expect(older()).toEqual([])
    expect(newer()).toEqual([push('a.txt', 'new')])
  })
  it('새것부터 풀기 → 마지막에 최신(new)', () => {
    const { older, newer } = setup()
    expect(newer()).toEqual([])
    expect(older()).toEqual([push('a.txt', 'new')])
  })
  it('넓은 붙잡기가 먼저 풀려도 이미 반영한 최신보다 옛 push 를 다시 내지 않는다', () => {
    const watch = createWatchHold()
    const wide = watch.hold({ root: '/wt', prefixes: ['dir'] })
    expect(watch.intercept(push('dir/a.txt', 'old'))).toBe(true)
    const narrow = watch.hold({ root: '/wt', prefixes: ['dir/a.txt'] })
    expect(watch.intercept(push('dir/a.txt', 'new'))).toBe(true)
    expect(narrow()).toEqual([])
    expect(wide()).toEqual([push('dir/a.txt', 'new')])
  })
})

describe('D2 — 앱이 옮겨 오는 도착 경로의 낡은 「없음」 감시 상태(최종 관문 수정 E4ⓒ)', () => {
  const state = (entries: [string, boolean][]) => new Map(entries.map(([key, exists]) => [key, { exists, stamp: exists ? 's' : null }]))
  const missing = (map: ReadonlyMap<string, { exists: boolean }>, key: string) => map.get(key)?.exists === false
  it('직전 회에 옮겨 간 경로(a3 없음)로 다시 옮겨 오면 그 「없음」 을 지운다 — 탭이 새 경로로 재지정돼도 「삭제됨」 이 아니다', () => {
    const before = state([['/wt\0docs/l592-a3.ts', false], ['/wt\0docs/l592-a2.ts', true]])
    expect(missing(before, '/wt\0docs/l592-a3.ts')).toBe(true)
    const after = forgetMissing(before, { root: '/wt', prefixes: ['docs/l592-a3.ts'] })
    expect(missing(after, '/wt\0docs/l592-a3.ts')).toBe(false)
    expect(after.get('/wt\0docs/l592-a2.ts')).toEqual({ exists: true, stamp: 's' })
  })
  it('도착 폴더 밑의 「없음」 도 지운다 · 다른 경로·다른 worktree·있음 상태는 그대로 · 지울 것이 없으면 같은 Map', () => {
    const before = state([['/wt\0dir/x.ts', false], ['/wt\0dir2/x.ts', false], ['/other\0dir/x.ts', false], ['/wt\0dir/y.ts', true]])
    const after = forgetMissing(before, { root: '/wt', prefixes: ['dir'] })
    expect([...after.keys()].sort()).toEqual(['/other\0dir/x.ts', '/wt\0dir/y.ts', '/wt\0dir2/x.ts'])
    expect(forgetMissing(after, { root: '/wt', prefixes: ['dir'] })).toBe(after)
  })
  it('양성 대조 — 지운 뒤 그 경로가 진짜로 지워지면 감시 push(없음)가 다시 「없음」 을 단다', () => {
    const watch = createWatchHold()
    const after = new Map(forgetMissing(state([['/wt\0a3.ts', false]]), { root: '/wt', prefixes: ['a3.ts'] }))
    const gone = { root: '/wt', rel: 'a3.ts', exists: false, stamp: null }
    expect(watch.intercept(gone)).toBe(false)
    after.set(`${gone.root}\0${gone.rel}`, { exists: gone.exists, stamp: gone.stamp })
    expect(missing(after, '/wt\0a3.ts')).toBe(true)
  })
})
