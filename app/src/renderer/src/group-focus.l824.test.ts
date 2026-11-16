// LIFE-824 — 영역 간 포커스·전환의 이름 있는 순수 판정(이웃 영역 네 방향·영역 넘는 이전/다음 탭·⌃` 후보·영역 MRU·MRU 편집기 키·줌 해제·worktree 복귀·편집기 양보).
import { describe, expect, it } from 'vitest'
import { matchBinding, yieldsToEditor } from '../../shared/keybindings.js'
import { editorMruKey, groupBodyKind, parseEditorMruKey, terminalEditorToggleTarget, toggleNoneHint, touchGroupMru, zoomedGroupOf, zoomHiding } from './group-focus.js'
import { neighborGroupId, neighborGroups, rightNeighborGroupId, type GroupDirection, type GroupNode } from './group-tree.js'
import { cycleAcrossGroups, cycleTabTarget } from './tab-actions.js'
import { worktreeReturnTarget } from './worktree-activate.js'

const leafNode = (groupId: string, tabOrder: string[] = [groupId.toLowerCase()], activeTabId: string | null = tabOrder[0] ?? null): GroupNode => ({ kind: 'leaf', group: { groupId, tabOrder, activeTabId } })
const split = (direction: 'row' | 'column', first: GroupNode, second: GroupNode, ratio = 0.5): GroupNode => ({ kind: 'split', direction, ratio, first, second })
const go = (root: GroupNode, groupId: string, direction: GroupDirection): string | null => neighborGroupId({ root, groupId, direction })

// 영역 3개 — 왼쪽 A(꽉 찬 열) | 오른쪽 열 위 B · 아래 C (가로·세로 섞인 배치, G1 배치와 같은 모양)
const three = split('row', leafNode('A'), split('column', leafNode('B'), leafNode('C')))

describe('neighborGroupId — 네 방향 이웃 영역(C1 · 823 rightNeighborGroupId 일반화)', () => {
  it('세 영역: A→오른쪽 = 위 B(겹침 같으면 위), B→왼쪽 = A, C→왼쪽 = A, B↓ = C, C↑ = B', () => {
    expect(go(three, 'A', 'right')).toBe('B')
    expect(go(three, 'B', 'left')).toBe('A')
    expect(go(three, 'C', 'left')).toBe('A')
    expect(go(three, 'B', 'down')).toBe('C')
    expect(go(three, 'C', 'up')).toBe('B')
  })
  it('그 방향 끝이면 null(무동작 — C1ⓔ)', () => {
    expect(go(three, 'A', 'left')).toBeNull()
    expect(go(three, 'A', 'up')).toBeNull()
    expect(go(three, 'A', 'down')).toBeNull()
    expect(go(three, 'B', 'up')).toBeNull()
    expect(go(three, 'C', 'down')).toBeNull()
    expect(go(three, 'B', 'right')).toBeNull()
    expect(go(leafNode('A'), 'A', 'right')).toBeNull()
  })
  it('위아래 이동의 동점은 왼쪽 — 위 꽉 찬 행 아래 두 칸이면 아래 = 왼쪽 칸', () => {
    const tree = split('column', leafNode('T'), split('row', leafNode('L'), leafNode('R')))
    expect(neighborGroups({ root: tree, groupId: 'T', direction: 'down' }).map((row) => row.groupId).sort()).toEqual(['L', 'R'])
    expect(go(tree, 'T', 'down')).toBe('L')
    expect(go(tree, 'R', 'up')).toBe('T')
  })
  it('겹침이 큰 쪽 — 아래 행이 30:70 이면 오른쪽', () => {
    const tree = split('column', leafNode('T'), split('row', leafNode('L'), leafNode('R'), 0.3))
    expect(go(tree, 'T', 'down')).toBe('R')
  })
  it('끝점만 닿는 것은 이웃이 아니다(2×2 대각)', () => {
    const grid = split('row', split('column', leafNode('A'), leafNode('C')), split('column', leafNode('B'), leafNode('D')))
    expect(neighborGroups({ root: grid, groupId: 'A', direction: 'right' }).map((row) => row.groupId)).toEqual(['B'])
    expect(go(grid, 'D', 'left')).toBe('C')
    expect(go(grid, 'D', 'up')).toBe('B')
  })
  it('오른쪽 판은 823 rightNeighborGroupId 와 같은 결과(옆으로 열기 회귀 0)', () => {
    const skew = split('row', split('column', leafNode('A'), leafNode('C')), split('column', leafNode('B'), leafNode('D'), 0.6))
    for (const root of [three, skew, split('row', leafNode('g1'), split('column', leafNode('g2'), leafNode('g3'), 0.3))])
      for (const groupId of ['A', 'B', 'C', 'D', 'g1', 'g2', 'g3']) expect(go(root, groupId, 'right')).toBe(rightNeighborGroupId({ root, groupId }))
  })
})

describe('cycleAcrossGroups — 이전/다음 탭이 영역을 넘는다(C5·P5, VS Code nextEditor)', () => {
  const groups = [
    { groupId: 'A', tabOrder: ['a1', 'file:x.ts'] },
    { groupId: 'E', tabOrder: [] },
    { groupId: 'B', tabOrder: ['b1', 'diff:w:x', 'b2'] },
  ]
  it('영역 안에 다음이 있으면 그것', () => {
    expect(cycleAcrossGroups({ groups, activeGroupId: 'A', activeTabId: 'a1', direction: 1 })).toEqual({ groupId: 'A', tabId: 'file:x.ts' })
    expect(cycleAcrossGroups({ groups, activeGroupId: 'B', activeTabId: 'b2', direction: -1 })).toEqual({ groupId: 'B', tabId: 'diff:w:x' })
  })
  it('영역 끝에서 다음 → 다음 영역 첫 탭(빈 영역 건너뜀), 처음에서 이전 → 이전 영역 마지막 탭', () => {
    expect(cycleAcrossGroups({ groups, activeGroupId: 'A', activeTabId: 'file:x.ts', direction: 1 })).toEqual({ groupId: 'B', tabId: 'b1' })
    expect(cycleAcrossGroups({ groups, activeGroupId: 'B', activeTabId: 'b1', direction: -1 })).toEqual({ groupId: 'A', tabId: 'file:x.ts' })
  })
  it('마지막 영역 끝 → 첫 영역 첫 탭(wrap), 첫 영역 처음 → 마지막 영역 마지막 탭', () => {
    expect(cycleAcrossGroups({ groups, activeGroupId: 'B', activeTabId: 'b2', direction: 1 })).toEqual({ groupId: 'A', tabId: 'a1' })
    expect(cycleAcrossGroups({ groups, activeGroupId: 'A', activeTabId: 'a1', direction: -1 })).toEqual({ groupId: 'B', tabId: 'b2' })
  })
  it('빈 영역이 활성이면 다음 영역 첫 탭 / 이전 영역 마지막 탭', () => {
    expect(cycleAcrossGroups({ groups, activeGroupId: 'E', activeTabId: null, direction: 1 })).toEqual({ groupId: 'B', tabId: 'b1' })
    expect(cycleAcrossGroups({ groups, activeGroupId: 'E', activeTabId: null, direction: -1 })).toEqual({ groupId: 'A', tabId: 'file:x.ts' })
  })
  it('영역이 하나면 cycleTabTarget 과 같은 결과(base 순환)', () => {
    const tabOrder = ['t1', 'file:a', 't3']
    for (const activeTabId of [...tabOrder, null])
      for (const direction of [1, -1] as const) {
        const base = cycleTabTarget({ tabOrder, activeTabId, direction })
        const across = cycleAcrossGroups({ groups: [{ groupId: 'g', tabOrder }], activeGroupId: 'g', activeTabId, direction })
        expect(across?.tabId ?? null).toBe(base === activeTabId ? null : base)
      }
  })
  it('탭이 하나뿐이고 영역도 하나면 null(그대로), 모르는 영역이면 null', () => {
    expect(cycleAcrossGroups({ groups: [{ groupId: 'g', tabOrder: ['t'] }], activeGroupId: 'g', activeTabId: 't', direction: 1 })).toBeNull()
    expect(cycleAcrossGroups({ groups, activeGroupId: 'Z', activeTabId: null, direction: 1 })).toBeNull()
  })
})

describe('terminalEditorToggleTarget — ⌃` 후보(C2·P2)', () => {
  const groups = [
    { groupId: 'A', activeTabId: 't1' },
    { groupId: 'B', activeTabId: 'file:a.ts' },
    { groupId: 'C', activeTabId: 'diff:w:x' },
    { groupId: 'D', activeTabId: 't2' },
  ]
  it('터미널 영역에서 → 편집기 영역, 여럿이면 영역 MRU 최근', () => {
    expect(terminalEditorToggleTarget({ groups, activeGroupId: 'A', recent: ['A', 'C', 'B'] })).toEqual({ kind: 'go', groupId: 'C' })
    expect(terminalEditorToggleTarget({ groups, activeGroupId: 'A', recent: ['B', 'C'] })).toEqual({ kind: 'go', groupId: 'B' })
  })
  it('편집기(파일·diff) 영역에서 → 터미널 영역(MRU 최근, 없으면 배치 순서 첫)', () => {
    expect(terminalEditorToggleTarget({ groups, activeGroupId: 'B', recent: ['D'] })).toEqual({ kind: 'go', groupId: 'D' })
    expect(terminalEditorToggleTarget({ groups, activeGroupId: 'C', recent: [] })).toEqual({ kind: 'go', groupId: 'A' })
  })
  it('빈 영역이면 터미널 쪽으로', () => {
    expect(terminalEditorToggleTarget({ groups: [{ groupId: 'E', activeTabId: null }, ...groups], activeGroupId: 'E', recent: [] })).toEqual({ kind: 'go', groupId: 'A' })
  })
  it('후보 0 이면 none + 찾던 종류(안내 한 줄 — 무음 실패 0)', () => {
    const only = [{ groupId: 'A', activeTabId: 't1' }, { groupId: 'B', activeTabId: 't2' }]
    expect(terminalEditorToggleTarget({ groups: only, activeGroupId: 'A', recent: [] })).toEqual({ kind: 'none', want: 'editor' })
    expect(terminalEditorToggleTarget({ groups: [{ groupId: 'B', activeTabId: 'file:a' }], activeGroupId: 'B', recent: [] })).toEqual({ kind: 'none', want: 'terminal' })
    expect(toggleNoneHint('editor')).toContain('편집기')
    expect(toggleNoneHint('terminal')).toContain('터미널')
  })
  it('groupBodyKind — 파일·diff = editor, 터미널 = terminal, 없음 = empty', () => {
    expect([groupBodyKind('t1'), groupBodyKind('file:a'), groupBodyKind('diff:w:x'), groupBodyKind(null)]).toEqual(['terminal', 'editor', 'editor', 'empty'])
  })
})

describe('touchGroupMru — 영역 MRU(앞이 최근, 중복 없음)', () => {
  it('맨 앞으로 옮긴다', () => {
    expect(touchGroupMru({ history: [], groupId: 'A' })).toEqual(['A'])
    expect(touchGroupMru({ history: ['A', 'B', 'C'], groupId: 'C' })).toEqual(['C', 'A', 'B'])
  })
})

describe('editorMruKey — ⌃Tab MRU 의 파일·diff 탭 키(C4ⓐ, 탭 id 체계 무변경)', () => {
  it('왕복하고 pane id 는 편집기 키가 아니다', () => {
    const key = editorMruKey({ worktreePath: '/r/w', tabId: 'file:src/a.ts' })
    expect(parseEditorMruKey(key)).toEqual({ worktreePath: '/r/w', tabId: 'file:src/a.ts' })
    expect(parseEditorMruKey('w1:p1')).toBeNull()
    expect(editorMruKey({ worktreePath: '/r/x', tabId: 'file:src/a.ts' })).not.toBe(key)
  })
})

describe('줌 해제 판정(P6 Zⓐⓑ)', () => {
  const groups = [
    { groupId: 'g1', panes: [{ paneId: 'p1' }, { paneId: 'p2' }], zoomedPaneId: 'p1' },
    { groupId: 'g2', panes: [{ paneId: 'p3' }, { paneId: 'p4' }], zoomedPaneId: null },
  ]
  it('zoomedGroupOf — 줌 중 영역의 pane 을 쪼개면 그 영역(줌을 푼다), 줌이 아니면 null', () => {
    expect(zoomedGroupOf({ groups, paneId: 'p1' })).toBe('g1')
    expect(zoomedGroupOf({ groups, paneId: 'p3' })).toBeNull()
    expect(zoomedGroupOf({ groups, paneId: 'zz' })).toBeNull()
  })
  it('zoomHiding — 줌에 가려진 pane 을 고르면 그 영역, 줌한 pane 자신·줌 없음은 null', () => {
    expect(zoomHiding({ groups, paneId: 'p2' })).toBe('g1')
    expect(zoomHiding({ groups, paneId: 'p1' })).toBeNull()
    expect(zoomHiding({ groups, paneId: 'p4' })).toBeNull()
  })
})

describe('worktreeReturnTarget — worktree 복귀(C7·P4)', () => {
  const layout = { root: split('row', leafNode('g1', ['t1', 'file:a.ts'], 'file:a.ts'), leafNode('g2', ['t2'], 't2')), activeGroupId: 'g1' }
  it('저장 배치의 활성 영역·활성 탭 — 파일 탭이어도 그대로', () => {
    expect(worktreeReturnTarget({ layout, liveTabIds: ['t1', 't2'] })).toEqual({ groupId: 'g1', tabId: 'file:a.ts' })
    expect(worktreeReturnTarget({ layout: { ...layout, activeGroupId: 'g2' }, liveTabIds: ['t1', 't2'] })).toEqual({ groupId: 'g2', tabId: 't2' })
  })
  it('배치 없음·활성 탭 없음·죽은 터미널 탭이면 null(옛 규칙 tabs[0])', () => {
    expect(worktreeReturnTarget({ layout: null, liveTabIds: ['t1'] })).toBeNull()
    expect(worktreeReturnTarget({ layout: { root: leafNode('g1', [], null), activeGroupId: 'g1' }, liveTabIds: ['t1'] })).toBeNull()
    expect(worktreeReturnTarget({ layout: { ...layout, activeGroupId: 'g2' }, liveTabIds: ['t1'] })).toBeNull()
  })
})

describe('yieldsToEditor — 편집기 양보는 방향·조합 단위(C1ⓓ)', () => {
  const at = (binding: string): boolean => {
    const match = matchBinding(binding, {})
    if (match === null) throw new Error(`no match: ${binding}`)
    return yieldsToEditor({ match, binding })
  }
  it('⌘⌥←→ 는 앱이 가져간다(영역 이동), ⌘⌥↑↓(커서 추가)·⌘⌥⇧방향(열 선택)은 편집기에', () => {
    expect(at('Mod+Alt+ArrowLeft')).toBe(false)
    expect(at('Mod+Alt+ArrowRight')).toBe(false)
    expect(at('Mod+Alt+ArrowUp')).toBe(true)
    expect(at('Mod+Alt+ArrowDown')).toBe(true)
    for (const arrow of ['Left', 'Right', 'Up', 'Down']) expect(at(`Mod+Alt+Shift+Arrow${arrow}`)).toBe(true)
  })
  it('⌘D·⌘⇧Z 는 그대로 양보, ⌃` 는 양보하지 않는다', () => {
    expect(at('Mod+D')).toBe(true)
    expect(at('Mod+Shift+Z')).toBe(true)
    expect(at('Control+`')).toBe(false)
  })
})
