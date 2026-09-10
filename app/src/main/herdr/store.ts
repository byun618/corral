// 세션 내부 상태 저장소 — workspace / tab / pane 을 id 키 맵으로 들고 있는다.
//
// **멱등성은 설계로 확보한다** (스파이크 제약 3): create = 맵에 set, close = 맵에서 delete.
// 같은 이벤트를 두 번 적용해도 결과가 같다. 부트스트랩에서 실제로 중복 create 가 나온다.
//
// pane 수·tab 수는 스냅샷이 준 카운터를 믿지 않고 **맵에서 센다.** 카운터를 믿으면 중복 적용이
// 숫자를 흔든다. 실측(raw/claude/20-*)에서 workspace_closed 는 그 안 pane 의 pane_closed 를
// 따로 보내지 않으므로, workspace 를 지울 때 그 workspace 의 pane·tab 도 함께 지운다.

import type { AgentStatus, WorkspaceRow } from '../../shared/types.js'
import { isRecord, readAgentStatus, readNumber, readRecord, readString, type PushFrame } from './protocol.js'

type Workspace = {
  workspaceId: string
  label: string
  number: number
  agentStatus: AgentStatus
  focused: boolean
  repoName: string | null
}

type Pane = { paneId: string; workspaceId: string; agentStatus: AgentStatus; agent: string | null }
type Tab = { tabId: string; workspaceId: string }

export type ApplyResult = { changed: boolean; note: string }

export class WorkspaceStore {
  private workspaces = new Map<string, Workspace>()
  private panes = new Map<string, Pane>()
  private tabs = new Map<string, Tab>()

  reset(): void {
    this.workspaces.clear()
    this.panes.clear()
    this.tabs.clear()
  }

  /** `session.snapshot` 의 result.snapshot 을 통째로 적용한다. */
  applySnapshot(snapshot: unknown): ApplyResult {
    if (!isRecord(snapshot)) return { changed: false, note: 'snapshot 모양이 아니다' }
    const inner = readRecord(snapshot, 'snapshot') ?? snapshot
    this.reset()
    const workspaces = inner['workspaces']
    if (Array.isArray(workspaces)) for (const item of workspaces) this.putWorkspace(item)
    const tabs = inner['tabs']
    if (Array.isArray(tabs)) for (const item of tabs) this.putTab(item)
    const panes = inner['panes']
    if (Array.isArray(panes)) for (const item of panes) this.putPane(item)
    return {
      changed: true,
      note: `workspaces=${this.workspaces.size} tabs=${this.tabs.size} panes=${this.panes.size}`,
    }
  }

  /** push 봉투 1건 적용. 모르는 이벤트는 조용히 무시하지 않고 note 에 남긴다. */
  applyEvent(frame: PushFrame): ApplyResult {
    const data = frame.data
    switch (frame.event) {
      case 'workspace_created':
      case 'workspace_updated':
      case 'workspace_metadata_updated':
        return { changed: this.putWorkspace(data['workspace']), note: frame.event }

      case 'workspace_renamed': {
        const id = readString(data, 'workspace_id')
        const label = readString(data, 'label')
        if (id === null || label === null) return { changed: false, note: 'workspace_renamed 필드 부족' }
        const existing = this.workspaces.get(id)
        if (!existing) return { changed: false, note: 'workspace_renamed: 모르는 workspace' }
        this.workspaces.set(id, { ...existing, label })
        return { changed: true, note: frame.event }
      }

      case 'workspace_closed': {
        const id = readString(data, 'workspace_id')
        if (id === null) return { changed: false, note: 'workspace_closed 필드 부족' }
        const had = this.workspaces.delete(id)
        for (const [paneId, pane] of this.panes) if (pane.workspaceId === id) this.panes.delete(paneId)
        for (const [tabId, tab] of this.tabs) if (tab.workspaceId === id) this.tabs.delete(tabId)
        return { changed: had, note: had ? frame.event : 'workspace_closed: 이미 없음(멱등)' }
      }

      case 'workspace_moved':
      case 'workspace_reordered': {
        const list = data['workspaces']
        if (!Array.isArray(list)) return { changed: false, note: `${frame.event}: workspaces 없음` }
        for (const item of list) this.putWorkspace(item)
        return { changed: true, note: frame.event }
      }

      case 'workspace_focused': {
        const id = readString(data, 'workspace_id')
        if (id === null) return { changed: false, note: 'workspace_focused 필드 부족' }
        let changed = false
        for (const [key, workspace] of this.workspaces) {
          const focused = key === id
          if (workspace.focused !== focused) {
            this.workspaces.set(key, { ...workspace, focused })
            changed = true
          }
        }
        return { changed, note: frame.event }
      }

      case 'tab_created':
        return { changed: this.putTab(data['tab']), note: frame.event }

      case 'tab_closed': {
        const id = readString(data, 'tab_id')
        if (id === null) return { changed: false, note: 'tab_closed 필드 부족' }
        const had = this.tabs.delete(id)
        return { changed: had, note: had ? frame.event : 'tab_closed: 이미 없음(멱등)' }
      }

      case 'pane_created':
      case 'pane_updated':
        return { changed: this.putPane(data['pane']), note: frame.event }

      case 'pane_closed': {
        const id = readString(data, 'pane_id')
        if (id === null) return { changed: false, note: 'pane_closed 필드 부족' }
        const had = this.panes.delete(id)
        return { changed: had, note: had ? frame.event : 'pane_closed: 이미 없음(멱등)' }
      }

      case 'pane_exited': {
        // pane 은 남고 프로세스만 끝난 것이다 — 목록에서 지우지 않는다.
        return { changed: false, note: 'pane_exited: 카운트에 영향 없음' }
      }

      case 'layout_updated':
        return { changed: false, note: 'layout_updated: 목록에 영향 없음' }

      default:
        return { changed: false, note: `모르는 이벤트: ${frame.event}` }
    }
  }

  rows(): WorkspaceRow[] {
    const paneCounts = new Map<string, number>()
    const paneAgents = new Map<string, string[]>()
    for (const pane of this.panes.values()) {
      paneCounts.set(pane.workspaceId, (paneCounts.get(pane.workspaceId) ?? 0) + 1)
      const list = paneAgents.get(pane.workspaceId) ?? []
      list.push(pane.agent === null ? pane.agentStatus : `${pane.agent}:${pane.agentStatus}`)
      paneAgents.set(pane.workspaceId, list)
    }
    const tabCounts = new Map<string, number>()
    for (const tab of this.tabs.values()) {
      tabCounts.set(tab.workspaceId, (tabCounts.get(tab.workspaceId) ?? 0) + 1)
    }

    const rows: WorkspaceRow[] = []
    for (const workspace of this.workspaces.values()) {
      rows.push({
        workspaceId: workspace.workspaceId,
        label: workspace.label,
        number: workspace.number,
        // 스냅샷의 pane_count 카운터를 믿지 않고 맵에서 센다 — 중복 적용에도 숫자가 안 흔들린다.
        paneCount: paneCounts.get(workspace.workspaceId) ?? 0,
        tabCount: tabCounts.get(workspace.workspaceId) ?? 0,
        agentStatus: workspace.agentStatus,
        focused: workspace.focused,
        repoName: workspace.repoName,
        paneAgents: paneAgents.get(workspace.workspaceId) ?? [],
      })
    }
    rows.sort((a, b) => a.number - b.number || a.workspaceId.localeCompare(b.workspaceId))
    return rows
  }

  /** K1 수렴 비교용 — id 집합만 뽑는다. */
  ids(): { workspaces: string[]; tabs: string[]; panes: string[] } {
    return {
      workspaces: [...this.workspaces.keys()].sort(),
      tabs: [...this.tabs.keys()].sort(),
      panes: [...this.panes.keys()].sort(),
    }
  }

  private putWorkspace(value: unknown): boolean {
    if (!isRecord(value)) return false
    const id = readString(value, 'workspace_id')
    if (id === null) return false
    const worktree = readRecord(value, 'worktree')
    this.workspaces.set(id, {
      workspaceId: id,
      label: readString(value, 'label') ?? id,
      number: readNumber(value, 'number') ?? 0,
      agentStatus: readAgentStatus(value, 'agent_status'),
      focused: value['focused'] === true,
      repoName: worktree === null ? null : readString(worktree, 'repo_name'),
    })
    return true
  }

  private putPane(value: unknown): boolean {
    if (!isRecord(value)) return false
    const id = readString(value, 'pane_id')
    const workspaceId = readString(value, 'workspace_id')
    if (id === null || workspaceId === null) return false
    this.panes.set(id, {
      paneId: id,
      workspaceId,
      agentStatus: readAgentStatus(value, 'agent_status'),
      agent: readString(value, 'display_agent') ?? readString(value, 'agent'),
    })
    return true
  }

  private putTab(value: unknown): boolean {
    if (!isRecord(value)) return false
    const id = readString(value, 'tab_id')
    const workspaceId = readString(value, 'workspace_id')
    if (id === null || workspaceId === null) return false
    this.tabs.set(id, { tabId: id, workspaceId })
    return true
  }
}
