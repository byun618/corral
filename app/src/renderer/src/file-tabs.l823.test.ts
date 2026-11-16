// LIFE-823 C1·C2·C3·C4 — 파일을 고른 자리에 여는 길(`placeFileTab`)·고스트 글자(B4)·안내 한 줄(P2) 모델.
//   · 연 탭은 고정(P1) — 놓은 영역의 미리보기 탭은 그대로
//   · 이미 열린 파일은 옮기지 않고 그 탭 활성(814) + 미리보기면 고정(P1') + 자리가 달랐는지(`elsewhere`, P2)
//   · 옆으로 열기 = 오른쪽 이웃 있으면 거기, 없으면 활성 영역 오른쪽 새 분할(P3)

import { describe, expect, it } from 'vitest'
import { alreadyOpenHint, dragGhostLabel, hintAfterContextChange, hintContextKey, placeFileTab, type FilePlacement } from './file-tabs.js'
import { listGroups, type GroupLayout, type GroupNode, type TabGroup } from './group-tree.js'
import { diffTabId } from '../../shared/scm.js'

const node = (group: TabGroup): GroupNode => ({ kind: 'leaf', group })
/** g1 = [터미널 t1, 미리보기 p.ts(활성)] · g2 = [a.ts] — 가로 분할, g1 활성. */
const layout = (): GroupLayout => ({
  root: {
    kind: 'split',
    direction: 'row',
    ratio: 0.5,
    first: node({ groupId: 'g1', tabOrder: ['t1', 'file:p.ts'], activeTabId: 'file:p.ts', previewTabId: 'file:p.ts' }),
    second: node({ groupId: 'g2', tabOrder: ['file:a.ts'], activeTabId: 'file:a.ts' }),
  },
  activeGroupId: 'g1',
})
const place = (input: { layout?: GroupLayout; rel: string; placement: FilePlacement }) =>
  placeFileTab({ layout: input.layout ?? layout(), rel: input.rel, placement: input.placement, newGroupId: 'g3' })
const groups = (value: GroupLayout) => listGroups(value.root)
const tabCount = (value: GroupLayout, tabId: string) => groups(value).flatMap((group) => group.tabOrder).filter((id) => id === tabId).length

describe('placeFileTab — 새로 여는 파일(C1)', () => {
  it('ⓐ 탭바 — 삽입선 자리, 그 영역 활성, 고정(미리보기 아님), 기존 미리보기는 남는다(ⓔ)', () => {
    const { layout: next, result } = place({ rel: 'b.ts', placement: { kind: 'tabbar', groupId: 'g1', index: 0 } })
    expect(result).toEqual({ kind: 'opened', groupId: 'g1' })
    expect(groups(next)[0]).toMatchObject({ tabOrder: ['file:b.ts', 't1', 'file:p.ts'], activeTabId: 'file:b.ts', previewTabId: 'file:p.ts' })
    expect(next.activeGroupId).toBe('g1')
  })
  it('ⓐ 다른 영역 탭바', () => {
    const { layout: next } = place({ rel: 'b.ts', placement: { kind: 'tabbar', groupId: 'g2', index: 1 } })
    expect(groups(next)[1]).toMatchObject({ tabOrder: ['file:a.ts', 'file:b.ts'], activeTabId: 'file:b.ts' })
    expect(next.activeGroupId).toBe('g2')
  })
  it('ⓑ 가장자리 — 그 방향에 이 파일 탭 하나인 새 영역, 새 영역 활성', () => {
    const { layout: next, result } = place({ rel: 'b.ts', placement: { kind: 'split', groupId: 'g2', direction: 'column', edge: 'after' } })
    expect(result).toEqual({ kind: 'opened', groupId: 'g3' })
    expect(groups(next).map((group) => group.tabOrder)).toEqual([['t1', 'file:p.ts'], ['file:a.ts'], ['file:b.ts']])
    expect(next.activeGroupId).toBe('g3')
    expect(groups(next)[2]?.previewTabId ?? null).toBeNull()
  })
  it('ⓑ 탭 1개 영역(g2)의 왼쪽 가장자리도 된다', () => {
    const { layout: next } = place({ rel: 'b.ts', placement: { kind: 'split', groupId: 'g2', direction: 'row', edge: 'before' } })
    expect(groups(next).map((group) => group.groupId)).toEqual(['g1', 'g3', 'g2'])
  })
  it('ⓒ 가운데 — 그 영역 활성 탭 오른쪽, 그 영역 활성, 미리보기 교체 없음', () => {
    const { layout: next } = place({ rel: 'b.ts', placement: { kind: 'center', groupId: 'g1' } })
    expect(groups(next)[0]).toMatchObject({ tabOrder: ['t1', 'file:p.ts', 'file:b.ts'], activeTabId: 'file:b.ts', previewTabId: 'file:p.ts' })
    expect(next.activeGroupId).toBe('g1')
  })
  it('없는 영역이면 none — 배치 그대로', () => {
    const before = layout()
    const { layout: next, result } = place({ layout: before, rel: 'b.ts', placement: { kind: 'center', groupId: 'g9' } })
    expect(result).toEqual({ kind: 'none' })
    expect(next).toBe(before)
  })
  it('diff 탭 id 도 같은 규칙', () => {
    const tabId = diffTabId({ mode: 'wt', rel: 'b.ts', orig: null })
    const { layout: next } = placeFileTab({ layout: layout(), rel: 'b.ts', tabId, placement: { kind: 'center', groupId: 'g2' }, newGroupId: 'g3' })
    expect(groups(next)[1]?.tabOrder).toEqual(['file:a.ts', tabId])
  })
})

describe('placeFileTab — 이미 열린 파일(C2)', () => {
  it('다른 영역에 놓아도 옮기지 않고 그 탭 활성 — 소속·순서 그대로, elsewhere', () => {
    const { layout: next, result } = place({ rel: 'a.ts', placement: { kind: 'tabbar', groupId: 'g1', index: 0 } })
    expect(result).toEqual({ kind: 'already-open', groupId: 'g2', elsewhere: true })
    expect(groups(next).map((group) => group.tabOrder)).toEqual([['t1', 'file:p.ts'], ['file:a.ts']])
    expect(next.activeGroupId).toBe('g2')
    expect(tabCount(next, 'file:a.ts')).toBe(1)
  })
  it('가장자리에 놓아도 분할 없음(영역 수 그대로) — elsewhere', () => {
    const { layout: next, result } = place({ rel: 'a.ts', placement: { kind: 'split', groupId: 'g2', direction: 'row', edge: 'after' } })
    expect(result).toMatchObject({ kind: 'already-open', elsewhere: true })
    expect(groups(next)).toHaveLength(2)
  })
  it("미리보기 탭이면 고정(P1') — 같은 영역 가운데는 자리 같음", () => {
    const { layout: next, result } = place({ rel: 'p.ts', placement: { kind: 'center', groupId: 'g1' } })
    expect(result).toEqual({ kind: 'already-open', groupId: 'g1', elsewhere: false })
    expect(groups(next)[0]).toMatchObject({ activeTabId: 'file:p.ts', previewTabId: null, tabOrder: ['t1', 'file:p.ts'] })
  })
  it('같은 영역 탭바 — 자기 앞·뒤 칸은 같은 자리, 그 밖은 elsewhere(순서는 그대로)', () => {
    expect(place({ rel: 'p.ts', placement: { kind: 'tabbar', groupId: 'g1', index: 1 } }).result).toMatchObject({ elsewhere: false })
    expect(place({ rel: 'p.ts', placement: { kind: 'tabbar', groupId: 'g1', index: 2 } }).result).toMatchObject({ elsewhere: false })
    const moved = place({ rel: 'p.ts', placement: { kind: 'tabbar', groupId: 'g1', index: 0 } })
    expect(moved.result).toMatchObject({ elsewhere: true })
    expect(groups(moved.layout)[0]?.tabOrder).toEqual(['t1', 'file:p.ts'])
  })
  it('옆으로 열기 — 오른쪽 이웃에 이미 있으면 같은 자리, 활성 영역에 있으면 elsewhere', () => {
    expect(place({ rel: 'a.ts', placement: { kind: 'side' } }).result).toEqual({ kind: 'already-open', groupId: 'g2', elsewhere: false })
    expect(place({ rel: 'p.ts', placement: { kind: 'side' } }).result).toEqual({ kind: 'already-open', groupId: 'g1', elsewhere: true })
  })
})

describe('placeFileTab — 옆으로 열기(C3·P3)', () => {
  it('오른쪽 이웃이 있으면 그 영역 활성 탭 오른쪽, 그 영역 활성, 고정', () => {
    const { layout: next, result } = place({ rel: 'b.ts', placement: { kind: 'side' } })
    expect(result).toEqual({ kind: 'opened', groupId: 'g2' })
    expect(groups(next)[1]).toMatchObject({ tabOrder: ['file:a.ts', 'file:b.ts'], activeTabId: 'file:b.ts' })
    expect(groups(next)[1]?.previewTabId ?? null).toBeNull()
  })
  it('없으면(활성 영역이 가장 오른쪽) 활성 영역 오른쪽에 새 분할', () => {
    const rightmost = { ...layout(), activeGroupId: 'g2' }
    const { layout: next, result } = place({ layout: rightmost, rel: 'b.ts', placement: { kind: 'side' } })
    expect(result).toEqual({ kind: 'opened', groupId: 'g3' })
    expect(groups(next).map((group) => group.groupId)).toEqual(['g1', 'g2', 'g3'])
    expect(next.root.kind === 'split' ? next.root.second : null).toMatchObject({ kind: 'split', direction: 'row', first: { group: { groupId: 'g2' } } })
  })
  it('영역이 하나면 오른쪽 새 분할', () => {
    const one: GroupLayout = { root: node({ groupId: 'g1', tabOrder: ['t1'], activeTabId: 't1' }), activeGroupId: 'g1' }
    const { layout: next } = place({ layout: one, rel: 'b.ts', placement: { kind: 'side' } })
    expect(groups(next).map((group) => group.tabOrder)).toEqual([['t1'], ['file:b.ts']])
  })
})

describe('dragGhostLabel — 탭 끌기 고스트 글자(B4)', () => {
  it('파일 탭 = 파일 이름, diff 탭 = diff 제목, 터미널 = 받은 이름', () => {
    expect(dragGhostLabel({ tabId: 'file:src/a.ts', terminalLabel: null })).toBe('a.ts')
    const diff = dragGhostLabel({ tabId: diffTabId({ mode: 'wt', rel: 'src/b.ts', orig: null }), terminalLabel: null })
    expect(diff).toContain('b.ts')
    expect(diff).not.toBe('')
    expect(dragGhostLabel({ tabId: 'w1:t1', terminalLabel: 'zsh' })).toBe('zsh')
    expect(dragGhostLabel({ tabId: 'w1:t1', terminalLabel: null })).toBe('')
    expect(dragGhostLabel({ tabId: 'diff:broken', terminalLabel: null })).toBe('(diff)')
  })
})

describe('안내 한 줄(P2)', () => {
  it('문구는 이미 열린 탭으로 갔다는 뜻 + 파일 이름', () => {
    expect(alreadyOpenHint('src/a.ts')).toBe('a.ts 은(는) 이미 열려 있다 — 그 탭으로 갔다')
  })
  it('맥락이 바뀐 뒤엔 실어 둔 안내가 바로 그 맥락의 것일 때만 보인다', () => {
    const context = hintContextKey({ worktreePath: '/w', groupId: 'g2', tabId: 'file:a.ts' })
    expect(context).toBe('/w\ng2\nfile:a.ts')
    expect(hintAfterContextChange({ carry: { message: 'm', context }, context })).toBe('m')
    expect(hintAfterContextChange({ carry: { message: 'm', context }, context: hintContextKey({ worktreePath: '/w', groupId: 'g1', tabId: 't1' }) })).toBeNull()
    expect(hintAfterContextChange({ carry: null, context })).toBeNull()
  })
})
