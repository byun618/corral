// LIFE-683 fix r1 R1-05 — 허브 git push 의 소스 제어 몫은 상한 + 1 개까지만 싣고 전체 개수를 따로 싣는다(탐색기 `git` 은 그대로 전량).
import { describe, expect, it } from 'vitest'
import { scmPushOf } from './explorer-hub.js'
import { SCM_STATUS_LIMIT, type ScmChange } from '../shared/scm.js'

const many = (count: number): ScmChange[] => Array.from({ length: count }, (_value, index) => ({ group: 'workingTree', status: 'UNTRACKED', rel: `u${index}`, orig: null }))

describe('scmPushOf', () => {
  it('상한 넘으면 상한 + 1 개 + 전체 개수, 안 넘으면 그대로, 오류(null)면 칸 없음', () => {
    const big = scmPushOf(many(SCM_STATUS_LIMIT + 500))
    expect(big.changes).toHaveLength(SCM_STATUS_LIMIT + 1)
    expect(big.changesTotal).toBe(SCM_STATUS_LIMIT + 500)
    expect(scmPushOf(many(3))).toEqual({ changes: many(3), changesTotal: 3 })
    expect(scmPushOf(null)).toEqual({})
  })
})
