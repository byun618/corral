// 카드 우클릭 메뉴 모델 (LIFE-478 K2ⓐ·K6ⓐ·K7ⓐ) — 순수 함수. 화면(`ContextMenu`)은 그리기만 한다.
//
// 198 단일 선택 메뉴(`WorktreeContextMenuView.tsx:155-379`) 순서:
//   [Workspace] Update · (Move to Status) | Open in ▸ · Copy Path | Pin/Unpin · (Mark Read) · (그룹 3) | Set/Change Parent… ·
//   Open Parent · Remove from Parent | (Developer) · (Sleep) | Delete (주 체크아웃이면 disabled Delete + Remove Project)
// 괄호 항목은 의도적으로 뺐다(RESULT 대응표). **주 체크아웃 카드에 「프로젝트 제거」 를 두지 않는다** — Orca #17645(Delete 를 누르려다
// 프로젝트 전체를 뺐다). 레포 제거는 레포 ⋯ 한 곳.
import type { RepoRow, WorktreeRow } from '../../shared/types.js'
import type { MenuEntry } from './components/ContextMenu.js'

export type CardMenuAction =
  | 'update'
  | 'open-in'
  | 'reveal-finder'
  | 'open-editor'
  | 'copy-path'
  | 'toggle-pin'
  | 'set-parent'
  | 'open-parent'
  | 'remove-parent'
  | 'delete'

export const PRIMARY_DELETE_DISABLED = '주 워크트리는 삭제할 수 없습니다 — 레포 ⋯ 의 「목록에서 프로젝트 제거」 를 쓰세요'
export const NO_PARENT_CANDIDATES = '같은 프로젝트에 상위로 지정할 수 있는 워크트리가 없습니다'

export function cardMenuEntries(input: {
  worktree: WorktreeRow
  pinned: boolean
  deleting: boolean
  /** 상위 후보 수(`parentCandidates`) — 0 이면 지정 항목 disabled(198 `policy.ts:116-121`). */
  candidateCount: number
  /** 부모가 지금 트리에 있나 — 있어야 「상위 워크트리 열기」(198 은 유효한 edge 일 때만). */
  parentInTree: boolean
  /** 삭제 단축키 표시(⌘⇧⌫) — 198 은 단일 비주 체크아웃에서 Delete 옆에 단축키를 보인다. */
  deleteShortcut: string | null
}): MenuEntry<CardMenuAction>[] {
  const { worktree, deleting } = input
  const hasParent = worktree.parentPath !== null
  const entries: MenuEntry<CardMenuAction>[] = [
    { kind: 'label', key: 'label', label: '워크스페이스' },
    { kind: 'item', action: 'update', label: '업데이트', disabled: deleting },
    { kind: 'sep', key: 'sep-open' },
    {
      kind: 'item',
      action: 'open-in',
      label: '열기',
      disabled: deleting,
      submenu: [
        { kind: 'item', action: 'reveal-finder', label: 'Finder' },
        { kind: 'item', action: 'open-editor', label: 'VS Code' },
      ],
    },
    { kind: 'item', action: 'copy-path', label: '경로 복사', disabled: deleting },
    { kind: 'sep', key: 'sep-pin' },
    { kind: 'item', action: 'toggle-pin', label: input.pinned ? '고정 해제' : '고정', disabled: deleting },
    { kind: 'sep', key: 'sep-parent' },
    {
      kind: 'item',
      action: 'set-parent',
      label: hasParent ? '상위 워크트리 변경…' : '상위 워크트리 지정…',
      disabled: deleting || input.candidateCount === 0,
      title: input.candidateCount === 0 ? NO_PARENT_CANDIDATES : undefined,
    },
  ]
  if (hasParent && input.parentInTree) entries.push({ kind: 'item', action: 'open-parent', label: '상위 워크트리 열기', disabled: deleting })
  if (hasParent) entries.push({ kind: 'item', action: 'remove-parent', label: '상위에서 빼기', disabled: deleting })
  entries.push({ kind: 'sep', key: 'sep-delete' })
  if (!worktree.isLinked) {
    entries.push({ kind: 'item', action: 'delete', label: '워크트리 삭제', danger: true, disabled: true, title: PRIMARY_DELETE_DISABLED })
  } else {
    entries.push({ kind: 'item', action: 'delete', label: deleting ? '삭제 중…' : '워크트리 삭제', danger: true, disabled: deleting, shortcut: deleting ? null : input.deleteShortcut })
  }
  return entries
}

/**
 * 상위 워크트리 후보 (198 `worktree-parent-candidates.ts:61-76` · `worktree-parent-eligibility.ts:16-51`) — 같은 프로젝트(레포),
 * 자기 자신·현재 부모 제외, **자기 후손 제외**(순환 방지 — CLI `worktree set --parent-worktree` 도 같은 순환을 거절한다).
 * 주 체크아웃도 부모가 될 수 있다. 순서 = 레포 목록 순서(198 store 순서).
 */
export function parentCandidates(input: { worktree: WorktreeRow; repo: RepoRow }): WorktreeRow[] {
  const { worktree, repo } = input
  const byPath = new Map(repo.worktrees.map((row) => [row.path, row]))
  const descendsFromTarget = (candidate: WorktreeRow): boolean => {
    const seen = new Set<string>()
    let cursor: WorktreeRow | undefined = candidate
    while (cursor !== undefined) {
      if (cursor.path === worktree.path) return true
      // 이미 순환이 있는 사슬의 구성원도 뺀다(198 「members of a known cycle」).
      if (seen.has(cursor.path)) return true
      seen.add(cursor.path)
      cursor = cursor.parentPath === null ? undefined : byPath.get(cursor.parentPath)
    }
    return false
  }
  return repo.worktrees.filter((row) => row.path !== worktree.path && row.path !== worktree.parentPath && !descendsFromTarget(row))
}

/** 피커 검색 — 표시 이름·브랜치·경로에 부분 문자열(대소문자 무시). 198 은 퍼지지만 후보가 한 레포 안이라 부분 일치로 충분하다. */
export function filterCandidates(input: { candidates: readonly WorktreeRow[]; query: string; nameOf: (row: WorktreeRow) => string }): WorktreeRow[] {
  const query = input.query.trim().toLowerCase()
  if (query === '') return [...input.candidates]
  return input.candidates.filter((row) => [input.nameOf(row), row.branch ?? '', row.path].some((text) => text.toLowerCase().includes(query)))
}

/**
 * 삭제 확인 대화의 단추 (K7ⓑ·ⓓ·ⓔ) — 판정은 `worktree rm` 이 다시 한다. 여기서는 무엇을 보여 줄지만 정한다.
 *   · 막힘: 주 체크아웃 · Git 잠김(강제로도 안 넘긴다 — 198 분류기와 같다) · herdr 링크 없음(바쁨을 못 본다 — U3)
 *   · 깨끗하고 한가하면 「삭제」 · dirty·바쁨이면 「강제 삭제」 + **넘기는 것을 하나씩**(Orca #16526 — force 가 무엇을 넘기는지 안 알림)
 */
export type DeleteDecision =
  | { kind: 'blocked'; reason: string }
  | { kind: 'delete' }
  | { kind: 'force'; warnings: string[] }

export function deleteDecision(input: { isMain: boolean; locked: boolean; dirtyCount: number; liveSessions: number | null; backendError: string | null }): DeleteDecision {
  if (input.isMain) return { kind: 'blocked', reason: PRIMARY_DELETE_DISABLED }
  if (input.locked) return { kind: 'blocked', reason: 'Git 이 잠근 워크트리입니다 — `git worktree unlock` 으로 푼 뒤에 지울 수 있습니다.' }
  if (input.liveSessions === null) return { kind: 'blocked', reason: `herdr 연결이 없어 살아 있는 세션을 확인할 수 없습니다 — 연결된 뒤에 지울 수 있습니다.${input.backendError === null ? '' : ` (${input.backendError})`}` }
  const warnings: string[] = []
  if (input.dirtyCount > 0) warnings.push(`커밋하지 않은 변경 ${input.dirtyCount}개가 디스크에서 사라집니다`)
  if (input.liveSessions > 0) warnings.push(`실행 중인 세션 ${input.liveSessions}개가 종료됩니다`)
  return warnings.length === 0 ? { kind: 'delete' } : { kind: 'force', warnings }
}

/** 삭제 결과 알림 (K7ⓘ · 게이트 ⓪ Q3) — 브랜치는 CLI 로 만든(`createdBranch`) 것만 `git branch -d`, 나머지는 남는다. */
export function deleteResultNotice(input: { name: string; preservedBranch: string | null; warning: string | null }): string {
  const branch = input.preservedBranch === null ? '' : ` — 브랜치 ${input.preservedBranch} 는 남았습니다`
  return `워크트리 ${input.name} 를 삭제했습니다${branch}${input.warning === null ? '' : ` (${input.warning})`}`
}
