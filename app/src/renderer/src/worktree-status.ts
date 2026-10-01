// 워크트리 카드 **상태 슬롯** (LIFE-468 K5ⓑ) — 워크트리의 에이전트 활동을 점 하나로 모은다.
//
// Orca 1.4.198 의 카드 상태 점은 git 상태가 아니라 **에이전트 활동 집계**다(`lib/worktree-status.ts`
// `resolveWorktreeStatus` · `worktree-agent-activity-summary.ts` `applyLiveAgentState`). 우선순위도 그대로 옮긴다:
//   permission(blocked·waiting) > working > monitoring > interrupted > done(살아 있는 done·보존 done) > active(열린 탭) > inactive.
// corral 은 행마다 이미 점을 하나 고른다(`agent-dot.ts`, LIFE-467 K4) — 그 점들을 워크트리 단위로 접는다.
// 대응표 전문은 specs/LIFE-468-sidebar-cards/raw/claude/k5-status-slot.md.
import type { AgentDot } from './agent-dot.js'
import type { AgentRowNode } from './sidebar-agents.js'

export type WorktreeStatus = 'permission' | 'working' | 'monitoring' | 'interrupted' | 'done' | 'active' | 'inactive'

/** 슬롯 툴팁·접근성 라벨 — Orca `STATUS_LABELS` 의 뜻을 한국어 UI 로 (D17). */
export const WORKTREE_STATUS_LABEL: Record<WorktreeStatus, string> = {
  permission: '입력 대기',
  working: '작업중',
  monitoring: '백그라운드 작업 감시 중',
  interrupted: '중단됨',
  done: '완료',
  active: '열림',
  inactive: '닫힘',
}

/** 행 점 하나가 워크트리 집계의 어느 칸을 켜는가. `idle`·`unverifiable` 은 아무 칸도 켜지 않는다(Orca 도 idle 은 칸이 없다). */
function flagOf(dot: AgentDot): WorktreeStatus | null {
  switch (dot) {
    case 'waiting':
    case 'blocked':
      return 'permission'
    case 'working':
      return 'working'
    case 'monitoring':
      return 'monitoring'
    case 'interrupted':
    case 'failed':
      return 'interrupted'
    case 'done':
      return 'done'
    case 'idle':
    case 'unverifiable':
      return null
  }
}

const PRIORITY: readonly WorktreeStatus[] = ['permission', 'working', 'monitoring', 'interrupted', 'done']

function collect({ rows, into }: { rows: readonly AgentRowNode[]; into: Set<WorktreeStatus> }): void {
  for (const row of rows) {
    // 보존 행은 끝난 기록이다 — Orca `hasRetainedDone` 처럼 점이 무엇이든 done 칸만 켠다.
    const flag = row.source === 'retained' ? 'done' : flagOf(row.dot)
    if (flag !== null) into.add(flag)
    collect({ rows: row.children, into })
  }
}

export function worktreeStatus({ rows, hasOpenTabs }: { rows: readonly AgentRowNode[]; hasOpenTabs: boolean }): WorktreeStatus {
  const flags = new Set<WorktreeStatus>()
  collect({ rows, into: flags })
  for (const status of PRIORITY) if (flags.has(status)) return status
  return hasOpenTabs ? 'active' : 'inactive'
}
