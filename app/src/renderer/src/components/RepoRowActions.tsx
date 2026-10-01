// 레포 헤더 우측 액션 (LIFE-468 D21) — Orca 1.4.198 `ProjectHeaderActions` 외관: 행 오른쪽 위에 겹쳐 뜨고(absolute right-1),
// 평소엔 숨었다가 행 hover 때 나타난다. 순서도 Orca 그대로 접기 셰브론 · ⋯ · `+`. ⋯·`+` 는 숨었을 때 폭 0 으로 접힌다
// (`REPO_HEADER_ACTION_REVEAL_CLASS` — max-w-0 · -ml-1.5). 항목·`+` 동작 신설은 S4(LIFE-470) 몫이고 지금 동작을 그대로 쓴다.
// 셋 다 stopPropagation — 행의 접기 토글로 전파되지 않는다(셰브론은 스스로 접는다).
import { Chevron, EllipsisIcon, PlusIcon } from './AgentStateDot.js'

export function RepoRowActions({
  repoRoot,
  collapsed,
  onToggleCollapse,
  onCreateWorktree,
  onToggleMenu,
}: {
  repoRoot: string
  collapsed: boolean
  onToggleCollapse: (event: React.MouseEvent) => void
  onCreateWorktree: (event: React.MouseEvent) => void
  onToggleMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div className="repo-row-actions" data-repo-row-actions={repoRoot}>
      <button
        className="repo-row-action-btn repo-row-caret"
        data-repo-caret={repoRoot}
        data-repo-header-collapse-affordance=""
        title={collapsed ? '펼치기' : '접기'}
        aria-label={collapsed ? '펼치기' : '접기'}
        onClick={onToggleCollapse}
      >
        <Chevron direction="down" className={`repo-row-caret-icon ${collapsed ? 'is-collapsed' : ''}`} />
      </button>
      <button className="repo-row-action-btn is-reveal" data-repo-menu-toggle={repoRoot} title="더보기" aria-label="더보기" onClick={onToggleMenu}>
        <EllipsisIcon className="repo-row-action-icon" />
      </button>
      <button className="repo-row-action-btn is-reveal" data-create-worktree={repoRoot} title="워크트리 생성" aria-label="워크트리 생성" onClick={onCreateWorktree}>
        <PlusIcon className="repo-row-action-icon is-small" />
      </button>
    </div>
  )
}
