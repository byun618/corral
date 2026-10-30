// 오른쪽 패널 보기 목록 (LIFE-682 A2) — activity bar 단추·툴팁·기본 폭은 **이 배열 한 곳**에서 나온다.
// 보기를 더하려면(예: LIFE-683 소스 제어) `RightPanelView` 에 이름을 더하고 여기에 항목 하나를 더한다 — 줄의 순서 = 배열 순서.
// 단축키는 액션 id 로 잡아 설정에서 바꾸면 툴팁이 따라간다. 액션이 없거나 묶인 키가 없으면 툴팁은 제목만(Orca `${title} (${shortcut})`).
import type { ActionId } from '../../../shared/keybindings.js'
import type { RightPanelView } from '../../../shared/types.js'
import { FilesIcon } from './SidebarIcons.js'
import { TasksIcon } from './SidebarSearch.js'

export type RightPanelViewDef = {
  id: RightPanelView
  title: string
  /** 툴팁에 붙일 단축키의 액션 — 없으면 null(작업 상세는 기본 단축키 없음, Q4). */
  action: ActionId | null
  icon: (props: { className: string }) => React.JSX.Element
  /** 기본 폭 토큰과 토큰을 못 읽을 때의 값. */
  widthToken: string
  widthFallback: number
}

/** 소스 제어 아이콘 (LIFE-683 S1) — VS Code codicon `source-control`(0xea68, `codiconsLibrary.ts:34`). 다른 보기 아이콘과 같은 16px 상자. */
// 글리프는 CSS `::before` 로 — 머리에 글자 노드가 생기지 않게(activity bar 는 제목 글자 없음, A1).
function SourceControlIcon({ className }: { className: string }): React.JSX.Element {
  return <span className={`codicon ${className} is-codicon is-source-control`} data-codicon="source-control" aria-hidden />
}

export const RIGHT_PANEL_VIEWS: readonly RightPanelViewDef[] = [
  { id: 'explorer', title: '탐색기', action: 'explorer.show', icon: FilesIcon, widthToken: '--right-panel-w', widthFallback: 300 },
  // LIFE-683 — 폭은 탐색기 폭 칸을 같이 쓴다(`useRightPanel` `widthSlotOf`) — 토큰도 같은 것.
  { id: 'scm', title: '소스 제어', action: 'scm.show', icon: SourceControlIcon, widthToken: '--right-panel-w', widthFallback: 300 },
  { id: 'detail', title: '작업 상세', action: null, icon: TasksIcon, widthToken: '--right-panel-detail-w', widthFallback: 560 },
]

/** 툴팁·aria-label 글 — 「제목 (단축키)」, 단축키가 없으면 제목만. */
export function viewLabel({ title, shortcut }: { title: string; shortcut: string | null }): string {
  return shortcut === null ? title : `${title} (${shortcut})`
}
