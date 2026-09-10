// 세션 내부 상태 저장소 — workspace / tab / pane 을 id 키 맵으로 들고 있는다.
//
// **멱등성은 설계로 확보한다** (스파이크 제약 3): create = 맵에 set, close = 맵에서 delete.
// 같은 이벤트를 두 번 적용해도 결과가 같다. 부트스트랩에서 실제로 중복 create 가 나온다.
//
// pane 수·tab 수는 스냅샷이 준 카운터를 믿지 않고 **맵에서 센다.** 카운터를 믿으면 중복 적용이
// 숫자를 흔든다. 실측(raw/claude/20-*)에서 workspace_closed 는 그 안 pane 의 pane_closed 를
// 따로 보내지 않으므로, workspace 를 지울 때 그 workspace 의 pane·tab 도 함께 지운다.

import type { AgentStatus, PaneRow, WorkspaceRow } from '../../shared/types.js'
import { isRecord, readAgentStatus, readNumber, readRecord, readString, type PushFrame } from './protocol.js'

type Workspace = {
  workspaceId: string
  label: string
  number: number
  agentStatus: AgentStatus
  focused: boolean
  repoName: string | null
  repoRoot: string | null
  isLinkedWorktree: boolean | null
}

type Pane = {
  paneId: string
  workspaceId: string
  tabId: string
  agentStatus: AgentStatus
  agent: string | null
  title: string
  cwd: string | null
  focused: boolean
}

/** repo 층 — 스냅샷이 아니라 worktree.list 로 채운다 (link 가 넣어 준다). */
export type RepoInfo = {
  repoName: string | null
  repoRoot: string | null
  branch: string | null
  isLinkedWorktree: boolean | null
  source: 'snapshot' | 'worktree.list' | 'none'
}
type Tab = { tabId: string; workspaceId: string }

export type ApplyResult = { changed: boolean; note: string }

/**
 * **실측(raw/claude/27-push-ordering.json)**: 흔들기를 촘촘히 돌리면 herdr 가 같은 workspace 의
 * `workspace_created` 를 `workspace_closed` **뒤에** 밀어 넣는다 (create 는 workspace 가 실제로
 * 다 서고 나서 알려지기 때문이다). 그대로 적용하면 이미 죽은 workspace 가 목록에 되살아난다.
 *
 * 푸시에는 시퀀스 번호가 없으므로 시간창으로 막는다 — 닫힌 지 이 시간 안에 도착한 create 는
 * "늦게 온 과거"로 보고 버린다. 스냅샷은 권위이므로 스냅샷을 적용하면 이 기록도 지운다.
 */
const LATE_CREATE_WINDOW_MS = 5000

export class WorkspaceStore {
  private workspaces = new Map<string, Workspace>()
  private panes = new Map<string, Pane>()
  private tabs = new Map<string, Tab>()
  private repos = new Map<string, RepoInfo>()
  private closedAt = new Map<string, number>()

  reset(): void {
    this.workspaces.clear()
    this.panes.clear()
    this.tabs.clear()
    this.repos.clear()
    this.closedAt.clear()
  }

  /** worktree.list 로 알아낸 repo 정보를 붙인다. workspace 가 사라지면 같이 지운다. */
  setRepo(workspaceId: string, repo: RepoInfo): void {
    this.repos.set(workspaceId, repo)
  }

  /** 아직 repo 를 못 붙인 workspace 들 — link 가 이걸 보고 조회한다. */
  workspacesMissingRepo(): Array<{ workspaceId: string; cwd: string | null }> {
    const out: Array<{ workspaceId: string; cwd: string | null }> = []
    for (const workspace of this.workspaces.values()) {
      if (this.repos.has(workspace.workspaceId)) continue
      const pane = [...this.panes.values()].find((item) => item.workspaceId === workspace.workspaceId)
      out.push({ workspaceId: workspace.workspaceId, cwd: pane?.cwd ?? null })
    }
    return out
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
      case 'workspace_metadata_updated': {
        const workspace = data['workspace']
        const id = isRecord(workspace) ? readString(workspace, 'workspace_id') : null
        if (id !== null && this.recentlyClosed(id)) {
          return { changed: false, note: `${frame.event}: 닫힌 뒤 늦게 온 create — 버린다 (${id})` }
        }
        return { changed: this.putWorkspace(workspace), note: frame.event }
      }

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
        this.closedAt.set(id, Date.now())
        this.repos.delete(id)
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

      case 'tab_created': {
        const added = this.putTab(data['tab'])
        return { changed: added, note: added ? frame.event : 'tab_created: 모르는 workspace 의 고아 — 버린다' }
      }

      case 'tab_closed': {
        const id = readString(data, 'tab_id')
        if (id === null) return { changed: false, note: 'tab_closed 필드 부족' }
        const had = this.tabs.delete(id)
        return { changed: had, note: had ? frame.event : 'tab_closed: 이미 없음(멱등)' }
      }

      case 'pane_created':
      case 'pane_updated': {
        const added = this.putPane(data['pane'])
        return { changed: added, note: added ? frame.event : `${frame.event}: 모르는 workspace 의 고아 — 버린다` }
      }

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
    const panesByWorkspace = new Map<string, PaneRow[]>()
    for (const pane of this.panes.values()) {
      const list = panesByWorkspace.get(pane.workspaceId) ?? []
      list.push({
        paneId: pane.paneId,
        workspaceId: pane.workspaceId,
        tabId: pane.tabId,
        title: pane.title,
        agent: pane.agent,
        agentStatus: pane.agentStatus,
        cwd: pane.cwd,
        focused: pane.focused,
      })
      panesByWorkspace.set(pane.workspaceId, list)
    }
    for (const list of panesByWorkspace.values()) list.sort((a, b) => a.paneId.localeCompare(b.paneId))
    const tabCounts = new Map<string, number>()
    for (const tab of this.tabs.values()) {
      tabCounts.set(tab.workspaceId, (tabCounts.get(tab.workspaceId) ?? 0) + 1)
    }

    const rows: WorkspaceRow[] = []
    for (const workspace of this.workspaces.values()) {
      const panes = panesByWorkspace.get(workspace.workspaceId) ?? []
      const repo = this.repos.get(workspace.workspaceId) ?? null
      rows.push({
        workspaceId: workspace.workspaceId,
        label: workspace.label,
        number: workspace.number,
        // 스냅샷의 pane_count 카운터를 믿지 않고 맵에서 센다 — 중복 적용에도 숫자가 안 흔들린다.
        paneCount: panes.length,
        tabCount: tabCounts.get(workspace.workspaceId) ?? 0,
        agentStatus: workspace.agentStatus,
        focused: workspace.focused,
        repoName: repo?.repoName ?? workspace.repoName,
        repoRoot: repo?.repoRoot ?? workspace.repoRoot,
        branch: repo?.branch ?? null,
        isLinkedWorktree: repo?.isLinkedWorktree ?? workspace.isLinkedWorktree,
        repoSource: repo?.source ?? (workspace.repoName === null ? 'none' : 'snapshot'),
        panes,
      })
    }
    rows.sort((a, b) => a.number - b.number || a.workspaceId.localeCompare(b.workspaceId))
    return rows
  }

  /** 닫힌 지 얼마 안 된 id 인가. 겸사겸사 오래된 기록을 턴다. */
  private recentlyClosed(workspaceId: string): boolean {
    const now = Date.now()
    for (const [key, at] of this.closedAt) if (now - at > LATE_CREATE_WINDOW_MS) this.closedAt.delete(key)
    const at = this.closedAt.get(workspaceId)
    return at !== undefined && now - at <= LATE_CREATE_WINDOW_MS
  }

  paneIds(): string[] {
    return [...this.panes.keys()].sort()
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
      repoRoot: worktree === null ? null : readString(worktree, 'repo_root'),
      isLinkedWorktree: worktree === null ? null : worktree['is_linked_worktree'] === true,
    })
    return true
  }

  /**
   * pane 은 그 workspace 가 있을 때만 들고 있는다.
   *
   * 실측: 흔들기를 촘촘히 돌리면 `workspace_closed` 가 그 workspace 의 `pane_created` 보다
   * **먼저** 도착한다 (pane 은 PTY 가 실제로 뜬 뒤 알려지기 때문이다). 그때 pane 을 그냥 넣으면
   * 주인 없는 고아가 남는다 — 화면에는 안 보이지만 수렴 비교가 어긋나고 맵이 샌다.
   */
  private putPane(value: unknown): boolean {
    if (!isRecord(value)) return false
    const id = readString(value, 'pane_id')
    const workspaceId = readString(value, 'workspace_id')
    if (id === null || workspaceId === null) return false
    if (!this.workspaces.has(workspaceId)) return false
    this.panes.set(id, {
      paneId: id,
      workspaceId,
      tabId: readString(value, 'tab_id') ?? '',
      agentStatus: readAgentStatus(value, 'agent_status'),
      agent: readString(value, 'display_agent') ?? readString(value, 'agent'),
      title:
        readString(value, 'title') ??
        readString(value, 'terminal_title_stripped') ??
        readString(value, 'terminal_title') ??
        readString(value, 'label') ??
        id,
      cwd: readString(value, 'foreground_cwd') ?? readString(value, 'cwd'),
      focused: value['focused'] === true,
    })
    return true
  }

  /** tab 도 pane 과 같은 이유로 workspace 가 있을 때만 들고 있는다. */
  private putTab(value: unknown): boolean {
    if (!isRecord(value)) return false
    const id = readString(value, 'tab_id')
    const workspaceId = readString(value, 'workspace_id')
    if (id === null || workspaceId === null) return false
    if (!this.workspaces.has(workspaceId)) return false
    this.tabs.set(id, { tabId: id, workspaceId })
    return true
  }
}
