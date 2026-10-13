// LIFE-590 E1·E2 — 파일 탭 종류 구분·정리 생존·미리보기 규칙·영속 형식 양방향(단위).
// 하위 방향(E1ⓓ)은 기준 commit `bd2fca411` 의 `group-tree.ts` 사본(`legacy/group-tree.bd2fca411.ts` — 바이트 그대로)에 새 형식을 넣어 본다.
import { describe, expect, it } from 'vitest'
import { closeFileTab, fileTabId, fileTabsOf, keepFileTab, openFileTab, previewOf, reopenFileTab, tabKindOf, terminalKeyTarget } from './file-tabs.js'
import { dropDeadTabs, LAYOUT_FORMAT, listGroups, mergeTabIntoGroup, moveTabWithinTabbar, readStoredLayouts, reconcileLayout, singleLayout, splitGroup, type GroupLayout } from './group-tree.js'
import * as legacy from './legacy/group-tree.bd2fca411.js'

const A = fileTabId('src/a.ts')
const B = fileTabId('src/b.ts')
const C = fileTabId('README.md')
const terminals = (): GroupLayout => singleLayout({ groupId: 'g1', tabOrder: ['w1:t1', 'w1:t2'], activeTabId: 'w1:t1' })
const orders = (layout: GroupLayout): string[][] => listGroups(layout.root).map((group) => group.tabOrder)

describe('E1ⓐ 종류 구분', () => {
  it('file: 접두사 = 파일 탭, 그 밖 = 터미널', () => {
    expect(tabKindOf(A)).toEqual({ kind: 'file', tabId: A, rel: 'src/a.ts' })
    expect(tabKindOf('w1:t1')).toEqual({ kind: 'terminal', tabId: 'w1:t1' })
    expect(tabKindOf('file:')).toEqual({ kind: 'terminal', tabId: 'file:' })
  })
})

describe('E1ⓐ 정리에서 살아남는다', () => {
  it('reconcileLayout — herdr 산 탭 목록에 없어도 파일 탭은 남고 중복은 걷힌다', () => {
    const layout: GroupLayout = { root: { kind: 'split', direction: 'row', ratio: 0.5, first: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['w1:t1', A, 'w1:dead'], activeTabId: A } }, second: { kind: 'leaf', group: { groupId: 'g2', tabOrder: [A, B], activeTabId: B } } }, activeGroupId: 'g1' }
    const next = reconcileLayout({ layout, liveTabIds: ['w1:t1'] })
    expect(orders(next)).toEqual([['w1:t1', A], [B]])
    expect(listGroups(next.root)[0]?.activeTabId).toBe(A)
  })
  it('파일 탭만 남은 영역은 접히지 않는다', () => {
    const layout: GroupLayout = { root: { kind: 'split', direction: 'row', ratio: 0.5, first: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['w1:t1'], activeTabId: 'w1:t1' } }, second: { kind: 'leaf', group: { groupId: 'g2', tabOrder: [A], activeTabId: A } } }, activeGroupId: 'g2' }
    const next = reconcileLayout({ layout, liveTabIds: ['w1:t1'] })
    expect(orders(next)).toEqual([['w1:t1'], [A]])
    expect(next.activeGroupId).toBe('g2')
  })
  it('herdr 재기동(터미널 id 전부 바뀜)이면 파일 탭이 있어도 복원 실패로 보고 새 터미널은 첫 영역에', () => {
    const layout: GroupLayout = { root: { kind: 'split', direction: 'row', ratio: 0.5, first: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['w1:t1'], activeTabId: 'w1:t1' } }, second: { kind: 'leaf', group: { groupId: 'g2', tabOrder: ['w1:t2', A], activeTabId: A } } }, activeGroupId: 'g2' }
    const next = reconcileLayout({ layout, liveTabIds: ['w9:t1'] })
    expect(orders(next)).toEqual([['w9:t1'], [A]])
    expect(next.activeGroupId).toBe('g1')
  })
  it('dropDeadTabs — 파일 탭만 남은 worktree 배치도 버리지 않는다', () => {
    const layout = singleLayout({ groupId: 'g1', tabOrder: ['w1:t1', A], activeTabId: A })
    const kept = dropDeadTabs({ layout, herdrTabIds: new Set() })
    expect(kept).not.toBeNull()
    expect(kept === null ? null : orders(kept)).toEqual([[A]])
    expect(dropDeadTabs({ layout: terminals(), herdrTabIds: new Set() })).toBeNull()
  })
})

describe('E2 열기·미리보기 규칙', () => {
  it('한 번 클릭 = 미리보기, 활성 탭 바로 오른쪽', () => {
    const { layout } = openFileTab({ layout: terminals(), rel: 'src/a.ts', preview: true })
    const group = listGroups(layout.root)[0]!
    expect(group.tabOrder).toEqual(['w1:t1', A, 'w1:t2'])
    expect(group.activeTabId).toBe(A)
    expect(previewOf(group)).toBe(A)
  })
  it('영역당 미리보기 1개 — 다른 파일 한 번 클릭은 같은 자리에서 교체, 밀려난 파일을 알린다', () => {
    const first = openFileTab({ layout: terminals(), rel: 'src/a.ts', preview: true }).layout
    const second = openFileTab({ layout: first, rel: 'src/b.ts', preview: true })
    expect(orders(second.layout)).toEqual([['w1:t1', B, 'w1:t2']])
    expect(previewOf(listGroups(second.layout.root)[0]!)).toBe(B)
    expect(second.replaced).toEqual({ rel: 'src/a.ts', groupId: 'g1', index: 1 })
  })
  it('고정 탭은 교체되지 않는다 — 더블클릭(preview:false)으로 연 탭 옆에 새 미리보기', () => {
    const pinned = openFileTab({ layout: terminals(), rel: 'src/a.ts', preview: false }).layout
    const next = openFileTab({ layout: pinned, rel: 'src/b.ts', preview: true })
    expect(orders(next.layout)).toEqual([['w1:t1', A, B, 'w1:t2']])
    expect(next.replaced).toBeNull()
    expect(previewOf(listGroups(next.layout.root)[0]!)).toBe(B)
  })
  it('이미 열린 파일 클릭 = 그 탭 활성(미리보기 유지), 더블클릭 = 고정', () => {
    const opened = openFileTab({ layout: terminals(), rel: 'src/a.ts', preview: true }).layout
    const away = { ...opened, root: { kind: 'leaf' as const, group: { ...listGroups(opened.root)[0]!, activeTabId: 'w1:t1' } } }
    const again = openFileTab({ layout: away, rel: 'src/a.ts', preview: true }).layout
    expect(listGroups(again.root)[0]?.activeTabId).toBe(A)
    expect(previewOf(listGroups(again.root)[0]!)).toBe(A)
    const kept = openFileTab({ layout: again, rel: 'src/a.ts', preview: false }).layout
    expect(previewOf(listGroups(kept.root)[0]!)).toBeNull()
    expect(orders(kept)).toEqual(orders(again))
  })
  it('미리보기 탭 더블클릭 = 고정(keepFileTab)', () => {
    const opened = openFileTab({ layout: terminals(), rel: 'src/a.ts', preview: true }).layout
    expect(previewOf(listGroups(keepFileTab({ layout: opened, tabId: A }).root)[0]!)).toBeNull()
    expect(keepFileTab({ layout: terminals(), tabId: A })).toEqual(terminals())
  })
  it('열리는 영역 = 활성 영역, 다른 영역에 이미 열려 있으면 그 영역으로 간다', () => {
    const split = splitGroup({ layout: openFileTab({ layout: terminals(), rel: 'src/a.ts', preview: false }).layout, groupId: 'g1', tabId: 'w1:t2', direction: 'row', newGroupId: 'g2' })
    expect(split.activeGroupId).toBe('g2')
    const opened = openFileTab({ layout: split, rel: 'src/b.ts', preview: true }).layout
    expect(orders(opened)).toEqual([['w1:t1', A], ['w1:t2', B]])
    const back = openFileTab({ layout: opened, rel: 'src/a.ts', preview: true }).layout
    expect(back.activeGroupId).toBe('g1')
    expect(orders(back)).toEqual(orders(opened))
  })
  it('미리보기 탭을 다른 영역으로 옮기면 고정 탭이 된다(이동 = 고정)', () => {
    const opened = openFileTab({ layout: terminals(), rel: 'src/a.ts', preview: true }).layout
    const split = splitGroup({ layout: opened, groupId: 'g1', tabId: 'w1:t2', direction: 'row', newGroupId: 'g2' })
    const merged = mergeTabIntoGroup(split, { tabId: A, fromGroupId: 'g1', toGroupId: 'g2' })
    for (const group of listGroups(merged.root)) expect(previewOf(group)).toBeNull()
  })
})

describe('E3ⓓ 닫기·다시 열기(같은 영역·자리·미리보기)', () => {
  it('닫으면 자리를 돌려주고 다시 열면 그 자리에', () => {
    const opened = openFileTab({ layout: openFileTab({ layout: terminals(), rel: 'src/a.ts', preview: false }).layout, rel: 'src/b.ts', preview: true }).layout
    const closed = closeFileTab({ layout: opened, tabId: A })
    expect(closed.closed).toEqual({ groupId: 'g1', index: 1, preview: false })
    expect(orders(closed.layout)).toEqual([['w1:t1', B, 'w1:t2']])
    const reopened = reopenFileTab({ layout: closed.layout, rel: 'src/a.ts', ...closed.closed! })
    expect(orders(reopened)).toEqual(orders(opened))
    expect(previewOf(listGroups(reopened.root)[0]!)).toBe(B)
  })
  it('영역의 마지막 파일 탭을 닫으면 영역이 접힌다(터미널 탭과 같은 규칙)', () => {
    const layout: GroupLayout = { root: { kind: 'split', direction: 'row', ratio: 0.5, first: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['w1:t1'], activeTabId: 'w1:t1' } }, second: { kind: 'leaf', group: { groupId: 'g2', tabOrder: [C], activeTabId: C, previewTabId: C } } }, activeGroupId: 'g2' }
    const closed = closeFileTab({ layout, tabId: C })
    expect(orders(closed.layout)).toEqual([['w1:t1']])
    expect(closed.closed).toEqual({ groupId: 'g2', index: 0, preview: true })
    // 영역이 없어졌으면 활성 영역 끝으로, 미리보기로
    const reopened = reopenFileTab({ layout: closed.layout, rel: 'README.md', ...closed.closed! })
    expect(orders(reopened)).toEqual([['w1:t1', C]])
    expect(previewOf(listGroups(reopened.root)[0]!)).toBe(C)
  })
})

describe('E1ⓒⓓ 영속 형식', () => {
  const mixed = (): GroupLayout => ({ root: { kind: 'split', direction: 'row', ratio: 0.4, first: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['w1:t1', A, B], activeTabId: B, previewTabId: B } }, second: { kind: 'leaf', group: { groupId: 'g2', tabOrder: ['w1:t2'], activeTabId: 'w1:t2' } } }, activeGroupId: 'g1' })
  it('구 형식(현재 저장 모양, 합성 fixture)을 새 코드가 읽으면 터미널 배치 그대로', () => {
    const old = [{ worktreePath: '/r/wt', layout: { root: { kind: 'split', direction: 'column', ratio: 0.3, first: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['w1:t1', 'w1:t3'], activeTabId: 'w1:t3' } }, second: { kind: 'leaf', group: { groupId: 'g2', tabOrder: ['w1:t2'], activeTabId: 'w1:t2' } } }, activeGroupId: 'g2' } }]
    const rows = readStoredLayouts(old)
    expect(rows).toEqual(legacy.readStoredLayouts(old))
    expect(rows[0]?.layout).toEqual(old[0]?.layout)
  })
  it('새 형식 왕복 — 쓰기 → JSON → 읽기 같음(미리보기 포함)', () => {
    const rows = [{ worktreePath: '/r/wt', layout: mixed(), layoutFormat: LAYOUT_FORMAT }]
    const read = readStoredLayouts(JSON.parse(JSON.stringify(rows)))
    expect(read).toEqual([{ worktreePath: '/r/wt', layout: mixed() }])
    expect(fileTabsOf(read[0]!.layout).map((tab) => tab.rel)).toEqual(['src/a.ts', 'src/b.ts'])
  })
  it('손으로 고친 미리보기 값(그 영역에 없음·터미널 id)은 버린다', () => {
    const bad = JSON.parse(JSON.stringify([{ worktreePath: '/r/wt', layout: mixed() }]))
    bad[0].layout.root.first.group.previewTabId = 'w1:t1'
    bad[0].layout.root.second.group.previewTabId = A
    const read = readStoredLayouts(bad)
    for (const group of listGroups(read[0]!.layout.root)) expect(group.previewTabId).toBeUndefined()
  })
  it('하위 방향 — 기준 commit 코드가 새 형식을 읽어도 죽지 않고 터미널 배치를 지킨다(파일 탭은 걸러진다)', () => {
    const stored = JSON.parse(JSON.stringify([{ worktreePath: '/r/wt', layout: mixed(), layoutFormat: LAYOUT_FORMAT }, { worktreePath: '/r/files-only', layout: singleLayout({ groupId: 'g1', tabOrder: [C], activeTabId: C }), layoutFormat: LAYOUT_FORMAT }]))
    const rows = legacy.readStoredLayouts(stored)
    expect(rows.map((row) => row.worktreePath)).toEqual(['/r/wt', '/r/files-only'])
    const shown = legacy.reconcileLayout({ layout: rows[0]!.layout, liveTabIds: ['w1:t1', 'w1:t2'] })
    expect(legacy.listGroups(shown.root).map((group) => group.tabOrder)).toEqual([['w1:t1'], ['w1:t2']])
    expect(shown.root.kind === 'split' ? shown.root.ratio : null).toBe(0.4)
    const live = new Set(['w1:t1', 'w1:t2'])
    const pruned = legacy.dropDeadTabs({ layout: rows[0]!.layout, herdrTabIds: live })
    expect(pruned === null ? null : legacy.listGroups(pruned.root).map((group) => group.tabOrder)).toEqual([['w1:t1'], ['w1:t2']])
    // 파일 탭만 있던 worktree 는 구 코드에서 배치를 버린다(다음에 열면 한 영역) — 터미널 배치에는 영향 없음
    expect(legacy.dropDeadTabs({ layout: rows[1]!.layout, herdrTabIds: live })).toBeNull()
  })
})

describe('수정 r1 R1-C 끌면 고정 — 같은 탭바 재정렬 포함', () => {
  it('같은 영역 안에서 미리보기 탭을 옮기면 고정되고, 다음 한 번 클릭은 새 탭을 연다', () => {
    const opened = openFileTab({ layout: terminals(), rel: 'README.md', preview: true }).layout
    expect(previewOf(listGroups(opened.root)[0]!)).toBe(C)
    const moved = moveTabWithinTabbar(opened, { tabId: C, fromGroupId: 'g1', toGroupId: 'g1', index: 0 })
    expect(orders(moved)[0]![0]).toBe(C)
    expect(previewOf(listGroups(moved.root)[0]!)).toBeNull()
    const next = openFileTab({ layout: moved, rel: 'src/a.ts', preview: true }).layout
    expect(orders(next)[0]).toEqual(expect.arrayContaining([C, A]))
  })
  it('다른 탭(터미널)을 옮겨도 미리보기는 그대로', () => {
    const opened = openFileTab({ layout: terminals(), rel: 'README.md', preview: true }).layout
    const moved = moveTabWithinTabbar(opened, { tabId: 'w1:t2', fromGroupId: 'g1', toGroupId: 'g1', index: 0 })
    expect(previewOf(listGroups(moved.root)[0]!)).toBe(C)
  })
})

describe('수정 r1 R1-B 터미널 대상 단축키 — 파일 탭이 활성이면 대상 없음', () => {
  it('파일 탭 활성 → null(숨은 터미널 pane 을 쓰지 않는다)', () => {
    expect(terminalKeyTarget({ activeTabId: C, selectedPane: 'w1:p1' })).toBeNull()
  })
  it('터미널 탭 활성·활성 탭 없음 → 이전과 같이 selectedPane', () => {
    expect(terminalKeyTarget({ activeTabId: 'w1:t1', selectedPane: 'w1:p1' })).toBe('w1:p1')
    expect(terminalKeyTarget({ activeTabId: null, selectedPane: 'w1:p1' })).toBe('w1:p1')
  })
})
