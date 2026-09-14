// design-handoff.md §2 RepoRowActions — hover 시에만 보이는 2버튼(+워크트리 생성 · ⋯메뉴).
// 둘 다 stopPropagation — RepoRow 접기 토글로 전파되지 않는다.
export function RepoRowActions({
  repoRoot,
  onCreateWorktree,
  onToggleMenu,
}: {
  repoRoot: string
  onCreateWorktree: (event: React.MouseEvent) => void
  onToggleMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div className="repo-row-actions" data-repo-row-actions={repoRoot}>
      <button className="repo-row-action-btn" data-create-worktree={repoRoot} title="워크트리 생성" onClick={onCreateWorktree}>
        +
      </button>
      <button className="repo-row-action-btn" data-repo-menu-toggle={repoRoot} title="더보기" onClick={onToggleMenu}>
        ⋯
      </button>
    </div>
  )
}
