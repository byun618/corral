// 사이드바 끌어 옮기기 컨트롤러 (LIFE-469) — 레포 헤더·워크트리 카드(주 체크아웃 포함).
//
// 판정은 `sidebar-reorder.ts` 순수 함수가 한다 — 여기서는 DOM(마우스 이벤트·사각형 실측·자동 스크롤)만 다룬다.
// 198 사이드바도 dnd-kit 이 아니라 자체 pointer 구현이고(00-analysis F1), corral 탭 드래그(`useTabDrag`)도 같은 결이라
// 라이브러리를 들이지 않는다. 마우스 이벤트를 쓰는 이유: 헤더에서 `mousedown` 의 기본 동작(글자 선택 시작)을 막아야
// SVG 아이콘에서 끌어도 글자 선택이 생기지 않는다(C4).
//
// 취소 = `Escape`(헤더·카드 모두 — C3) · 창 blur · 목록 밖 놓기. 문턱을 넘긴 드래그 뒤의 click 하나는 삼킨다
// (198 `header-drag-click-swallow.ts` — 놓은 자리의 접기·카드 선택이 또 불리지 않게).
//
// 미리 보기(게이트 ① 사용자 수정 1, K3ⓗ) = 198 카드 포인터 드래그와 같은 결: 끄는 항목을 복제한 **자체 DOM 사본**이
// 커서를 따라오고(`worktree-sidebar-pointer-drag-dom.ts` `createSidebarDragPreview`), 원래 행은 투명해지며
// (`item-row.tsx` `opacity-0`), 다른 행은 `transform` 으로 밀려 자리를 벌린다(`buildReorderPreview`). 브라우저 drag image
// (HTML5 `draggable`)를 쓰지 않는 이유: 그 경로로 가면 mousedown 컨트롤러 대신 dragstart/dragover 로 바꿔야 하고, 그러면
// 헤더 mousedown 의 기본 동작을 막아 지키던 C4(글자 선택 없음)·문턱 미만 클릭·클릭 삼킴·Escape 취소를 다시 세워야 한다.
// 사본은 `.sidebar` 안에 붙인다 — 사이드바 범위 CSS(테두리 리셋 등)를 그대로 받게.
//
// 놓일 자리는 **밀리기 전 기하**로 잰다(K3ⓗⓒ): 매 프레임 실측하되 각 행과 조상에 걸린 translateY(전환 중이면 그 순간 값)를
// 빼서, 밀린 행 위로 포인터가 지나가도 판정이 진동하지 않는다. 198 은 시작 때 한 번 잰 사각형을 쓰지만 corral 은 드래그 중
// 목록 갱신·행 소멸을 따라가야 해서(R1-03) 매 프레임 재되 transform 을 뺀다.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildReorderPreview,
  hasCrossedReorderThreshold,
  buildInsertionPreview,
  nextAutoscrollTop,
  resolveCardDropSlot,
  resolveLineageTarget,
  resolveRepoDropSlot,
  unitSlotToFlat,
  type ItemRect,
  type LineageTargetRect,
  type Point,
  type RepoSlotRect,
} from '../sidebar-reorder.js'

/** `all-card` = Group by None 의 단일 「All」 구획 카드 (LIFE-470) — 레포가 섞여 있어 레포 묶음이 아니라 그 구획 안에서 잰다. */
export type ReorderSource = { kind: 'repo'; root: string } | { kind: 'card'; repoRoot: string; path: string } | { kind: 'all-card'; path: string }

/** `lineageTarget` = 지금 상위 지정 대상 카드 경로(LIFE-576 D3) — 있으면 표시 줄·행 밀림이 없다(둘이 동시에 보이지 않는다, K3ⓑ). */
export type ReorderState = {
  source: ReorderSource
  indicatorY: number | null
  lineageTarget?: string
  /** 끄는 덩어리(끄는 항목 + 보이는 후손, 드래그 시작 때) — 원래 자리 투명 처리 대상. 저장 `block` 과 같은 집합(수정 r3 R2-C). */
  block: readonly string[]
}

/**
 * 놓기 — `keys` 는 놓는 순간 화면에 보이던 순서(끄는 항목 포함, 중첩 후손도 화면 순서로), `slot` 은 그 기준 경계 번호.
 * `block` = 함께 옮길 덩어리(끄는 카드 + 펼친 후손, LIFE-576 D5) — 끄는 카드 하나뿐이면 없다.
 */
export type ReorderCommit = {
  source: ReorderSource
  keys: string[]
  slot: number
  block?: string[]
  /** 부모 해제 동반(LIFE-576 R2-A) — Sidebar 가 붙인다. 평면 목록이 같아도 표시 자리로 착지하고 바뀐 것으로 센다. */
  unnest?: boolean
}

/** 끌어서 상위 지정 (LIFE-576) — `path` 카드를 `parentPath` 카드의 하위로. */
export type NestCommit = { path: string; parentPath: string }

/** 헤더에서 드래그로 치지 않는 곳 — 셰브론·⋯·+ 버튼과 열린 메뉴(U14, 198 `REPO_HEADER_ACTION_SELECTOR`). */
const NON_HANDLE_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"], [data-repo-row-actions], .repo-row-menu'

function isHandleTarget(target: EventTarget | null): boolean {
  // `Element` 로 본다 — 폴더 아이콘은 <svg> 라 HTMLElement 가 아니다(198 #8575, C4).
  return target instanceof Element && target.closest(NON_HANDLE_SELECTOR) === null
}

/** 요소에 지금 걸린 세로 이동(전환 중이면 그 순간 값). 이동이 없으면 0. */
function translateYOf(element: Element): number {
  const transform = getComputedStyle(element).transform
  if (transform === '' || transform === 'none') return 0
  return new DOMMatrixReadOnly(transform).m42
}

/**
 * 목록 스크롤 내용 기준 사각형 — **밀리기 전** 자리. 요소와 목록 사이 조상에 걸린 translateY 를 뺀다(K3ⓗⓒ).
 * 끄는 동안 transform 을 거는 것은 이 hook 뿐이고(행 밀림), 사본은 목록 밖이라 여기 걸리지 않는다.
 */
function rectOf(input: { list: HTMLElement; element: Element }): ItemRect {
  const listTop = input.list.getBoundingClientRect().top - input.list.scrollTop
  const rect = input.element.getBoundingClientRect()
  let shift = 0
  for (let node: Element | null = input.element; node !== null && node !== input.list; node = node.parentElement) shift += translateYOf(node)
  return { top: rect.top - listTop - shift, bottom: rect.bottom - listTop - shift }
}

function repoGroups(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(':scope > [data-repo]')]
}

/** 한 번 잰 목록 — `keys`·`rects`·`elements` 는 같은 자리끼리 짝이다(화면 순서). */
type Measured<R extends ItemRect> = { keys: string[]; rects: R[]; elements: HTMLElement[] }

function measureRepos(list: HTMLElement): Measured<RepoSlotRect> {
  const keys: string[] = []
  const rects: RepoSlotRect[] = []
  const elements: HTMLElement[] = []
  for (const group of repoGroups(list)) {
    const root = group.getAttribute('data-repo')
    const head = group.querySelector('[data-repo-head]')
    if (root === null || head === null) continue
    const box = rectOf({ list, element: group })
    // 헤더는 지금 그려진 자리(sticky 로 붙었으면 붙은 자리)를 묶음 범위와 따로 잰다(R1-05).
    const headBox = rectOf({ list, element: head })
    keys.push(root)
    rects.push({ top: box.top, bottom: box.bottom, headTop: headBox.top, headBottom: headBox.bottom })
    elements.push(group)
  }
  return { keys, rects, elements }
}

/**
 * 잰 구획 — `keys`·`rects`·`elements` 는 **덩어리**(루트 카드 행 — 중첩 후손은 그 행 안에 그려진다, LIFE-576) 단위,
 * `all` 은 화면의 카드 전부(문서 순서), `owner` 는 카드 → 그 카드를 품은 가장 가까운 카드(루트면 없음).
 */
type MeasuredCards = Measured<ItemRect> & { all: string[]; owner: Map<string, string>; cards: Map<string, HTMLElement>; depth: Map<string, number> }

/** 카드를 품은 가장 가까운 다른 카드(같은 구획 안) — 없으면 null. */
function ownerCardOf(input: { card: HTMLElement; group: HTMLElement }): string | null {
  for (let node = input.card.parentElement; node !== null && node !== input.group; node = node.parentElement) {
    const path = node.getAttribute('data-reorder-card')
    if (path !== null) return path
  }
  return null
}

function measureCards(input: { list: HTMLElement; group: HTMLElement | undefined }): (MeasuredCards & { groupRange: ItemRect }) | null {
  const { list, group } = input
  if (group === undefined) return null
  const keys: string[] = []
  const rects: ItemRect[] = []
  const elements: HTMLElement[] = []
  const all: string[] = []
  const owner = new Map<string, string>()
  const cards = new Map<string, HTMLElement>()
  const depth = new Map<string, number>()
  for (const card of group.querySelectorAll<HTMLElement>('[data-reorder-card]')) {
    const path = card.getAttribute('data-reorder-card')
    if (path === null) continue
    all.push(path)
    cards.set(path, card)
    // 계보 깊이(`WorktreeBlock` 의 `data-lineage-depth`, 루트는 없음 = 0) — 후손은 루트 행 안에 평평하게 그려져 DOM 소유로는 손자를 못 가른다.
    depth.set(path, Number(card.getAttribute('data-lineage-depth') ?? 0) || 0)
    const parent = ownerCardOf({ card, group })
    if (parent !== null) {
      owner.set(path, parent)
      continue
    }
    keys.push(path)
    rects.push(rectOf({ list, element: card }))
    elements.push(card)
  }
  return { keys, rects, elements, all, owner, cards, depth, groupRange: rectOf({ list, element: group }) }
}

/**
 * 끄는 덩어리 — 카드 + 그 카드의 **보이는 후손**(화면 순서). Orca `expandDraggedWorktreeIdsForVisibleLineage` 대응(수정 r2 R1-B):
 * 같은 루트 덩어리 안에서 바로 뒤에 이어지는, 깊이가 더 깊은 카드들. 루트면 덩어리 전체, 하위 카드면 그 아래 손자들까지.
 */
function blockOf(input: { key: string; measured: MeasuredCards }): string[] {
  const { key, measured } = input
  const rootOf = (path: string): string => {
    const seen = new Set<string>()
    let cursor = path
    for (let next = measured.owner.get(cursor); next !== undefined && !seen.has(next); next = measured.owner.get(next)) {
      seen.add(next)
      cursor = next
    }
    return cursor
  }
  const start = measured.all.indexOf(key)
  if (start < 0) return []
  const base = measured.depth.get(key) ?? 0
  const root = rootOf(key)
  const block = [key]
  for (const path of measured.all.slice(start + 1)) {
    if (rootOf(path) !== root || (measured.depth.get(path) ?? 0) <= base) break
    block.push(path)
  }
  return block
}

/** 덩어리의 밀리기 전 높이 — 첫 카드 윗변 ~ 마지막 카드 아랫변(하위 카드 + 손자 행이 따로 그려진다). */
function blockHeight(input: { list: HTMLElement; measured: MeasuredCards; block: readonly string[] }): number {
  const first = input.block[0] === undefined ? undefined : input.measured.cards.get(input.block[0])
  const last = input.block.at(-1) === undefined ? undefined : input.measured.cards.get(input.block.at(-1) ?? '')
  if (first === undefined || last === undefined) return 0
  return Math.max(0, rectOf({ list: input.list, element: last }).bottom - rectOf({ list: input.list, element: first }).top)
}

/**
 * 상위 지정 후보 사각형 (D3) — 후보 Set(드래그 시작 때 구한 것)에 든 카드만. 사각형 = 그 카드 자기 내용 영역(밀리기 전), 아랫변은 그 카드 안 첫
 * 자식 카드 윗변에서 자른다(Orca main 「keep their rows out of its hit zone」).
 */
function lineageTargets(input: {
  list: HTMLElement
  measured: MeasuredCards
  sourceKey: string
  candidates: ReadonlySet<string>
}): LineageTargetRect[] {
  const { list, measured, sourceKey } = input
  const targets: LineageTargetRect[] = []
  for (const key of measured.all) {
    if (key === sourceKey || !input.candidates.has(key)) continue
    const content = measured.cards.get(key)?.querySelector('[data-worktree-card-parent-content]') ?? null
    if (content === null) continue
    const rect = rectOf({ list, element: content })
    const firstChild = measured.all.find((path) => measured.owner.get(path) === key)
    const childElement = firstChild === undefined ? undefined : measured.cards.get(firstChild)
    const bottom = childElement === undefined ? rect.bottom : Math.min(rect.bottom, rectOf({ list, element: childElement }).top)
    targets.push({ key, rect: { top: rect.top, bottom } })
  }
  return targets
}

function sourceKey(source: ReorderSource): string {
  switch (source.kind) {
    case 'repo':
      return source.root
    case 'card':
    case 'all-card':
      return source.path
  }
}

/**
 * 지금 DOM·포인터로 놓일 자리를 잰다. `keys` 는 지금 화면 순서(끄는 항목 포함) — 끄는 항목이 없으면 그 행이 사라진 것이다.
 * 포인터가 스크롤러의 **보이는 범위**(좌우·위아래) 밖이면 slot 은 `null`(놓으면 취소, R1-01). 자동 스크롤은 바깥 48px 까지
 * 돌지만(`nextAutoscrollTop`) 그 띠는 놓기 허용과 별개다 — 화면 밖 항목 기준으로 순서가 바뀌지 않게.
 */
type DropMeasure = Measured<ItemRect> & {
  slot: number | null
  /** 화면의 항목 전부(카드면 중첩 후손 포함, 문서 순서) — 끄는 항목이 여기 없으면 그 행이 사라진 것이다. */
  all: string[]
  /** 끄는 덩어리(끄는 카드 + 그 안의 후손). */
  block: string[]
  /** 덩어리마다 카드 수 — 덩어리 경계를 평면 경계로 바꾼다(`unitSlotToFlat`). */
  sizes: number[]
  /** 상위 지정 대상(D3). 있으면 순서 이동이 아니다. */
  lineageTarget: string | null
  /** 끄는 덩어리의 밀리기 전 높이 — 중첩된 자식 끌기 미리 보기(M4)가 벌릴 높이. */
  blockHeight: number
  /** 끄는 항목의 행 요소 — 사본을 복제한다. 중첩된 자식은 덩어리 목록에 없어 따로 든다. */
  sourceElement: HTMLElement | undefined
  /** 끄는 덩어리의 행 요소(화면 순서) — 사본에 싣는다(R2-C). */
  blockElements: HTMLElement[]
}

function measureDrop(input: { list: HTMLElement; source: ReorderSource; point: Point; candidates: ReadonlySet<string> | null }): DropMeasure {
  const { list, source, point } = input
  const listRect = list.getBoundingClientRect()
  const outside = point.x < listRect.left || point.x > listRect.right || point.y < listRect.top || point.y > listRect.bottom
  const y = point.y - listRect.top + list.scrollTop
  switch (source.kind) {
    case 'repo': {
      const repos = measureRepos(list)
      return {
        ...repos,
        slot: outside ? null : resolveRepoDropSlot({ rects: repos.rects, y }),
        all: repos.keys,
        block: [source.root],
        sizes: repos.keys.map(() => 1),
        lineageTarget: null,
        blockHeight: 0,
        sourceElement: repos.elements[repos.keys.indexOf(source.root)],
        blockElements: repos.elements.filter((_, index) => repos.keys[index] === source.root),
      }
    }
    case 'card':
    case 'all-card': {
      const group =
        source.kind === 'card'
          ? repoGroups(list).find((element) => element.getAttribute('data-repo') === source.repoRoot)
          : (list.querySelector<HTMLElement>(':scope > [data-reorder-all]') ?? undefined)
      const cards = measureCards({ list, group })
      if (cards === null) return { slot: null, keys: [], rects: [], elements: [], all: [], block: [], sizes: [], lineageTarget: null, blockHeight: 0, sourceElement: undefined, blockElements: [] }
      const block = blockOf({ key: source.path, measured: cards })
      const lineageTarget =
        outside || input.candidates === null ? null : resolveLineageTarget({ targets: lineageTargets({ list, measured: cards, sourceKey: source.path, candidates: input.candidates }), y })
      return {
        keys: cards.keys,
        rects: cards.rects,
        elements: cards.elements,
        all: cards.all,
        block,
        sizes: cards.keys.map((key) => blockOf({ key, measured: cards }).length),
        blockHeight: blockHeight({ list, measured: cards, block }),
        lineageTarget,
        sourceElement: cards.cards.get(source.path),
        blockElements: block.flatMap((path) => cards.cards.get(path) ?? []),
        slot: outside || lineageTarget !== null ? null : resolveCardDropSlot({ rects: cards.rects, groupRange: cards.groupRange, y }),
      }
    }
  }
}

/**
 * 사본에서 떼어 낼 일시 UI — 열린 `⋯` 메뉴(레포·카드 모두 `.repo-row-menu`)와 role 로 표시한 메뉴·툴팁·대화상자(R6-01).
 * 사본은 끄는 항목의 모양만 보여야 한다. 라이브 메뉴는 `reordering` 효과가 닫지만 그 효과는 렌더 뒤라, 복제하는 순간에는
 * 아직 열려 있다 — CSS 로 숨기는 대신 복제본에서 노드를 빼서, 사본 안에서 그 UI 가 어떤 상태로도 다시 보이지 않게 한다.
 */
const TRANSIENT_UI_SELECTOR = '.repo-row-menu, [role="menu"], [role="tooltip"], [role="dialog"]'

/** 198 `createSidebarDragPreview` 의 확대율 — 사본이 원래 행보다 살짝 커 「들려 있다」. */
const DRAG_PREVIEW_SCALE = 1.015

/**
 * 끄는 항목의 사본 (198 `createSidebarDragPreview` 대응) — 복제한 행을 고정 위치 틀에 넣어 `.sidebar` 에 붙인다. 잡은 점의
 * 행 안 위치(행 범위로 자름)를 지켜 커서를 따라온다. 복제본의 id·순서 표식은 지운다 — 측정·하네스 질의가 사본을 원래
 * 행으로 착각하지 않게. 반투명·그림자·z 는 CSS `[data-sidebar-drag-preview]`.
 *
 * 레포는 묶음(헤더+카드)을 복제하되 잡은 점은 **헤더** 기준으로 잰다 — 붙은(sticky) 헤더를 묶음 아래쪽에서 잡아도 사본의
 * 헤더가 커서 밑에 온다(사본 안 헤더는 묶음 맨 위에 그려진다). 사본 높이 상한은 CSS(펼친 큰 레포가 목록을 덮지 않게).
 */
function createDragPreview(input: {
  list: HTMLElement
  sourceElement: HTMLElement
  /** 끄는 덩어리의 카드 행들(화면 순서). 하위 카드의 손자는 하위 카드 행 밖(평면 배치)에 있어 따로 복제한다(수정 r3 R2-C). */
  blockElements: readonly HTMLElement[]
  source: ReorderSource
  grab: Point
  point: Point
}): {
  element: HTMLElement
  offsetX: number
  offsetY: number
} {
  const { list, sourceElement, grab, point } = input
  // 덩어리가 끄는 행 안에 다 있으면(레포·루트 카드·손자 없는 하위 카드) 그 행 하나, 아니면 행들을 같은 틀(후손 묶음) 기준으로 쌓는다 —
  // 들여쓰기가 화면과 같게 틀 폭·왼쪽에 맞춘다.
  const outside = input.blockElements.filter((element) => element !== sourceElement && !sourceElement.contains(element))
  const frame = outside.length === 0 ? null : sourceElement.parentElement
  const sourceRect = sourceElement.getBoundingClientRect()
  const lastRect = (outside.at(-1) ?? sourceElement).getBoundingClientRect()
  const frameRect = frame?.getBoundingClientRect() ?? sourceRect
  const rect = { left: frameRect.left, width: frameRect.width, top: sourceRect.top, height: Math.max(sourceRect.height, lastRect.bottom - sourceRect.top) }
  const anchor = input.source.kind === 'repo' ? (sourceElement.querySelector('[data-repo-head]') ?? sourceElement) : sourceElement
  const anchorRect = anchor.getBoundingClientRect()
  const element = document.createElement('div')
  element.setAttribute('data-sidebar-drag-preview', 'true')
  element.setAttribute('data-sidebar-drag-preview-kind', input.source.kind)
  element.setAttribute('aria-hidden', 'true')
  element.style.width = `${rect.width}px`
  element.style.height = `${rect.height}px`
  for (const row of frame === null ? [sourceElement] : [sourceElement, ...outside]) {
    const clone = row.cloneNode(true)
    if (!(clone instanceof HTMLElement)) continue
    for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
      node.removeAttribute('id')
      for (const name of ['data-repo', 'data-repo-head', 'data-reorder-card', 'data-worktree']) node.removeAttribute(name)
    }
    for (const node of [clone, ...clone.querySelectorAll('.is-reorder-source')]) node.classList.remove('is-reorder-source')
    for (const node of clone.querySelectorAll(TRANSIENT_UI_SELECTOR)) node.remove()
    // 메뉴가 열린 헤더의 z 올림 표식도 뗀다 — 메뉴가 없는 사본에는 의미가 없다.
    for (const node of clone.querySelectorAll('.is-menu-open')) node.classList.remove('is-menu-open')
    element.appendChild(clone)
  }
  const host = list.closest('[data-sidebar]') ?? document.body
  host.appendChild(element)
  // 잡은 점 = mousedown 자리(198 은 문턱을 넘은 자리 — 보통 4px 차이. 빠르게 끌어 한 이벤트에 크게 움직여도 잡은 점이 유지되게).
  const offsetX = Math.max(0, Math.min(rect.width, grab.x - rect.left))
  const offsetY = Math.max(0, Math.min(anchorRect.height, grab.y - anchorRect.top))
  movePreview({ element, point, offsetX, offsetY })
  return { element, offsetX, offsetY }
}

function movePreview(input: { element: HTMLElement; point: Point; offsetX: number; offsetY: number }): void {
  input.element.style.transform = `translate3d(${input.point.x - input.offsetX}px, ${input.point.y - input.offsetY}px, 0) scale(${DRAG_PREVIEW_SCALE})`
}

export function useSidebarReorder(input: {
  listRef: React.RefObject<HTMLDivElement | null>
  onCommit: (commit: ReorderCommit) => void
  /**
   * 끌어서 상위 지정 (LIFE-576 D3) — `nestCandidates(끄는 경로)` 에 든 카드의 내용 영역 안쪽에 놓으면 `onNest`. 후보는 호출부가 메뉴
   * 피커와 같은 `parentCandidates()` 로 준다(K3ⓒ — 복제 금지). 드래그 시작 때 한 번 부른다(수정 r3 R2-E). 없으면 순서 끌기만.
   */
  nestCandidates?: (path: string) => ReadonlySet<string>
  onNest?: (nest: NestCommit) => void
}): {
  state: ReorderState | null
  /** 레포 헤더(`.repo-row`)의 `onMouseDown`. 레포가 1개면 시작하지 않는다(198 — 헤더 2개 이상일 때만, K1ⓒ). */
  onRepoMouseDown: (input: { event: React.MouseEvent; root: string }) => void
  /** 워크트리 카드의 `onMouseDown` — 주 체크아웃 카드에도 붙는다(게이트 ① 사용자 수정 1, K2ⓑ 폐지). */
  onCardMouseDown: (input: { event: React.MouseEvent; repoRoot: string; path: string }) => void
  /** Group by None 구획 카드의 `onMouseDown` (LIFE-470). */
  onAllCardMouseDown: (input: { event: React.MouseEvent; path: string }) => void
} {
  const [state, setState] = useState<ReorderState | null>(null)
  const inputRef = useRef(input)
  inputRef.current = input
  /** 진행 중인 드래그의 정리 함수 — 언마운트 때도 부른다. */
  const abortRef = useRef<(() => void) | null>(null)

  useEffect(() => () => abortRef.current?.(), [])

  const arm = useCallback((armInput: { event: React.MouseEvent; source: ReorderSource }) => {
    const { event, source } = armInput
    const list = inputRef.current.listRef.current
    if (event.button !== 0 || list === null || abortRef.current !== null) return
    if (!isHandleTarget(event.target)) return
    switch (source.kind) {
      case 'repo':
        if (repoGroups(list).length < 2) return
        // 헤더는 누르는 순간 글자 선택 시작을 막는다(C4). click 은 그대로 온다 — 문턱 미만이면 접기로 처리된다.
        event.preventDefault()
        break
      case 'card':
      case 'all-card':
        break
    }
    const key = sourceKey(source)
    const start = { x: event.clientX, y: event.clientY }
    let point = start
    let dragging = false
    let done = false
    /** 이 드래그의 버튼 해제(mouseup) 안에서 끝나는가 — 아니면 버튼은 아직 눌려 있다. */
    let released = false
    let slot: number | null = null
    let keys: string[] = []
    let block: string[] = []
    let lineageTarget: string | null = null
    let shownY: number | null = null
    let shownTarget: string | null = null
    let shownBlock = ''
    /** 상위 지정 후보(R2-E) — 문턱을 넘는 때(드래그 시작) 한 번 구하고 프레임마다는 포함 여부만 본다. */
    let candidates: ReadonlySet<string> | null = null
    let frame = 0
    let lastFrameAt = 0
    let preview: { element: HTMLElement; offsetX: number; offsetY: number } | null = null
    /** 밀림을 건 행 → 건 값. 목록이 다시 그려져 사라진 행도 정리 때 지운다. */
    const shifted = new Map<HTMLElement, number>()

    /**
     * 행마다 밀림을 건다. 이미 건 값과 0.5px 안이면 그대로 둔다 — 전환 중 실측에서 transform 을 빼면 소수 오차가 남아, 매
     * 프레임 다시 쓰면 150ms 전환이 계속 재시작돼 값이 수렴하지 않는다(격리 run18 K3h-c-repo 에서 관측).
     */
    const applyShifts = (shiftInput: { elements: readonly HTMLElement[]; offsets: readonly number[] }): void => {
      const next = new Map<HTMLElement, number>()
      shiftInput.elements.forEach((element, index) => {
        const offset = shiftInput.offsets[index] ?? 0
        if (offset === 0) return
        const current = shifted.get(element)
        next.set(element, current !== undefined && Math.abs(current - offset) < 0.5 ? current : offset)
      })
      for (const [element] of shifted) if (!next.has(element)) element.style.removeProperty('transform')
      for (const [element, offset] of next) if (shifted.get(element) !== offset) element.style.transform = `translateY(${offset}px)`
      shifted.clear()
      for (const [element, offset] of next) shifted.set(element, offset)
    }

    /** 지금 DOM 으로 다시 잰다 — 끄는 행이 사라졌으면(목록 갱신) 드래그를 취소한다(R1-03). */
    const update = (): void => {
      const measured = measureDrop({ list, source, point, candidates })
      if (!measured.all.includes(key)) {
        finish({ commit: false })
        return
      }
      // 덩어리 목록에서 끄는 카드 자리 — 중첩된 자식이면 -1(부모 덩어리 안이다).
      const from = measured.keys.indexOf(key)
      lineageTarget = measured.lineageTarget
      keys = measured.all
      block = measured.block
      slot = measured.slot === null ? null : unitSlotToFlat({ sizes: measured.sizes, slot: measured.slot })
      const view = { top: list.scrollTop, bottom: list.scrollTop + list.clientHeight }
      let indicatorY: number | null = null
      if (measured.slot === null) applyShifts({ elements: [], offsets: [] })
      else if (from < 0) {
        // 중첩된 자식 — 덩어리 목록 밖이라 끼워 넣기 미리 보기(M4). 높이는 끄는 덩어리(그 카드 + 보이는 손자, R1-B)의 밀리기 전 높이.
        const built = buildInsertionPreview({ rects: measured.rects, slot: measured.slot, height: measured.blockHeight, view })
        applyShifts({ elements: measured.elements, offsets: built.offsets })
        indicatorY = built.indicatorY
      } else {
        const built = buildReorderPreview({ rects: measured.rects, from, slot: measured.slot, view })
        applyShifts({ elements: measured.elements, offsets: built.offsets })
        indicatorY = built.indicatorY
      }
      const blockKey = block.join('\n')
      if (indicatorY === shownY && lineageTarget === shownTarget && blockKey === shownBlock) return
      shownY = indicatorY
      shownTarget = lineageTarget
      shownBlock = blockKey
      setState(lineageTarget === null ? { source, indicatorY, block } : { source, indicatorY, lineageTarget, block })
    }
    const tick = (now: number): void => {
      const elapsed = lastFrameAt === 0 ? 16 : now - lastFrameAt
      lastFrameAt = now
      const next = nextAutoscrollTop({
        point,
        containerRect: list.getBoundingClientRect(),
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        elapsedMs: elapsed,
      })
      if (next !== null) list.scrollTop = next
      // 스크롤이 없어도 매 프레임 다시 잰다 — 드래그 중 목록이 바뀌면(새 워크트리·행 소멸) 표시 줄과 놓을 자리가 따라간다.
      update()
      if (!done) frame = requestAnimationFrame(tick)
    }
    const cleanup = (): void => {
      done = true
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
      if (frame !== 0) cancelAnimationFrame(frame)
      preview?.element.remove()
      preview = null
      applyShifts({ elements: [], offsets: [] })
      list.classList.remove('is-reorder-shifting')
      document.body.classList.remove('is-sidebar-reorder')
      abortRef.current = null
      setState(null)
    }
    /**
     * 끝내기. 버튼 해제 전에 끝났으면(Escape·blur·행 소멸·언마운트) 그 해제로 생길 click 하나를 기다렸다 삼킨다(R1-02).
     */
    const finish = (finishInput: { commit: boolean }): void => {
      if (done) return
      const wasDragging = dragging
      const finalSlot = slot
      const finalKeys = keys
      const finalBlock = block
      const finalTarget = lineageTarget
      cleanup()
      if (!wasDragging) return
      if (released) swallowNextClick()
      else swallowClickOfPendingRelease()
      if (!finishInput.commit) return
      if (finalTarget !== null) inputRef.current.onNest?.({ path: key, parentPath: finalTarget })
      else if (finalSlot !== null)
        inputRef.current.onCommit(finalBlock.length > 1 ? { source, keys: finalKeys, slot: finalSlot, block: finalBlock } : { source, keys: finalKeys, slot: finalSlot })
    }
    const onMove = (moveEvent: MouseEvent): void => {
      point = { x: moveEvent.clientX, y: moveEvent.clientY }
      if (!dragging) {
        if (!hasCrossedReorderThreshold({ start, current: point })) return
        const measured = measureDrop({ list, source, point, candidates: null })
        const sourceElement = measured.sourceElement
        if (sourceElement === undefined) {
          finish({ commit: false })
          return
        }
        dragging = true
        document.body.classList.add('is-sidebar-reorder')
        list.classList.add('is-reorder-shifting')
        // 카드는 mousedown 을 막지 않았으니 문턱 전에 생긴 선택을 지운다.
        window.getSelection()?.removeAllRanges()
        // 사본은 원래 행이 투명해지기 전(아래 setState 의 다음 그리기 전)에 복제한다.
        preview = createDragPreview({ list, sourceElement, blockElements: measured.blockElements, source, grab: start, point })
        candidates = source.kind === 'repo' ? null : (inputRef.current.nestCandidates?.(key) ?? null)
        block = measured.block
        shownBlock = block.join('\n')
        setState({ source, indicatorY: null, block })
        frame = requestAnimationFrame(tick)
      }
      if (preview !== null) movePreview({ element: preview.element, point, offsetX: preview.offsetX, offsetY: preview.offsetY })
      update()
    }
    const onUp = (upEvent: MouseEvent): void => {
      released = true
      // 놓는 순간의 좌표·DOM 으로 다시 잰다 — 마지막 mousemove 뒤에 목록이 바뀌었어도 지금 화면 기준으로 놓는다(R1-03).
      if (dragging) {
        point = { x: upEvent.clientX, y: upEvent.clientY }
        update()
      }
      finish({ commit: true })
    }
    const onKeyDown = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape') return
      if (dragging) {
        // 앱의 다른 Escape 처리(모달 닫기 등)로 흘리지 않는다 — 이 키는 드래그 취소에 쓰였다.
        keyEvent.preventDefault()
        keyEvent.stopPropagation()
      }
      finish({ commit: false })
    }
    const onBlur = (): void => finish({ commit: false })

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    abortRef.current = () => finish({ commit: false })
  }, [])

  const onRepoMouseDown = useCallback(
    (handler: { event: React.MouseEvent; root: string }) => arm({ event: handler.event, source: { kind: 'repo', root: handler.root } }),
    [arm],
  )
  const onCardMouseDown = useCallback(
    (handler: { event: React.MouseEvent; repoRoot: string; path: string }) =>
      arm({ event: handler.event, source: { kind: 'card', repoRoot: handler.repoRoot, path: handler.path } }),
    [arm],
  )

  const onAllCardMouseDown = useCallback(
    (handler: { event: React.MouseEvent; path: string }) => arm({ event: handler.event, source: { kind: 'all-card', path: handler.path } }),
    [arm],
  )

  return { state, onRepoMouseDown, onCardMouseDown, onAllCardMouseDown }
}

/**
 * 드래그 직후의 click 하나를 삼킨다 — mouseup 뒤 click 이 헤더 접기·카드 선택을 또 부르지 않게(K3ⓐ).
 * 놓은 자리가 원래 요소 밖이면 click 이 안 올 수 있어 한 틱 뒤 스스로 내린다(네이티브 click 은 mouseup 직후 동기로 온다).
 */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent): void => {
    event.stopPropagation()
    event.preventDefault()
    window.removeEventListener('click', swallow, true)
  }
  window.addEventListener('click', swallow, true)
  window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}

/**
 * 취소된 드래그(Escape·blur 등)의 **그 버튼 해제**까지 기다렸다가 그 해제의 click 하나만 삼킨다(R1-02). 취소 뒤 늦게 놓은
 * 버튼이 헤더 접기·카드 선택으로 가지 않게. 해제가 창 밖에서 일어나 mouseup 이 안 오면 — 다음 mousedown 이나 버튼이
 * 떼어진 mousemove(`buttons` 의 왼쪽 비트 0)에서 기다림을 내린다. 이후의 정상 클릭은 삼키지 않는다.
 */
function swallowClickOfPendingRelease(): void {
  const stop = (): void => {
    document.removeEventListener('mouseup', onUp, true)
    document.removeEventListener('mousedown', stop, true)
    document.removeEventListener('mousemove', onMove, true)
  }
  const onUp = (event: MouseEvent): void => {
    if (event.button !== 0) return
    stop()
    swallowNextClick()
  }
  const onMove = (event: MouseEvent): void => {
    if ((event.buttons & 1) === 0) stop()
  }
  document.addEventListener('mouseup', onUp, true)
  document.addEventListener('mousedown', stop, true)
  document.addEventListener('mousemove', onMove, true)
}
