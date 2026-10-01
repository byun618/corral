// 사이드바 헤더·옵션 메뉴 아이콘 (LIFE-470) — lucide 경로를 그대로 옮겼다(198 이 쓰는 아이콘, `AgentStateDot.tsx` 와 같은 방식 —
// 아이콘 라이브러리를 들이지 않는다).
const STROKE: React.SVGProps<SVGSVGElement> = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }

/** lucide `SlidersHorizontal` — Workspace options 버튼(198 `SidebarWorkspaceOptionsMenu.tsx:68`, strokeWidth 2.25). */
export function SlidersIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE} strokeWidth={2.25}>
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </svg>
  )
}

/** lucide `Search` — 사이드바 Search 줄(198 `SidebarNav.tsx:102-105`, strokeWidth 1.75). */
export function SearchIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE} strokeWidth={1.75}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

export function CheckIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function ChevronRightIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** lucide `CircleX` — 빈 상태 「필터 지우기」(198 `EmptyState.tsx`). */
export function CircleXIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  )
}

/** lucide `List` — Group by None 의 「All」 헤더(198 `group-keys.ts:88-96`). */
export function ListIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
      <path d="M3 6h.01" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M8 6h13" />
    </svg>
  )
}

/** lucide `GitBranch` — Hide default branch 행(198 `SidebarWorkspaceFilterSection.tsx`). */
export function GitBranchIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

/** lucide `GitCommitHorizontal` — Hide detached HEAD 행. */
export function GitCommitIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <circle cx="12" cy="12" r="3" />
      <line x1="3" x2="9" y1="12" y2="12" />
      <line x1="15" x2="21" y1="12" y2="12" />
    </svg>
  )
}
