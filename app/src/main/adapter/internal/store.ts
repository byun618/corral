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
//   · 닫기 부분 통보 → store 가 연쇄 삭제 (tab_closed → 그 pane → (마지막이면) workspace /
//     마지막 pane → 탭 → workspace)
//   · putPane 의 pane·탭 묘비 검사
//   · workspace_id 는 서버 생애 안에서만 유일 → 늦게 온 push 는 **시간을 안 보고** 묘비로 막는다
//     (수정 2회차 H-1ⓑ 로 갈라졌다: 재동기만은 시간을 본다 — 묘비의 `closedAt` 과
//      사진의 `requestedAt` 을 대 틀린 묘비를 걷는다. `reconcile` ⓪)

import { isRecord, readNumber, readRecord, readString } from '../../../shared/json.js'
import { EMPTY_SESSION_DIGEST } from '../../../shared/types.js'
import type { AgentSessionRef, AgentState, AgentStatus, BlockedReason, PaneRow, RetainedAgentRow, TabRow, WorkspaceRow } from '../../../shared/types.js'
import { blockedReason, emptyAgentState, recordAgentTransition, rollupAgentStatus } from '../../../shared/agent-state.js'
import { readAgentStatus, readStateLabels, type PushFrame } from './protocol.js'

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
  /**
   * 화면에 놓이는 **자리**. `number` 와 다르다 (수정 1회차 M5 실측 — `00-shapes-fix1.json`).
   *
   * `tab.move` 로 탭을 옮기면 `tab.list`·`session.snapshot`·`tab_moved` 의 **배열 순서**가 바뀌고
   * `number` 는 그대로다 (t1·t2·t3 를 t3 앞으로 옮기면 `[t3(3), t1(1), t2(2)]`).
   * 즉 herdr 에서 순서의 진실은 목록의 자리이지 `number` 가 아니다 — `number` 는 안정적인 표찰이다.
   * 1회차는 `number` 로 정렬해서, 순서가 바뀐 목록을 herdr 와 다르게 그렸다.
   */
  order: number
  agentStatus: AgentStatus
  focused: boolean
  knownAt: number
}

type Pane = {
  paneId: string
  workspaceId: string
  tabId: string
  agentStatus: AgentStatus
  /** 사유·관측 시각·완료 시각·이력 (LIFE-456). `agentStatus` 와 짝으로만 갱신한다. */
  agentState: AgentState
  agent: string | null
  title: string
  cwd: string | null
  focused: boolean
  /** 에이전트가 스스로 밝힌 세션 참조 (LIFE-366). 보고 전·셸 탭이면 null. */
  agentSession: AgentSessionRef | null
  knownAt: number
}

/** 보존 상한 — 이력 상한과 같은 20 (Orca 198 `stateHistory` 에 맞춘 자리). */
export const RETAINED_LIMIT = 20

/** 닫힌 pane 의 마지막 기록 — 모양은 경계 타입 하나다(`shared/types.ts`). */
export type RetainedAgent = RetainedAgentRow

export type ApplyResult = {
  changed: boolean
  note: string
}

/** 재동기 한 판이 실제로 무엇을 고쳤나 — N7 의 근거로 그대로 로그·상태에 실린다. */
export type ReconcileResult = {
  added: { workspaces: string[]; tabs: string[]; panes: string[] }
  removed: { workspaces: string[]; tabs: string[]; panes: string[] }
  /** 스냅샷보다 나중에 생긴 행이라 **지우지 않고 둔** 것. */
  keptNewer: string[]
  /**
   * **걷어 낸 묘비** (수정 2회차 H-1ⓑ). 사진에 살아 있는데 우리가 죽은 것으로 알고 있던 id 다 —
   * 그 자체가 "추정이 틀렸다" 는 증거라 로그에 그대로 실어 둔다.
   */
  lifted: string[]
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

/**
 * **닫힘에는 두 출처가 있다** (수정 2회차 H-1 — 고친 방향의 근거).
 *
 * ① 관측 — herdr 가 그 id 를 두고 "닫혔다" 고 말했거나(`*_closed`/`*_exited`), 진실인 스냅샷에
 *    그 id 가 없었다. corral 이 무엇을 아는지와 무관하게 참이다.
 * ② 추정 — corral 이 **자기가 아는 것**에서 연쇄로 끌어냈다: "이 workspace 에 내가 아는 탭이
 *    하나도 안 남았으니 workspace 도 닫혔겠지". 그런데 그 앎은 push 로 만들어지고 push 는
 *    유실된다(분석 §3, 실측 152/274) — `tab_created` 한 건만 놓쳐도 추정은 **틀린다**.
 *
 * 재리뷰가 실행으로 보인 것: 틀린 추정이 묘비까지 세우면 `reconcile` §②가 그 id 를 건너뛰어
 * **산 workspace 가 재동기로도 안 돌아온다** (재생 E1).
 *
 * 고치는 길이 둘이었다.
 *   ⓐ 추정 연쇄는 묘비를 세우지 않는다 — 그러면 늦게 온 `workspace_created` 가 **진짜로**
 *      죽은 workspace 를 되살린다. 그게 정확히 N6 재생 ③ 이 재는 것이고, 지금 ③ 이 통과하는
 *      근거가 그 묘비다. **N7 을 살리려고 N6 을 깨는 맞바꿈이라 택하지 않았다.**
 *   ⓑ 재동기가 **틀린 묘비를 걷는다** — 사진에 살아 있는 id 의 묘비는 우리가 잘못 세운 것이다.
 *      묘비는 그대로 두므로 늦은 push 는 계속 막고(N6), 재동기는 회복의 문이 된다(N7).
 * ⓑ 를 택했다. 구현은 `reconcile` ⓪ 과 묘비 값의 `closedAt` 이다.
 */

export class WorkspaceStore {
  private workspaces = new Map<string, Workspace>()
  private tabs = new Map<string, Tab>()
  private panes = new Map<string, Pane>()
  /**
   * 이 생애에서 닫힌 workspace 의 묘비.
   *
   * 시간창이 아니라 묘비인 이유는 실측이다 — `workspace_id` 는 **서버 생애 안에서 재사용되지
   * 않는다**(LIFE-344: 40회 연속 생성·종료, 중복 0). 그러므로 한 번 닫힌 id 로 오는 create 는
   * **언제 오든** 늦게 온 과거다. **push 를 막을 때는** 시간을 볼 필요가 없다. (시간창은 부하를
   * 타고 늘어나 1374ms 까지 갔고 창을 넘긴 create 가 죽은 workspace 46개를 되살렸다.)
   * 서버를 재기동하면 id 가 처음으로 돌아가지만, 그 경로는 반드시 재부트스트랩을 지나고
   * 재부트스트랩은 `reset()` 으로 묘비를 지운 **뒤에** 버퍼를 적용한다.
   *
   * 값은 **묘비를 세운 시각**이다 (수정 2회차 H-1ⓑ). 재동기가 "이 묘비가 사진보다 먼저
   * 세워졌나" 를 물어야 틀린 묘비만 골라 걷을 수 있다 — `knownAt` 과 정확히 대칭이다.
   */
  private closed = new Map<string, number>()
  /**
   * 닫힌 **탭**의 묘비 (LIFE-346 M4 — 3자 리뷰가 겹쳐 가리킨 자리).
   * `putPane` 이 탭 존재를 안 보면, 탭이 지워진 뒤 늦게 온 `pane_created`/`pane_updated` 가
   * pane 만 되살려 **탭 목록에는 없는데** 수가 늘어난다. 탭 id 도 재사용되지 않는다(실측).
   */
  private closedTabs = new Map<string, number>()
  /**
   * 닫힌 **pane** 의 묘비 (수정 1회차 H1 — 리뷰어가 실행으로 반증한 자리).
   *
   * 1회차에는 이 묘비가 없었고, pane 의 부활을 막는 것은 "그 pane 의 탭이 같이 죽어서
   * `closedTabs` 에 들어갔다" 는 **간접 효과**뿐이었다. 그래서 **탭이 살아남는 경로**
   * — 형제 pane 이 남은 탭에서 pane 하나만 닫히거나, 재동기가 pane 만 지운 경우 —
   * 에는 방어가 하나도 없었고, 늦게 온 `pane_updated` 가 죽은 pane 을 되살렸다.
   * pane id 도 workspace·tab 과 같이 서버 생애 안에서 재사용되지 않으므로 규칙도 같다.
   */
  private closedPanes = new Map<string, number>()
  /** S15ⓓ — 닫힌 뒤에도 남기는 **마지막 기록**. 최신 우선, `RETAINED_LIMIT` 개. */
  private retained: RetainedAgent[] = []
  /**
   * **blocked 삽화마다 붙는 번호** (F1·F4). pane 이 blocked 로 **들어갈 때** 새 번호를 받고,
   * 떠나거나 사라지면 지운다. 두 가지를 동시에 푼다:
   *   · F1 — 사유를 물어야 할 대상을 **상태에서** 뽑는다. 「어느 경로로 들어왔나」가 아니라
   *     「지금 blocked 인데 사유가 없나」가 기준이라, 부팅 snapshot·재동기·버퍼 재생 어디로
   *     들어와도 빠지지 않는다. 전에는 live push 전이에만 붙어 있어서 나머지가 영영 공백이었다
   *   · F4 — 응답에 이 번호를 되돌려 받아 **지난 삽화의 늦은 응답을 버린다**
   */
  private blockedEntries = new Map<string, number>()
  private blockedEntrySeq = 0
  /**
   * **사유의 두 입력을 pane 마다 기억한다** (R2-F2 — 「한 입력 규칙」).
   *
   * 사유는 `blockedReason({ labels, ruleId })` 한 함수가 정하는데, 두 입력이 **다른 순간에**
   * 도착한다: `labels` 는 스냅샷·`pane_updated` 봉투에, `ruleId` 는 나중에 오는 `agent.explain`
   * 응답에 실린다. 라운드 1 은 자리마다 **한쪽만** 먹였다 — `putPane` 은 labels 만,
   * `explainBlocked` 는 ruleId 만, `agent_status_changed` 는 아무것도. 그래서 labels 가 채운
   * 사유가 있으면 `blockedNeedingReason` 이 그 pane 을 건너뛰어 **explain 이 영영 안 돌았고**,
   * CLI 는 둘 다 먹여서 같은 pane 에 다른 답이 나올 수 있었다.
   *
   * 여기 모아 두면 **어느 입력이 먼저 오든 항상 둘 다 먹인 값**이 나온다. CLI 도 같은 함수에
   * 같은 두 입력을 준다 — 그것이 S6 「한 어휘」의 실제 내용이다.
   */
  private blockedLabels = new Map<string, Readonly<Record<string, string>>>()
  /** 그 삽화에 대해 explain 응답을 이미 반영했나 (paneId → entry). */
  private blockedExplained = new Map<string, number>()

  /** 사유를 정하는 **유일한 자리**. 두 입력을 항상 함께 먹인다 (R2-F2). */
  private resolveBlockedReason(paneId: string, labels?: Readonly<Record<string, string>> | null): BlockedReason | null {
    if (labels !== undefined && labels !== null) this.blockedLabels.set(paneId, labels)
    return blockedReason({
      labels: this.blockedLabels.get(paneId) ?? null,
      ruleId: this.blockedRuleIds.get(paneId) ?? null,
    })
  }
  /** explain 이 고른 규칙 id (paneId → ruleId). 삽화가 끝나면 지운다. */
  private blockedRuleIds = new Map<string, string | null>()

  /** corral 이 스스로 닫은 pane·탭 — 그 닫힘은 보존하지 않는다 (아래 `suppressRetention`). */
  private retentionSuppressed = new Set<string>()
  private orphans: Orphan[] = []

  reset(): void {
    this.workspaces.clear()
    this.tabs.clear()
    this.panes.clear()
    this.closed.clear()
    this.closedTabs.clear()
    this.closedPanes.clear()
    this.retained = []
    this.retentionSuppressed.clear()
    this.blockedEntries.clear()
    this.blockedLabels.clear()
    this.blockedExplained.clear()
    this.blockedRuleIds.clear()
    this.orphans = []
  }

  /** `session.snapshot` 의 result 를 **통째로** 적용한다 (부트스트랩 — 묘비까지 턴다). */
  applySnapshot(snapshot: unknown): ApplyResult {
    const inner = readSnapshot(snapshot)
    if (inner === null) return { changed: false, note: 'snapshot 모양이 아니다' }
    this.reset()
    const at = Date.now()
    for (const item of arrayOf(inner, 'workspaces')) this.putWorkspace(item, at)
    // 탭은 **자리를 배열 순서에서 읽는다** (M5 실측) — 그래서 인덱스를 같이 넘긴다.
    arrayOf(inner, 'tabs').forEach((item, index) => this.putTab(item, at, index))
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
   *
   * ①의 "묘비를 지우지 않는다" 에는 **예외가 하나 있다** (수정 2회차 H-1ⓑ): 사진에 **살아
   * 있는** id 의 묘비다. 그건 우리가 잘못 세운 묘비다 — id 는 생애 안에서 재사용되지 않으므로
   * 죽은 id 가 사진에 있을 수는 없다. 그대로 두면 §②가 그 id 를 건너뛰어 **재동기가 회복의
   * 문이 아니라 영구 소멸의 문**이 된다. 단, 사진을 **요청한 뒤에** 세운 묘비는 사진이 못 본
   * 닫힘일 수 있으니 건드리지 않는다 — `knownAt >= requestedAt` 과 정확히 대칭인 규칙이다.
   */
  reconcile(snapshot: unknown, requestedAt: number): ReconcileResult {
    const empty: ReconcileResult = {
      added: { workspaces: [], tabs: [], panes: [] },
      removed: { workspaces: [], tabs: [], panes: [] },
      keptNewer: [],
      lifted: [],
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

    // ⓪ **틀린 묘비를 걷는다** — 사진에 살아 있는 id 의 묘비는 우리가 잘못 세운 것이다.
    const lifted: string[] = []
    const lift = (graves: Map<string, number>, alive: Set<string>, kind: string): void => {
      for (const [id, closedAt] of [...graves]) {
        if (!alive.has(id) || closedAt >= requestedAt) continue
        graves.delete(id)
        lifted.push(`${kind}:${id}`)
      }
    }
    lift(this.closed, truth.workspaces, 'workspace')
    lift(this.closedTabs, truth.tabs, 'tab')
    lift(this.closedPanes, truth.panes, 'pane')

    // ① 사진에 없는 행을 버린다 — 단, 사진보다 나중에 알게 된 행은 그대로 둔다.
    for (const [id, row] of [...this.workspaces]) {
      if (truth.workspaces.has(id)) continue
      if (row.knownAt >= requestedAt) {
        keptNewer.push(`workspace:${id}`)
        continue
      }
      // 재동기 정리 — 닫힘을 못 본 자리라 보존하지 않는다 (F5).
      this.dropWorkspace(id, at, false)
      removed.workspaces.push(id)
    }
    for (const [id, row] of [...this.tabs]) {
      if (truth.tabs.has(id)) continue
      if (row.knownAt >= requestedAt) {
        keptNewer.push(`tab:${id}`)
        continue
      }
      this.tabs.delete(id)
      this.closedTabs.set(id, at)
      this.releaseTabSuppression(id)
      removed.tabs.push(id)
    }
    for (const [id, row] of [...this.panes]) {
      if (truth.panes.has(id)) continue
      if (row.knownAt >= requestedAt) {
        keptNewer.push(`pane:${id}`)
        continue
      }
      // 탭 삭제와 같은 규칙으로 묘비를 세운다 (H1ⓓ). 위의 `knownAt` 으로 살려 둔 행
      // (keptNewer)은 여기 오지 않는다 — 산 행에 묘비를 세우면 그 행이 영영 못 돌아온다.
      // 재동기 정리는 **사라진 것을 뒤늦게 아는** 자리다. 닫힘을 못 본 채 사진으로만
      // 아는 것이라 「끝나 있었다」를 주장할 근거가 없다 — 보존하지 않는다.
      this.forgetPane({ pane: row, at, retain: false })
      removed.panes.push(id)
    }

    // ② 사진에 있는데 우리에게 없는 행을 붙인다. 여기 남은 묘비는 그대로 존중한다 —
    //    사진에 살아 있으면서 사진보다 먼저 세워진 묘비는 **⓪ 가 이미 걷었다**. 그러니 여기서
    //    걸리는 묘비는 사진을 **요청한 뒤에** 세운 것이다 — 그 사진이 못 본 닫힘이라 붙이지 않는다.
    const added: ReconcileResult['added'] = { workspaces: [], tabs: [], panes: [] }
    for (const item of arrayOf(inner, 'workspaces')) {
      const id = idOf(item, 'workspace_id')
      if (id === null || this.closed.has(id)) continue
      const had = this.workspaces.has(id)
      if (this.putWorkspace(item, at) && !had) added.workspaces.push(id)
    }
    // 재동기는 **순서도 맞춘다** — 스냅샷 배열의 자리가 진실이다 (M5).
    arrayOf(inner, 'tabs').forEach((item, index) => {
      const id = idOf(item, 'tab_id')
      if (id === null) return
      const had = this.tabs.has(id)
      if (this.putTab(item, at, index) && !had) added.tabs.push(id)
    })
    for (const item of arrayOf(inner, 'panes')) {
      const id = idOf(item, 'pane_id')
      if (id === null) continue
      const had = this.panes.has(id)
      if (this.putPane(item, at) && !had) added.panes.push(id)
    }

    const changed =
      added.workspaces.length + added.tabs.length + added.panes.length +
        removed.workspaces.length + removed.tabs.length + removed.panes.length +
        lifted.length >
      0
    return {
      added,
      removed,
      keptNewer,
      lifted,
      changed,
      note: changed
        ? `추가 ws${added.workspaces.length}/t${added.tabs.length}/p${added.panes.length} · ` +
          `삭제 ws${removed.workspaces.length}/t${removed.tabs.length}/p${removed.panes.length}` +
          (lifted.length > 0 ? ` · 묘비 걷음 ${lifted.length}` : '')
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
        // herdr 가 「닫혔다」고 말해 준 자리다 — 보존한다 (F5 의 반대 갈래).
        const had = this.dropWorkspace(id, at, true)
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
        // workspace 연쇄를 보려면 지우기 **전에** 주인을 읽어야 한다 (수정 1회차 L5).
        const workspaceId = this.tabs.get(id)?.workspaceId ?? readString(data, 'workspace_id')
        const had = this.tabs.delete(id)
        this.closedTabs.set(id, at)
        let orphaned = 0
        for (const pane of this.panes.values()) {
          if (pane.tabId !== id) continue
          // H1ⓒ — 탭과 함께 죽은 pane 에도 묘비. 탭이 닫혔다는 **관측**에서 바로 따라 나오는
          // 사실이라(닫힌 탭의 pane 은 herdr 에도 없다) 이쪽은 추정이 아니다.
          this.forgetPane({ pane, at, retain: true })
          orphaned += 1
        }
        this.releaseTabSuppression(id)
        // 이 탭을 기다리던 보류분도 의미가 없다 — 주인 탭이 이미 없다.
        const before = this.orphans.length
        this.orphans = this.orphans.filter((item) => readString(item.value, 'tab_id') !== id)
        const dropped = before - this.orphans.length
        /**
         * **마지막 탭이 닫히면 workspace 도 닫힌다** — `pane_exited` 경로와 대칭으로 (L5).
         * 1회차는 "마지막 탭은 `workspace_closed` 가 먼저 온다"(LIFE-346 실측)에 기대 비대칭이었다.
         * 그 실측은 지금도 맞고 N5ⓓ 가 5회 통과했지만, 분석 §3 이 박아 둔 전제는 **인과 비보장**이다 —
         * `workspace_closed` 가 늦으면 그 사이 유령 workspace 행이 보인다. 연쇄는 멱등이라 싸다.
         *
         * **다만 이 판별식이 묻는 것은 herdr 의 진실이 아니라 "corral 이 아는 탭" 이다**
         * (수정 2회차 H-1). `tab_created` 한 건을 놓친 채 아는 마지막 탭이 닫히면 판별식은
         * 산 workspace 에도 참이 된다. 그 추정이 틀렸을 때 되돌리는 것은 **재동기의 ⓪**이다 —
         * 사진에 살아 있으면 묘비를 걷는다. 여기서는 알던 대로 지우고 묘비를 세운다.
         */
        const workspaceGone =
          workspaceId !== null &&
          this.workspaces.has(workspaceId) &&
          [...this.tabs.values()].every((item) => item.workspaceId !== workspaceId) &&
          [...this.panes.values()].every((item) => item.workspaceId !== workspaceId)
        if (workspaceGone) this.dropWorkspace(workspaceId, at, true)
        const changed = had || orphaned > 0 || workspaceGone
        return {
          changed,
          note: changed
            ? `${frame.event}: pane ${orphaned}개 · 보류 ${dropped}개 함께 정리` +
              (workspaceGone ? ` · 아는 마지막 탭 — workspace(${workspaceId ?? ''})도 지움 (추정)` : '')
            : 'tab_closed: 이미 없음(멱등)',
        }
      }

      /**
       * **탭 순서 바뀜** (수정 1회차 M5 — codex 1).
       * 실측 봉투: `{event:"tab_moved", data:{tab_id, workspace_id, insert_index, tabs:[TabInfo…]}}`
       * — 그 workspace 의 탭 목록이 **통째로** 실려 온다 (`00-shapes-fix1.json`).
       * 그래서 `workspace_moved` 와 같은 규칙으로 통째 다시 넣는다. 묘비는 그대로 존중한다:
       * 목록에 죽은 탭이 섞여 와도 `putTab` 이 막는다.
       */
      case 'tab_moved': {
        const list = data['tabs']
        if (!Array.isArray(list)) return { changed: false, note: 'tab_moved: tabs 없음' }
        let changed = false
        list.forEach((item, index) => {
          if (this.putTab(item, at, index)) changed = true
        })
        return { changed, note: `${frame.event}: 탭 ${list.length}개 순서 갱신` }
      }

      case 'pane_created':
      case 'pane_updated': {
        const added = this.putPane(data['pane'], at)
        if (added) return { changed: true, note: frame.event }
        const pane = readRecord(data, 'pane')
        const paneId = pane === null ? null : readString(pane, 'pane_id')
        if (paneId !== null && this.closedPanes.has(paneId)) {
          return { changed: false, note: `${frame.event}: 닫힌 pane(${paneId}) — 묘비로 막음` }
        }
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
        // 묘비는 **모르는 pane 에도** 세운다 (H1ⓐ). tab_closed·dropWorkspace 가 이미 그렇게
        // 한다 — 닫힘 통보가 create 보다 먼저 오는 구간이 실제로 있기 때문이다.
        this.closedPanes.set(id, at)
        if (pane === null) return { changed: false, note: `${frame.event}: 이미 없음(멱등)` }
        this.forgetPane({ pane, at, retain: true })
        const siblings = [...this.panes.values()].filter((item) => item.tabId === pane.tabId).length
        if (siblings > 0) return { changed: true, note: `${frame.event}: 탭에 pane ${siblings}개 남음` }
        /**
         * 여기서부터는 **전부 추정이다** (수정 2회차 H-1). "내가 아는 pane 이 다 없어졌으니
         * 탭도 죽었겠지 · 아는 탭이 다 없어졌으니 workspace 도 죽었겠지" — 그 앎이 push 유실로
         * 구멍 나 있으면 그대로 틀린다. `tab_closed` 와 같은 자리이고, 되돌리는 것도 같다:
         * 재동기 ⓪ 가 사진에 살아 있는 id 의 묘비를 걷는다.
         * (위의 pane 묘비는 추정이 아니다 — herdr 가 그 id 를 두고 말해 준 것이다.)
         */
        const tabGone = this.tabs.delete(pane.tabId)
        this.closedTabs.set(pane.tabId, at)
        this.releaseTabSuppression(pane.tabId)
        const siblingTabs = [...this.tabs.values()].filter((item) => item.workspaceId === pane.workspaceId).length
        const siblingPanes = [...this.panes.values()].filter((item) => item.workspaceId === pane.workspaceId).length
        const workspaceGone =
          tabGone && siblingTabs === 0 && siblingPanes === 0 && this.workspaces.has(pane.workspaceId)
        if (workspaceGone) this.dropWorkspace(pane.workspaceId, at, true)
        return {
          changed: true,
          note: tabGone
            ? `${frame.event}: 아는 마지막 pane — 탭(${pane.tabId})도 지움 (추정)${
                workspaceGone ? ` · workspace(${pane.workspaceId})도 지움` : ''
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

  /**
   * workspace 하나를 그 아래 것들과 함께 버리고 묘비를 세운다. 묘비에는 **세운 시각**이 든다.
   *
   * `retain` 은 **사라짐의 출처**다 (F5). 같은 함수가 두 곳에서 불리는데 뜻이 다르다:
   *   · `workspace_closed` 이벤트 → `true`. herdr 가 "닫혔다"고 말해 준 것이다
   *   · 재동기 정리          → `false`. 사진에 없더라는 **뒤늦은 앎**이라 「끝나 있었다」를
   *     주장할 근거가 없다. 이 갈래가 `true` 로 굳어 있어서 「재동기는 보존하지 않는다」 규칙이
   *     workspace 째 사라질 때만 뒤집혀 있었다(코디 재현 C4)
   */
  private dropWorkspace(id: string, at: number, retain: boolean): boolean {
    const had = this.workspaces.delete(id)
    this.closed.set(id, at)
    // 주인이 닫혔으면 그 주인을 기다리던 보류분도 의미가 없다.
    this.orphans = this.orphans.filter((item) => item.workspaceId !== id)
    /**
     * **pane 을 먼저 잊고 표는 나중에 걷는다.** 순서가 거꾸로면 탭 표가 pane 보존 판정보다
     * 먼저 지워져, 사용자가 닫은 탭인데도 완료 행이 올라온다 — 탭이 하나뿐인 워크스페이스를
     * corral 로 닫자 실제로 그렇게 샜다(`s9b-retained-tabclose.txt` r049).
     */
    const droppedTabs: string[] = []
    for (const [tabId, tab] of this.tabs) {
      if (tab.workspaceId !== id) continue
      this.tabs.delete(tabId)
      this.closedTabs.set(tabId, at)
      droppedTabs.push(tabId)
    }
    for (const pane of this.panes.values()) {
      if (pane.workspaceId !== id) continue
      this.forgetPane({ pane, at, retain }) // H1ⓑ — 연쇄로 죽은 pane 에도 묘비
    }
    for (const tabId of droppedTabs) this.releaseTabSuppression(tabId)
    this.retentionSuppressed.delete(id)
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
        agentState: pane.agentState,
        cwd: pane.cwd,
        focused: pane.focused,
        agentSession: pane.agentSession,
        digest: EMPTY_SESSION_DIGEST,
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
        order: tab.order,
        // **롤업은 corral 이 자기 pane 집합에서 접는다** (S5ⓐ — H3 수정). herdr 가 탭 봉투에
        // 실어 주는 `agent_status` 는 pane 전이보다 늦게(스냅샷·30초 재동기) 오므로 그것을
        // 쓰면 같은 순간에 사이드바(pane)와 탭바(tab)가 다른 말을 한다. 아는 pane 이 하나도
        // 없을 때만 herdr 가 준 값으로 물러선다 — 그때는 접을 재료가 없다.
        agentStatus: rollupOrFallback(panesByTab.get(tab.tabId), tab.agentStatus),
        focused: tab.focused,
        panes: panesByTab.get(tab.tabId) ?? [],
        // **판독은 어댑터의 일이 아니다** (LIFE-366 기준 E1). 트랜스크립트를 읽는 층은 herdr 를
        // 모르고, 어댑터는 그 층을 모른다. 그래서 여기는 빈 지문을 놓고 가고 `tree.joinTree` 가
        // 덮는다 — `gitStatus` 가 worktree 줄에 붙는 것과 같은 자리다.
        digest: EMPTY_SESSION_DIGEST,
      })
      tabsByWorkspace.set(tab.workspaceId, list)
    }
    // **자리 순으로** 정렬한다 — herdr 의 목록 순서가 그것이다 (M5 실측). `number` 가 아니다.
    for (const list of tabsByWorkspace.values()) {
      list.sort((a, b) => a.order - b.order || a.tabId.localeCompare(b.tabId))
    }

    const rows: WorkspaceRow[] = []
    for (const workspace of this.workspaces.values()) {
      rows.push({
        workspaceId: workspace.workspaceId,
        label: workspace.label,
        number: workspace.number,
        // 같은 규칙으로 한 층 더 접는다 (S5ⓐ) — 이미 접힌 탭 값을 다시 접는다.
        agentStatus: rollupOrFallback(
          (tabsByWorkspace.get(workspace.workspaceId) ?? []).flatMap((tab) => tab.panes),
          workspace.agentStatus,
        ),
        focused: workspace.focused,
        tabs: tabsByWorkspace.get(workspace.workspaceId) ?? [],
      })
    }
    /**
     * workspace 는 **`number` 로 정렬한다** — 탭과 다르다 (수정 2회차 M-1, 실측 `00-shapes-fix2.json`).
     *
     * 탭 층의 발견("순서의 진실은 배열 자리")을 이 층에 그대로 옮기지 않은 것은 실측이 갈라졌기
     * 때문이다: `workspace.move` 를 걸면 herdr 가 **`number` 를 자리에 맞춰 다시 매긴다**
     * (`[w1(1),w2(2),w3(3)]` 에서 w3 을 맨 앞으로 → `[w3(1),w1(2),w2(3)]`). 이동 2회 + 가운데
     * 닫기까지 `workspace.list` 의 배열 순서에서 number 는 매번 단조 증가했다. 즉 이 층에서는
     * number 순서 = 배열 순서이고, `workspace_moved` 봉투가 새 number 를 통째로 싣고 오므로
     * 행도 같이 갱신된다. 탭은 정반대였다 — `tab.move` 는 number 를 건드리지 않는다.
     */
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

  /**
   * 계측용 — 보류함에 몇 개가 떠 있는지.
   * **읽을 때도 만료분을 턴다** (수정 1회차 L7 — codex 4): 1회차는 `hold()` 때만 털어서,
   * 늦은 이벤트가 더 안 오면 만료된 고아가 보류함에 그대로 남아 보였다.
   */
  heldOrphans(): Array<{ workspaceId: string; kind: 'pane' | 'tab' }> {
    this.purgeOrphans(Date.now())
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
      // `pickAgentStatus` 로 읽는다 — `agent_status` 키가 **없는** 봉투가 알던 값을 `unknown`
      // 으로 지우던 것이 H4 다 (pane 에만 있던 보호를 여기에도 준다, S5ⓑ).
      agentStatus: pickAgentStatus(value, before?.agentStatus ?? null),
      focused: value['focused'] === true,
      knownAt: before?.knownAt ?? at,
    })
    this.flushOrphans(id)
    return true
  }

  /** tab 은 그 workspace 가 있을 때만 들고 있는다 — 없으면 보류함으로 간다. */
  private putTab(value: unknown, at: number, order: number | null = null): boolean {
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
      // 목록을 통째로 받은 자리에서는 그 인덱스가 진실이고, 낱개 봉투(tab_created)는
      // 알던 자리를 지키거나 `number` 를 힌트로 삼는다.
      order: order ?? before?.order ?? this.initialTabOrder(value, workspaceId),
      // H4 — 같은 이유로 여기도 `pickAgentStatus` 다 (S5ⓑ).
      agentStatus: pickAgentStatus(value, before?.agentStatus ?? null),
      focused: value['focused'] === true,
      knownAt: before?.knownAt ?? at,
    })
    return true
  }

  /**
   * 낱개 `tab_created` 로 처음 알게 된 탭의 **초기 자리** (수정 2회차 L-5 — codex).
   *
   * 이 봉투에는 자리가 안 실린다. 1회차는 도착순으로 끝에 붙였는데, 분석 §3 의 전제가
   * **인과 순서 비보장**이라 빠르게 만든 두 탭의 `tab_created` 가 뒤집혀 오면 그 순서가
   * 재동기까지 굳는다. `number` 는 자리가 아니지만(`tab.move` 가 안 바꾼다 — M5 실측)
   * **생성 순서를 따라 커지는 표찰**이라 초기 힌트로는 도착순보다 낫다.
   * 진짜 자리는 목록이 통째로 오는 세 자리(스냅샷·reconcile·`tab_moved`)가 곧 덮는다.
   */
  private initialTabOrder(value: Record<string, unknown>, workspaceId: string): number {
    const number = readNumber(value, 'number')
    return number !== null && number > 0 ? number : this.nextTabOrder(workspaceId)
  }

  private nextTabOrder(workspaceId: string): number {
    let max = -1
    for (const tab of this.tabs.values()) if (tab.workspaceId === workspaceId) max = Math.max(max, tab.order)
    return max + 1
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
    // **묘비가 첫 검사다** (H1). 닫힌 pane 으로 오는 create/update 는 언제 오든 늦게 온 과거다.
    if (this.closedPanes.has(id)) return false
    // 닫힌 탭의 pane 은 되살리지 않는다 — 보류함에도 안 넣는다 (주인이 영영 안 온다).
    const tabId = readString(value, 'tab_id') ?? ''
    if (tabId.length > 0 && this.closedTabs.has(tabId)) return false
    if (!this.workspaces.has(workspaceId)) {
      this.hold({ at, workspaceId, kind: 'pane', value })
      return false
    }
    const before = this.panes.get(id) ?? null
    const nextStatus = pickAgentStatus(value, before?.agentStatus ?? null)
    this.trackBlockedEntry(id, before?.agentStatus ?? null, nextStatus)
    this.panes.set(id, {
      paneId: id,
      workspaceId,
      tabId,
      // 상태·정체는 pane.agent_status_changed 로도 들어온다. 그쪽이 더 새것이면 그걸 지킨다 —
      // 주석이 약속한 이 보호가 1회차 코드에는 이름(agent)에만 있었다 (수정 1회차 M2).
      agentStatus: nextStatus,
      agentState: recordAgentTransition({
        // `null` = 이 pane 을 이제 막 처음 봤다 (아래 함수 주석 — 이력을 만들지 않는다).
        previousStatus: before?.agentStatus ?? null,
        previousState: before?.agentState ?? emptyAgentState(at),
        nextStatus,
        // **두 입력을 함께** 먹인다 (R2-F2). explain 이 이미 답한 삽화면 그 ruleId 가 이긴다.
        blockedReason: this.resolveBlockedReason(id, readStateLabels(value)),
        observedAt: at,
        // 스냅샷·`pane_updated` 로 알게 된 값이다 — **진입 시각이 아니다**(`AgentObservedVia`).
        observedVia: 'snapshot',
      }),
      agent: pickAgent(value, before?.agent ?? null),
      // **원문 제목을 먼저 읽는다** (LIFE-366 C11ⓑ, 수정 라운드 8). r7 까지는 `title` →
      // `terminal_title_stripped` 순이라 herdr 가 `✳` 를 벗긴 값이 먼저 잡혔고, 그래서 corral 은
      // 상태 접두사를 **한 번도 못 봤다**(00-analysis.md §2.4 의 "미관측"이 그 사유였다).
      // Orca 는 접두사가 붙은 원문을 그대로 띄운다 — 같은 글자를 보려면 원문을 집어야 한다.
      // 마지막 `?? id` 는 터미널이 준 제목이 아니라 **어댑터의 자체 폴백**이다 (C11ⓔ 가 거절을
      // 거기에만 남긴 이유).
      //
      // **`label` 은 이 체인에 없다** (게이트 ① 수정, 04-manual-check-notes.md §3) — herdr 가
      // pane 생성 봉투에 싣는 `label` 은 `TabRow.label` 과 같은 값(그 워크스페이스 안 1-기반
      // 위치, 예: `"4"`)이다. 실제 터미널 제목(OSC)이 아직 안 온 갓 생긴 pane 에서 이걸 폴백으로
      // 쓰면 `session-title.ts` 의 `paneTitleLabel` 이 `PANE_ID_TITLE`(`wG:p3` 꼴)도
      // `SHELL_PROMPT_TITLE`(`user@host:~` 꼴)도 아닌 순수 숫자 문자열을 그대로 통과시켜 탭
      // 이름 자리에 **맨 숫자만**(`"4"`) 뜬다 — `userLabel` 이 `TabRow.label` 에 대해서만 하는
      // 기본-위치-라벨 거르기(`isDefaultPositionLabel`)가 여기(`PaneRow.title`)엔 적용되지
      // 않기 때문이다. "다음 탭이 생겨야 이름이 바뀐다"는 증상은 이 버그가 아니라 그 사이 실제
      // OSC 제목이 도착해 `pane.title` 이 갱신되는 시점과 우연히 겹친 것뿐이었다.
      title:
        readString(value, 'terminal_title') ??
        readString(value, 'title') ??
        readString(value, 'terminal_title_stripped') ??
        id,
      cwd: readString(value, 'foreground_cwd') ?? readString(value, 'cwd'),
      focused: value['focused'] === true,
      agentSession: pickAgentSession(value, before?.agentSession ?? null),
      knownAt: before?.knownAt ?? at,
    })
    return true
  }

  /**
   * `pane.agent_status_changed` 봉투를 적용한다.
   * 실측 봉투: `{event:"pane.agent_status_changed", data:{agent, agent_status, pane_id, workspace_id}}`
   *
   * **상태 구독은 상태만 말한다 — 정체(이름)는 여기서 안 집는다** (수정 3회차, 이번 회차 N8 이
   * 실제로 잡았다). 이 봉투의 `agent` 는 "지금 이 pane 의 에이전트" 가 아니라 **"상태가 바뀐
   * 그 에이전트"** 다. `pane.release_agent` 때 herdr 가 실제로 보내는 두 줄이 그것을 보인다
   * (probe 실측):
   *
   *   agent 구독: `{agent:"claude", agent_status:"unknown"}`      ← 이름이 실려 온다
   *   본 구독:    `{agent:"claude", released:true, final_status:"unknown"}`
   *   그 뒤 `pane.list` 의 진실: `agent` 없음(null) · `agent_status:"unknown"`
   *
   * 두 줄은 **다른 커넥션**이라 순서가 안 정해진다. 여기서 이름을 집으면 `released` 가 먼저
   * 온 경우에 상태 줄이 지운 이름을 **도로 붙여** 다음 재동기(기본 30초)까지 유령 이름이 남는다.
   * 실측에서 그 창이 8초 넘게 안 닫혔다 (`fix3/_discarded/n8-2026-09-11.md`).
   * 이름의 출처는 `pane_agent_detected`·`pane_updated`·스냅샷 셋이다 — 전부 본 구독/스냅샷이라
   * 저희끼리 순서가 선다.
   */
  private applyAgentStatus(data: Record<string, unknown>): ApplyResult {
    const paneId = readString(data, 'pane_id')
    if (paneId === null) return { changed: false, note: 'agent_status_changed 필드 부족' }
    const pane = this.panes.get(paneId)
    if (pane === undefined) return { changed: false, note: `agent_status_changed: 모르는 pane (${paneId})` }
    const status = readAgentStatus(data, 'agent_status')
    if (pane.agentStatus === status) {
      return { changed: false, note: `agent_status_changed: 같은 값 (${status})` }
    }
    const agentState = recordAgentTransition({
      previousStatus: pane.agentStatus,
      previousState: pane.agentState,
      nextStatus: status,
      // 이 봉투에는 `state_labels` 가 안 실린다(실측 — `{agent, agent_status, pane_id, workspace_id}`).
      // 전이가 일어났으면 **지난 삽화의 입력 둘 다** 버린다 (R2-F2) — 들고 가면 옛 화면의
      // 사유가 새 화면에 남는다. 비운 뒤 같은 함수를 부르므로 결과는 `null` 이고,
      // 그래야 `blockedNeedingReason` 이 이 pane 을 다시 집는다.
      blockedReason: (() => {
        this.blockedLabels.delete(paneId)
        this.blockedRuleIds.delete(paneId)
        return this.resolveBlockedReason(paneId)
      })(),
      observedAt: Date.now(),
      // 전이 이벤트다 — 이것만이 **진입 시각에 가까운** 관측이다.
      observedVia: 'event',
    })
    this.trackBlockedEntry(paneId, pane.agentStatus, status)
    this.panes.set(paneId, { ...pane, agentStatus: status, agentState })
    return { changed: true, note: `agent_status_changed: ${pane.agentStatus} → ${status}` }
  }

  /**
   * **닫힌 pane 의 마지막 기록을 남긴다** (S15ⓓ — Orca 198 `useRetainedAgents` 대조).
   *
   * 198 의 규칙 세 줄을 그대로 옮긴다(`useRetainedAgents.ts:298-309`):
   *   ① 마지막 상태가 `done` 일 때만 남긴다 — 「끝났는데 아직 안 본 것」만 남길 값이 있다.
   *      working 중에 죽은 pane 은 완료가 아니고, idle 은 이미 본 것이다
   *   ② **명시적으로 닫은 것은 남기지 않는다.** 사용자가 직접 닫은 탭을 완료 행으로 되살리면
   *      닫기가 안 먹은 것처럼 보인다. corral 이 자기 손으로 `pane.close`·`tab.close` 를 쏠 때
   *      `suppressRetention` 으로 미리 찍어 둔다
   *   ③ 198 의 `interrupted` 대응은 **공백**이다 — corral 에 그 신호가 없다(LIFE-458 몫).
   *      그래서 「중단 아님」을 확인하지 못한 채 남긴다는 한계가 결과 문서에 적힌다
   *
   * 수명: **메모리에만 둔다.** 재시작하면 사라진다 — 디스크에 남기면 「그 사이에 끝난 턴」을
   * 확인 못 한 채 완료 행으로 되살리게 되고, 그건 198 도 `restoredUnconfirmed` 로 따로
   * 막아 둔 자리다. 이 작업은 그 층을 만들지 않는다(S12 범위).
   */
  private retain(pane: Pane, at: number): void {
    if (pane.agentStatus !== 'done') return
    if (this.retentionSuppressed.has(pane.paneId)) {
      // pane 표는 그 pane 이 쓰고 버린다 — 한 번 닫히면 다시 쓸 일이 없다.
      this.retentionSuppressed.delete(pane.paneId)
      return
    }
    /**
     * **탭 표는 여기서 지우지 않는다.** 탭 하나에 pane 이 여럿일 수 있고(갈라진 탭),
     * 첫 pane 이 표를 먹어 치우면 **둘째 pane 이 되살아난다** — 사용자가 닫은 탭에서
     * 완료 행이 하나 올라오는 것이고, 그건 ② 가 막으려던 바로 그 모양이다.
     * 표는 탭·워크스페이스가 실제로 없어지는 자리에서 한 번에 걷는다.
     */
    if (this.retentionSuppressed.has(pane.tabId)) return
    if (this.retentionSuppressed.has(pane.workspaceId)) return
    this.retained = [
      { paneId: pane.paneId, tabId: pane.tabId, workspaceId: pane.workspaceId, title: pane.title,
        agent: pane.agent, agentStatus: pane.agentStatus, agentState: pane.agentState, retainedAt: at },
      ...this.retained.filter((row) => row.paneId !== pane.paneId),
    ].slice(0, RETAINED_LIMIT)
  }

  /**
   * **pane 하나를 잊는다** — 사라짐을 알게 된 **모든 경로**가 여기를 지난다.
   *
   * pane 이 없어지는 길은 넷이다. **묘비는 넷 다 찍고, 보존은 셋만 한다** — `retain` 을
   * 호출자가 그 자리에서 밝힌다. 숨은 기본값을 두면 길이 하나 늘 때마다 조용히 한쪽으로
   * 붙는데, 실제로 그렇게 새던 것을 네이티브 관문에서 잡았다:
   *
   *   · `pane_closed`·`pane_exited`  보존한다 — pane 하나가 끝나고 사라진 자리다
   *   · `tab_closed`                 보존한다 — 탭을 닫으면 herdr 는 **`tab_closed` 한 건만**
   *     주고 `pane_closed` 를 안 준다(위 G1 주석). 에이전트 pane 은 탭 하나에 하나씩 살기
   *     때문에 **이 길이 완료가 사라지는 흔한 길이다.** 전에는 여기서 기록이 통째로 날아갔다
   *   · workspace 연쇄               보존한다 — **탭이 하나뿐이면 같은 손짓이 이 길로 온다**
   *   · 재동기 정리                  보존하지 않는다 — 닫힘을 못 본 채 사진으로만 아는 자리라
   *     「끝나 있었다」를 주장할 근거가 없다
   *
   * **치움과 완료를 가르는 것은 이벤트 종류가 아니라 억제 표다.** 한때 `workspace_closed` 를
   * 「접는 것은 치움이니 보존 안 함」으로 뒀는데, 네이티브에서 탭이 **하나뿐인** 워크스페이스의
   * 탭을 닫자 `workspace_closed` 가 먼저 도착하고 `tab_closed` 는 멱등 무시로 왔다 —
   * 같은 손짓(탭 닫기)이 탭 수에 따라 다르게 판정됐다 (`raw/claude/s9/s9b-retained-tabclose.txt`).
   * 그래서 판정을 **누가 닫았나** 한 축으로 모았다: corral 이 스스로 닫을 때만 억제하고
   * (pane·탭·workspace 셋 다 `suppressRetention` 을 찍는다) 나머지 사라짐은 보존한다.
   *
   * **「herdr 가 workspace 를 먼저 보낸다」가 아니다** (F17 정정). v0.9.0 소스는 그 반대로
   * 낸다 — `src/app/api/tabs.rs:248-261` 이 `TabClosed` → `WorkspaceClosed` 순으로 emit 하고
   * 같은 파일 테스트가 그 순서를 검증한다. **도착 순서를 정하는 것은 corral 자신의 구독 목록**
   * 이다: 서버가 구독 항목을 클라이언트가 적은 순서대로 한 바퀴에 한 건씩 흘리기 때문에
   * (`src/api/server.rs:749-753`), `SUBSCRIPTION_TYPES` 에서 앞에 적힌 쪽이 먼저 온다.
   * 목록 순서만 뒤집어 같은 닫기를 동시에 받아 그대로 뒤집히는 것을 실측했다
   * (`raw/claude/s9-r1/08-f17-retained-and-order.md` §3).
   * → **보존 판정이 도착 순서에 기대면 안 된다.** 억제 표는 순서와 무관하다.
   */
  /**
   * pane 의 상태가 정해질 때마다 blocked 삽화 번호를 맞춘다 (F1·F4).
   *
   * **pane 을 쓰는 모든 자리가 여기를 지난다** — snapshot·재동기·`pane_created/updated`·
   * 전이 이벤트. 진입 경로마다 따로 붙이면 꼭 한 군데가 빠지는데, 실제로 그렇게 빠져서
   * 부팅 때 이미 blocked 이던 pane 은 사유를 영영 못 받았다(F1).
   */
  private trackBlockedEntry(paneId: string, previousStatus: AgentStatus | null, nextStatus: AgentStatus): void {
    if (nextStatus !== 'blocked') {
      this.blockedEntries.delete(paneId)
      this.blockedLabels.delete(paneId)
      this.blockedExplained.delete(paneId)
      this.blockedRuleIds.delete(paneId)
      return
    }
    // 이미 blocked 였고 번호도 있으면 **같은 삽화**다 — 번호를 바꾸지 않는다(같은 값 재관측).
    if (previousStatus === 'blocked' && this.blockedEntries.has(paneId)) return
    this.blockedEntrySeq += 1
    this.blockedEntries.set(paneId, this.blockedEntrySeq)
  }

  /**
   * **사유를 아직 못 받은 blocked pane 들** (F1). 호출자(link)가 이 목록을 보고 한 번씩 묻는다.
   *
   * 목록이 상태에서 나오므로 폴링이 아니다: 사유가 채워지면 **그 다음 호출부터 빠진다**.
   * 물어봤는데 못 받은 것(실패·빈 응답)은 호출자가 삽화 번호로 기억해 다시 묻지 않는다 —
   * 「실패」와 「아직 안 물어봄」을 가르는 자리가 거기다.
   */
  blockedNeedingReason(): Array<{ paneId: string; entry: number }> {
    const rows: Array<{ paneId: string; entry: number }> = []
    for (const [paneId, entry] of this.blockedEntries) {
      const pane = this.panes.get(paneId)
      if (pane === undefined || pane.agentStatus !== 'blocked') continue
      /**
       * **「사유가 비었나」가 아니라 「이 삽화에 explain 이 답했나」로 가른다** (R2-F2).
       * 전에는 사유가 차 있으면 건너뛰었는데, `state_labels` 가 먼저 사유를 채우면 그 pane 은
       * explain 을 **영영 못 받았다** — labels 가 지은 사유는 교정될 기회가 없었다.
       * (오늘 세 provider 의 labels 는 비어 와서 증상이 안 보일 뿐, 규칙이 틀려 있었다.)
       */
      if (this.blockedExplained.get(paneId) === entry) continue
      rows.push({ paneId, entry })
    }
    return rows
  }

  /** 탭이 실제로 사라졌다 — 그 탭에 걸어 둔 억제 표를 **한 번에** 걷는다. */
  private releaseTabSuppression(tabId: string): void {
    this.retentionSuppressed.delete(tabId)
  }

  private forgetPane(input: { pane: Pane; at: number; retain: boolean }): void {
    const { pane, at, retain } = input
    if (retain) this.retain(pane, at)
    this.blockedEntries.delete(pane.paneId)
    this.blockedLabels.delete(pane.paneId)
    this.blockedExplained.delete(pane.paneId)
    this.blockedRuleIds.delete(pane.paneId)
    this.panes.delete(pane.paneId)
    this.closedPanes.set(pane.paneId, at)
  }

  /**
   * **corral 이 스스로 닫는 중이다** — 그 pane·탭의 닫힘은 보존하지 않는다 (S15ⓓ ②).
   * `pane.close`·`tab.close` 를 쏘기 **전에** 부른다. 닫힘 통보가 안 와도 새는 것이 없도록
   * 보존 시점에 표를 지운다.
   */
  suppressRetention(id: string): void {
    this.retentionSuppressed.add(id)
  }

  /**
   * **찍은 억제 표를 되돌린다** (F6) — 닫기가 **확정 거절**되거나 실패했을 때 부른다.
   *
   * 표를 찍는 것은 「지금 닫는 중이다」는 약속인데, 닫기가 거절되면 그 약속이 거짓이 된다.
   * 그대로 두면 그 pane 이 **나중에 진짜로 끝나서 사라질 때** 완료 기록을 조용히 삼킨다.
   *
   * **timeout 은 부르지 않는다.** 결과 불명이라 닫혔을 수도 있고, 그때 표를 걷으면 사용자가
   * 닫은 것이 완료 행으로 되살아난다. 둘 중 덜 나쁜 쪽을 고른다 — 「끝난 것 하나를 못 남김」이
   * 「사용자가 닫은 것이 되살아남」보다 낫다. 호출자는 이 구분을 로그에 남긴다.
   */
  releaseSuppression(id: string): void {
    this.retentionSuppressed.delete(id)
  }

  /** 보존된 마지막 기록 — 최신 우선. */
  retainedRows(): readonly RetainedAgent[] {
    return this.retained
  }

  /**
   * `agent.explain` 이 늦게 물어다 준 **blocked 사유**를 붙인다 (LIFE-456 S3).
   *
   * 응답이 오는 사이에 그 pane 이 blocked 를 떠났을 수 있다 — 그때는 **버린다**. 지나간
   * 상태의 사유를 지금 상태에 붙이면 화면이 거짓말을 한다. 상태 자체는 건드리지 않으므로
   * 관측 시각·이력도 그대로다(같은 값 갈래를 타고 사유만 갈린다).
   */
  applyBlockedRule(input: { paneId: string; entry: number; ruleId: string | null }): ApplyResult {
    const pane = this.panes.get(input.paneId)
    if (pane === undefined) return { changed: false, note: `blocked_reason: 모르는 pane (${input.paneId})` }
    if (pane.agentStatus !== 'blocked') {
      return { changed: false, note: `blocked_reason: 이미 blocked 가 아니다 (${pane.agentStatus})` }
    }
    /**
     * **F4 — 지난 삽화의 응답은 버린다.** 상태가 blocked → working → blocked 로 돌아오면
     * 값은 다시 `blocked` 라 위 검사를 통과한다. 그때 먼저 보낸 요청의 늦은 응답이 도착하면
     * **새 삽화의 사유를 옛 화면의 것으로 덮는다**. 삽화 번호가 그 둘을 가른다.
     */
    const current = this.blockedEntries.get(input.paneId)
    if (current !== input.entry) {
      return { changed: false, note: `blocked_reason: 지난 진입의 응답 (${input.entry} ≠ ${String(current)})` }
    }
    // 답을 받았다는 사실은 **사유가 바뀌었든 아니든** 기록한다 — 안 그러면 매 훑기마다 다시 묻는다.
    this.blockedExplained.set(input.paneId, input.entry)
    this.blockedRuleIds.set(input.paneId, input.ruleId)
    const reason = this.resolveBlockedReason(input.paneId)
    if (pane.agentState.blockedReason === reason) {
      return { changed: false, note: `blocked_reason: 같은 값 (${String(reason)})` }
    }
    this.panes.set(input.paneId, { ...pane, agentState: { ...pane.agentState, blockedReason: reason } })
    return { changed: true, note: `blocked_reason: ${String(pane.agentState.blockedReason)} → ${String(reason)}` }
  }


  /**
   * 보류함에 담는다. 담을 때마다 창 지난 것을 턴다 — 별도 타이머를 두지 않기 위해서다.
   * **닫힌 workspace 앞으로 온 것은 애초에 담지 않는다** (L7): 주인이 영영 안 오므로
   * 5초를 기다릴 이유가 없다.
   */
  private hold(orphan: Orphan): void {
    this.purgeOrphans(orphan.at)
    if (this.closed.has(orphan.workspaceId)) return
    this.orphans.push(orphan)
  }

  private purgeOrphans(now: number): void {
    if (this.orphans.length === 0) return
    this.orphans = this.orphans.filter((item) => now - item.at <= ORPHAN_HOLD_MS)
  }

  /** 주인이 도착했다 — 그 주인의 보류분을 꺼내 붙인다. 창이 지난 것은 붙이지 않고 버린다. */
  private flushOrphans(workspaceId: string): void {
    if (this.orphans.length === 0) return
    const now = Date.now()
    this.purgeOrphans(now)
    const mine = this.orphans.filter((item) => item.workspaceId === workspaceId && now - item.at <= ORPHAN_HOLD_MS)
    if (mine.length === 0) return
    this.orphans = this.orphans.filter((item) => item.workspaceId !== workspaceId)
    // tab 을 먼저 붙인다 — pane 이 tab_id 를 참조한다.
    for (const item of mine) if (item.kind === 'tab') this.putTab(item.value, item.at)
    for (const item of mine) if (item.kind === 'pane') this.putPane(item.value, item.at)
  }
}

/**
 * 에이전트 **이름**을 읽는다 — "키가 없다" 와 "값이 null 이다" 를 가른다.
 *
 * 옛 규칙(`readString(…) ?? before?.agent`)은 둘을 같게 다뤘다. 그래서 herdr 가 에이전트를
 * 떼어 낸 뒤(`release_agent`) 보낸 상태 전이에 `agent: null` 이 실려 와도 **이전 이름을 그대로
 * 붙들었고**, 화면에는 이미 없는 에이전트의 이름표가 남았다 (N8 1회차 실측).
 * 키가 있으면 herdr 가 값을 말해 준 것이다 — null 이어도 그게 답이다.
 */
/**
 * 에이전트 **상태**를 읽는다 — `pickAgent` 와 같은 규칙으로 "키가 없다" 를 가른다.
 *
 * 1회차는 `readAgentStatus` 를 무조건 불렀고, 키가 없으면 그게 `'unknown'` 을 돌려주므로
 * `agent_status` 를 안 싣고 온 `pane_updated` 한 건이 칩을 `막힘 → 미상` 으로 지웠다
 * (리뷰 부록 C). 키가 없으면 herdr 가 그 필드를 말하지 않은 것이다 — 알던 값을 지킨다.
 */
/**
 * pane 집합에서 탭·워크스페이스 값을 접는다 (S5ⓐ). **아는 pane 이 없을 때만** herdr 가 준
 * 값으로 물러선다 — 접을 재료가 없는데 `unknown` 을 만들어 내면 갓 열린 탭이 깜빡인다.
 */
function rollupOrFallback(panes: readonly PaneRow[] | undefined, fallback: AgentStatus): AgentStatus {
  if (panes === undefined || panes.length === 0) return fallback
  return rollupAgentStatus(panes.map((pane) => pane.agentStatus))
}

function pickAgentStatus(source: Record<string, unknown>, fallback: AgentStatus | null): AgentStatus {
  if ('agent_status' in source) return readAgentStatus(source, 'agent_status')
  return fallback ?? 'unknown'
}

function pickAgent(source: Record<string, unknown>, fallback: string | null): string | null {
  if ('display_agent' in source) return readString(source, 'display_agent')
  if ('agent' in source) return readString(source, 'agent')
  return fallback
}

/**
 * 세션 **참조**를 읽는다 — `pickAgent` 와 같은 규칙으로 "키가 없다" 를 가른다 (LIFE-366).
 *
 * 이게 왜 중요하냐면, 참조는 에이전트가 뜰 때 **딱 한 번** 실려 오고 그 뒤의 `pane_updated` 는
 * 그 필드를 안 싣고 오기 때문이다. `readRecord(...) ?? null` 로 읽으면 그 한 건이 알던 참조를
 * 지워 2차 줄이 깜빡인다 — 수정 1회차 M2(에이전트 이름)가 겪은 것과 **같은 모양의 결함**이다.
 * 키가 있으면 herdr 가 값을 말해 준 것이고, null 이어도 그게 답이다.
 */
function pickAgentSession(
  source: Record<string, unknown>,
  fallback: AgentSessionRef | null,
): AgentSessionRef | null {
  if (!('agent_session' in source)) return fallback
  return readAgentSession(source['agent_session'])
}

/**
 * herdr 의 세션 참조 봉투를 corral 타입으로 옮긴다. **여기가 마지막 herdr 어휘다** —
 * 밖으로 나가는 것은 `AgentSessionRef` 이고 snake_case 는 이 함수 안에서 끝난다 (기준 A2).
 *
 * 실측 봉투 (`raw/claude/a3-agent-session-probe.json`):
 *   `{"source":"herdr:claude","agent":"claude","kind":"id","value":"<세션 id>"}`
 * `kind` 가 둘 중 하나가 아니면 **버린다** — 모르는 갈래를 지어내 화면에 올리지 않는다.
 */
function readAgentSession(value: unknown): AgentSessionRef | null {
  if (!isRecord(value)) return null
  const agent = readString(value, 'agent')
  const source = readString(value, 'source')
  const kind = readString(value, 'kind')
  const raw = readString(value, 'value')
  if (agent === null || source === null || raw === null || raw.length === 0) return null
  if (kind === 'id') return { kind: 'id', agent, source, id: raw }
  if (kind === 'path') return { kind: 'path', agent, source, path: raw }
  return null
}

/**
 * `{result:{snapshot:{…}}}` · `{snapshot:{…}}` · `{…}` 어느 모양으로 와도 안쪽을 집는다.
 *
 * **모양이 아니면 null 이다** (수정 1회차 M1). 1회차에는 `snapshot` 키가 없으면 받은 객체를
 * 그대로 안쪽으로 삼았고, 그래서 엉뚱한 응답 하나가 "workspace 0·tab 0·pane 0 인 스냅샷" 으로
 * 읽혔다. 스냅샷이 진실인 규칙 아래서 그것은 **목록 전멸 + 영구 묘비**다 (리뷰 부록 D).
 * 세 키 중 하나도 없으면 그건 스냅샷이 아니다 — 아무것도 고치지 않는 편이 옳다.
 *
 * **세 키가 다 있어야 한다** (수정 2회차 L-1). 1회차 지시의 문언은 "하나도 없으면 null" 이라
 * `some` 으로 정확히 그것을 했는데, 그러면 `{tabs:[…]}` 처럼 **한 층만 든 응답**은 여전히
 * 스냅샷으로 통과해 나머지 두 층을 전멸시킨다. 진짜 `session.snapshot` 은 세 키를 다 싣는다
 * (실측 `00-shapes.json`) — 하나라도 없으면 스냅샷이 아니다.
 */
const SNAPSHOT_KEYS: readonly string[] = ['workspaces', 'tabs', 'panes']

function readSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const inner = readRecord(value, 'snapshot') ?? value
  if (!SNAPSHOT_KEYS.every((key) => Array.isArray(inner[key]))) return null
  return inner
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
