// 세션 내부 상태 저장소 — workspace / tab / pane 을 id 키 맵으로 들고 있는다.
//
// **멱등성은 설계로 확보한다** (스파이크 제약 3): create = 맵에 set, close = 맵에서 delete.
// 같은 이벤트를 두 번 적용해도 결과가 같다. 부트스트랩에서 실제로 중복 create 가 나온다.
// pane 수·tab 수는 스냅샷이 준 카운터를 믿지 않고 **맵에서 센다** — 카운터를 믿으면 중복 적용이
// 숫자를 흔든다.
//
// 승계 팩트 (00-analysis.md §3 — 재측정하지 않되 지키는지는 새로 증명한다):
//   · 구독은 갱신이지 진실이 아니다 — 스냅샷이 진실 (applySnapshot·reconcile)
//   · push 에 시퀀스·revision 없음 · 인과 순서 비보장 → **묘비 + 보류함**
//   · 닫기 부분 통보 → store 가 연쇄 삭제 (tab_closed → 그 pane / 마지막 pane → 탭 → workspace)
//   · putPane 의 탭 존재(묘비) 검사
//   · workspace_id 는 서버 생애 안에서만 유일 → 묘비에 시간을 재지 않는다

import { isRecord, readNumber, readRecord, readString } from '../../../shared/json.js'
import type { AgentStatus, PaneRow, TabRow, WorkspaceRow } from '../../../shared/types.js'
import { readAgentStatus, type PushFrame } from './protocol.js'

type Workspace = {
  workspaceId: string
  label: string
  number: number
  agentStatus: AgentStatus
  focused: boolean
  /** 이 행을 **언제 처음 알았나**. 재동기가 "스냅샷보다 나중에 생긴 행" 을 지우지 않게 하는 열쇠다. */
  knownAt: number
}

type Tab = {
  tabId: string
  workspaceId: string
  label: string
  number: number
  agentStatus: AgentStatus
  focused: boolean
  knownAt: number
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
  knownAt: number
}

export type ApplyResult = { changed: boolean; note: string }

/** 재동기 한 판이 실제로 무엇을 고쳤나 — N7 의 근거로 그대로 로그·상태에 실린다. */
export type ReconcileResult = {
  added: { workspaces: string[]; tabs: string[]; panes: string[] }
  removed: { workspaces: string[]; tabs: string[]; panes: string[] }
  /** 스냅샷보다 나중에 생긴 행이라 **지우지 않고 둔** 것. */
  keptNewer: string[]
  changed: boolean
  note: string
}

/**
 * 주인보다 **먼저** 온 pane/tab 을 담아 두는 창. 여기는 시간창이 맞다 — 주인이 영영 안 오는
 * 경우가 있어(그 workspace 가 닫힌 경우) 무한정 들고 있을 수는 없다. 넉넉히 잡는다:
 * 너무 일찍 버리면 pane 을 잃고, 오래 들고 있으면 잠깐 메모리만 쓴다. 대칭이 아니다.
 */
const ORPHAN_HOLD_MS = 5000

type Orphan = { at: number; workspaceId: string; kind: 'pane' | 'tab'; value: Record<string, unknown> }

export class WorkspaceStore {
  private workspaces = new Map<string, Workspace>()
  private tabs = new Map<string, Tab>()
  private panes = new Map<string, Pane>()
  /**
   * 이 생애에서 닫힌 workspace 의 묘비.
   *
   * 시간창이 아니라 묘비인 이유는 실측이다 — `workspace_id` 는 **서버 생애 안에서 재사용되지
   * 않는다**(LIFE-344: 40회 연속 생성·종료, 중복 0). 그러므로 한 번 닫힌 id 로 오는 create 는
   * **언제 오든** 늦게 온 과거다. 시간을 볼 필요가 없다. (시간창은 부하를 타고 늘어나
   * 1374ms 까지 갔고 창을 넘긴 create 가 죽은 workspace 46개를 되살렸다.)
   * 서버를 재기동하면 id 가 처음으로 돌아가지만, 그 경로는 반드시 재부트스트랩을 지나고
   * 재부트스트랩은 `reset()` 으로 묘비를 지운 **뒤에** 버퍼를 적용한다.
   */
  private closed = new Set<string>()
  /**
   * 닫힌 **탭**의 묘비 (LIFE-346 M4 — 3자 리뷰가 겹쳐 가리킨 자리).
   * `putPane` 이 탭 존재를 안 보면, 탭이 지워진 뒤 늦게 온 `pane_created`/`pane_updated` 가
   * pane 만 되살려 **탭 목록에는 없는데** 수가 늘어난다. 탭 id 도 재사용되지 않는다(실측).
   */
  private closedTabs = new Set<string>()
  private orphans: Orphan[] = []

  reset(): void {
    this.workspaces.clear()
    this.tabs.clear()
    this.panes.clear()
    this.closed.clear()
    this.closedTabs.clear()
    this.orphans = []
  }

  /** `session.snapshot` 의 result 를 **통째로** 적용한다 (부트스트랩 — 묘비까지 턴다). */
  applySnapshot(snapshot: unknown): ApplyResult {
    const inner = readSnapshot(snapshot)
    if (inner === null) return { changed: false, note: 'snapshot 모양이 아니다' }
    this.reset()
    const at = Date.now()
    for (const item of arrayOf(inner, 'workspaces')) this.putWorkspace(item, at)
    for (const item of arrayOf(inner, 'tabs')) this.putTab(item, at)
    for (const item of arrayOf(inner, 'panes')) this.putPane(item, at)
    return {
      changed: true,
      note: `workspaces=${this.workspaces.size} tabs=${this.tabs.size} panes=${this.panes.size}`,
    }
  }

  /**
   * **재동기** — 스냅샷을 진실로 삼아 어긋난 것을 맞춘다 (기준 N7).
   *
   * `applySnapshot` 과 다른 점이 둘이다.
   * ① **묘비를 지우지 않는다.** 재동기는 같은 서버 생애 안의 일이라, 묘비가 가리키는 id 는
   *    여전히 "죽은 과거" 다. 지우면 재동기가 부활의 문이 된다.
   * ② **스냅샷보다 나중에 알게 된 행은 지우지 않는다.** 스냅샷은 요청 시점의 사진이다.
   *    그 뒤에 도착한 `tab_created` 를 "사진에 없다" 는 이유로 지우면 산 행을 죽인다.
   *    그래서 행마다 `knownAt` 을 들고, `knownAt >= requestedAt` 이면 건드리지 않는다.
   */
  reconcile(snapshot: unknown, requestedAt: number): ReconcileResult {
    const empty: ReconcileResult = {
      added: { workspaces: [], tabs: [], panes: [] },
      removed: { workspaces: [], tabs: [], panes: [] },
      keptNewer: [],
      changed: false,
      note: 'snapshot 모양이 아니다',
    }
    const inner = readSnapshot(snapshot)
    if (inner === null) return empty

    const at = Date.now()
    const truth = {
      workspaces: idsOf(arrayOf(inner, 'workspaces'), 'workspace_id'),
      tabs: idsOf(arrayOf(inner, 'tabs'), 'tab_id'),
      panes: idsOf(arrayOf(inner, 'panes'), 'pane_id'),
    }
    const keptNewer: string[] = []
    const removed: ReconcileResult['removed'] = { workspaces: [], tabs: [], panes: [] }

    // ① 사진에 없는 행을 버린다 — 단, 사진보다 나중에 알게 된 행은 그대로 둔다.
    for (const [id, row] of [...this.workspaces]) {
      if (truth.workspaces.has(id)) continue
      if (row.knownAt >= requestedAt) {
        keptNewer.push(`workspace:${id}`)
        continue
      }
      this.dropWorkspace(id)
      removed.workspaces.push(id)
    }
    for (const [id, row] of [...this.tabs]) {
      if (truth.tabs.has(id)) continue
      if (row.knownAt >= requestedAt) {
        keptNewer.push(`tab:${id}`)
        continue
      }
      this.tabs.delete(id)
      this.closedTabs.add(id)
      removed.tabs.push(id)
    }
    for (const [id, row] of [...this.panes]) {
      if (truth.panes.has(id)) continue
      if (row.knownAt >= requestedAt) {
        keptNewer.push(`pane:${id}`)
        continue
      }
      this.panes.delete(id)
      removed.panes.push(id)
    }

    // ② 사진에 있는데 우리에게 없는 행을 붙인다. 묘비는 그대로 존중한다 —
    //    묘비가 있는 id 가 사진에 살아 있을 수는 없다 (id 는 생애 안에서 재사용 안 됨).
    const added: ReconcileResult['added'] = { workspaces: [], tabs: [], panes: [] }
    for (const item of arrayOf(inner, 'workspaces')) {
      const id = idOf(item, 'workspace_id')
      if (id === null || this.closed.has(id)) continue
      const had = this.workspaces.has(id)
      if (this.putWorkspace(item, at) && !had) added.workspaces.push(id)
    }
    for (const item of arrayOf(inner, 'tabs')) {
      const id = idOf(item, 'tab_id')
      if (id === null) continue
      const had = this.tabs.has(id)
      if (this.putTab(item, at) && !had) added.tabs.push(id)
    }
    for (const item of arrayOf(inner, 'panes')) {
      const id = idOf(item, 'pane_id')
      if (id === null) continue
      const had = this.panes.has(id)
      if (this.putPane(item, at) && !had) added.panes.push(id)
    }

    const changed =
      added.workspaces.length + added.tabs.length + added.panes.length +
        removed.workspaces.length + removed.tabs.length + removed.panes.length >
      0
    return {
      added,
      removed,
      keptNewer,
      changed,
      note: changed
        ? `추가 ws${added.workspaces.length}/t${added.tabs.length}/p${added.panes.length} · ` +
          `삭제 ws${removed.workspaces.length}/t${removed.tabs.length}/p${removed.panes.length}`
        : '어긋난 것 없음',
    }
  }

  /** push 봉투 1건 적용. 모르는 이벤트는 조용히 무시하지 않고 note 에 남긴다. */
  applyEvent(frame: PushFrame): ApplyResult {
    const data = frame.data
    const at = Date.now()
    switch (frame.event) {
      case 'workspace_created':
      case 'workspace_updated':
      case 'workspace_metadata_updated': {
        const workspace = data['workspace']
        const id = isRecord(workspace) ? readString(workspace, 'workspace_id') : null
        if (id !== null && this.closed.has(id)) {
          return { changed: false, note: `${frame.event}: 닫힌 뒤 늦게 온 것 — 버린다 (${id})` }
        }
        return { changed: this.putWorkspace(workspace, at), note: frame.event }
      }

      case 'workspace_renamed': {
        const id = readString(data, 'workspace_id')
        const label = readString(data, 'label')
        if (id === null || label === null) return { changed: false, note: 'workspace_renamed 필드 부족' }
        const existing = this.workspaces.get(id)
        if (existing === undefined) return { changed: false, note: 'workspace_renamed: 모르는 workspace' }
        this.workspaces.set(id, { ...existing, label })
        return { changed: true, note: frame.event }
      }

      case 'workspace_closed': {
        const id = readString(data, 'workspace_id')
        if (id === null) return { changed: false, note: 'workspace_closed 필드 부족' }
        const had = this.dropWorkspace(id)
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
          this.putWorkspace(item, at)
        }
        return { changed: true, note: frame.event }
      }

      case 'workspace_focused': {
        const id = readString(data, 'workspace_id')
        if (id === null) return { changed: false, note: 'workspace_focused 필드 부족' }
        let changed = false
        for (const [key, workspace] of this.workspaces) {
          const focused = key === id
          if (workspace.focused === focused) continue
          this.workspaces.set(key, { ...workspace, focused })
          changed = true
        }
        return { changed, note: frame.event }
      }

      case 'tab_created': {
        const added = this.putTab(data['tab'] ?? data, at)
        return { changed: added, note: added ? frame.event : `${frame.event}: 주인 없음/묘비 — 안 붙임` }
      }

      /** rename·focus 봉투는 탭 전체가 아니라 바뀐 필드만 온다 — 통째로 넣으려 하면 사라진다. */
      case 'tab_renamed': {
        const id = readString(data, 'tab_id')
        const label = readString(data, 'label')
        if (id === null || label === null) return { changed: false, note: 'tab_renamed 필드 부족' }
        const existing = this.tabs.get(id)
        if (existing === undefined) return { changed: false, note: 'tab_renamed: 모르는 탭' }
        this.tabs.set(id, { ...existing, label })
        return { changed: true, note: frame.event }
      }

      case 'tab_focused': {
        const id = readString(data, 'tab_id')
        if (id === null) return { changed: false, note: 'tab_focused 필드 부족' }
        const target = this.tabs.get(id)
        if (target === undefined) return { changed: false, note: 'tab_focused: 모르는 탭' }
        let changed = false
        for (const [key, tab] of this.tabs) {
          // 포커스는 workspace 안에서 하나다 — 다른 workspace 의 탭은 건드리지 않는다.
          if (tab.workspaceId !== target.workspaceId) continue
          const focused = key === id
          if (tab.focused === focused) continue
          this.tabs.set(key, { ...tab, focused })
          changed = true
        }
        return { changed, note: frame.event }
      }

      /**
       * **탭을 지우면 그 탭의 pane 도 지운다** (LIFE-346 G1).
       * 실측: `tab.close` 는 `tab_closed` **한 건만** 준다. pane 은 프로세스까지 죽는데
       * `pane_closed` 는 안 온다 — 레이아웃에서 먼저 빼고 죽이기 때문이다. 그래서 탭만 지우면
       * pane 이 맵에 남아 수가 과대해진다.
       */
      case 'tab_closed': {
        const id = readString(data, 'tab_id')
        if (id === null) return { changed: false, note: 'tab_closed 필드 부족' }
        const had = this.tabs.delete(id)
        this.closedTabs.add(id)
        let orphaned = 0
        for (const [paneId, pane] of this.panes) {
          if (pane.tabId !== id) continue
          this.panes.delete(paneId)
          orphaned += 1
        }
        // 이 탭을 기다리던 보류분도 의미가 없다 — 주인 탭이 이미 없다.
        const before = this.orphans.length
        this.orphans = this.orphans.filter((item) => readString(item.value, 'tab_id') !== id)
        const dropped = before - this.orphans.length
        const changed = had || orphaned > 0
        return {
          changed,
          note: changed
            ? `${frame.event}: pane ${orphaned}개 · 보류 ${dropped}개 함께 정리`
            : 'tab_closed: 이미 없음(멱등)',
        }
      }

      case 'pane_created':
      case 'pane_updated': {
        const added = this.putPane(data['pane'], at)
        if (added) return { changed: true, note: frame.event }
        const pane = readRecord(data, 'pane')
        const tabId = pane === null ? null : readString(pane, 'tab_id')
        if (tabId !== null && this.closedTabs.has(tabId)) {
          return { changed: false, note: `${frame.event}: 닫힌 탭(${tabId}) — 묘비로 막음` }
        }
        return { changed: false, note: `${frame.event}: 주인 없음 — 보류함` }
      }

      /**
       * **마지막 pane 이 사라지면 그 탭도 사라진다** (LIFE-346 G2), 그리고
       * **그게 마지막 탭이었으면 workspace 도 사라진다** (G4).
       *
       * 실측: `pane.close` 는 `pane_closed` **한 건만** 주는데 같은 시각 herdr `tab.list` 에는
       * 그 탭이 이미 없다. 사용자가 셸에 `exit` 를 친 경로는 `pane_exited` **한 건만** 오고
       * 그 시점에 pane·탭·(마지막이면)workspace 가 herdr 에서 이미 사라져 있다 —
       * **`workspace_closed` 는 안 온다.** 그대로 두면 corral 에만 남는 유령 행이 된다.
       *
       * 탭이 비었다고 무조건 지우지는 않는다 — `tab_created` 가 `pane_created` 보다 먼저 오는
       * 구간이 있어 갓 만든 탭은 잠시 pane 0 이다. 여기는 **pane 이 실제로 있다가 사라진**
       * 경로라서 0 이 곧 "이제 없다" 다.
       */
      case 'pane_closed':
      case 'pane_exited': {
        const id = readString(data, 'pane_id')
        if (id === null) return { changed: false, note: `${frame.event} 필드 부족` }
        const pane = this.panes.get(id) ?? null
        if (pane === null) return { changed: false, note: `${frame.event}: 이미 없음(멱등)` }
        this.panes.delete(id)
        const siblings = [...this.panes.values()].filter((item) => item.tabId === pane.tabId).length
        if (siblings > 0) return { changed: true, note: `${frame.event}: 탭에 pane ${siblings}개 남음` }
        const tabGone = this.tabs.delete(pane.tabId)
        this.closedTabs.add(pane.tabId)
        const siblingTabs = [...this.tabs.values()].filter((item) => item.workspaceId === pane.workspaceId).length
        const siblingPanes = [...this.panes.values()].filter((item) => item.workspaceId === pane.workspaceId).length
        const workspaceGone =
          tabGone && siblingTabs === 0 && siblingPanes === 0 && this.workspaces.has(pane.workspaceId)
        if (workspaceGone) this.dropWorkspace(pane.workspaceId)
        return {
          changed: true,
          note: tabGone
            ? `${frame.event}: 마지막 pane — 탭(${pane.tabId})도 지움${
                workspaceGone ? ` · 마지막 탭 — workspace(${pane.workspaceId})도 지움` : ''
              }`
            : frame.event,
        }
      }

      case 'pane_agent_status_changed':
        return this.applyAgentStatus(data)

      case 'pane_agent_detected': {
        const paneId = readString(data, 'pane_id')
        if (paneId === null) return { changed: false, note: 'agent_detected 필드 부족' }
        const pane = this.panes.get(paneId)
        if (pane === undefined) return { changed: false, note: `agent_detected: 모르는 pane (${paneId})` }
        const agent = readString(data, 'display_agent') ?? readString(data, 'agent')
        // released:true 는 에이전트가 떠난 것이다 — 정체를 지운다.
        const released = data['released'] === true
        const next = released ? null : (agent ?? pane.agent)
        if (pane.agent === next) return { changed: false, note: 'agent_detected: 같은 값' }
        this.panes.set(paneId, { ...pane, agent: next })
        return { changed: true, note: released ? `agent_detected: ${agent} 떠남` : `agent_detected: ${agent}` }
      }

      case 'worktree_created':
      case 'worktree_opened':
      case 'worktree_removed':
        // worktree 층의 진실은 `git worktree list` + `worktree.list` 다 (기준 N4ⓒ).
        // 이 push 는 "다시 봐라" 는 신호일 뿐 — 저장소가 직접 반영하지 않는다.
        return { changed: false, note: `${frame.event}: worktree 층 갱신 신호` }

      case 'layout_updated':
        return { changed: false, note: 'layout_updated: 목록에 영향 없음' }

      default:
        return { changed: false, note: `모르는 이벤트: ${frame.event}` }
    }
  }

  /** workspace 하나를 그 아래 것들과 함께 버리고 묘비를 세운다. */
  private dropWorkspace(id: string): boolean {
    const had = this.workspaces.delete(id)
    this.closed.add(id)
    // 주인이 닫혔으면 그 주인을 기다리던 보류분도 의미가 없다.
    this.orphans = this.orphans.filter((item) => item.workspaceId !== id)
    for (const [tabId, tab] of this.tabs) {
      if (tab.workspaceId !== id) continue
      this.tabs.delete(tabId)
      this.closedTabs.add(tabId)
    }
    for (const [paneId, pane] of this.panes) if (pane.workspaceId === id) this.panes.delete(paneId)
    return had
  }

  // --- 읽기 ------------------------------------------------------------------

  rows(): WorkspaceRow[] {
    const panesByTab = new Map<string, PaneRow[]>()
    for (const pane of this.panes.values()) {
      const row: PaneRow = {
        paneId: pane.paneId,
        tabId: pane.tabId,
        workspaceId: pane.workspaceId,
        title: pane.title,
        agent: pane.agent,
        agentStatus: pane.agentStatus,
        cwd: pane.cwd,
        focused: pane.focused,
      }
      const list = panesByTab.get(pane.tabId) ?? []
      list.push(row)
      panesByTab.set(pane.tabId, list)
    }
    for (const list of panesByTab.values()) list.sort((a, b) => a.paneId.localeCompare(b.paneId))

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
        panes: panesByTab.get(tab.tabId) ?? [],
      })
      tabsByWorkspace.set(tab.workspaceId, list)
    }
    for (const list of tabsByWorkspace.values()) {
      list.sort((a, b) => a.number - b.number || a.tabId.localeCompare(b.tabId))
    }

    const rows: WorkspaceRow[] = []
    for (const workspace of this.workspaces.values()) {
      rows.push({
        workspaceId: workspace.workspaceId,
        label: workspace.label,
        number: workspace.number,
        agentStatus: workspace.agentStatus,
        focused: workspace.focused,
        tabs: tabsByWorkspace.get(workspace.workspaceId) ?? [],
      })
    }
    rows.sort((a, b) => a.number - b.number || a.workspaceId.localeCompare(b.workspaceId))
    return rows
  }

  /** 계측·비교용 — id 집합만 뽑는다 (N5 의 대조 형식). */
  ids(): { workspaces: string[]; tabs: string[]; panes: string[] } {
    return {
      workspaces: [...this.workspaces.keys()].sort(),
      tabs: [...this.tabs.keys()].sort(),
      panes: [...this.panes.keys()].sort(),
    }
  }

  paneIds(): string[] {
    return [...this.panes.keys()].sort()
  }

  /** 계측용 — 보류함에 몇 개가 떠 있는지. */
  heldOrphans(): Array<{ workspaceId: string; kind: 'pane' | 'tab' }> {
    return this.orphans.map((item) => ({ workspaceId: item.workspaceId, kind: item.kind }))
  }

  // --- 쓰기 (내부) ------------------------------------------------------------

  private putWorkspace(value: unknown, at: number): boolean {
    if (!isRecord(value)) return false
    const id = readString(value, 'workspace_id')
    if (id === null) return false
    const before = this.workspaces.get(id)
    this.workspaces.set(id, {
      workspaceId: id,
      label: readString(value, 'label') ?? id,
      number: readNumber(value, 'number') ?? 0,
      agentStatus: readAgentStatus(value, 'agent_status'),
      focused: value['focused'] === true,
      knownAt: before?.knownAt ?? at,
    })
    this.flushOrphans(id)
    return true
  }

  /** tab 은 그 workspace 가 있을 때만 들고 있는다 — 없으면 보류함으로 간다. */
  private putTab(value: unknown, at: number): boolean {
    if (!isRecord(value)) return false
    const id = readString(value, 'tab_id')
    const workspaceId = readString(value, 'workspace_id')
    if (id === null || workspaceId === null) return false
    // 닫힌 탭으로 오는 create 는 늦게 온 과거다 (workspace 묘비와 같은 규칙).
    if (this.closedTabs.has(id)) return false
    if (!this.workspaces.has(workspaceId)) {
      this.hold({ at, workspaceId, kind: 'tab', value })
      return false
    }
    const before = this.tabs.get(id)
    this.tabs.set(id, {
      tabId: id,
      workspaceId,
      label: readString(value, 'label') ?? id,
      number: readNumber(value, 'number') ?? 0,
      agentStatus: readAgentStatus(value, 'agent_status'),
      focused: value['focused'] === true,
      knownAt: before?.knownAt ?? at,
    })
    return true
  }

  /**
   * pane 은 그 workspace 가 있을 때만 들고 있는다.
   *
   * 실측: 흔들기를 촘촘히 돌리면 `workspace_closed` 가 그 workspace 의 `pane_created` 보다
   * **먼저** 도착한다 (pane 은 PTY 가 실제로 뜬 뒤 알려지기 때문이다). 그때 pane 을 그냥 넣으면
   * 주인 없는 고아가 남는다 — 화면에는 안 보이지만 대조가 어긋나고 맵이 샌다.
   */
  private putPane(value: unknown, at: number): boolean {
    if (!isRecord(value)) return false
    const id = readString(value, 'pane_id')
    const workspaceId = readString(value, 'workspace_id')
    if (id === null || workspaceId === null) return false
    // 닫힌 탭의 pane 은 되살리지 않는다 — 보류함에도 안 넣는다 (주인이 영영 안 온다).
    const tabId = readString(value, 'tab_id') ?? ''
    if (tabId.length > 0 && this.closedTabs.has(tabId)) return false
    if (!this.workspaces.has(workspaceId)) {
      this.hold({ at, workspaceId, kind: 'pane', value })
      return false
    }
    const before = this.panes.get(id) ?? null
    this.panes.set(id, {
      paneId: id,
      workspaceId,
      tabId,
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
      knownAt: before?.knownAt ?? at,
    })
    return true
  }

  /**
   * `pane.agent_status_changed` 봉투를 적용한다.
   * 실측 봉투: `{event:"pane.agent_status_changed", data:{agent, agent_status, pane_id, workspace_id}}`
   */
  private applyAgentStatus(data: Record<string, unknown>): ApplyResult {
    const paneId = readString(data, 'pane_id')
    if (paneId === null) return { changed: false, note: 'agent_status_changed 필드 부족' }
    const pane = this.panes.get(paneId)
    if (pane === undefined) return { changed: false, note: `agent_status_changed: 모르는 pane (${paneId})` }
    const status = readAgentStatus(data, 'agent_status')
    const agent = readString(data, 'display_agent') ?? readString(data, 'agent') ?? pane.agent
    if (pane.agentStatus === status && pane.agent === agent) {
      return { changed: false, note: `agent_status_changed: 같은 값 (${status})` }
    }
    this.panes.set(paneId, { ...pane, agentStatus: status, agent })
    return { changed: true, note: `agent_status_changed: ${pane.agentStatus} → ${status}` }
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
    const mine = this.orphans.filter((item) => item.workspaceId === workspaceId && now - item.at <= ORPHAN_HOLD_MS)
    if (mine.length === 0) return
    this.orphans = this.orphans.filter((item) => item.workspaceId !== workspaceId)
    // tab 을 먼저 붙인다 — pane 이 tab_id 를 참조한다.
    for (const item of mine) if (item.kind === 'tab') this.putTab(item.value, item.at)
    for (const item of mine) if (item.kind === 'pane') this.putPane(item.value, item.at)
  }
}

/** `{result:{snapshot:{…}}}` · `{snapshot:{…}}` · `{…}` 어느 모양으로 와도 안쪽을 집는다. */
function readSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  return readRecord(value, 'snapshot') ?? value
}

function arrayOf(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key]
  return Array.isArray(value) ? value : []
}

function idOf(item: unknown, key: string): string | null {
  return isRecord(item) ? readString(item, key) : null
}

function idsOf(items: unknown[], key: string): Set<string> {
  const out = new Set<string>()
  for (const item of items) {
    const id = idOf(item, key)
    if (id !== null) out.add(id)
  }
  return out
}
