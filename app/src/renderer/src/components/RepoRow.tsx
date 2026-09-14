// design-handoff.md §2 RepoRow — 레포 스퀘어(이니셜) + 이름 + [RepoRowActions] + 캐럿.
// hover/메뉴 열림일 때만 배경·액션이 보인다(레이아웃 점유는 유지 — opacity 만 바뀐다, §2 표).
import { useState } from 'react'
import type { RepoRow as RepoRowData } from '../../../shared/types.js'
import { RepoRowActions } from './RepoRowActions.js'
import { RepoRowMenu } from './RepoRowMenu.js'

export function RepoRow({
  repo,
  collapsed,
  onToggleCollapse,
  onCreateWorktree,
  onRemove,
  children,
}: {
  repo: RepoRowData
  collapsed: boolean
  onToggleCollapse: () => void
  onCreateWorktree: () => void
  onRemove: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const active = hovered || menuOpen
  const initial = repo.name.slice(0, 1).toUpperCase()

  return (
    <div className="repo-row-group" data-repo={repo.root}>
      <div
        className={`repo-row ${active ? 'is-active' : ''}`}
        data-repo-toggle={repo.root}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => {
          setMenuOpen(false)
          onToggleCollapse()
        }}
      >
        <span className="repo-row-avatar" data-repo-name={repo.root}>
          {initial}
        </span>
        <span className="repo-row-name" title={repo.root}>
          {repo.name}
        </span>
        <div className="repo-row-spacer" />
        <RepoRowActions
          repoRoot={repo.root}
          onCreateWorktree={(event) => {
            event.stopPropagation()
            setMenuOpen(false)
            onCreateWorktree()
          }}
          onToggleMenu={(event) => {
            event.stopPropagation()
            setMenuOpen((prev) => !prev)
          }}
        />
        <span className="repo-row-caret" data-repo-caret={repo.root}>
          {collapsed ? '▸' : '▾'}
        </span>
      </div>
      {menuOpen ? (
        <RepoRowMenu
          repoRoot={repo.root}
          onCreateWorktree={(event) => {
            event.stopPropagation()
            setMenuOpen(false)
            onCreateWorktree()
          }}
          onRemove={(event) => {
            event.stopPropagation()
            setMenuOpen(false)
            onRemove()
          }}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
      {repo.error !== null ? (
        <p className="repo-row-error" data-repo-error={repo.root}>
          {repo.error}
        </p>
      ) : null}
      {collapsed ? null : children}
    </div>
  )
}
