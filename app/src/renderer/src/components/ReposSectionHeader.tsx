// 사이드바 헤더 줄 (LIFE-470 · D20') — 198 `SidebarHeader.tsx:46-127`: `mt-2 flex h-8 px-2` · 제목(Project 그룹이면 "Projects",
// 아니면 "Workspaces") · 오른쪽 `gap-1` 에 [벨] · 옵션(`SlidersHorizontal`) · `+`.
// 벨(Activity 뷰, D35)은 만들지 않는다 — 게이트 ⓪ Q4 「448 밖 후보」. 옛 `◍`·`⇅` 자리 표시도 지웠다.
// `+` 는 corral 에서는 레포 등록(198 `+` 는 New workspace — 레포 ⋯·카드 `+` 쪽 정리는 C 조각 LIFE-478).
import type { RepoRow } from '../../../shared/types.js'
import type { SidebarView } from '../../../shared/sidebar-view.js'
import { PlusIcon } from './AgentStateDot.js'
import { SidebarOptionsMenu } from './SidebarOptionsMenu.js'

/** 제목 문구 — 198 "Projects"/"Workspaces" 의 한국어(D17, RESULT 문구 표). */
export function sidebarHeaderTitle(view: SidebarView): string {
  return view.groupBy === 'repo' ? '프로젝트' : '워크스페이스'
}

export function ReposSectionHeader({
  view,
  repos,
  onChangeView,
  onAddRepo,
}: {
  view: SidebarView
  repos: readonly RepoRow[]
  onChangeView: (patch: Partial<SidebarView>) => void
  onAddRepo: () => void
}): React.JSX.Element {
  return (
    <div className="repos-header" data-repos-header>
      <span className="repos-header-label" data-sidebar-section-title="">
        {sidebarHeaderTitle(view)}
      </span>
      <div className="repos-header-spacer" />
      <div className="repos-header-actions">
        <SidebarOptionsMenu view={view} repos={repos} onChange={onChangeView} />
        <button className="repos-header-glyph repos-header-add" data-add-repo onClick={onAddRepo} title="레포 추가" aria-label="레포 추가">
          <PlusIcon className="repos-header-icon" />
        </button>
      </div>
    </div>
  )
}
