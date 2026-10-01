// 레포 헤더 (LIFE-468 D21) — Orca 1.4.198 `SectionHeader` 레포 행: lucide `Folder` + 이름 + [RepoRowActions(셰브론·⋯·+)].
// 액션은 행 위에 겹쳐 hover/메뉴 열림 때만 보인다(제목 폭을 상시 점유하지 않는다 — Orca `ProjectHeaderActions`).
// 행은 레포 묶음 안에서 **sticky** 다 — 스크롤하면 위에 붙고 다음 레포 헤더가 밀어낸다(묶음이 sticky 의 경계).
// sticky 는 행과 ⋯ 메뉴를 함께 감싼 `.repo-row-head` 에 건다 — 메뉴의 기준점이 붙은 헤더를 따라간다(LIFE-468 r1 CDX-R1).
// corral 은 가상 목록이 아니라 붙은 헤더가 첫 행을 덮거나 접힌 레포 아래 빈 칸을 남기는 경로(Orca #18667)가 없다.
import { useState } from 'react'
import type { RepoRow as RepoRowData } from '../../../shared/types.js'
import { FolderIcon } from './AgentStateDot.js'
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

  return (
    <div className="repo-row-group" data-repo={repo.root}>
      <div className={`repo-row-head ${menuOpen ? 'is-menu-open' : ''}`}>
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
          <span className="repo-row-icon" data-repo-name={repo.root}>
            <FolderIcon className="repo-row-icon-glyph" />
          </span>
          <span className="repo-row-name" title={`${repo.name}\n${repo.root}`}>
            {repo.name}
          </span>
          <RepoRowActions
            repoRoot={repo.root}
            collapsed={collapsed}
            onToggleCollapse={(event) => {
              event.stopPropagation()
              setMenuOpen(false)
              onToggleCollapse()
            }}
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
      </div>
      {repo.error !== null ? (
        <p className="repo-row-error" data-repo-error={repo.root}>
          {repo.error}
        </p>
      ) : null}
      {collapsed ? null : children}
    </div>
  )
}
