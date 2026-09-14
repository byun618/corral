// design-handoff.md §2 RepoRowMenu — 168px 드롭다운. 워크트리 생성 · Finder 에서 열기(부가,
// 어댑터 미지정 — §4) · 구분선 · 목록에서 레포 제거(파괴적, --st-error).
import { useEffect, useRef } from 'react'

export function RepoRowMenu({
  repoRoot,
  onCreateWorktree,
  onRemove,
  onClose,
}: {
  repoRoot: string
  onCreateWorktree: (event: React.MouseEvent) => void
  onRemove: (event: React.MouseEvent) => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)

  // 바깥 클릭 시 닫힘 (§4 계약). repo 접기 시 닫힘은 RepoRow 쪽 토글 핸들러가 이미 처리한다.
  useEffect(() => {
    const onDocPointerDown = (event: MouseEvent): void => {
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
      <div className="repo-row-menu-item" data-repo-menu-reveal={repoRoot} title="부가 항목 — 어댑터 동작 미지정 (design-handoff.md §4)">
        <span className="repo-row-menu-glyph">↗</span>
        <span>Finder 에서 열기</span>
      </div>
      <div className="repo-row-menu-sep" />
      <div className="repo-row-menu-item repo-row-menu-danger" data-repo-menu-remove={repoRoot} onClick={onRemove}>
        <span className="repo-row-menu-glyph">−</span>
        <span>목록에서 레포 제거</span>
      </div>
    </div>
  )
}
