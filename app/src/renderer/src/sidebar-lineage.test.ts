// 사이드바 계보 중첩 단위 시험 (LIFE-576 K1ⓐⓑⓒⓓⓕ · K2ⓒⓔ · K3ⓐⓔ · K4ⓑ) — 구획 덩어리·상위 지정 기하·덩어리 이동.
// 끌기 hook 쪽은 `hooks/useSidebarReorder.lineage.test.mjs`, 카드 그리기는 `components/WorktreeBlock.lineage.test.tsx`.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SIDEBAR_VIEW, type SidebarView } from '../../shared/sidebar-view.js'
import type { RepoRow, WorktreeRow } from '../../shared/types.js'
import { applyWorktreeMove, EMPTY_MANUAL_ORDER, moveBlock } from './manual-order.js'
import { buildInsertionPreview, isLineageDropZoneHit, resolveLineageTarget, unitSlotToFlat } from './sidebar-reorder.js'
import {
  buildSidebarSections,
  collapsedAncestors,
  hasValidLineage,
  LINEAGE_CARD_MIN_WIDTH_PX,
  lineageCycleMembers,
  lineageIndent,
  nestSectionItems,
  sectionKey,
  type LineageUnit,
  type SidebarSection,
  type SortItem,
} from './sidebar-sections.js'

const GIT = { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }

function wt(input: { path: string; parent?: string; linked?: boolean; branch?: string }): WorktreeRow {
  const branch = input.branch ?? input.path.split('/').pop() ?? 'main'
  return {
    path: input.path,
    branch,
    isLinked: input.linked ?? true,
    head: null,
    repoName: 'repo',
    openWorkspaceId: null,
    workspace: null,
    gitStatus: { ...GIT, branch },
    displayName: null,
    comment: null,
    parentPath: input.parent ?? null,
  }
}

function repo(root: string, worktrees: WorktreeRow[]): RepoRow {
  return { root, name: root.split('/').pop() ?? root, error: null, worktrees }
}

const item = (repoRoot: string, worktree: WorktreeRow): SortItem => ({ repoRoot, repoName: repoRoot, worktree })
const items = (repoRoot: string, rows: WorktreeRow[]): SortItem[] => rows.map((row) => item(repoRoot, row))

/** 덩어리를 읽기 쉬운 모양으로 — `경로@깊이(직계 자식 수)`. */
function shape(units: readonly LineageUnit[]): string[][] {
  return units.map((unit) => [unit.root, ...unit.descendants].map((row) => `${row.item.worktree.path}@${row.depth}(${row.childCount}${row.collapsed ? ',접힘' : ''})`))
}

const NONE: ReadonlySet<string> = new Set()
const view = (patch: Partial<SidebarView> = {}): SidebarView => ({ ...DEFAULT_SIDEBAR_VIEW, ...patch })
const sectionUnits = (sections: readonly SidebarSection[], key: string): string[][] =>
  shape(nestSectionItems({ items: sections.find((section) => sectionKey(section) === key)?.items ?? [], collapsed: NONE }))

describe('K1ⓐⓑ 같은 구획·같은 레포 부모 아래 중첩 — Orca `appendWorktreeRows`', () => {
  it('코디 → 구현·리뷰 2단: 부모 덩어리 안에 직계 자식, 「N 하위」 N = 직계 자식 수', () => {
    const rows = [wt({ path: '/r', linked: false }), wt({ path: '/r/coord' }), wt({ path: '/r/impl', parent: '/r/coord' }), wt({ path: '/r/review', parent: '/r/coord' })]
    expect(shape(nestSectionItems({ items: items('/r', rows), collapsed: NONE }))).toEqual([['/r@0(0)'], ['/r/coord@0(2)', '/r/impl@1(0)', '/r/review@1(0)']])
  })

  it('자식이 부모보다 앞 순서여도 부모 자리로 간다 · 자식끼리는 구획 순서 그대로', () => {
    const rows = [wt({ path: '/r/b', parent: '/r/p' }), wt({ path: '/r/x' }), wt({ path: '/r/a', parent: '/r/p' }), wt({ path: '/r/p' })]
    expect(shape(nestSectionItems({ items: items('/r', rows), collapsed: NONE }))).toEqual([['/r/x@0(0)'], ['/r/p@0(2)', '/r/b@1(0)', '/r/a@1(0)']])
  })

  it('다단계 — 깊이 우선, 단계마다 깊이 +1 (N 은 직계만 센다)', () => {
    const rows = [wt({ path: '/r/p' }), wt({ path: '/r/c1', parent: '/r/p' }), wt({ path: '/r/g1', parent: '/r/c1' }), wt({ path: '/r/c2', parent: '/r/p' })]
    expect(shape(nestSectionItems({ items: items('/r', rows), collapsed: NONE }))).toEqual([['/r/p@0(2)', '/r/c1@1(1)', '/r/g1@2(0)', '/r/c2@1(0)']])
  })

  it('깊이 상한 없음(O7) — 200단 사슬도 재귀 없이 모두 그린다', () => {
    const rows = Array.from({ length: 200 }, (_, index) => wt({ path: `/r/n${index}`, parent: index === 0 ? undefined : `/r/n${index - 1}` }))
    const units = nestSectionItems({ items: items('/r', rows), collapsed: NONE })
    expect(units).toHaveLength(1)
    expect(units[0]?.descendants).toHaveLength(199)
    expect(units[0]?.descendants.at(-1)?.depth).toBe(199)
  })
})

describe('K1ⓒ 중첩 판정 = Orca (수정 r1 M1 · 수정 r2 R1-A 같은 레포 간선만) — buildSidebarSections 와 함께', () => {
  const repos = [
    repo('/r', [wt({ path: '/r', linked: false }), wt({ path: '/r/coord' }), wt({ path: '/r/impl', parent: '/r/coord' }), wt({ path: '/r/x', parent: '/s/other' })]),
    repo('/s', [wt({ path: '/s', linked: false }), wt({ path: '/s/other' }), wt({ path: '/s/y', parent: '/r/coord' })]),
  ]

  it('같은 레포 부모 = 중첩, 다른 레포 부모(Project 그룹 = 다른 구획) = 평소 자리', () => {
    const sections = buildSidebarSections({ repos, view: view(), order: EMPTY_MANUAL_ORDER, now: 0 })
    expect(sectionUnits(sections, '/r')).toEqual([['/r@0(0)'], ['/r/coord@0(1)', '/r/impl@1(0)'], ['/r/x@0(0)']])
    expect(sectionUnits(sections, '/s')).toEqual([['/s@0(0)'], ['/s/other@0(0)'], ['/s/y@0(0)']])
  })

  it('R1-A Group by None — 다른 레포 부모는 같은 구획에 보여도 중첩 안 함(Orca `sharesWorktreeLineageBoundary` repoId 동일)', () => {
    const sections = buildSidebarSections({ repos, view: view({ groupBy: 'none' }), order: EMPTY_MANUAL_ORDER, now: 0 })
    const units = sectionUnits(sections, '*all')
    expect(units).toContainEqual(['/r/coord@0(1)', '/r/impl@1(0)'])
    expect(units).toContainEqual(['/s/other@0(0)'])
    expect(units).toContainEqual(['/r/x@0(0)'])
    expect(units).toContainEqual(['/s/y@0(0)'])
  })

  it('M1 고정한 부모 — 후손이 Pinned 구획으로 함께 올라가 그 안에 중첩, 원래 구획에서는 빠진다', () => {
    const sections = buildSidebarSections({ repos, view: view(), order: EMPTY_MANUAL_ORDER, now: 0, pinned: new Set(['/r/coord']) })
    // /s/y 는 /r/coord 를 가리키지만 다른 레포 — 유효 간선이 아니라 올라가지 않는다(R1-A).
    expect(sectionUnits(sections, '*pinned')).toEqual([['/r/coord@0(1)', '/r/impl@1(0)']])
    expect(sectionUnits(sections, '/r')).toEqual([['/r@0(0)'], ['/r/x@0(0)']])
    expect(sectionUnits(sections, '/s')).toEqual([['/s@0(0)'], ['/s/other@0(0)'], ['/s/y@0(0)']])
  })

  it('M1 고정 해제 = 후손이 원래 구획으로 돌아간다', () => {
    const sections = buildSidebarSections({ repos, view: view(), order: EMPTY_MANUAL_ORDER, now: 0, pinned: new Set() })
    expect(sections.some((section) => section.kind === 'pinned')).toBe(false)
    expect(sectionUnits(sections, '/r')).toEqual([['/r@0(0)'], ['/r/coord@0(1)', '/r/impl@1(0)'], ['/r/x@0(0)']])
  })

  it('M1 손자까지 따라 내려가고, 필터로 가려진 중간 카드도 길로는 지나간다(가려진 카드 자신은 안 올라감)', () => {
    const deep = [repo('/r', [wt({ path: '/r', linked: false }), wt({ path: '/r/p' }), wt({ path: '/r/mid', parent: '/r/p', branch: '' }), wt({ path: '/r/leaf', parent: '/r/mid' })])]
    const detachedMid = [{ ...deep[0]!, worktrees: deep[0]!.worktrees.map((row) => (row.path === '/r/mid' ? { ...row, branch: null, head: 'abcdef0123456789' } : row)) }]
    const shown = buildSidebarSections({ repos: detachedMid, view: view(), order: EMPTY_MANUAL_ORDER, now: 0, pinned: new Set(['/r/p']) })
    expect(sectionUnits(shown, '*pinned')).toEqual([['/r/p@0(1)', '/r/mid@1(1)', '/r/leaf@2(0)']])
    const hidden = buildSidebarSections({ repos: detachedMid, view: view({ hideDetachedHead: true }), order: EMPTY_MANUAL_ORDER, now: 0, pinned: new Set(['/r/p']) })
    // mid 가 가려져 leaf 는 Pinned 구획에서 부모가 안 보인다 → 루트로(칩).
    expect(sectionUnits(hidden, '*pinned')).toEqual(expect.arrayContaining([['/r/p@0(0)'], ['/r/leaf@0(0)']]))
    expect(sectionUnits(hidden, '*pinned')).toHaveLength(2)
    expect(sectionUnits(hidden, '/r')).toEqual([['/r@0(0)']])
  })

  it('M1 가려진 고정 카드는 출발점이 아니다 — 후손은 원래 구획(Orca 는 보이는 목록에서 고정을 고른다)', () => {
    const withMainParent = [repo('/r', [wt({ path: '/r', linked: false }), wt({ path: '/r/k', parent: '/r' })])]
    const sections = buildSidebarSections({ repos: withMainParent, view: view({ hideDefaultBranch: true }), order: EMPTY_MANUAL_ORDER, now: 0, pinned: new Set(['/r']) })
    expect(sections.some((section) => section.kind === 'pinned')).toBe(false)
    expect(sectionUnits(sections, '/r')).toEqual([['/r/k@0(0)']])
  })

  it('부모와 자식을 다 고정해도 같다(Pinned 구획 안 중첩)', () => {
    const sections = buildSidebarSections({ repos, view: view(), order: EMPTY_MANUAL_ORDER, now: 0, pinned: new Set(['/r/coord', '/r/impl']) })
    expect(sectionUnits(sections, '*pinned')).toEqual([['/r/coord@0(1)', '/r/impl@1(0)']])
  })

  it('필터로 부모가 숨으면 자식은 평소 자리(Hide default branch 가 주 체크아웃 부모를 숨김)', () => {
    const withMainParent = [repo('/r', [wt({ path: '/r', linked: false }), wt({ path: '/r/k', parent: '/r' })])]
    expect(sectionUnits(buildSidebarSections({ repos: withMainParent, view: view(), order: EMPTY_MANUAL_ORDER, now: 0 }), '/r')).toEqual([['/r@0(1)', '/r/k@1(0)']])
    expect(sectionUnits(buildSidebarSections({ repos: withMainParent, view: view({ hideDefaultBranch: true }), order: EMPTY_MANUAL_ORDER, now: 0 }), '/r')).toEqual([['/r/k@0(0)']])
  })

  it('없는 부모 경로(삭제된 부모) = 평소 자리', () => {
    expect(shape(nestSectionItems({ items: items('/r', [wt({ path: '/r/a', parent: '/r/gone' })]), collapsed: NONE }))).toEqual([['/r/a@0(0)']])
  })
})

describe('K1ⓓ 순환 — 렌더가 멈추거나 카드가 사라지지 않는다(Orca 「malformed cyclic lineage should not hide every participant」)', () => {
  it('R1-A 레포를 넘는 링크는 순환 간선이 아니다 — A(r)→B(s)→A 는 순환 아님, 둘 다 루트', () => {
    const mixed = [item('/r', wt({ path: '/r/a', parent: '/s/b' })), item('/s', wt({ path: '/s/b', parent: '/r/a' }))]
    expect([...lineageCycleMembers(mixed)]).toEqual([])
    expect(shape(nestSectionItems({ items: mixed, collapsed: NONE }))).toEqual([['/r/a@0(0)'], ['/s/b@0(0)']])
  })

  it('A↔B 순환 + C→A: 순환 구성원은 루트, 매달린 C 는 A 아래', () => {
    const rows = [wt({ path: '/r/a', parent: '/r/b' }), wt({ path: '/r/b', parent: '/r/a' }), wt({ path: '/r/c', parent: '/r/a' })]
    expect([...lineageCycleMembers(items('/r', rows))].sort()).toEqual(['/r/a', '/r/b'])
    expect(shape(nestSectionItems({ items: items('/r', rows), collapsed: NONE }))).toEqual([['/r/a@0(1)', '/r/c@1(0)'], ['/r/b@0(0)']])
  })

  it('자기 자신이 부모(서버 밖에서 생긴 값) — 루트로', () => {
    expect(shape(nestSectionItems({ items: items('/r', [wt({ path: '/r/a', parent: '/r/a' })]), collapsed: NONE }))).toEqual([['/r/a@0(0)']])
  })

  it('3각 순환 — 모든 카드가 한 번씩 그려진다', () => {
    const rows = [wt({ path: '/r/a', parent: '/r/c' }), wt({ path: '/r/b', parent: '/r/a' }), wt({ path: '/r/c', parent: '/r/b' })]
    const units = nestSectionItems({ items: items('/r', rows), collapsed: NONE })
    expect(units.flatMap((unit) => [unit.root, ...unit.descendants].map((row) => row.item.worktree.path)).sort()).toEqual(['/r/a', '/r/b', '/r/c'])
  })
})

describe('K2ⓒⓔ 접기 — 기본 펼침, 접은 부모의 후손은 빠지고 칩 수는 그대로', () => {
  const rows = [wt({ path: '/r/p' }), wt({ path: '/r/c', parent: '/r/p' }), wt({ path: '/r/g', parent: '/r/c' })]

  it('빈 집합 = 전부 펼침', () => {
    expect(shape(nestSectionItems({ items: items('/r', rows), collapsed: NONE }))).toEqual([['/r/p@0(1)', '/r/c@1(1)', '/r/g@2(0)']])
  })

  it('루트를 접으면 후손 전체가 빠진다 — 자식이 루트로 새어 나오지 않는다', () => {
    expect(shape(nestSectionItems({ items: items('/r', rows), collapsed: new Set(['/r/p']) }))).toEqual([['/r/p@0(1,접힘)']])
  })

  it('중간을 접으면 그 아래만 빠진다', () => {
    expect(shape(nestSectionItems({ items: items('/r', rows), collapsed: new Set(['/r/c']) }))).toEqual([['/r/p@0(1)', '/r/c@1(1,접힘)']])
  })

  it('자식이 없는 경로·없는 경로가 접힘 목록에 남아도 무해', () => {
    expect(shape(nestSectionItems({ items: items('/r', rows), collapsed: new Set(['/r/g', '/nowhere']) }))).toEqual([['/r/p@0(1)', '/r/c@1(1)', '/r/g@2(0)']])
  })
})

describe('들여쓰기 — 단계당 18px, 깊어도 카드 최소 폭을 지킨다(좁은 사이드바)', () => {
  it('깊이 1·2 = 18px·36px, 깊이와 무관하게 「폭 − 최소 폭」 에서 멈추고 음수가 되지 않는다', () => {
    expect(lineageIndent(1)).toBe(`max(0px, min(18px, calc(100% - ${LINEAGE_CARD_MIN_WIDTH_PX}px)))`)
    expect(lineageIndent(2)).toBe(`max(0px, min(36px, calc(100% - ${LINEAGE_CARD_MIN_WIDTH_PX}px)))`)
    expect(lineageIndent(40)).toContain(`calc(100% - ${LINEAGE_CARD_MIN_WIDTH_PX}px)`)
    expect(lineageIndent(Number.NaN)).toBe(`max(0px, min(0px, calc(100% - ${LINEAGE_CARD_MIN_WIDTH_PX}px)))`)
  })
})

describe('K3ⓐⓔ 상위 지정 기하 — Orca main #20412 수치(가장자리 20%·최대 8px)', () => {
  it('높이 50 — 가장자리 8px(20%=10 이 상한 8 에 걸림): 경계값 포함, 바로 바깥은 순서 줄', () => {
    const rect = { top: 100, bottom: 150 }
    expect(isLineageDropZoneHit({ y: 107.99, rect })).toBe(false)
    expect(isLineageDropZoneHit({ y: 108, rect })).toBe(true)
    expect(isLineageDropZoneHit({ y: 125, rect })).toBe(true)
    expect(isLineageDropZoneHit({ y: 142, rect })).toBe(true)
    expect(isLineageDropZoneHit({ y: 142.01, rect })).toBe(false)
  })

  it('높이 30 — 가장자리 = 20% = 6px', () => {
    const rect = { top: 0, bottom: 30 }
    expect(isLineageDropZoneHit({ y: 5.99, rect })).toBe(false)
    expect(isLineageDropZoneHit({ y: 6, rect })).toBe(true)
    expect(isLineageDropZoneHit({ y: 24, rect })).toBe(true)
    expect(isLineageDropZoneHit({ y: 24.01, rect })).toBe(false)
  })

  it('높이 0·뒤집힌 사각형 = 적중 없음', () => {
    expect(isLineageDropZoneHit({ y: 10, rect: { top: 10, bottom: 10 } })).toBe(false)
    expect(isLineageDropZoneHit({ y: 10, rect: { top: 20, bottom: 10 } })).toBe(false)
  })

  it('후보 목록 — 들어간 후보 하나, 가장자리·틈이면 null', () => {
    const targets = [{ key: '/a', rect: { top: 0, bottom: 50 } }, { key: '/b', rect: { top: 56, bottom: 106 } }]
    expect(resolveLineageTarget({ targets, y: 25 })).toBe('/a')
    expect(resolveLineageTarget({ targets, y: 80 })).toBe('/b')
    expect(resolveLineageTarget({ targets, y: 53 })).toBeNull()
    expect(resolveLineageTarget({ targets, y: 59 })).toBeNull()
    expect(resolveLineageTarget({ targets: [], y: 25 })).toBeNull()
  })
})

describe('K4ⓑ 덩어리 이동 — 부모를 끌면 후손이 함께(Orca `getFullDropIndexForWorktreeDragUnit`·`reorderDraggedIds`)', () => {
  it('덩어리 경계 → 평면 경계 = 앞 덩어리 카드 수 합', () => {
    expect(unitSlotToFlat({ sizes: [1, 3, 1], slot: 0 })).toBe(0)
    expect(unitSlotToFlat({ sizes: [1, 3, 1], slot: 2 })).toBe(4)
    expect(unitSlotToFlat({ sizes: [1, 3, 1], slot: 3 })).toBe(5)
    expect(unitSlotToFlat({ sizes: [1, 3, 1], slot: 9 })).toBe(5)
  })

  it('moveBlock — 덩어리째 앞·뒤로, 자기 범위 안 경계는 제자리(null)', () => {
    const keys = ['/x', '/p', '/c1', '/c2', '/y']
    expect(moveBlock({ keys, block: ['/p', '/c1', '/c2'], slot: 0 })).toEqual(['/p', '/c1', '/c2', '/x', '/y'])
    expect(moveBlock({ keys, block: ['/p', '/c1', '/c2'], slot: 5 })).toEqual(['/x', '/y', '/p', '/c1', '/c2'])
    for (const slot of [1, 2, 3, 4]) expect(moveBlock({ keys, block: ['/p', '/c1', '/c2'], slot })).toBeNull()
    // 덩어리 안 자식 하나를 덩어리 밖으로(순서 줄 = 부모 풀기와 함께 D4).
    expect(moveBlock({ keys, block: ['/c2'], slot: 0 })).toEqual(['/c2', '/x', '/p', '/c1', '/y'])
    expect(moveBlock({ keys, block: ['/missing'], slot: 0 })).toBeNull()
  })

  it('applyWorktreeMove 에 덩어리를 주면 수동 순서에 후손이 부모 뒤에 붙어 옮겨진다', () => {
    const rows = [wt({ path: '/r', linked: false }), wt({ path: '/r/x' }), wt({ path: '/r/p' }), wt({ path: '/r/c', parent: '/r/p' })]
    const order = { repos: ['/r'], worktrees: { '/r': ['/r', '/r/x', '/r/p', '/r/c'] }, all: [] }
    const next = applyWorktreeMove({ order, repoRoot: '/r', worktrees: rows, visiblePaths: ['/r', '/r/x', '/r/p', '/r/c'], path: '/r/p', slot: 0, block: ['/r/p', '/r/c'] })
    expect(next?.worktrees['/r']).toEqual(['/r/p', '/r/c', '/r', '/r/x'])
  })

  it('M4 중첩된 자식 끌기 미리 보기 — 경계 뒤 덩어리를 끄는 카드 높이 + 틈만큼 내리고, 표시 줄 = 벌어진 자리 윗변', () => {
    const rects = [{ top: 0, bottom: 50 }, { top: 56, bottom: 200 }, { top: 206, bottom: 256 }]
    const view = { top: 0, bottom: 600 }
    expect(buildInsertionPreview({ rects, slot: 0, height: 40, view })).toEqual({ offsets: [46, 46, 46], indicatorY: 5 })
    expect(buildInsertionPreview({ rects, slot: 2, height: 40, view })).toEqual({ offsets: [0, 0, 46], indicatorY: 206 })
    expect(buildInsertionPreview({ rects, slot: 3, height: 40, view })).toEqual({ offsets: [0, 0, 0], indicatorY: 262 })
  })
})

describe('K4ⓒ 순서 줄 부모 해제 판정 = Orca lineage 유효 (수정 r1 M2 — `getReorderedWorktreeIdsToUnnest`)', () => {
  const repos = [
    repo('/r', [wt({ path: '/r', linked: false }), wt({ path: '/r/p' }), wt({ path: '/r/c', parent: '/r/p' }), wt({ path: '/r/gone', parent: '/r/nowhere' }), wt({ path: '/r/a', parent: '/r/b' }), wt({ path: '/r/b', parent: '/r/a' })]),
    repo('/s', [wt({ path: '/s/x', parent: '/r/p' })]),
  ]
  it('부모가 같은 레포 목록에 있으면 참 — 화면에 보이든(중첩) 아니든(고정·필터)', () => {
    expect(hasValidLineage({ repos, path: '/r/c' })).toBe(true)
  })
  it('R1-A 다른 레포 부모 = 유효 간선 아님 → 거짓(순서 줄에 놓아도 lineage 무변경)', () => {
    expect(hasValidLineage({ repos, path: '/s/x' })).toBe(false)
  })
  it('부모 없는 카드·없는 부모·순환 구성원·없는 카드 = 거짓(lineage 무변경)', () => {
    expect(hasValidLineage({ repos, path: '/r/p' })).toBe(false)
    expect(hasValidLineage({ repos, path: '/r/gone' })).toBe(false)
    expect(hasValidLineage({ repos, path: '/r/a' })).toBe(false)
    expect(hasValidLineage({ repos, path: '/nope' })).toBe(false)
  })
})

describe('K2ⓓ 활성 카드를 가리는 접힌 조상 (수정 r2 R1-C — Sidebar 가 접힘 적재 뒤에도 이 경로들을 펼친다)', () => {
  const repos = [
    repo('/r', [wt({ path: '/r/p' }), wt({ path: '/r/c', parent: '/r/p' }), wt({ path: '/r/g', parent: '/r/c' }), wt({ path: '/r/a', parent: '/r/b' }), wt({ path: '/r/b', parent: '/r/a' })]),
    repo('/s', [wt({ path: '/s/x', parent: '/r/g' })]),
  ]
  it('접힌 조상만 아래에서 위 순서로 — 펼친 조상은 빠진다', () => {
    expect(collapsedAncestors({ repos, path: '/r/g', collapsed: new Set(['/r/p', '/r/c']) })).toEqual(['/r/c', '/r/p'])
    expect(collapsedAncestors({ repos, path: '/r/g', collapsed: new Set(['/r/p']) })).toEqual(['/r/p'])
    expect(collapsedAncestors({ repos, path: '/r/g', collapsed: new Set() })).toEqual([])
  })
  it('순환은 한 바퀴에서 멈추고, 다른 레포 링크(유효 간선 아님)는 따라가지 않는다', () => {
    expect(collapsedAncestors({ repos, path: '/r/a', collapsed: new Set(['/r/a', '/r/b']) })).toEqual(['/r/b'])
    expect(collapsedAncestors({ repos, path: '/s/x', collapsed: new Set(['/r/g', '/r/p']) })).toEqual([])
  })
})
