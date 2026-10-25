// LIFE-697 C6ⓐⓔ — 폴더만 남은 죽은 worktree 자리 줄의 배지·툴팁. 줄 모양은 main `orphanSources` 가 내는 것과 같다(`resource-ipc-697.test.ts`).
import { describe, expect, it } from 'vitest'
import type { ResourceOrphanRow } from '../../shared/resource.js'
import { ORPHAN_DEAD_SLOT, ORPHAN_OWNERLESS_TOOLTIP, orphanOwnerBadge, orphanTooltip } from './resource-view.js'

const DEAD = '/repo/.claude/worktrees/LIFE-608'
function row(paths: ResourceOrphanRow['paths']): ResourceOrphanRow {
  return { workspaceId: 'w1', label: 'w1', paths, ownerless: true, agents: ['claude'], stoppedAgents: [], paneIds: ['p1'], measure: { state: 'unavailable', reason: 'x' } }
}

describe('죽은 worktree 자리 사유 (C6)', () => {
  it('ⓐ 배지는 주인 없음, 배지 툴팁과 줄 툴팁에 「worktree 아님(폴더만 남음)」', () => {
    const dead = row([{ path: DEAD, exists: true, deadSlot: true }])
    expect(ORPHAN_DEAD_SLOT).toBe('worktree 아님(폴더만 남음)')
    expect(orphanOwnerBadge(dead)).toMatchObject({ kind: 'ownerless', text: '주인 없음' })
    expect(orphanOwnerBadge(dead)?.tooltip).toContain(ORPHAN_DEAD_SLOT)
    expect(orphanTooltip(dead)).toContain(`${DEAD} — worktree 아님(폴더만 남음)`)
  })
  it('ⓔ 기존 주인 없음(경로 사라짐·HOME)의 툴팁은 그대로', () => {
    const gone = row([{ path: '/gone/wt', exists: false }, { path: '/home', exists: true }])
    expect(orphanOwnerBadge(gone)?.tooltip).toBe(ORPHAN_OWNERLESS_TOOLTIP)
    expect(orphanTooltip(gone)).toBe('/gone/wt — 디렉터리 없음\n/home\npane 1개 · w1')
  })
})
