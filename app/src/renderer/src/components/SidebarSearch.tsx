// 사이드바 Search 줄 (LIFE-470 · D28a) — 198 `SidebarNav.tsx:93-121`: 버튼 `px-2 py-1.5 rounded-md bg-foreground/5 text-[13px]
// font-medium` · `Search` 아이콘 size-4 30% · 문구 "Search" · ⌘J 키캡(9px)은 hover·focus 때만. 누르면 팔레트가 열린다.
// corral 은 LIFE-391 팔레트를 그대로 연다(게이트 ⓪ Q3 — 팔레트 동일화 D28c 는 448 밖). 옛 disabled 입력은 지웠다(K1ⓓ).
import { SearchIcon } from './SidebarIcons.js'

export function SidebarSearch({ shortcut, onOpen, tasks }: { shortcut: string | null; onOpen: () => void; tasks?: { open: boolean; onToggle: () => void; shortcut: string | null } }): React.JSX.Element {
  return (
    <div className="sidebar-nav" data-sidebar-nav="">
      <button type="button" className="sidebar-search" data-sidebar-search="" onClick={onOpen} aria-label="검색 — 팔레트 열기">
        <SearchIcon className="sidebar-search-glyph" />
        <span className="sidebar-search-label">검색</span>
        {shortcut !== null ? (
          <kbd className="sidebar-search-keys" data-sidebar-search-keys="">
            {shortcut}
          </kbd>
        ) : null}
      </button>
      {/* LIFE-601 — 「작업」 진입. 검색 줄과 같은 문법(아이콘 30% · 키캡은 hover·focus 때만), 열려 있으면 켜짐 칠. */}
      {tasks === undefined ? null : <button
        type="button"
        className={`sidebar-search sidebar-tasks${tasks.open ? ' is-on' : ''}`}
        data-tasks-open=""
        aria-pressed={tasks.open}
        onClick={tasks.onToggle}
        title={tasks.shortcut === null ? '작업' : `작업 (${tasks.shortcut})`}
      >
        <TasksIcon className="sidebar-search-glyph" />
        <span className="sidebar-search-label">작업</span>
        {tasks.shortcut !== null ? (
          <kbd className="sidebar-search-keys">{tasks.shortcut}</kbd>
        ) : null}
      </button>}
    </div>
  )
}

/** 작업 아이콘 — lucide `SquareKanban`(ISC) path. 오른쪽 패널 작업 상세 보기 아이콘도 이것(LIFE-682 Q4 — 사이드바 작업 진입과 같은 모양). */
export function TasksIcon({ className }: { className: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M8 7v7" />
      <path d="M12 7v4" />
      <path d="M16 7v9" />
    </svg>
  )
}
