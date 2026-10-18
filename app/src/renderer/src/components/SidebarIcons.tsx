// 사이드바 헤더·옵션 메뉴 아이콘 (LIFE-470) — lucide 경로를 그대로 옮겼다(198 이 쓰는 아이콘, `AgentStateDot.tsx` 와 같은 방식 —
// 아이콘 라이브러리를 들이지 않는다).
// 출처·라이선스: lucide(https://lucide.dev, lucide-react v0.577.0 — Orca 198 이 쓰는 판) · ISC License · Copyright (c) Lucide Contributors.
// LIFE-515 가 `Bot`·`Terminal`·`Settings` 를 더하며 이 고지를 적었다(01-criteria K2ⓖ).
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

/** lucide `GitCommitHorizontal` — Hide detached HEAD 행 · detached HEAD 카드 배지(LIFE-491, 198 `DetachedHeadBadge.tsx`). */
export function GitCommitIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <circle cx="12" cy="12" r="3" />
      <line x1="3" x2="9" y1="12" y2="12" />
      <line x1="15" x2="21" y1="12" y2="12" />
    </svg>
  )
}

/** lucide `Wrench` — Full list 2줄 도구(198 `DashboardAgentRowToolStep.tsx` `size-2.5`). */
export function WrenchIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
    </svg>
  )
}

/** lucide `Star` — Compact 카드의 주 워크트리 표시(198 `worktree-card-header.tsx` `Star size-3 fill-amber-400 text-amber-400`). */
export function StarIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE} fill="currentColor">
      <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
    </svg>
  )
}

/** lucide `StickyNote` — 워크스페이스 메모 배지 (LIFE-478, 198 `WorktreeCardMetaBadges.tsx:81-90`). */
export function NoteIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z" />
      <path d="M15 3v4a2 2 0 0 0 2 2h4" />
    </svg>
  )
}

/** lucide `Trash2` — Option+hover 삭제 단추 (LIFE-478, 198 `worktree-card-header.tsx:291-317`). */
export function TrashIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

/** lucide `Pin` — Pinned 구획 머리 (LIFE-478, 198 `group-keys.ts:78-85`). */
export function PinIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  )
}

/** lucide `Workflow` — 「N 하위」 칩 (LIFE-576, Orca main `worktree-card-secondary-rows.tsx`). */
export function WorkflowIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <rect width="8" height="8" x="3" y="3" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
      <rect width="8" height="8" x="13" y="13" rx="2" />
    </svg>
  )
}

/** lucide `Crosshair` — Reveal active (LIFE-478, 198 `ScrollToCurrentWorkspaceToolbarButton.tsx`). */
export function CrosshairIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <circle cx="12" cy="12" r="10" />
      <line x1="22" x2="18" y1="12" y2="12" />
      <line x1="6" x2="2" y1="12" y2="12" />
      <line x1="12" x2="12" y1="6" y2="2" />
      <line x1="12" x2="12" y1="22" y2="18" />
    </svg>
  )
}

/** lucide `ArrowLeft` — 설정 「앱으로 돌아가기」(198 `SettingsSidebar.tsx:209`, LIFE-511). */
export function ArrowLeftIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  )
}

/** lucide `Keyboard` — 설정 내비 「단축키」(198 settings nav icon, LIFE-511). */
export function KeyboardIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M10 8h.01" />
      <path d="M12 12h.01" />
      <path d="M14 8h.01" />
      <path d="M16 12h.01" />
      <path d="M18 8h.01" />
      <path d="M6 8h.01" />
      <path d="M7 16h10" />
      <path d="M8 12h.01" />
      <rect width="20" height="16" x="2" y="4" rx="2" />
    </svg>
  )
}

/** lucide `Palette` — 설정 내비 「외관」(198 `settings-navigation-interface-sections.ts`, LIFE-512). */
export function PaletteIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  )
}

/** lucide `SquareTerminal` — 외관 › 터미널 카드(198 `AppearancePane.tsx` `TerminalSquare`). */
export function TerminalSquareIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    </svg>
  )
}

/** lucide `Minus`·`Plus` — 글꼴 크기 ± (198 `TerminalFontSizeSetting.tsx`). */
export function MinusIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M5 12h14" />
    </svg>
  )
}
export function PlusIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  )
}

/** lucide `Bot` — 설정 내비 「에이전트」(198 `settings-navigation-capability-sections.ts:42`, LIFE-515). */
export function BotIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  )
}

/** lucide `Smartphone` — 설정 내비 「Mobile」(LIFE-577). */
export function SmartphoneIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </svg>
  )
}

/** lucide `Terminal` — 기본 Agent 「agent 없음(빈 terminal)」 pill(198 `AgentDefaultSetting.tsx`, LIFE-515). */
export function TerminalIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M12 19h8" />
      <path d="m4 17 6-6-6-6" />
    </svg>
  )
}

/** lucide `Settings` — 탭바 `+` 메뉴 「Agent 설정…」(198 `QuickLaunchButton.tsx:250`, LIFE-515). */
export function SettingsGearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

/** lucide `CircleHelp`(0.577.0 = `circle-question-mark` 경로) — 하단 바 도움말(198 `SidebarSettingsHelpMenu.tsx:239`). LIFE-526 이 더했다(위 고지 그대로). */
export function CircleHelpIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  )
}

/** lucide `RefreshCw` — 하단 바 ↻ worktree 재조회(corral 고유, 아이콘은 198 「업데이트 확인」 `SidebarSettingsHelpMenu.tsx:339`). LIFE-526 이 더했다(위 고지 그대로). */
export function RefreshCwIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

/** lucide `PanelLeft` — 설정 › 외관 「창 및 사이드바」 카드(198 `AppearancePane.tsx:264`). LIFE-516 가 더했다(위 고지 그대로). LIFE-527 사이드바 머리 토글도 쓴다(198 `TitlebarLeftControls.tsx` `<PanelLeft size={16} />`). */
/** lucide `PanelRight` — 오른쪽 패널 토글(LIFE-589, Orca `TitlebarRightControls` 와 같은 아이콘). */
export function PanelRightIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </svg>
  )
}

export function PanelLeftIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  )
}

/** 칸반 — 설정 › 작업 연결(LIFE-600, 목업 tasks-settings.dc.html 내비 아이콘). */
export function KanbanIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden {...STROKE}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="M15 3v10" />
    </svg>
  )
}
