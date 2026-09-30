// 사이드바 worktree 한 벌의 **에이전트 행 나무** (LIFE-467 S1 — D2·D4·D6~D12·D14).
//
// Orca 1.4.198 compact 목록(`WorktreeCardAgents.tsx:340-407`)이 그리는 행은 세 출처에서 온다:
//   · 살아 있는 pane                                   → `live`
//   · 부모 세션의 서브에이전트(462 `lifecycle.subagents`) → `subagent` (자기 pane 이 없다 — 클릭 = 부모 pane)
//   · 닫힌 탭의 마지막 완료 기록(456 `retainedAgents`)     → `retained`
// 그리고 459 `orchestrationLineage` 가 살아 있는 pane 끼리 부모·자식을 잇는다.
//
// 이 파일은 그 넷을 **한 번** 합쳐 루트 행 목록을 만든다. 화면(`WorktreeBlock`)은 그리기만 한다 — 묶음 임계·
// 알약 요약·행 글자가 전부 여기서 나온 같은 목록을 본다.
//
// # 시각 깊이는 1 로 고정한다
//
// Orca 는 계보 깊이를 0/1 로 자른다(`agent-row-lineage.ts:54-55` — "visual depth remains capped so dense
// sidebar rows don't lose too much prompt width"). 손자는 **루트 아래 같은 깊이**로 이어 붙인다(깊이 우선 순서).
// 셰브론·`+N` 은 자식이 있는 루트에만 선다.
//
// # 정렬 — 기준 시각이 없어서 Orca 정렬 사슬의 다음 키를 쓴다 (U5)
//
// Orca 는 `startedAt` 오름차순 → `tab.sortOrder` → `tab.createdAt` → paneKey 다(`worktree-agent-row-order.ts:17-23`).
// corral 에는 에이전트 **시작 시각이 없다** — herdr 0.9.0 스키마에 에이전트 시각 필드가 없고(`shared/types.ts`
// `AgentObservedVia` 주석), `agentState.observedAt` 은 "지금 상태를 처음 본 시각" 이라 상태가 바뀔 때마다 움직이며
// `history` 는 20칸에서 잘린다. 움직이는 키로 정렬하면 행이 제멋대로 자리를 바꾼다. 그래서 사슬의 둘째 키인
// **탭 목록 순서**(새 탭은 끝에 붙는다 = 만든 순서)와 탭 안 pane 순서를 쓴다. retained 행은 살아 있는 행 뒤에
// 보존된 순서(오래된 것 먼저)로 붙는다.

import type { AgentKind, IntegrationRow, OrchestrationLineage, PaneRow, RetainedAgentRow, TabRow } from '../../shared/types.js'
import { AGENT_DOT_LABEL, agentDot, type AgentDot } from './agent-dot.js'
import { paneSecondaryLine, sessionRowText, type SessionRowText } from './session-activity.js'
import { agentIcon, AGENT_ICON } from './session-glyphs.js'
import { paneSessionTitle } from './session-title.js'

export type AgentRowSource = 'live' | 'subagent' | 'retained'

export type AgentRowNode = {
  /** 행 키 — live 는 paneId, subagent 는 `<부모 paneId>\u0000subagent:<id>`(Orca 합성 키와 같은 NUL 구분), retained 는 `retained:<paneId>`. */
  key: string
  source: AgentRowSource
  /** 그 행이 선 pane (live·retained) 또는 부모 pane (subagent). */
  paneId: string
  /** live 행의 탭 — `data-tab` 과 닫기 버튼이 쓴다. 다른 출처는 null. */
  tabId: string | null
  /**
   * 행을 눌렀을 때 갈 pane. **null 이면 무반응**이다.
   * retained 는 그 pane 이 아직 살아 있을 때만 그 pane 이다(B2 — Orca #20803 의 기대 동작; 198 은 늘 무반응).
   */
  activationPaneId: string | null
  kind: AgentKind | null
  /** 종류 아이콘을 그리나 — 서브에이전트 행은 숨긴다(부모 들여쓰기가 정체성을 대신한다, Orca `:112-116`). */
  showIcon: boolean
  dot: AgentDot
  /** 안 본 완료(herdr `done`) — 굵게 그린다(B1, 1.4.217 기준). live 행만. */
  unseenDone: boolean
  text: SessionRowText
  model: string | null
  /** 경과 시간의 기준 시각. 없으면 시간 칸이 없다. */
  timeAt: number | null
  /** 시각 깊이 1 로 편 자손 (루트만 가진다). */
  children: AgentRowNode[]
}

/** 묶음 알약이 서는 루트 수 — Orca `summaryAgents.length > 1` (`WorktreeCardAgents.tsx:365`). */
export const SUMMARY_MIN_ROOTS = 2

/**
 * 이 worktree 의 루트 행 목록.
 *
 * `tabs` 는 이 worktree 의 열린 탭(탭 목록 순서), `retained` 는 앱 전체의 보존 목록, `livePaneIds` 는 **앱 전체**의
 * 살아 있는 pane — retained 행의 pane 이 다른 곳에 살아 있으면 그리로 간다.
 */
export function buildAgentRows(input: {
  tabs: readonly TabRow[]
  workspaceId: string | null
  retained: readonly RetainedAgentRow[]
  lineage: OrchestrationLineage
  livePaneIds: ReadonlySet<string>
  integrations: readonly IntegrationRow[]
  home: string
}): AgentRowNode[] {
  const panes = input.tabs.flatMap((tab) => tab.panes.filter((pane) => pane.agent !== null))
  const liveNodes = panes.map((pane, index) => liveNode({ pane, ordinal: index + 1, integrations: input.integrations, home: input.home }))
  const byPane = new Map(liveNodes.map((node) => [node.paneId, node]))
  const paneOf = new Map(panes.map((pane) => [pane.paneId, pane]))
  const subagentsOf = (node: AgentRowNode): AgentRowNode[] => {
    const pane = paneOf.get(node.paneId)
    return pane === undefined ? [] : subagentNodes({ parent: node, pane })
  }

  // 계보: 부모가 **이 worktree 의 살아 있는 에이전트 pane** 일 때만 잇는다 — 다른 곳의 부모는 여기서 못 그린다.
  const parentOf = new Map<string, string>()
  if (input.lineage.state === 'ready') {
    for (const entry of input.lineage.entries) {
      if (entry.parentPaneId === null || entry.parentPaneId === entry.paneId) continue
      if (!byPane.has(entry.paneId) || !byPane.has(entry.parentPaneId)) continue
      parentOf.set(entry.paneId, entry.parentPaneId)
    }
  }
  const childrenOf = new Map<string, AgentRowNode[]>()
  for (const node of liveNodes) {
    const parent = parentOf.get(node.paneId)
    if (parent === undefined) continue
    const list = childrenOf.get(parent)
    if (list === undefined) childrenOf.set(parent, [node])
    else list.push(node)
  }

  // 순환 방어 — 공급 단계가 순환 없는 숲을 보장하지만(`OrchestrationLineageEntry` 주석) 화면이 그 약속에 목숨을
  // 걸지 않는다. 조상을 따라 올라가다 자기로 돌아오면 그 pane 은 루트로 둔다.
  const isRoot = (paneId: string): boolean => {
    const seen = new Set<string>([paneId])
    let current = parentOf.get(paneId)
    while (current !== undefined) {
      if (seen.has(current)) return true
      seen.add(current)
      current = parentOf.get(current)
    }
    return !parentOf.has(paneId)
  }

  const roots: AgentRowNode[] = []
  const placed = new Set<string>()
  const flatten = (node: AgentRowNode, into: AgentRowNode[]): void => {
    for (const sub of subagentsOf(node)) into.push(sub)
    for (const child of childrenOf.get(node.paneId) ?? []) {
      if (placed.has(child.paneId)) continue
      placed.add(child.paneId)
      into.push(child)
      flatten(child, into)
    }
  }
  for (const node of liveNodes) {
    // 순환 고리의 pane 은 둘 다 루트 자격이 서므로, 먼저 선 루트가 이미 자식으로 데려간 pane 은 건너뛴다.
    if (!isRoot(node.paneId) || placed.has(node.paneId)) continue
    placed.add(node.paneId)
    const children: AgentRowNode[] = []
    flatten(node, children)
    roots.push({ ...node, children })
  }
  // 순환에 갇혀 어느 루트에도 안 닿은 pane 은 루트로 살린다 — 행이 사라지는 것보다 낫다.
  for (const node of liveNodes) {
    if (placed.has(node.paneId)) continue
    placed.add(node.paneId)
    roots.push({ ...node, children: subagentsOf(node) })
  }

  const liveHere = new Set(liveNodes.map((node) => node.paneId))
  const retainedRows = input.workspaceId === null ? [] : input.retained.filter((row) => row.workspaceId === input.workspaceId && !liveHere.has(row.paneId))
  // `retainedAgents` 는 최신 우선이다(`AppState` 주석) — 행은 오래된 것부터 쌓는다.
  for (const row of [...retainedRows].reverse()) roots.push(retainedNode({ row, livePaneIds: input.livePaneIds }))
  return roots
}

function liveNode(input: { pane: PaneRow; ordinal: number; integrations: readonly IntegrationRow[]; home: string }): AgentRowNode {
  const { pane, ordinal } = input
  const dot = agentDot({
    agentStatus: pane.agentStatus,
    blockedReason: pane.agentState.blockedReason,
    pendingQuestions: pane.digest.pendingQuestions,
    turnOutcome: pane.digest.turnOutcome,
    lifecycle: pane.digest.lifecycle,
  })
  const kind = agentIcon(pane.agent)?.kind ?? null
  const title = paneSessionTitle({ pane, ordinal, home: input.home })
  const done = pane.agentStatus === 'idle' || pane.agentStatus === 'done'
  return {
    key: pane.paneId,
    source: 'live',
    paneId: pane.paneId,
    tabId: pane.tabId,
    activationPaneId: pane.paneId,
    kind,
    showIcon: true,
    dot,
    unseenDone: pane.agentStatus === 'done',
    text: liveText({ pane, dot, title, ordinalTitle: title === `${pane.agent ?? 'terminal'} ${ordinal}`, kind, integrations: input.integrations }),
    model: pane.digest.model,
    // Orca: 끝난 에이전트는 「끝난 지 얼마」, 아니면 시작부터(`getCompactAgentTime`). corral 은 시작 시각이 없어
    // **지금 상태를 처음 본 시각**을 쓴다 — 결과 문서에 기준 시각으로 적는다.
    timeAt: done && pane.agentState.enteredDoneAt !== null ? pane.agentState.enteredDoneAt : pane.agentState.observedAt,
    children: [],
  }
}

/**
 * live 행 글 — Orca `getCompactAgentSecondary`(`worktree-card-compact-agent-row.tsx:26-57`)의 순서를 corral 칸으로 옮긴다:
 *   ① 중단된 턴 → 「중단됨」 ② monitoring → 상태 이름을 **앞**에 두고 제목을 뒤로(Orca `:142-144` — 잘릴 때 수동/능동 구분이 남게)
 *   ③ 진행 중 도구·마지막 발화·통지 (`paneSecondaryLine`, 기존 규칙) ④ 그것도 없으면 종류 이름.
 * ④ 는 codex·grok 처럼 `providerTitle`·`tool` 이 구조적으로 null 인 provider 에서 뒤 칸이 비지 않게 하는 폴백이다 —
 * 단 제목이 이미 `codex 1` 같은 종류 폴백이면 같은 말을 두 번 하지 않는다.
 */
function liveText(input: {
  pane: PaneRow
  dot: AgentDot
  title: string
  ordinalTitle: boolean
  kind: AgentKind | null
  integrations: readonly IntegrationRow[]
}): SessionRowText {
  const { pane, dot, title } = input
  if (dot === 'monitoring') {
    const label = AGENT_DOT_LABEL.monitoring
    return { leading: label, trailing: title, full: `${label} - ${title}` }
  }
  if (dot === 'interrupted') return sessionRowText({ title, secondary: { kind: 'text', text: AGENT_DOT_LABEL.interrupted } })
  const secondary = paneSecondaryLine({ pane, integrations: input.integrations })
  if (secondary.kind !== 'empty' || input.ordinalTitle || input.kind === null) return sessionRowText({ title, secondary })
  return sessionRowText({ title, secondary: { kind: 'text', text: AGENT_ICON[input.kind].label } })
}

/** 서브에이전트 자식 행 — 462 `lifecycle.subagents`. 기록에서 가를 수 있는 상태는 `running` 하나라 점은 작업중이다. */
function subagentNodes(input: { parent: AgentRowNode; pane: PaneRow }): AgentRowNode[] {
  const { parent, pane } = input
  const lifecycle = pane.digest.lifecycle
  if (lifecycle.state !== 'known') return []
  return lifecycle.subagents.map((sub) => {
    const leading = sub.name ?? sub.description ?? sub.agentType ?? '서브에이전트'
    const trailing =
      sub.name !== null && sub.description !== null && sub.description !== sub.name
        ? sub.description
        : sub.agentType !== null && sub.agentType !== leading
          ? sub.agentType
          : null
    return {
      key: `${parent.paneId}\u0000subagent:${sub.id}`,
      source: 'subagent',
      paneId: parent.paneId,
      tabId: null,
      activationPaneId: parent.paneId,
      kind: parent.kind,
      showIcon: false,
      dot: 'working',
      unseenDone: false,
      text: { leading, trailing, full: trailing === null ? leading : `${leading} - ${trailing}` },
      model: null,
      timeAt: sub.startedAt,
      children: [],
    }
  })
}

function retainedNode(input: { row: RetainedAgentRow; livePaneIds: ReadonlySet<string> }): AgentRowNode {
  const { row } = input
  const kind = agentIcon(row.agent)?.kind ?? null
  const leading = row.title.trim().length > 0 ? row.title : kind === null ? '에이전트' : AGENT_ICON[kind].label
  const trailing = '닫힌 탭'
  return {
    key: `retained:${row.paneId}`,
    source: 'retained',
    paneId: row.paneId,
    tabId: null,
    activationPaneId: input.livePaneIds.has(row.paneId) ? row.paneId : null,
    kind,
    showIcon: true,
    // 보존은 `done` 인 pane 만 한다(`store.ts` `retain`) — 완료 점 하나다.
    dot: 'done',
    // 닫힌 탭은 「봤다」 로 바꿀 길이 없다 — 굵게 두면 영영 안 풀린다. 굵기는 live 행만.
    unseenDone: false,
    text: { leading, trailing, full: `${leading} - ${trailing}` },
    model: null,
    timeAt: row.agentState.enteredDoneAt ?? row.retainedAt,
    children: [],
  }
}

/** 앱 전체의 살아 있는 pane id. */
export function livePaneIdsOf(repos: readonly { worktrees: readonly { workspace: { tabs: readonly TabRow[] } | null }[] }[]): Set<string> {
  const ids = new Set<string>()
  for (const repo of repos) for (const worktree of repo.worktrees) for (const tab of worktree.workspace?.tabs ?? []) for (const pane of tab.panes) ids.add(pane.paneId)
  return ids
}
