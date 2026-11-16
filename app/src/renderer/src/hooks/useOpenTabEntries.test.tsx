// @vitest-environment happy-dom
// LIFE-496 D36 — omnibox 의 열린 탭 제목은 탭 스트립 제목과 같아야 한다 (리뷰 r1 R1-05).
// 부팅 순서: state 가 UI prefs 보다 먼저 오면, 폴백 번호 배정표(`tabOrdinals`)를 싣기 전에 목록이 만들어진다.
// 그 뒤 `hydrate` 로 번호가 7 로 바뀌면 스트립은 `terminal 7` 을 그린다. 검색 목록도 같은 이름이어야 한다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyAgentState } from '../../../shared/agent-state.js'
import { EMPTY_SESSION_DIGEST, type PaneRow, type TabRow, type WorkspaceRow } from '../../../shared/types.js'
import { tabOrdinals } from '../fallback-ordinal.js'
import type { TabGroup } from '../group-tree.js'
import { sessionTitle } from '../session-title.js'
import type { OpenTabSearchEntry } from '../tab-create-menu.js'
import { useOpenTabEntries } from './useOpenTabEntries.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const pane = ({ paneId, tabId }: { paneId: string; tabId: string }): PaneRow => ({
  paneId, tabId, workspaceId: 'w1', title: '', agent: null, agentStatus: 'idle', agentState: emptyAgentState(0), cwd: null, focused: false, agentSession: null,
  digest: EMPTY_SESSION_DIGEST,
})
const tab = ({ tabId, order }: { tabId: string; order: number }): TabRow => ({
  tabId, workspaceId: 'w1', label: '', number: order + 1, order, agentStatus: 'idle', focused: false, panes: [pane({ paneId: `p-${tabId}`, tabId })], digest: EMPTY_SESSION_DIGEST,
})
const workspace: WorkspaceRow = { workspaceId: 'w1', label: 'w1', number: 1, agentStatus: 'idle', focused: true, tabs: [tab({ tabId: 't1', order: 0 }), tab({ tabId: 't2', order: 1 })] }
const groups: TabGroup[] = [{ groupId: 'g1', tabOrder: ['t1', 't2'], activeTabId: 't1' }]

let host: HTMLDivElement
let root: Root
let seen: OpenTabSearchEntry[] = []
function Harness({ ordinalsReady }: { ordinalsReady: boolean }): null {
  seen = useOpenTabEntries({ workspace, worktree: null, groups, activeGroupId: 'g1', home: null, selectedPane: null, ordinalsReady })
  return null
}
/** 탭 스트립이 그리는 제목 — `MainTabBar` 와 같은 식(렌더마다 배정표를 읽는다). */
const stripTitle = (row: TabRow): string =>
  sessionTitle({ tab: row, tabCount: workspace.tabs.length, ordinal: tabOrdinals.ordinalFor({ tabId: row.tabId, groupId: row.workspaceId }), home: null, selectedPaneId: null })

beforeEach(() => {
  tabOrdinals.hydrate([])
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  tabOrdinals.hydrate([])
})

describe('useOpenTabEntries — 번호 복원 뒤 제목 (R1-05)', () => {
  it('배정표를 싣기 전에 만든 목록이 복원 뒤에도 옛 번호로 남지 않는다 — 스트립 제목과 같다', () => {
    act(() => root.render(createElement(Harness, { ordinalsReady: false })))
    tabOrdinals.hydrate([{ tabId: 't1', groupId: 'w1', ordinal: 7 }, { tabId: 't2', groupId: 'w1', ordinal: 3 }])
    act(() => root.render(createElement(Harness, { ordinalsReady: true })))
    const [first, second] = workspace.tabs
    expect(seen.map((entry) => entry.title)).toEqual([stripTitle(first!), stripTitle(second!)])
    expect(seen[0]?.title).toContain('7')
  })
})

describe('useOpenTabEntries — 파일·diff 탭도 싣는다 (LIFE-824 C4ⓑ)', () => {
  it('영역 순서·탭 순서대로 터미널 사이에 파일·diff 탭, 제목은 탭 스트립과 같은 이름, 현재 탭 표지', () => {
    const mixed: TabGroup[] = [
      { groupId: 'g1', tabOrder: ['t1', 'file:src/a.ts'], activeTabId: 'file:src/a.ts' },
      { groupId: 'g2', tabOrder: ['diff:["wt","b.ts",null]', 't2'], activeTabId: 't2' },
    ]
    function Mixed(): null {
      seen = useOpenTabEntries({ workspace, worktree: null, groups: mixed, activeGroupId: 'g1', home: null, selectedPane: null, ordinalsReady: true })
      return null
    }
    act(() => root.render(createElement(Mixed)))
    expect(seen.map((entry) => [entry.tabId, entry.groupId, entry.groupIndex, entry.tabIndex])).toEqual([
      ['t1', 'g1', 0, 0],
      ['file:src/a.ts', 'g1', 0, 1],
      ['diff:["wt","b.ts",null]', 'g2', 1, 0],
      ['t2', 'g2', 1, 1],
    ])
    const file = seen.find((entry) => entry.tabId === 'file:src/a.ts')
    expect(file).toMatchObject({ title: 'a.ts', agent: null, isCurrent: true })
    expect(seen.find((entry) => entry.tabId.startsWith('diff:'))?.title).toContain('b.ts')
  })
})
