// LIFE-683 S5·S10 — diff 탭: 종류 구분, 파일 탭과 같은 미리보기·고정·중복 0 규칙, 정리 생존, 그리고 **기준 빌드(682 `0aad74da`)** 의 `group-tree.ts`
// 사본(`legacy/group-tree.0aad74da.ts` — 바이트 그대로)이 diff 탭 id 든 배치를 읽어도 죽지 않고 터미널·파일 탭 배치가 남는다(하위 방향).
import { describe, expect, it } from 'vitest'
import { fileTabId, fileTabsOf, keepFileTab, openFileTab, previewOf, tabKindOf } from './file-tabs.js'
import { dropDeadTabs, listGroups, readStoredLayouts, reconcileLayout, singleLayout, type GroupLayout } from './group-tree.js'
import * as base from './legacy/group-tree.0aad74da.js'
import { diffTabId, type ScmDiffTarget } from '../../shared/scm.js'

const WT: ScmDiffTarget = { mode: 'wt', rel: 'src/a.ts', orig: null }
const IDX: ScmDiffTarget = { mode: 'idx', rel: 'src/a.ts', orig: null }
const D1 = diffTabId(WT)
const D2 = diffTabId(IDX)
const F = fileTabId('src/b.ts')
const orders = (layout: GroupLayout): string[][] => listGroups(layout.root).map((group) => group.tabOrder)

describe('종류 구분', () => {
  it('diff: = diff 탭(대상 파싱), 깨진 id 는 대상 null', () => {
    expect(tabKindOf(D1)).toEqual({ kind: 'diff', tabId: D1, target: WT })
    expect(tabKindOf('diff:nope')).toEqual({ kind: 'diff', tabId: 'diff:nope', target: null })
    expect(tabKindOf('diff:')).toEqual({ kind: 'terminal', tabId: 'diff:' })
  })
  it('파일 탭 목록(복원 가둠·탐색기 조작 대상)에는 diff 탭이 들지 않는다', () => {
    const layout = singleLayout({ groupId: 'g1', tabOrder: ['w1:t1', D1, F], activeTabId: D1 })
    expect(fileTabsOf(layout).map((tab) => tab.tabId)).toEqual([F])
  })
})

describe('여는 규칙 — 파일 탭과 같다', () => {
  it('한 번 클릭 = 미리보기, 다른 대상 미리보기는 그 자리 교체(밀려난 id 를 돌려준다), 같은 대상 다시 = 같은 탭(중복 0)', () => {
    let layout = singleLayout({ groupId: 'g1', tabOrder: ['w1:t1'], activeTabId: 'w1:t1' })
    layout = openFileTab({ layout, rel: WT.rel, preview: true, tabId: D1 }).layout
    expect(orders(layout)).toEqual([['w1:t1', D1]])
    expect(previewOf(listGroups(layout.root)[0]!)).toBe(D1)
    const swapped = openFileTab({ layout, rel: IDX.rel, preview: true, tabId: D2 })
    expect(orders(swapped.layout)).toEqual([['w1:t1', D2]])
    expect(swapped.replaced).toMatchObject({ tabId: D1 })
    const again = openFileTab({ layout: swapped.layout, rel: IDX.rel, preview: true, tabId: D2 })
    expect(orders(again.layout)).toEqual([['w1:t1', D2]])
    expect(again.replaced).toBeNull()
  })
  it('두 번 클릭 = 고정 — 다음 미리보기가 교체하지 않는다', () => {
    let layout = singleLayout({ groupId: 'g1', tabOrder: ['w1:t1'], activeTabId: 'w1:t1' })
    layout = openFileTab({ layout, rel: WT.rel, preview: true, tabId: D1 }).layout
    layout = keepFileTab({ layout, tabId: D1 })
    layout = openFileTab({ layout, rel: IDX.rel, preview: true, tabId: D2 }).layout
    expect(orders(layout)).toEqual([['w1:t1', D1, D2]])
  })
  it('정리(reconcile·dropDeadTabs)에서 herdr 와 무관하게 남는다', () => {
    const layout = singleLayout({ groupId: 'g1', tabOrder: ['w1:t1', D1, 'w1:dead'], activeTabId: D1 })
    expect(orders(reconcileLayout({ layout, liveTabIds: ['w1:t1'] }))).toEqual([['w1:t1', D1]])
    expect(orders(dropDeadTabs({ layout, herdrTabIds: new Set(['w1:t1']) }) ?? layout)).toEqual([['w1:t1', D1]])
  })
  it('저장 배치 왕복 — 미리보기 diff 탭도 그대로 읽힌다', () => {
    const layout: GroupLayout = { root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['w1:t1', D1], activeTabId: D1, previewTabId: D1 } }, activeGroupId: 'g1' }
    const [row] = readStoredLayouts(JSON.parse(JSON.stringify([{ worktreePath: '/w', layout, layoutFormat: 2 }])))
    expect(row?.layout).toEqual(layout)
  })
})

describe('하위 방향 — 기준 빌드 group-tree(0aad74da)가 새 배치를 읽는다 (S10)', () => {
  const stored = [
    {
      worktreePath: '/w',
      layoutFormat: 2,
      layout: { root: { kind: 'split', direction: 'row', ratio: 0.5, first: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['w1:t1', D1, F], activeTabId: D1, previewTabId: D1 } }, second: { kind: 'leaf', group: { groupId: 'g2', tabOrder: [D2], activeTabId: D2 } } }, activeGroupId: 'g1' },
    },
  ]
  it('읽기에서 죽지 않고, diff 탭은 herdr 에 없는 탭으로 걷히고 터미널·파일 탭 배치는 남는다', () => {
    const rows = base.readStoredLayouts(JSON.parse(JSON.stringify(stored)))
    expect(rows).toHaveLength(1)
    const layout = rows[0]!.layout
    const kept = base.dropDeadTabs({ layout, herdrTabIds: new Set(['w1:t1']) })
    expect(kept === null ? null : base.listGroups(kept.root).map((group) => group.tabOrder)).toEqual([['w1:t1', F]])
    const shown = base.reconcileLayout({ layout, liveTabIds: ['w1:t1'] })
    expect(base.listGroups(shown.root).map((group) => group.tabOrder)).toEqual([['w1:t1', F]])
    // 기준 빌드는 diff 미리보기를 미리보기로 싣지 않는다(파일 탭만) — 남는 영역에 엉뚱한 미리보기 표시가 없다.
    expect(base.listGroups(layout.root)[0]?.previewTabId).toBeUndefined()
  })
})
