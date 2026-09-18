// 접힘 요약 행의 **상태 클러스터** (기준 C7, 수정 라운드 5 P6 — Orca 동등).
//
// 접힌 worktree 카드가 보여야 하는 것은 "세션 몇 개" 가 아니라 **"무엇이 어떤 상태인가"** 다.
// 지금까지 corral 은 첫 세션 하나의 글리프 + `+N` 이었다 (H-5). Orca 는 같은 자리에
// **상태로 묶은 클러스터 줄**을 그린다 (`worktree-card-compact-agents.tsx:77-188`,
// `worktree-card-agent-summary.ts`) — 사용자가 접힘 카드 스크린샷을 들고 "이렇게 나오게" 라고
// 짚은 것이 그 줄이다.
//
// 규칙은 Orca 것을 그대로 옮긴다 (코드가 아니라 규칙을 — 타입이 다르다):
//   ① 상태로 묶고 **고정 순서**로 정렬한다. 생성 순서가 아니다 (동률 깨기로만 남는다)
//   ② 클러스터는 **최대 3개** (Orca `groups.slice(0, 3)` 의 리터럴 3 그대로)
//   ③ 클러스터 = 상태 점 1 + **종류별 대표** 아이콘 최대 3. 같은 상태의 claude 5개는 아이콘 1개다
//   ④ `+N` 이 **두 층**이다 — 클러스터 안에서 아이콘이 안 붙은 수, 그리고 잘려나간 클러스터들의
//      세션 합. **둘 다 숨은 수이지 총수가 아니다**
//   ⑤ 상태 점과 종류 아이콘은 **안 합친다** (Orca `AgentStateDot.tsx:18-21` 의 명문 — "누가" 와
//      "어떤 상태인가" 를 각각 훑을 수 있어야 한다). corral 의 H-6 두 칸 규칙과 같은 말이다

import type { AgentKind, AgentStatus, PaneRow } from '../../shared/types.js'
import { agentIcon } from './session-glyphs.js'

/**
 * 상태 정렬 순서. **corral 의 상태는 넷뿐**이라 Orca 의 8단을 그대로 못 쓴다
 * (`waiting`·`monitoring`·`interrupted`·`done` 은 corral 에 값 자체가 없다 — `session-glyphs.ts`).
 *
 * `unknown` 이 `idle` 위인 것은 Orca 의 `unverifiable` 자리를 잇는 것이다. 거기 주석이
 * "보고하는 상태들 아래, 진짜 idle 위 — pane 은 아직 잡혀 있다" 라고 사유를 박아 뒀다.
 */
export const SUMMARY_STATUS_ORDER: readonly AgentStatus[] = ['blocked', 'working', 'unknown', 'idle']

/** 클러스터 상한 · 클러스터당 아이콘 상한 — Orca 의 리터럴 3 두 자리 그대로. */
export const MAX_CLUSTERS = 3
export const MAX_ICONS_PER_CLUSTER = 3

export type SummaryIcon = { kind: AgentKind; glyph: string; label: string }

export type SummaryCluster = {
  status: AgentStatus
  /** 이 상태의 **종류별 대표** 아이콘 (최대 3). 종류를 모르면 아이콘이 안 실린다. */
  icons: SummaryIcon[]
  /** 이 클러스터에서 **아이콘이 안 붙은** 세션 수 (`+N` 첫 층). */
  hiddenIcons: number
  /** 이 상태의 세션 수. */
  count: number
}

export type CollapsedSummary = {
  clusters: SummaryCluster[]
  /** 상한에 잘려나간 클러스터들의 **세션 합** (`+N` 둘째 층). */
  hiddenSessions: number
  /** 접힌 세션 총수 — 툴팁에만 쓴다. `+N` 두 개와 **다른 수**다. */
  total: number
}

/**
 * 접힌 카드의 요약 한 줄.
 *
 * 입력은 **이미 걸러진 에이전트 pane 목록**이다 (`WorktreeBlock.panes`) — 사이드바가 그리는
 * 세션과 같은 집합이어야 접힘/펼침이 같은 것을 말한다.
 */
export function collapsedSummary(input: { panes: readonly PaneRow[] }): CollapsedSummary {
  const byStatus = new Map<AgentStatus, PaneRow[]>()
  for (const pane of input.panes) {
    const rows = byStatus.get(pane.agentStatus)
    if (rows === undefined) byStatus.set(pane.agentStatus, [pane])
    else rows.push(pane)
  }

  const ordered: SummaryCluster[] = []
  for (const status of SUMMARY_STATUS_ORDER) {
    const rows = byStatus.get(status)
    if (rows === undefined || rows.length === 0) continue
    const icons = representativeIcons(rows)
    ordered.push({ status, icons, hiddenIcons: Math.max(0, rows.length - icons.length), count: rows.length })
  }

  const clusters = ordered.slice(0, MAX_CLUSTERS)
  const hiddenSessions = ordered.slice(clusters.length).reduce((sum, cluster) => sum + cluster.count, 0)
  return { clusters, hiddenSessions, total: input.panes.length }
}

/**
 * 한 클러스터의 **종류별 대표** 아이콘 (Orca `selectSummaryGroupIconAgents`).
 *
 * 종류로 묶어 **많은 종류부터**, 동률이면 먼저 나온 것부터 하나씩 집는다. 그래서 같은 상태에
 * claude 5개 + codex 1개가 있으면 아이콘은 `claude` · `codex` **둘**이고 `+4` 가 붙는다.
 * 종류를 모르는 세션(`agentIcon` 이 null)은 대표를 못 내므로 숨은 수로 간다 — 없는 아이콘을
 * 지어내지 않는다 (H-6 과 같은 규칙).
 */
function representativeIcons(rows: readonly PaneRow[]): SummaryIcon[] {
  const byKind = new Map<AgentKind, { icon: SummaryIcon; count: number; firstIndex: number }>()
  rows.forEach((pane, index) => {
    const icon = agentIcon(pane.agent)
    if (icon === null) return
    const seen = byKind.get(icon.kind)
    if (seen === undefined) byKind.set(icon.kind, { icon, count: 1, firstIndex: index })
    else seen.count += 1
  })
  return [...byKind.values()]
    .sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex)
    .slice(0, MAX_ICONS_PER_CLUSTER)
    .map((entry) => entry.icon)
}
