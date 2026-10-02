// design-handoff.md §2 RepoRowMenu — 168px 드롭다운. 워크트리 생성 · Finder 에서 열기 · 구분선 · 목록에서 프로젝트 제거(파괴적, --st-error).
// LIFE-478: Finder 배선(K4ⓓ — 레포 루트를 Finder 에서 보이고 선택, 198 카드 Open in ▸ Finder 와 같은 `showItemInFolder`. 198 레포 헤더 ⋯ 에는
// 없는 corral 항목) · Esc 닫기 · 메뉴 하나 규칙. 문구 「레포」 → 「프로젝트」(470 문구 표 · 198 「Remove Project」, K10).
import { useEffect, useRef } from 'react'
import { useMenuBus } from '../menu-bus.js'

export function RepoRowMenu({
  repoRoot,
  onCreateWorktree,
  onRemove,
  onRevealInFinder,
  onClose,
}: {
  repoRoot: string
  onCreateWorktree: (event: React.MouseEvent) => void
  onRemove: (event: React.MouseEvent) => void
  onRevealInFinder: (event: React.MouseEvent) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useMenuBus({ open: true, close: onClose })
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 바깥 클릭 시 닫힘 (§4 계약). repo 접기 시 닫힘은 RepoRow 쪽 토글 핸들러가 이미 처리한다.
  useEffect(() => {
    const onDocPointerDown = (event: MouseEvent): void => {
      // ⋯ 단추 자신은 토글이 맡는다.
      if (event.target instanceof Element && event.target.closest('[data-repo-row-actions]') !== null) return
      if (ref.current !== null && event.target instanceof Node && !ref.current.contains(event.target)) onClose()
    }
    document.addEventListener('mousedown', onDocPointerDown)
    return () => document.removeEventListener('mousedown', onDocPointerDown)
  }, [onClose])

  return (
    <div className="repo-row-menu" data-repo-menu={repoRoot} ref={ref} onClick={(event) => event.stopPropagation()}>
      <div className="repo-row-menu-item" data-repo-menu-create-worktree={repoRoot} onClick={onCreateWorktree}>
        <span className="repo-row-menu-glyph">+</span>
        <span>워크트리 생성</span>
      </div>
      <div className="repo-row-menu-item" data-repo-menu-reveal={repoRoot} onClick={onRevealInFinder}>
        <span className="repo-row-menu-glyph">↗</span>
        <span>Finder 에서 열기</span>
      </div>
      <div className="repo-row-menu-sep" />
      <div className="repo-row-menu-item repo-row-menu-danger" data-repo-menu-remove={repoRoot} onClick={onRemove}>
        <span className="repo-row-menu-glyph">−</span>
        <span>목록에서 프로젝트 제거</span>
      </div>
    </div>
  )
}
