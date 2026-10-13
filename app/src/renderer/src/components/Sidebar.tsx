// design-handoff.md §1 — 사이드바 4단 전개(repo 헤더 → worktree 2줄 블록 → 세션 행). 이 파일은
// C6 이 나열한 개별 컴포넌트(SidebarSearch 등 — 머리는 LIFE-527 부터 App 의 SidebarHead)를 엮는 조립부다 — 자체는 판정표에 없는 이름이라
// 자유롭게 구조화했다.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { AgentKind, AppState, RepoRow as RepoRowData, WorktreeMetaUpdate, WorktreeRow } from '../../../shared/types.js'
import { showsInlineAgents, type SidebarView } from '../../../shared/sidebar-view.js'
import type { LifecycleActions } from '../lifecycle-types.js'
import type { UnreadView } from '../hooks/useUnread.js'
import { useNowTick } from '../hooks/useNowTick.js'
import { useSettledSections } from '../hooks/useSettledSections.js'
import { useSidebarReorder, type NestCommit, type ReorderCommit } from '../hooks/useSidebarReorder.js'
import type { LayoutGroup, ManualOrder } from '../manual-order.js'
import {
  activeFilterCount,
  buildSidebarSections,
  collapsedAncestors,
  lineageAncestors,
  lineageGraph,
  nestSectionItems,
  PINNED_SECTION_KEY,
  sectionKey,
  sectionLayout,
  visibleCardCount,
  type LineageRow,
  type LineageUnit,
  type SidebarSection,
  type SortItem,
} from '../sidebar-sections.js'
import { cardMenuEntries, parentCandidates, type CardMenuAction } from '../card-menu.js'
import { worktreeDisplayName } from '../worktree-name.js'
import { ContextMenu } from './ContextMenu.js'
import { ParentPicker } from './ParentPicker.js'
import { activateWorktreeCard } from '../worktree-activate.js'
import { flashPaneRim } from '../pane-rim-flash.js'
import { livePaneIdsOf, retainedByWorktree } from '../sidebar-agents.js'
import { RepoRow } from './RepoRow.js'
import { RevealConfirmDialog } from './RevealConfirmDialog.js'
import { ReposSectionHeader } from './ReposSectionHeader.js'
import { SidebarFooterToolbar } from './SidebarFooterToolbar.js'
import { SidebarSearch } from './SidebarSearch.js'
import { CircleXIcon, ListIcon, PinIcon } from './SidebarIcons.js'
import { WorktreeBlock, type CardNest } from './WorktreeBlock.js'

/**
 * 카드 메뉴 쪽 입력 (LIFE-478) — 고정·삭제 중·대화는 App 이 갖고(단축키·대화가 App 층), 메뉴·피커·rename·Reveal 실행은 Sidebar 가 한다
 * (구획·스크롤·접힘을 아는 곳).
 */
export type SidebarCardProps = {
  pinned: ReadonlySet<string>
  togglePin: (path: string) => void
  /** 안 읽음 장부 (LIFE-471) — pane 안 읽음(행)·벨(카드)·Mark Read/Unread. */
  unread: UnreadView
  deleting: ReadonlySet<string>
  /** Option 을 누르고 있다 — hover 카드에 휴지통(K7ⓗ). */
  altHeld: boolean
  /** 레지스트리 메타 쓰기(CLI `worktree set` 경로). 오류면 문자열. */
  setMeta: (update: WorktreeMetaUpdate) => Promise<string | null>
  openDetails: (worktree: WorktreeRow) => void
  requestDelete: (worktree: WorktreeRow) => void
  notify: (message: string) => void
  /** hover 중인 카드 — ⌘⇧⌫ 대상(198 은 hover 카드를 지운다). */
  onHoverCard: (path: string | null) => void
  /** 밖(⌘⌥R 등)에서 오는 드러내기 요청 — `seq` 가 바뀔 때마다 한 번. */
  revealRequest: { path: string; rename: boolean; seq: number } | null
  deleteShortcut: string | null
}

/** 「N 하위」 접기 (LIFE-576 D6) — 접은 부모 경로 집합(ui-prefs `collapsedLineage`). */
export type LineageCollapse = { values: ReadonlySet<string>; toggle: (path: string) => void; remove: (path: string) => void; loaded: boolean }

/** Reveal 번쩍 길이 — 198 `use-reveal-highlight.ts:37-53` 1500ms. */
const REVEAL_FLASH_MS = 1500
/** 카드가 아직 안 그려졌을 때 다시 볼 프레임 수 — 198 `MAX_REVEAL_RETRIES`(8). */
const REVEAL_RETRIES = 8
/** sticky 헤더 아래 여백 — 198 `worktree-sidebar-reveal.ts:3-5`(28px 헤더 + 6px). 헤더 높이는 실측한다. */
const REVEAL_GAP = 6

export function Sidebar({
  sidebarRef,
  width,
  state,
  activeWorkspaceId,
  selectedPane,
  selectPane,
  closePane,
  actions,
  manualOrder,
  onReorder,
  view,
  onChangeView,
  onOpenSearch,
  tasks,
  searchShortcut,
  isRepoCollapsed,
  toggleRepoCollapsed,
  isGroupExpanded,
  toggleGroupExpanded,
  onAddRepo,
  onRemoveRepo,
  onRefresh,
  groupGlyphOf,
  cards,
  lineageCollapse,
  onOpenShortcuts,
  onOpenSettings,
}: {
  cards: SidebarCardProps
  lineageCollapse: LineageCollapse
  /** 하단 ? 메뉴 「단축키」 (K8ⓐ) — LIFE-511 부터 설정 › 단축키. */
  onOpenShortcuts: () => void
  /** 하단 ⚙ — 설정 페이지 (LIFE-511). */
  onOpenSettings: () => void
  sidebarRef: RefObject<HTMLDivElement | null>
  width: number
  /** 사이드바가 읽는 칸만(LIFE-576 — 배선 시험이 앱 상태 전체 없이 띄운다). */
  state: Pick<AppState, 'repos' | 'integrations' | 'home' | 'retainedAgents' | 'orchestrationLineage'>
  activeWorkspaceId: string | null
  selectedPane: string | null
  selectPane: (paneId: string) => void
  closePane: (paneId: string) => void
  actions: LifecycleActions
  /** 레포·워크트리 수동 순서 (LIFE-469) — 표시 순서는 여기서 나온다. */
  manualOrder: ManualOrder
  /** `layout` = 놓는 순간 화면에 보이는 그룹별 카드 배치(필터 뒤) — 비-manual → Manual 전환 드롭에서 확정에 쓴다(LIFE-470 R2-01). */
  onReorder: (input: { commit: ReorderCommit; layout: LayoutGroup[] }) => void
  /** Workspace options 값 (LIFE-470) — 그룹·정렬·필터. */
  view: SidebarView
  onChangeView: (patch: Partial<SidebarView>) => void
  /** Search 줄 → 391 팔레트 (LIFE-470 D28a). */
  onOpenSearch: () => void
  /** 사이드바 「작업」 진입 (LIFE-601) — 작업 페이지 열기/닫기. */
  tasks?: { open: boolean; onToggle: () => void; shortcut: string | null }
  /** Search 줄 hover 키캡 — ⌘J 의 지금 조합(비켜 서 없으면 null). */
  searchShortcut: string | null
  isRepoCollapsed: (root: string) => boolean
  toggleRepoCollapsed: (root: string) => void
  /** 에이전트 묶음 알약이 펼쳐져 있나 (LIFE-467 — 기본 접힘, 펼친 것만 영속). */
  isGroupExpanded: (worktreePath: string) => boolean
  toggleGroupExpanded: (worktreePath: string) => void
  onAddRepo: () => void
  onRemoveRepo: (root: string) => void
  onRefresh: () => void
  /** 비활성 worktree 의 보존된 영역 레이아웃 글리프 (LIFE-373). 없으면 null. */
  groupGlyphOf: (worktreePath: string) => string | null
}): React.JSX.Element {
  // 경과 시간이 얼지 않게 **한 곳에서만** 시계를 돌린다 (LIFE-366 D1) — 행마다 타이머를 두면
  // 세션 수만큼 타이머가 생긴다.
  const now = useNowTick()
  // 블록 클릭 시 첫 세션 자동 활성(§4 — 에이전트 세션이 아니라 전체 탭의 첫 번째, 09-gate1-fix.md D)은 `worktree-activate.ts` 로 옮겼다(LIFE-601 — 작업 중 줄이 같은 경로).

  /**
   * 세션 행 클릭 — **그 탭의 workspace 를 먼저 활성화**하고 pane 을 고른다 (11-gate1-fix3.md I-6).
   *
   * 전에는 `selectPane` 만 불렀다. 그래서 활성이 아닌 worktree 의 세션을 누르면 터미널만 바뀌고
   * 탭바·상태바는 딴 workspace 를 계속 가리켰다 — `App.tsx` 의 `activeWorkspace` 가
   * `activeWorkspaceId` 를 따르기 때문이다. `onSelectBlock` 이
   * `activateWorkspace` → 첫 세션 선택 순으로 하는 것과 같은 결로 맞춘다.
   *
   * 행이 주는 것은 pane id 하나다(LIFE-467 — 서브에이전트 행은 부모 pane, 보존 행은 아직 살아 있는 그 pane).
   * 그 pane 의 workspace 는 지금 상태에서 찾는다. 고른 뒤 pane 테두리를 한 번 번쩍인다(D11 — Orca 림 플래시 1.5s).
   */
  const onSelectSession = (paneId: string): void => {
    const workspaceId = workspaceOfPane(paneId)
    if (workspaceId === null) return
    if (workspaceId !== activeWorkspaceId) actions.activateWorkspace(workspaceId)
    selectPane(paneId)
    flashPaneRim(paneId)
  }
  const workspaceOfPane = (paneId: string): string | null => {
    for (const repo of state.repos)
      for (const worktree of repo.worktrees)
        for (const tab of worktree.workspace?.tabs ?? []) if (tab.panes.some((pane) => pane.paneId === paneId)) return tab.workspaceId
    return null
  }
  const listRef = useRef<HTMLDivElement | null>(null)
  // 놓는 때 부른다 — 그 렌더의 `sections`(아래에서 계산, 잡아 둔 배치 포함)가 화면 그대로다.
  const reorder = useSidebarReorder({
    listRef,
    onCommit: (commit) => {
      // 순서 줄에 놓은 카드는 lineage 가 유효하면 부모를 푼다 — 부모가 화면에 보이든 아니든(D4 · 수정 r1 M2, Orca main
      // `getReorderedWorktreeIdsToUnnest` 「un-nest escape hatch」). 끈 카드의 후손 링크는 그대로, 부모 없는 카드는 lineage 를 안 쓴다.
      // 부모를 푸는 드롭은 평면 목록이 같아도 표시 줄 자리에 착지한다(`unnest` — 수정 r3 R2-A, Orca 와 다르게: Orca 는 no-op 이라 저장
      // 순서가 드러나 카드가 부모 위로 튄다). 비수동 정렬이면 이 드롭도 「바뀐 드롭」 이라 Manual 로 간다.
      const path = commit.source.kind === 'repo' ? null : commit.source.path
      const unnest = path !== null && lineage.parentOf.has(path)
      if (unnest) removeParent(path)
      onReorder({ commit: unnest ? { ...commit, unnest: true } : commit, layout: sectionLayout(sections) })
    },
    // 아래에서 정의하는 후보 — 드래그 시작 때 한 번 부른다(R2-E). 그때는 이 렌더가 끝난 뒤다.
    nestCandidates: (path) => nestCandidatesOf(path),
    onNest: (nest: NestCommit) => {
      void cards.setMeta({ path: nest.path, parentPath: nest.parentPath }).then((error) => {
        if (error !== null) cards.notify(`상위 워크트리를 지정하지 못했습니다: ${error}`)
      })
    },
  })
  const dragSource = reorder.state?.source ?? null
  /** 끄는 덩어리(끄는 카드 + 보이는 후손) — 원래 자리를 다 투명하게(R2-C). 하위 카드의 손자는 그 카드 행 밖에 평평하게 그려진다. */
  const dragBlock = new Set(reorder.state?.block ?? [])
  const livePaneIds = livePaneIdsOf(state.repos)
  const retainedOf = retainedByWorktree({ repos: state.repos, retained: state.retainedAgents })
  const sections = useSettledSections({ sections: buildSidebarSections({ repos: state.repos, view, order: manualOrder, now, pinned: cards.pinned }), view, order: manualOrder })
  // 계보 덩어리 (LIFE-576) — 구획은 평면 그대로 두고 그리기 직전에만 묶는다(`nestSectionItems`).
  // 유효 간선·순환은 표시 구획이 아니라 전체 그래프에서 한 번(수정 r3 R2-D) — 중첩·순서 줄 부모 해제·조상 펼침이 공유한다.
  const lineage = lineageGraph(state.repos)
  const unitsOf = new Map<string, LineageUnit[]>(sections.map((section) => [sectionKey(section), nestSectionItems({ items: section.items, collapsed: lineageCollapse.values, graph: lineage })]))
  /** 지금 부모 카드 안에 중첩돼 그려진 카드 — `↳ 부모` 칩을 생략한다(부모 해제 판정은 전체 그래프 `lineage.parentOf`). */
  const nestedPaths = new Set<string>()
  for (const units of unitsOf.values()) for (const unit of units) for (const row of unit.descendants) nestedPaths.add(row.item.worktree.path)
  const filtersOn = activeFilterCount({ view, repos: state.repos }) > 0
  /** 레포 헤더 드래그 게이트 — Project 그룹 + Project order Manual 일 때만(198 `use-header-drag.ts:81-82`, K6ⓒ). 그 밖은 클릭(접기)만. */
  const repoDragEnabled = view.groupBy === 'repo' && view.projectOrderBy === 'manual'

  /** 에이전트 목록을 카드에 그리나 (LIFE-477) — 에이전트 활동 켬 + Detailed. Compact 카드는 그리지 않는다(198 F4). */
  const showAgents = showsInlineAgents(view)

  // --- 카드 메뉴 · rename · 상위 피커 · Reveal (LIFE-478) ------------------------------------------------
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [picker, setPicker] = useState<{ path: string; anchor: { left: number; right: number; top: number } } | null>(null)
  const [flashPath, setFlashPath] = useState<string | null>(null)
  const [revealConfirm, setRevealConfirm] = useState<{ path: string; rename: boolean } | null>(null)
  const pendingReveal = useRef<{ path: string; rename: boolean; tries: number } | null>(null)
  /** 필터를 지운 뒤 다시 드러낼 대상 — 구획이 새로 서면 `reveal` 을 다시 부른다(접힘 펼치기는 그때 본다). */
  const revealAfterFilters = useRef<{ path: string; rename: boolean } | null>(null)
  const [revealTick, setRevealTick] = useState(0)
  const flashTimer = useRef<number | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const closePicker = useCallback(() => setPicker(null), [])

  const rowsByPath = new Map<string, { repo: RepoRowData; worktree: WorktreeRow }>()
  for (const repo of state.repos) for (const worktree of repo.worktrees) rowsByPath.set(worktree.path, { repo, worktree })
  const activePath = state.repos.flatMap((repo) => repo.worktrees).find((row) => row.openWorkspaceId !== null && row.openWorkspaceId === activeWorkspaceId)?.path ?? null

  /** 끌어서 상위 지정 후보 — 메뉴 피커와 **같은 술어**(`parentCandidates`, K3ⓒ). 자기·후손·다른 레포·현재 부모는 여기서 빠진다. */
  const nestCandidatesOf = (path: string): ReadonlySet<string> => {
    const found = rowsByPath.get(path)
    return new Set(found === undefined ? [] : parentCandidates({ worktree: found.worktree, repo: found.repo }).map((row) => row.path))
  }
  const removeParent = (path: string): void => {
    void cards.setMeta({ path, parentPath: null }).then((error) => {
      if (error !== null) cards.notify(`상위에서 빼지 못했습니다: ${error}`)
    })
  }
  /**
   * 접힌 조상 펼치기 (K2ⓓ · Orca #25950) — 활성·드러낼 카드가 접힌 「N 하위」 안에 숨지 않게. 사슬이 순환이면 한 바퀴에서 멈춘다.
   * 사용자가 활성 카드의 부모를 직접 접는 것은 막지 않는다 — 그 조작 뒤에는 다음 활성화·드러내기 때 다시 펼친다.
   */
  const expandAncestors = (path: string): void => {
    for (const parent of collapsedAncestors({ graph: lineage, path, collapsed: lineageCollapse.values })) lineageCollapse.remove(parent)
  }
  // 접힘 집합 적재(`loaded`) 뒤에도 한 번 더 — 활성 경로가 적재보다 먼저 서면 첫 실행이 빈 집합을 보고 지나간다(수정 r2 R1-C).
  // 활성 카드의 **조상 경로**가 바뀌어도(끌어서 상위 지정·메뉴·CLI 로 부모 변경) 한 번 더 — 접힌 새 조상 아래로 숨지 않게(수정 r3 R2-B).
  // 집합 값 자체는 의존성에 넣지 않는다 — 넣으면 사용자가 활성 카드의 조상을 접는 즉시 다시 펼친다(위 주석의 허용 동작).
  const activeAncestry = activePath === null ? '' : lineageAncestors({ graph: lineage, path: activePath }).join('\n')
  useEffect(() => {
    if (activePath !== null && lineageCollapse.loaded) expandAncestors(activePath)
  }, [activePath, activeAncestry, lineageCollapse.loaded])

  const sectionOf = (sectionList: readonly SidebarSection[], path: string): SidebarSection | null =>
    sectionList.find((section) => section.items.some((item) => item.worktree.path === path)) ?? null

  /**
   * 카드 드러내기 (K9 · 198 `use-reveal-requests.ts` → `use-pending-reveal.ts`) — ① 필터에 가려졌으면 확인 대화(보이면 필터를 안 건드린다,
   * Orca #17543) ② 접힌 구획 펼치기 ③ 잘렸을 때만 최소 스크롤 ④ 번쩍 1.5s ⑤ `rename` 이면 그 카드에서 인라인 rename(⌘⌥R).
   */
  const reveal = useCallback(
    (input: { path: string; rename: boolean }): void => {
      if (!rowsByPath.has(input.path)) return
      const section = sectionOf(sections, input.path)
      if (section === null) {
        if (filtersOn) setRevealConfirm(input)
        return
      }
      if (section.kind === 'pinned' && isRepoCollapsed(PINNED_SECTION_KEY)) toggleRepoCollapsed(PINNED_SECTION_KEY)
      if (section.kind === 'repo' && isRepoCollapsed(section.repo.root)) toggleRepoCollapsed(section.repo.root)
      expandAncestors(input.path)
      pendingReveal.current = { ...input, tries: 0 }
      setRevealTick((value) => value + 1)
    },
    // rowsByPath·sectionOf 는 렌더마다 새로 서지만 state.repos·sections 가 바뀔 때만 다시 만든다.
    [sections, filtersOn, isRepoCollapsed, toggleRepoCollapsed, state.repos, lineageCollapse.values, lineageCollapse.remove],
  )

  useEffect(() => {
    const pending = pendingReveal.current
    if (pending === null) return
    const list = listRef.current
    const card = list?.querySelector<HTMLElement>(`[data-worktree="${CSS.escape(pending.path)}"]`) ?? null
    if (list === null || card === null) {
      if (pending.tries++ < REVEAL_RETRIES) requestAnimationFrame(() => setRevealTick((value) => value + 1))
      else pendingReveal.current = null
      return
    }
    pendingReveal.current = null
    scrollCardIntoView({ list, card })
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    setFlashPath(pending.path)
    flashTimer.current = window.setTimeout(() => setFlashPath(null), REVEAL_FLASH_MS)
    if (pending.rename) setRenamingPath(pending.path)
  }, [revealTick, sections])

  useEffect(() => {
    const retry = revealAfterFilters.current
    if (retry === null || sectionOf(sections, retry.path) === null) return
    revealAfterFilters.current = null
    reveal(retry)
  }, [sections])

  // 밖에서 온 요청(⌘⌥R · 상위 열기) — seq 마다 한 번.
  const lastRequest = useRef<number | null>(null)
  useEffect(() => {
    const request = cards.revealRequest
    if (request === null || request.seq === lastRequest.current) return
    lastRequest.current = request.seq
    reveal({ path: request.path, rename: request.rename })
  }, [cards.revealRequest, reveal])

  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
  }, [])

  const activateRow = (input: { repoRoot: string; worktree: WorktreeRow }): void => {
    activateWorktreeCard({ actions, repoRoot: input.repoRoot, worktree: input.worktree, selectPane })
  }

  const runMenuAction = (input: { path: string; action: CardMenuAction }): void => {
    const found = rowsByPath.get(input.path)
    if (found === undefined) return
    const { worktree } = found
    const shellFailed = (label: string) => (result: { ok: true } | { ok: false; error: string }) => {
      if (!result.ok) cards.notify(`${label}: ${result.error}`)
    }
    switch (input.action) {
      case 'update':
        cards.openDetails(worktree)
        return
      case 'open-in':
        return
      case 'reveal-finder':
        void window.corral.revealInFinder({ path: worktree.path, kind: 'worktree' }).then(shellFailed('Finder 에서 열지 못했습니다'))
        return
      case 'open-editor':
        void window.corral.openInEditor({ path: worktree.path }).then(shellFailed('VS Code 를 열지 못했습니다'))
        return
      case 'copy-path':
        // 198 처럼 알림 없음 — 실패만 알린다.
        void window.corral.copyPath({ path: worktree.path }).then(shellFailed('경로를 복사하지 못했습니다'))
        return
      case 'toggle-pin':
        cards.togglePin(worktree.path)
        return
      case 'toggle-unread':
        if (cards.unread.worktrees.has(worktree.path)) cards.unread.markRead(worktree.path)
        else cards.unread.markUnread(worktree.path)
        return
      case 'set-parent': {
        const surface = listRef.current?.querySelector<HTMLElement>(`[data-worktree="${CSS.escape(worktree.path)}"] [data-worktree-card-surface]`)
        const rect = surface?.getBoundingClientRect()
        if (rect === undefined) return
        setPicker({ path: worktree.path, anchor: { left: rect.left, right: rect.right, top: rect.top } })
        return
      }
      case 'open-parent': {
        const parent = worktree.parentPath === null ? undefined : rowsByPath.get(worktree.parentPath)
        if (parent === undefined) return
        activateRow({ repoRoot: parent.repo.root, worktree: parent.worktree })
        reveal({ path: parent.worktree.path, rename: false })
        return
      }
      case 'remove-parent':
        void cards.setMeta({ path: worktree.path, parentPath: null }).then((error) => {
          if (error !== null) cards.notify(`상위에서 빼지 못했습니다: ${error}`)
        })
        return
      case 'delete':
        if (worktree.isLinked && !cards.deleting.has(worktree.path)) cards.requestDelete(worktree)
        return
    }
  }

  const menuRow = menu === null ? undefined : rowsByPath.get(menu.path)
  const pickerRow = picker === null ? undefined : rowsByPath.get(picker.path)

  const renderCard = (input: {
    item: SortItem
    onCardMouseDown: (event: React.MouseEvent) => void
    dragging: boolean
    repoLabel: string | null
    reorderable?: boolean
    nest?: CardNest
  }): React.JSX.Element => {
    const { worktree, repoRoot } = input.item
    const selected = worktree.openWorkspaceId !== null && worktree.openWorkspaceId === activeWorkspaceId
    // 부모 카드 안에 중첩돼 보이면 `↳ 부모` 칩은 겹말이라 뺀다 — 칩은 부모가 같은 구획에 안 보일 때만(D1).
    const parent = worktree.parentPath === null || nestedPaths.has(worktree.path) ? undefined : rowsByPath.get(worktree.parentPath)
    return (
      <WorktreeBlock
        key={worktree.path}
        card={{
          reorderable: input.reorderable !== false,
          pinned: cards.pinned.has(worktree.path),
          deleting: cards.deleting.has(worktree.path),
          renaming: renamingPath === worktree.path,
          flash: flashPath === worktree.path,
          showTrash: cards.altHeld,
          parentName: parent === undefined ? null : worktreeDisplayName(parent.worktree),
          unread: cards.unread.worktrees.has(worktree.path),
          onToggleUnread: () => cards.unread.toggle(worktree.path),
          onContextMenu: (point) => {
            // #14545 — 다른 앱이 앞이면 창부터 앞으로(키보드가 메뉴로 오게). 강조는 hover 상태라 포커스 없이도 선다.
            window.corral.activateWindow()
            setMenu({ path: worktree.path, ...point })
          },
          onBeginRename: () => setRenamingPath(worktree.path),
          onRenameCommit: (name) => {
            setRenamingPath(null)
            void cards.setMeta({ path: worktree.path, displayName: name }).then((error) => {
              if (error !== null) cards.notify(`이름을 바꾸지 못했습니다: ${error}`)
            })
          },
          onRenameCancel: () => setRenamingPath(null),
          onOpenDetails: () => cards.openDetails(worktree),
          onDelete: () => cards.requestDelete(worktree),
          onHover: (hovered) => cards.onHoverCard(hovered ? worktree.path : null),
        }}
        nest={input.nest}
        worktree={worktree}
        repoLabel={input.repoLabel}
        layout={view.cardLayout}
        showAgents={showAgents}
        agentLayout={view.agentActivityLayout}
        reordering={reorder.state !== null}
        dragging={input.dragging}
        // 주 체크아웃도 옮긴다(게이트 ① 사용자 수정 1 — 198 `section-order.ts:66-74` 고정과 의도적 차이).
        onCardMouseDown={input.onCardMouseDown}
        integrations={state.integrations}
        home={state.home}
        now={now}
        retained={retainedOf.get(worktree.path) ?? []}
        lineage={state.orchestrationLineage}
        livePaneIds={livePaneIds}
        unreadPanes={cards.unread.panes}
        selected={selected}
        selectedPane={selectedPane}
        groupGlyph={selected ? null : groupGlyphOf(worktree.path)}
        groupExpanded={isGroupExpanded(worktree.path)}
        onToggleGroup={() => toggleGroupExpanded(worktree.path)}
        onSelectBlock={() => activateWorktreeCard({ actions, repoRoot, worktree, selectPane })}
        onSelectSession={onSelectSession}
        onCloseSession={closePane}
        onCloseWorktree={() => {
          if (worktree.openWorkspaceId !== null) actions.closeWorktree(worktree.openWorkspaceId)
        }}
        onCreateShell={() => {
          if (worktree.openWorkspaceId !== null) actions.createRow(worktree.openWorkspaceId, 'shell')
        }}
        onCreateAgent={(kind: AgentKind) => {
          if (worktree.openWorkspaceId !== null) actions.createRow(worktree.openWorkspaceId, kind)
        }}
      />
    )
  }

  /**
   * 덩어리 하나 — 루트 카드 행 안에 펼친 후손을 평면으로(각자 깊이만큼 들여) 그린다(Orca `lineage-group`). 끌기 손잡이는 카드마다
   * 같은 구획 손잡이를 쓴다 — 후손을 끌면 그 카드(와 그 아래)만 움직이고, 순서 줄에 놓으면 부모가 풀린다(D4).
   */
  const renderUnit = (input: {
    unit: LineageUnit
    repoLabel: (item: SortItem) => string | null
    reorderable: boolean
    isDragging: (path: string) => boolean
    onCardMouseDown: (input: { event: React.MouseEvent; path: string }) => void
  }): React.JSX.Element => {
    const lineageTarget = reorder.state?.lineageTarget ?? null
    const cardOf = (row: LineageRow, children: React.ReactNode | null): React.JSX.Element => {
      const path = row.item.worktree.path
      return renderCard({
        item: row.item,
        repoLabel: input.repoLabel(row.item),
        reorderable: input.reorderable,
        dragging: input.isDragging(path),
        onCardMouseDown: (event) => input.onCardMouseDown({ event, path }),
        nest: {
          depth: row.depth,
          childCount: row.childCount,
          collapsed: row.collapsed,
          onToggle: () => lineageCollapse.toggle(path),
          dropTarget: lineageTarget === path,
          children,
        },
      })
    }
    const { unit } = input
    return cardOf(unit.root, unit.descendants.length === 0 ? null : unit.descendants.map((row) => cardOf(row, null)))
  }

  return (
    <div className={`sidebar ${reorder.state !== null ? 'is-reordering' : ''}`} data-sidebar ref={sidebarRef} style={{ width }}>
      <SidebarSearch shortcut={searchShortcut} onOpen={onOpenSearch} tasks={tasks} />
      <ReposSectionHeader view={view} repos={state.repos} onChangeView={onChangeView} onAddRepo={onAddRepo} />
      <div className="repo-list" data-repo-list ref={listRef}>
        {state.repos.length === 0 ? (
          <p className="sidebar-empty" data-empty>
            등록된 레포가 없다. 위의 「+」 로 폴더를 고른다.
          </p>
        ) : filtersOn && visibleCardCount(sections) === 0 ? (
          // 198 `EmptyState.tsx` — 필터로 목록이 비면 문구 + 「필터 지우기」(K2ⓕ).
          <div className="sidebar-empty" data-empty-filtered="">
            <span>워크스페이스가 없다</span>
            <button
              type="button"
              className="sidebar-empty-clear"
              data-clear-filters=""
              onClick={() => onChangeView({ repoFilter: [], hideDefaultBranch: false, hideDetachedHead: false })}
            >
              <CircleXIcon className="sidebar-empty-clear-icon" />
              필터 지우기
            </button>
          </div>
        ) : (
          sections.map((section) => {
            switch (section.kind) {
              case 'pinned': {
                // 198 Pinned 구획(`pinned-group-rows.ts`) — 맨 위, 접을 수 있다. 카드는 끌기 대상이 아니고(K5ⓕ) 레포 이름을 **글자로**
                // 보인다(Orca #24304 — 198 은 아이콘+툴팁뿐이라 여러 레포의 `main` 이 구분되지 않는다).
                const collapsed = isRepoCollapsed(PINNED_SECTION_KEY)
                return (
                  <div key={PINNED_SECTION_KEY} className="repo-row-group pinned-group" data-pinned-section="">
                    <div className="all-group-head pinned-group-head" data-pinned-head="" role="button" aria-expanded={!collapsed} onClick={() => toggleRepoCollapsed(PINNED_SECTION_KEY)}>
                      <PinIcon className="all-group-icon" />
                      <span className="all-group-label">고정됨</span>
                      <span className="all-group-count" data-pinned-count="">
                        {section.items.length}
                      </span>
                    </div>
                    {collapsed
                      ? null
                      : (unitsOf.get(PINNED_SECTION_KEY) ?? []).map((unit) =>
                          renderUnit({ unit, repoLabel: (item) => item.repoName, reorderable: false, isDragging: () => false, onCardMouseDown: () => {} }),
                        )}
                  </div>
                )
              }
              case 'all':
                return (
                  <div key="*all" className="repo-row-group all-group" data-reorder-all="">
                    <div className="all-group-head" data-all-group-head="">
                      <ListIcon className="all-group-icon" />
                      <span className="all-group-label">전체</span>
                      <span className="all-group-count" data-all-group-count="">
                        {section.items.length}
                      </span>
                    </div>
                    {(unitsOf.get(sectionKey(section)) ?? []).map((unit) =>
                      renderUnit({
                        unit,
                        repoLabel: (item) => item.repoName,
                        reorderable: true,
                        isDragging: (path) => dragSource?.kind === 'all-card' && dragBlock.has(path),
                        onCardMouseDown: ({ event, path }) => reorder.onAllCardMouseDown({ event, path }),
                      }),
                    )}
                  </div>
                )
              case 'repo': {
                const repo = section.repo
                return (
                  <RepoRow
                    key={repo.root}
                    repo={repo}
                    reordering={reorder.state !== null}
                    dragging={dragSource?.kind === 'repo' && dragSource.root === repo.root}
                    onHeadMouseDown={(event) => {
                      if (repoDragEnabled) reorder.onRepoMouseDown({ event, root: repo.root })
                    }}
                    collapsed={isRepoCollapsed(repo.root)}
                    onToggleCollapse={() => toggleRepoCollapsed(repo.root)}
                    onCreateWorktree={() => actions.openCreateWorktree(repo.root)}
                    onRemove={() => onRemoveRepo(repo.root)}
                    onRevealInFinder={() => {
                      void window.corral.revealInFinder({ path: repo.root, kind: 'repo' }).then((result) => {
                        if (!result.ok) cards.notify(`Finder 에서 열지 못했습니다: ${result.error}`)
                      })
                    }}
                  >
                    {(unitsOf.get(sectionKey(section)) ?? []).map((unit) =>
                      renderUnit({
                        unit,
                        repoLabel: () => null,
                        reorderable: true,
                        isDragging: (path) => dragSource?.kind === 'card' && dragSource.repoRoot === repo.root && dragBlock.has(path),
                        onCardMouseDown: ({ event, path }) => reorder.onCardMouseDown({ event, repoRoot: repo.root, path }),
                      }),
                    )}
                  </RepoRow>
                )
              }
            }
          })
        )}
        {reorder.state?.indicatorY != null ? <ReorderDropIndicator y={reorder.state.indicatorY} /> : null}
      </div>
      <SidebarFooterToolbar onRefresh={onRefresh} onReveal={() => {
        if (activePath !== null) reveal({ path: activePath, rename: false })
      }} onOpenShortcuts={onOpenShortcuts} onOpenSettings={onOpenSettings} />
      {menu !== null && menuRow !== undefined ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          attrs={{ 'data-card-menu': menu.path }}
          entries={cardMenuEntries({
            worktree: menuRow.worktree,
            pinned: cards.pinned.has(menu.path),
            unread: cards.unread.worktrees.has(menu.path),
            deleting: cards.deleting.has(menu.path),
            candidateCount: parentCandidates({ worktree: menuRow.worktree, repo: menuRow.repo }).length,
            parentInTree: menuRow.worktree.parentPath !== null && rowsByPath.has(menuRow.worktree.parentPath),
            deleteShortcut: cards.deleteShortcut,
          })}
          onAction={(action) => runMenuAction({ path: menu.path, action })}
          onClose={closeMenu}
        />
      ) : null}
      {picker !== null && pickerRow !== undefined ? (
        <ParentPicker
          child={pickerRow.worktree}
          candidates={parentCandidates({ worktree: pickerRow.worktree, repo: pickerRow.repo })}
          anchor={picker.anchor}
          activePath={activePath}
          onPick={(parent) => {
            setPicker(null)
            void cards.setMeta({ path: pickerRow.worktree.path, parentPath: parent.path }).then((error) => {
              if (error !== null) cards.notify(`상위 워크트리를 지정하지 못했습니다: ${error}`)
            })
          }}
          onClose={closePicker}
        />
      ) : null}
      {revealConfirm === null ? null : (
        <RevealConfirmDialog
          path={revealConfirm.path}
          onKeep={() => setRevealConfirm(null)}
          onClear={() => {
            revealAfterFilters.current = revealConfirm
            setRevealConfirm(null)
            onChangeView({ repoFilter: [], hideDefaultBranch: false, hideDetachedHead: false })
          }}
        />
      )}
    </div>
  )
}

/**
 * 잘렸을 때만 최소 거리 스크롤 (198 `worktree-sidebar-reveal.ts:21-36` — `nearest` 같은 최소 이동, 위 여백 = sticky 헤더 + 6px).
 * reduced motion 이면 즉시(198 `:60-67`).
 */
function scrollCardIntoView(input: { list: HTMLElement; card: HTMLElement }): void {
  const { list, card } = input
  const listRect = list.getBoundingClientRect()
  const rect = card.getBoundingClientRect()
  const head = card.closest('.repo-row-group')?.querySelector<HTMLElement>('[data-repo-head]') ?? null
  const inset = (head !== null && getComputedStyle(head).position === 'sticky' ? head.offsetHeight : 0) + REVEAL_GAP
  let delta = 0
  if (rect.top < listRect.top + inset) delta = rect.top - (listRect.top + inset)
  else if (rect.bottom > listRect.bottom) delta = Math.min(rect.bottom - listRect.bottom, rect.top - (listRect.top + inset))
  if (delta === 0) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  list.scrollTo({ top: list.scrollTop + delta, behavior: reduced ? 'auto' : 'smooth' })
}

/**
 * 드롭 표시 줄 — 198 `WorktreeSidebarDropIndicator.tsx:17-25` 대응: 양끝 점 6px(`size-1.5`) + 가운데 막대 2px(`h-0.5`),
 * 색 `--worktree-sidebar-ring`, 바탕색 2px 그림자 테두리, `left-3 right-2 z-30`(sticky 헤더 z 20 위), 세로 가운데 맞춤.
 */
function ReorderDropIndicator({ y }: { y: number }): React.JSX.Element {
  return (
    <div className="reorder-drop-indicator" data-reorder-indicator="" role="presentation" style={{ top: `${y}px` }}>
      <span className="reorder-drop-dot" />
      <span className="reorder-drop-bar" />
      <span className="reorder-drop-dot" />
    </div>
  )
}
