// design-handoff.md §2 ReposSectionHeader — "Repos" 라벨 + 알림·정렬(정적, 이번 라운드 범위 밖)
// + 레포 **등록**(새 레포 추가, 기존 AddRepoModal 플로우 그대로) `+`.
export function ReposSectionHeader({ onAddRepo }: { onAddRepo: () => void }): React.JSX.Element {
  return (
    <div className="repos-header" data-repos-header>
      <span className="repos-header-label">Repos</span>
      <div className="repos-header-spacer" />
      <span className="repos-header-glyph" title="알림 (범위 밖)">
        ◍
      </span>
      <span className="repos-header-glyph" title="정렬 (범위 밖)">
        ⇅
      </span>
      <button className="repos-header-glyph repos-header-add" data-add-repo onClick={onAddRepo} title="레포 추가" aria-label="레포 추가">
        +
      </button>
    </div>
  )
}
