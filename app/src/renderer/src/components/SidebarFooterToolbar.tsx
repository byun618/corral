// 사이드바 하단 바 (LIFE-478 K8 · 198 `SidebarSettingsHelpMenu.tsx`·`ScrollToCurrentWorkspaceToolbarButton.tsx`) —
// 왼쪽 ⚙ · ?(메뉴), 오른쪽 Reveal active · ↻(LIFE-526 — 198 오른쪽 첫 칸이 Reveal 이라 같은 자리에 두고, ↻ 는 198 Kanban 자리). 198 오른쪽의 Kanban(◫)은 Kanban 경계라 뺐다(C20 의도적).
//   · ⚙ = 설정 페이지(LIFE-511 — 198 `SidebarSettingsHelpMenu.tsx:207` openSettingsPage)
//   · ? = 메뉴, 첫 항목 「단축키」 → 설정 › 단축키(LIFE-511 — 옛 단축키 모달 자리). 198 의 나머지 10항목(피드백·문서·변경 기록·GitHub·Discord·X·업데이트·재시작…)은
//     Orca 외부 링크·앱 수명 기능이라 대응 없음(RESULT 대응표)
//   · ↻ = corral 항목(worktree 상태 재조회, 198 없음 — 의도적 차이)
//   · Reveal = 활성 카드를 드러낸다(필터 확인 → 접힘 펼침 → 최소 스크롤 → 번쩍). 198 처럼 늘 누를 수 있고, 활성이 없으면 아무 일 없음
// LIFE-526 — 네 버튼 모두 198 `Button variant="ghost" size="icon-xs"`(24px 박스) + lucide 아이콘 `size-3.5`. 줄은 198 `SidebarToolbar.tsx` 안쪽
// `div.flex.items-center.justify-between.border-t.px-2.py-1.5`, 양쪽 묶음 `gap-1`.
import { useRef, useState } from 'react'
import { ContextMenu } from './ContextMenu.js'
import { CircleHelpIcon, CrosshairIcon, RefreshCwIcon, SettingsGearIcon } from './SidebarIcons.js'

export function SidebarFooterToolbar({
  onRefresh,
  onReveal,
  onOpenShortcuts,
  onOpenSettings,
}: {
  onRefresh: () => void
  onReveal: () => void
  onOpenShortcuts: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const helpRef = useRef<HTMLButtonElement | null>(null)
  const [help, setHelp] = useState<{ x: number; y: number } | null>(null)
  return (
    <div className="sidebar-footer" data-sidebar-footer>
      <div className="sidebar-footer-group">
        <button className="sidebar-footer-btn" data-settings-open="" title="설정" aria-label="설정" onClick={onOpenSettings}>
          <SettingsGearIcon className="sidebar-footer-icon" />
        </button>
        <button
          ref={helpRef}
          className="sidebar-footer-btn"
          data-help-menu-toggle=""
          title="도움말"
          aria-label="도움말"
          aria-haspopup="menu"
          aria-expanded={help !== null}
          onClick={() => {
            if (help !== null) {
              setHelp(null)
              return
            }
            const rect = helpRef.current?.getBoundingClientRect()
            if (rect !== undefined) setHelp({ x: rect.left, y: rect.top - 4 })
          }}
        >
          <CircleHelpIcon className="sidebar-footer-icon" />
        </button>
      </div>
      <div className="sidebar-footer-group">
        <button className="sidebar-footer-btn" data-reveal-active="" title="활성 워크스페이스 보기" aria-label="활성 워크스페이스 보기" onClick={onReveal}>
          <CrosshairIcon className="sidebar-footer-icon" />
        </button>
        <button className="sidebar-footer-btn" data-refresh-tree title="worktree 상태 재조회" aria-label="worktree 상태 재조회" onClick={onRefresh}>
          <RefreshCwIcon className="sidebar-footer-icon" />
        </button>
      </div>
      {help === null ? null : (
        <ContextMenu
          x={help.x}
          y={help.y}
          above
          toggleSelector="[data-help-menu-toggle]"
          attrs={{ 'data-help-menu': '' }}
          entries={[{ kind: 'item', action: 'shortcuts', label: '단축키' }]}
          onAction={(action) => {
            if (action === 'shortcuts') onOpenShortcuts()
          }}
          onClose={() => setHelp(null)}
        />
      )}
    </div>
  )
}
