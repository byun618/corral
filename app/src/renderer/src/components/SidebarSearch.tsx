// 사이드바 Search 줄 (LIFE-470 · D28a) — 198 `SidebarNav.tsx:93-121`: 버튼 `px-2 py-1.5 rounded-md bg-foreground/5 text-[13px]
// font-medium` · `Search` 아이콘 size-4 30% · 문구 "Search" · ⌘J 키캡(9px)은 hover·focus 때만. 누르면 팔레트가 열린다.
// corral 은 LIFE-391 팔레트를 그대로 연다(게이트 ⓪ Q3 — 팔레트 동일화 D28c 는 448 밖). 옛 disabled 입력은 지웠다(K1ⓓ).
import { SearchIcon } from './SidebarIcons.js'

export function SidebarSearch({ shortcut, onOpen }: { shortcut: string | null; onOpen: () => void }): React.JSX.Element {
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
    </div>
  )
}
