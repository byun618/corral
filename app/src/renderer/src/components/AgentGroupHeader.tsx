// design-handoff.md §2 AgentGroupHeader — 세션 3개 이상인 worktree 에서만 등장(C3ⓑ).
// 클릭은 블록 선택(WorktreeBlock)으로 전파되지 않는다.
export function AgentGroupHeader({
  worktreePath,
  count,
  collapsed,
  onToggle,
}: {
  worktreePath: string
  count: number
  collapsed: boolean
  onToggle: (event: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div className="agent-group-header" data-agent-group={worktreePath} onClick={onToggle}>
      <span className="agent-group-label">{count} agents</span>
      <div className="agent-group-spacer" />
      <span className="agent-group-caret">{collapsed ? '▸' : '▾'}</span>
    </div>
  )
}
