// 세션 내부 상태 저장소 — workspace / tab / pane 을 id 키 맵으로 들고 있는다.
//
// **멱등성은 설계로 확보한다** (스파이크 제약 3): create = 맵에 set, close = 맵에서 delete.
// 같은 이벤트를 두 번 적용해도 결과가 같다. 부트스트랩에서 실제로 중복 create 가 나온다.
//
// pane 수·tab 수는 스냅샷이 준 카운터를 믿지 않고 **맵에서 센다.** 카운터를 믿으면 중복 적용이
// 숫자를 흔든다. 실측(raw/claude/20-*)에서 workspace_closed 는 그 안 pane 의 pane_closed 를
// 따로 보내지 않으므로, workspace 를 지울 때 그 workspace 의 pane·tab 도 함께 지운다.

import type { AgentStatus, PaneRow, RepoGroupRow, TabRow, WorkspaceRow, WorktreeRow } from '../../shared/types.js'
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
  /**
   * L7 — 이 pane 이 마지막으로 **바뀐** 시각. herdr 는 pane 에 타임스탬프를 주지 않으므로
   * corral 이 직접 찍는다. 근거는 `pane.updated` 의 `revision` 이 이벤트 경로에서 실제로
   * 움직인다는 실측이다 (`36-agent-status-and-revision.json` — LIFE-342 §2.2 의 미검증 공백).
   * 스냅샷으로 처음 알게 된 pane 은 `null` 이다 — 언제 바뀌었는지 모르는 것을 0초로 적지 않는다.
   */
  lastRevision: number | null
  changedAt: number | null
}

/** repo 층 — 스냅샷이 아니라 worktree.list 로 채운다 (link 가 넣어 준다). */
export type RepoInfo = {
  repoName: string | null
  repoRoot: string | null
  branch: string | null
  isLinkedWorktree: boolean | null
  source: 'snapshot' | 'worktree.list' | 'none'
  /** 이 workspace 가 열고 있는 checkout 경로 — worktree 행과 짝짓는 열쇠 */
  checkoutPath: string | null
  /** 그 repo 의 worktree **전부**. 1회차는 cwd 에 맞는 하나만 쓰고 나머지를 버렸다 (판정문 2회차) */
  worktrees: WorktreeRow[]
}
type Tab = {
  tabId: string
  workspaceId: string
  label: string
  number: number
  agentStatus: AgentStatus
  focused: boolean
  /** 스냅샷/푸시가 준 카운터. 맵에서 센 수와 다를 수 있어 **믿지 않고 그대로 싣기만** 한다 */
  snapshotPaneCount: number | null
}

export type ApplyResult = { changed: boolean; note: string }

/**
 * **실측(raw/claude/27-push-ordering.json)**: 흔들기를 촘촘히 돌리면 herdr 가 같은 workspace 의
 * `workspace_created` 를 `workspace_closed` **뒤에** 밀어 넣는다 (create 는 workspace 가 실제로
 * 다 서고 나서 알려지기 때문이다). 그대로 적용하면 이미 죽은 workspace 가 목록에 되살아난다.
 *
 * 1회차는 이걸 **시간창**(5000ms)으로 막았다. 시간창은 틀린 도구다 — 뒤집힘 지연이 부하를 따라
 * 늘어난다. 4갈래로 흔들 때 최대 214ms 였던 것이 6갈래·8초에서는 **1374ms** 까지 갔고, 창을
 * 넘긴 create 가 죽은 workspace 46개를 되살렸다 (28-orphan-holding.json 의 1차 측정).
 *
 * 그래서 창을 버리고 **묘비**로 바꾼다. 근거는 실측이다 — `workspace_id` 는 **서버 생애 안에서
 * 재사용되지 않는다**(29-id-reuse.json: 40회 연속 생성·종료, 중복 0). 그러므로 한 번 닫힌 id 로
 * 오는 create 는 **언제 오든** 늦게 온 과거다. 시간을 볼 필요가 없다.
 *
 * id 는 서버를 재기동하면 처음으로 되돌아간다(같은 측정). 그건 문제가 되지 않는다 — 생애가
 * 바뀌는 유일한 경로가 재부트스트랩이고, 재부트스트랩은 `applySnapshot` → `reset()` 으로 묘비를
 * 지운 **뒤에** 버퍼를 적용한다. 29-id-reuse.json 의 ③ 이 그걸 실측으로 확인한다.
 */

/**
 * 주인보다 **먼저** 온 pane/tab 을 담아 두는 창. 여기는 시간창이 맞다 — 주인이 영영 안 오는
 * 경우가 있어서(그 workspace 가 닫힌 경우) 무한정 들고 있을 수는 없다. 넉넉히 잡는다:
 * 너무 일찍 버리면 pane 을 잃고, 오래 들고 있으면 잠깐 메모리만 쓴다. 대칭이 아니다.
 */
const ORPHAN_HOLD_MS = 5000

/** 주인 workspace 보다 먼저 도착한 pane/tab. 창이 지나면 턴다. */
type Orphan = { at: number; workspaceId: string; kind: 'pane' | 'tab'; value: Record<string, unknown> }

export class WorkspaceStore {
  private workspaces = new Map<string, Workspace>()
  private panes = new Map<string, Pane>()
  private tabs = new Map<string, Tab>()
  private repos = new Map<string, RepoInfo>()
  /** 이 생애에서 닫힌 workspace 의 묘비. 재사용되지 않는 id 이므로 시간을 재지 않는다. */
  private closed = new Set<string>()
  private orphans: Orphan[] = []

  reset(): void {
    this.workspaces.clear()
    this.panes.clear()
    this.tabs.clear()
    this.repos.clear()
    this.closed.clear()
    this.orphans = []
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
        if (id !== null && this.closed.has(id)) {
          return { changed: false, note: `${frame.event}: 닫힌 뒤 늦게 온 것 — 버린다 (${id})` }
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
        this.closed.add(id)
        this.repos.delete(id)
        // 주인이 닫혔으면 그 주인을 기다리던 보류분도 의미가 없다.
        this.orphans = this.orphans.filter((item) => item.workspaceId !== id)
        for (const [paneId, pane] of this.panes) if (pane.workspaceId === id) this.panes.delete(paneId)
        for (const [tabId, tab] of this.tabs) if (tab.workspaceId === id) this.tabs.delete(tabId)
        return { changed: had, note: had ? frame.event : 'workspace_closed: 이미 없음(멱등)' }
      }

      case 'workspace_moved':
      case 'workspace_reordered': {
        const list = data['workspaces']
        if (!Array.isArray(list)) return { changed: false, note: `${frame.event}: workspaces 없음` }
        // 여기도 묘비를 본다 — 순서가 뒤집히면 이 목록으로도 죽은 workspace 가 되살아난다.
        for (const item of list) {
          const id = isRecord(item) ? readString(item, 'workspace_id') : null
          if (id !== null && this.closed.has(id)) continue
          this.putWorkspace(item)
        }
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
        return { changed: added, note: added ? frame.event : 'tab_created: 주인 없음 — 보류함' }
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
        return { changed: added, note: added ? frame.event : `${frame.event}: 주인 없음 — 보류함` }
      }

      case 'pane_closed': {
        const id = readString(data, 'pane_id')
        if (id === null) return { changed: false, note: 'pane_closed 필드 부족' }
        const had = this.panes.delete(id)
        return { changed: had, note: had ? frame.event : 'pane_closed: 이미 없음(멱등)' }
      }

      case 'pane_agent_status_changed':
        return this.applyAgentStatus(data)

      case 'pane_agent_detected': {
        const paneId = readString(data, 'pane_id')
        if (paneId === null) return { changed: false, note: 'agent_detected 필드 부족' }
        const pane = this.panes.get(paneId)
        if (!pane) return { changed: false, note: `agent_detected: 모르는 pane (${paneId})` }
        const agent = readString(data, 'display_agent') ?? readString(data, 'agent')
        // released:true 는 에이전트가 떠난 것이다 — 정체를 지운다.
        const released = data['released'] === true
        const next = released ? null : (agent ?? pane.agent)
        if (pane.agent === next) return { changed: false, note: 'agent_detected: 같은 값' }
        this.panes.set(paneId, { ...pane, agent: next, changedAt: Date.now() })
        return { changed: true, note: released ? `agent_detected: ${agent} 떠남` : `agent_detected: ${agent}` }
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
    const panesByTab = new Map<string, PaneRow[]>()
    const panesByWorkspace = new Map<string, PaneRow[]>()
    for (const pane of this.panes.values()) {
      const row: PaneRow = {
        paneId: pane.paneId,
        workspaceId: pane.workspaceId,
        tabId: pane.tabId,
        title: pane.title,
        agent: pane.agent,
        agentStatus: pane.agentStatus,
        cwd: pane.cwd,
        focused: pane.focused,
        changedAt: pane.changedAt,
      }
      const byTab = panesByTab.get(pane.tabId) ?? []
      byTab.push(row)
      panesByTab.set(pane.tabId, byTab)
      const byWorkspace = panesByWorkspace.get(pane.workspaceId) ?? []
      byWorkspace.push(row)
      panesByWorkspace.set(pane.workspaceId, byWorkspace)
    }
    for (const list of panesByTab.values()) list.sort((a, b) => a.paneId.localeCompare(b.paneId))
    for (const list of panesByWorkspace.values()) list.sort((a, b) => a.paneId.localeCompare(b.paneId))

    const tabsByWorkspace = new Map<string, TabRow[]>()
    for (const tab of this.tabs.values()) {
      const list = tabsByWorkspace.get(tab.workspaceId) ?? []
      list.push({
        tabId: tab.tabId,
        workspaceId: tab.workspaceId,
        label: tab.label,
        number: tab.number,
        agentStatus: tab.agentStatus,
        focused: tab.focused,
        snapshotPaneCount: tab.snapshotPaneCount,
        panes: panesByTab.get(tab.tabId) ?? [],
      })
      tabsByWorkspace.set(tab.workspaceId, list)
    }
    for (const list of tabsByWorkspace.values()) {
      list.sort((a, b) => a.number - b.number || a.tabId.localeCompare(b.tabId))
    }

    const rows: WorkspaceRow[] = []
    for (const workspace of this.workspaces.values()) {
      const panes = panesByWorkspace.get(workspace.workspaceId) ?? []
      const tabs = tabsByWorkspace.get(workspace.workspaceId) ?? []
      const repo = this.repos.get(workspace.workspaceId) ?? null
      rows.push({
        workspaceId: workspace.workspaceId,
        label: workspace.label,
        number: workspace.number,
        // 스냅샷의 pane_count 카운터를 믿지 않고 맵에서 센다 — 중복 적용에도 숫자가 안 흔들린다.
        paneCount: panes.length,
        tabCount: tabs.length,
        agentStatus: workspace.agentStatus,
        focused: workspace.focused,
        repoName: repo?.repoName ?? workspace.repoName,
        repoRoot: repo?.repoRoot ?? workspace.repoRoot,
        branch: repo?.branch ?? null,
        isLinkedWorktree: repo?.isLinkedWorktree ?? workspace.isLinkedWorktree,
        repoSource: repo?.source ?? (workspace.repoName === null ? 'none' : 'snapshot'),
        checkoutPath: repo?.checkoutPath ?? null,
        tabs,
        panes,
      })
    }
    rows.sort((a, b) => a.number - b.number || a.workspaceId.localeCompare(b.workspaceId))
    return rows
  }

  /**
   * 화면 왼쪽 트리의 맨 위 층. **열린 workspace 가 있는 repo 만** 나온다 — herdr 에는 repo
   * 레지스트리가 없고(session.json 이 여는 것만 영속한다) corral 은 얇은 층을 유지한다.
   * 대신 그 repo 의 **worktree 는 전부** 싣는다 (기준 L2r). 열림 여부는 응답의 `open_workspace_id`
   * 를 믿지 않고 **우리가 들고 있는 workspace 의 checkout 경로**와 맞춰 정한다 — 그 필드는 조회
   * 시점 값이라 낡는다.
   */
  repoGroups(rows: WorkspaceRow[]): RepoGroupRow[] {
    const NO_REPO = '(repo 없음)'
    const groups = new Map<string, RepoGroupRow>()
    for (const workspace of rows) {
      const key = workspace.repoRoot ?? workspace.repoName ?? NO_REPO
      const group = groups.get(key) ?? {
        key,
        repoName: key === NO_REPO ? null : workspace.repoName,
        repoRoot: key === NO_REPO ? null : workspace.repoRoot,
        worktrees: [],
        workspaces: [],
      }
      group.workspaces.push(workspace)
      const known = this.repos.get(workspace.workspaceId)
      if (known && group.worktrees.length === 0) group.worktrees = known.worktrees
      groups.set(key, group)
    }

    const openByPath = new Map<string, string>()
    for (const workspace of rows) {
      if (workspace.checkoutPath !== null) openByPath.set(workspace.checkoutPath, workspace.workspaceId)
    }

    const out: RepoGroupRow[] = []
    for (const group of groups.values()) {
      const worktrees = group.worktrees
        .map((worktree) => ({ ...worktree, openWorkspaceId: openByPath.get(worktree.path) ?? null }))
        .sort((a, b) => Number(a.isLinkedWorktree) - Number(b.isLinkedWorktree) || a.path.localeCompare(b.path))
      out.push({ ...group, worktrees })
    }
    out.sort((a, b) => {
      if ((a.key === NO_REPO) !== (b.key === NO_REPO)) return a.key === NO_REPO ? 1 : -1
      return (a.repoName ?? a.key).localeCompare(b.repoName ?? b.key)
    })
    return out
  }


  /** 계측용 — 보류함에 몇 개가 떠 있는지 (K1 원자료에 싣는다). */
  heldOrphans(): { workspaceId: string; kind: 'pane' | 'tab' }[] {
    return this.orphans.map((item) => ({ workspaceId: item.workspaceId, kind: item.kind }))
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
    this.flushOrphans(id)
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
    if (!this.workspaces.has(workspaceId)) {
      this.hold({ at: Date.now(), workspaceId, kind: 'pane', value })
      return false
    }
    const before = this.panes.get(id) ?? null
    const revision = readNumber(value, 'revision')
    // revision 이 움직였을 때만 "바뀐 시각"을 새로 찍는다. 같은 값으로 다시 오는 것은 변화가 아니다.
    const moved = revision !== null && before !== null && before.lastRevision !== null && revision !== before.lastRevision
    this.panes.set(id, {
      paneId: id,
      workspaceId,
      tabId: readString(value, 'tab_id') ?? '',
      // 상태·정체는 pane.agent_status_changed 로도 들어온다. 그쪽이 더 새것이면 그걸 지킨다.
      agentStatus: readAgentStatus(value, 'agent_status'),
      agent: readString(value, 'display_agent') ?? readString(value, 'agent') ?? before?.agent ?? null,
      title:
        readString(value, 'title') ??
        readString(value, 'terminal_title_stripped') ??
        readString(value, 'terminal_title') ??
        readString(value, 'label') ??
        id,
      cwd: readString(value, 'foreground_cwd') ?? readString(value, 'cwd'),
      focused: value['focused'] === true,
      lastRevision: revision ?? before?.lastRevision ?? null,
      changedAt: moved ? Date.now() : (before?.changedAt ?? null),
    })
    return true
  }

  /**
   * L6 — `pane.agent_status_changed` 봉투를 적용한다.
   * 실측 봉투: `{event:"pane.agent_status_changed", data:{agent, agent_status, pane_id, workspace_id}}`
   * (`36-agent-status-and-revision.json`). `title`·`display_agent` 는 올 때만 쓴다.
   */
  private applyAgentStatus(data: Record<string, unknown>): ApplyResult {
    const paneId = readString(data, 'pane_id')
    if (paneId === null) return { changed: false, note: 'agent_status_changed 필드 부족' }
    const pane = this.panes.get(paneId)
    if (!pane) return { changed: false, note: `agent_status_changed: 모르는 pane (${paneId})` }
    const status = readAgentStatus(data, 'agent_status')
    const agent = readString(data, 'display_agent') ?? readString(data, 'agent') ?? pane.agent
    const title = readString(data, 'title') ?? pane.title
    if (pane.agentStatus === status && pane.agent === agent && pane.title === title) {
      return { changed: false, note: `agent_status_changed: 같은 값 (${status})` }
    }
    this.panes.set(paneId, { ...pane, agentStatus: status, agent, title, changedAt: Date.now() })
    return { changed: true, note: `agent_status_changed: ${pane.agentStatus} → ${status}` }
  }

  /** tab 도 pane 과 같은 이유로 workspace 가 있을 때만 들고 있는다. */
  private putTab(value: unknown): boolean {
    if (!isRecord(value)) return false
    const id = readString(value, 'tab_id')
    const workspaceId = readString(value, 'workspace_id')
    if (id === null || workspaceId === null) return false
    if (!this.workspaces.has(workspaceId)) {
      this.hold({ at: Date.now(), workspaceId, kind: 'tab', value })
      return false
    }
    this.tabs.set(id, {
      tabId: id,
      workspaceId,
      label: readString(value, 'label') ?? id,
      number: readNumber(value, 'number') ?? 0,
      agentStatus: readAgentStatus(value, 'agent_status'),
      focused: value['focused'] === true,
      snapshotPaneCount: readNumber(value, 'pane_count'),
    })
    return true
  }

  /** 보류함에 담는다. 담을 때마다 창 지난 것을 턴다 — 별도 타이머를 두지 않기 위해서다. */
  private hold(orphan: Orphan): void {
    const now = orphan.at
    this.orphans = this.orphans.filter((item) => now - item.at <= ORPHAN_HOLD_MS)
    this.orphans.push(orphan)
  }

  /** 주인이 도착했다 — 그 주인의 보류분을 꺼내 붙인다. 창이 지난 것은 붙이지 않고 버린다. */
  private flushOrphans(workspaceId: string): void {
    if (this.orphans.length === 0) return
    const now = Date.now()
    const mine = this.orphans.filter(
      (item) => item.workspaceId === workspaceId && now - item.at <= ORPHAN_HOLD_MS,
    )
    if (mine.length === 0) return
    this.orphans = this.orphans.filter((item) => item.workspaceId !== workspaceId)
    // tab 을 먼저 붙인다 — pane 이 tab_id 를 참조한다.
    for (const item of mine) if (item.kind === 'tab') this.putTab(item.value)
    for (const item of mine) if (item.kind === 'pane') this.putPane(item.value)
  }
}
