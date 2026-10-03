// 탭 **선두 표시** (LIFE-493 K2) — 탭 안 pane 들의 상태를 Orca 1.4.198 탭 어휘로 접는다. 순수 함수.
//
// Orca 는 탭을 「pane 을 담는 그릇」으로 보고 워크트리 카드와 **같은 어휘·같은 집계**를 쓴다
// (`terminal-tab-activity-status.ts:10-13`, `resolveWorktreeStatus` 재사용). corral 도 그대로 간다:
//   ① pane 하나 → 점 하나: 사이드바 에이전트 행과 **같은 함수**(`agentDot` + `displayStatus`, LIFE-467·471) — 사이드바와 탭이
//      같은 세션을 다른 기호로 그리면 두 목록을 짝지어 읽을 수 없다(H-6).
//   ② 점 → 탭 상태 칸: 카드 집계와 같은 `flagOf`, 우선순위 permission > working > monitoring > interrupted > done (pane 끼리 갈리면 permission 승).
//   ③ 탭 상태 + 안 읽음 → 배지: Orca `resolveTerminalTabAttentionBadge`(`:198-224`) 사다리 working > permission > monitoring > unread > done > interrupted.
//   ④ 배지 → 선두: Orca `TerminalTabLeadingIcon`(`:46-104`) — 벨(+로고) → 상태 점(+로고) → 로고만 → 셸 아이콘.
// 대응표 전문과 칸마다의 사유는 specs/LIFE-493-tabbar/raw/claude/k2-tab-status-map.md.
import type { AgentKind, TabRow } from '../../shared/types.js'
import { agentDot, type AgentDot } from './agent-dot.js'
import { agentIcon } from './session-glyphs.js'
import { tabAgent } from './session-title.js'
import { displayStatus } from './sidebar-agents.js'
import { flagOf, type WorktreeStatus } from './worktree-status.js'

/** 탭 활동 상태 — Orca `TerminalTabActivityStatus` 중 글리프를 가진 다섯 칸. 조용한 탭(active·inactive)은 null 이다. */
export type TabStatus = Exclude<WorktreeStatus, 'active' | 'inactive'>

/** pane 끼리 갈릴 때의 순서 — Orca `resolveWorktreeStatus`(`lib/worktree-status.ts:150-184`), 카드 집계(`worktree-status.ts`)와 같다. */
const STATUS_PRIORITY: readonly TabStatus[] = ['permission', 'working', 'monitoring', 'interrupted', 'done']

/** Orca `TerminalTabAttentionBadge` 그대로. */
export type TabBadge = 'working' | 'permission' | 'monitoring' | 'unread' | 'done' | 'interrupted'

/** 에이전트 정체 — 로고를 그리는 종류만. 셸은 정체가 아니라 폴백이다(Orca `agent: null`). */
export type TabAgentKind = Exclude<AgentKind, 'shell'>

export type TabLeading =
  | { kind: 'bell'; agent: TabAgentKind | null }
  | { kind: 'dot'; dot: AgentDot; agent: TabAgentKind | null }
  | { kind: 'agent'; agent: TabAgentKind }
  | { kind: 'shell' }

/** pane 하나의 점 — 사이드바 에이전트 행(`sidebar-agents.ts` `liveNode`)과 같은 입력·같은 함수. */
export function paneDot(input: { pane: TabRow['panes'][number]; unread: boolean }): AgentDot {
  const { pane } = input
  return agentDot({
    agentStatus: displayStatus({ agentStatus: pane.agentStatus, unread: input.unread }),
    blockedReason: pane.agentState.blockedReason,
    pendingQuestions: pane.digest.pendingQuestions,
    turnOutcome: pane.digest.turnOutcome,
    lifecycle: pane.digest.lifecycle,
    freshness: { observedAt: pane.agentState.observedAt, observedVia: pane.agentState.observedVia, outcomeAt: pane.digest.turnOutcomeAt },
  })
}

/**
 * pane 점들 → 탭 상태와 그 상태를 그릴 점 하나.
 *
 * 상태 칸은 Orca 와 같다. **그릴 점**은 그 칸에 든 pane 점 중 하나다 — permission 칸이면 질문 대기(`waiting`)가 있으면
 * 질문 아이콘, 사람이 답해서 풀리지 않는 막힘(`blocked`: trust·login·update·사유 모름)뿐이면 빨간 점이다. Orca 탭은 둘 다
 * 질문 아이콘으로 그리지만(blocked·waiting → permission) corral 은 사유를 갖고 있고, 사이드바 행이 이미 둘을 가른다(467 K4).
 * interrupted 칸의 `failed` 도 같은 빨간 점이다.
 */
export function tabStatus(dots: readonly AgentDot[]): { status: TabStatus; dot: AgentDot } | null {
  for (const status of STATUS_PRIORITY) {
    const inSlot = dots.filter((dot) => flagOf(dot) === status)
    const first = inSlot[0]
    if (first === undefined) continue
    return { status, dot: inSlot.includes('waiting') ? 'waiting' : first }
  }
  return null
}

/** Orca `resolveTerminalTabAttentionBadge` 사다리 그대로 — working > permission > monitoring > unread > done > interrupted.
 *  턴 안의 신호(스피너·입력 대기)는 지난 턴의 안 읽음보다 새것이라 벨 위에 선다(Orca `isTerminalTabActivityLive`). */
export function tabBadge(input: { status: TabStatus | null; hasUnread: boolean }): TabBadge | null {
  const { status, hasUnread } = input
  if (status === 'working') return 'working'
  if (status === 'permission') return 'permission'
  if (status === 'monitoring') return 'monitoring'
  if (hasUnread) return 'unread'
  if (status === 'done') return 'done'
  if (status === 'interrupted') return 'interrupted'
  return null
}

/** 탭의 에이전트 정체 — 라벨 규칙과 같은 `tabAgent`(첫 에이전트 pane). 모르는 종류·셸은 정체 없음. */
export function tabAgentKind(tab: TabRow): TabAgentKind | null {
  const kind = agentIcon(tabAgent(tab))?.kind ?? null
  return kind === null || kind === 'shell' ? null : kind
}

/**
 * 탭 하나의 선두 표시 (Orca `TerminalTabLeadingIcon`).
 *
 * 탭 안 읽음 = **그 탭 pane 중 하나라도 확인 안 된 완료가 있다**(LIFE-471 pane 장부). Orca 의 탭 안 읽음도 pane 완료 표식을
 * 탭으로 모은 것이다(`terminalTabHasUnreadActivity` 의 `unreadAgentCompletionPanes`) — 다른 반쪽(`unreadTerminalTabs`, 터미널
 * BEL 기반)은 corral 에 출처가 없다(k2 대응표 「대응 못 하는 칸」).
 */
export function tabLeading(input: { tab: TabRow; unreadPanes: ReadonlySet<string> }): TabLeading {
  const { tab, unreadPanes } = input
  const dots = tab.panes.map((pane) => paneDot({ pane, unread: unreadPanes.has(pane.paneId) }))
  const resolved = tabStatus(dots)
  const hasUnread = tab.panes.some((pane) => unreadPanes.has(pane.paneId))
  const agent = tabAgentKind(tab)
  const badge = tabBadge({ status: resolved?.status ?? null, hasUnread })
  if (badge === 'unread') return { kind: 'bell', agent }
  if (badge !== null && resolved !== null) return { kind: 'dot', dot: resolved.dot, agent }
  if (agent !== null) return { kind: 'agent', agent }
  return { kind: 'shell' }
}
