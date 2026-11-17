// 영역 배치를 화면에 편다 (LIFE-373 ① · 핸드오프 §2 PaneGrid).
//
// 트리를 flex 로 편다: 분할 마디 하나가 `flex-direction: row|column` 컨테이너 하나, 리프가
// 영역 하나. 비율은 `flex-grow` 가 아니라 **`flex-basis: N%`** 로 준다 — grow 는 내용 크기가
// 섞여 들어와 같은 비율이 창 크기마다 다른 px 이 된다. 격자는 상자 px 이 정하므로(R13)
// 그 상자가 비율대로 정확해야 한다.
//
// 경계선(GroupDivider)은 **탭바를 관통**한다(§1-0) — 분할 마디의 자식 사이에 그으므로 영역
// 상자의 top~bottom 을 전부 지난다. pane 경계선은 탭바 아래에서 시작하고, 그건 ② 의 것이다.

import { useCallback, useEffect, useRef, useState } from 'react'
import { RATIO_MAX, RATIO_MIN, splitIdOf, type GroupNode, type TabGroup } from '../group-tree.js'
import { snapSplitRatio, type CellSize } from '../term-metrics.js'

export type GroupDragCommit = (input: { splitId: string; ratio: number }) => void

/**
 * 드래그 중인 경계 — 고스트만 그리고 **mouseup 에 1회 커밋**한다 (F1-2).
 *
 * `leaf` 는 그 쪽이 **영역 하나인가**다. 중첩 분할이면 그 쪽의 셀 수는 의미가 없어서 배지에
 * 숫자 대신 `—` 를 보인다 — 없는 숫자를 지어내지 않는다.
 */
type DragState = {
  splitId: string
  direction: 'row' | 'column'
  ratio: number
  first: number
  second: number
  leaf: { first: boolean; second: boolean }
}

/**
 * 분할 상자 안에서 **터미널이 아닌 부분** px 을 양쪽에서 잰다 (셀 스냅의 분모 보정).
 *
 * 세로 분할이면 각 쪽에 탭바가 얹혀 있어 상자 높이 ≠ 터미널 높이다. 상수로 적지 않고 DOM 에서
 * 재는 이유는 헤더 높이 토큰이 바뀌면 상수가 조용히 어긋나기 때문이다. 터미널 상자가 아직
 * 없으면(빈 영역) 0 으로 둔다 — 그 쪽은 격자를 요청하지도 않는다.
 *
 * ⚠ **바로 아래 자식이 영역일 때만** 잰다. 그 쪽이 또 분할이면(⌘⌥D 두 번) 안쪽 터미널 상자는
 * 그 쪽 전체가 아니라 **일부**라, 깊이 훑어 찾으면 형제 폭만큼을 "터미널이 아닌 부분"으로
 * 세어 버린다. 배지가 거짓말을 하고 스냅도 엉뚱한 자리에 선다. 중첩된 쪽은 0 으로 둔다 —
 * 그 안의 경계는 자기 분할 상자 기준으로 따로 잰다.
 */
function overheadOf(input: { box: HTMLElement; direction: 'row' | 'column' }): SideMetrics {
  const sides = input.box.querySelectorAll(':scope > .group-split-side')
  const axis = (side: Element | undefined): { overhead: number; leaf: boolean } => {
    if (!(side instanceof HTMLElement)) return { overhead: 0, leaf: false }
    const group = side.querySelector(':scope > .tab-group')
    if (!(group instanceof HTMLElement)) return { overhead: 0, leaf: false }
    // **격자의 분모와 같은 상자**를 재야 한다 (`[data-term-box]`). `.term-group` 은 패딩을
    // 포함하므로 그걸 재면 오버헤드가 패딩만큼 모자라고, 스냅이 그만큼 어긋난다.
    const term = group.querySelector(':scope > .term-group > [data-term-box]')
    if (!(term instanceof HTMLElement)) return { overhead: 0, leaf: false }
    const sideBox = side.getBoundingClientRect()
    const termBox = term.getBoundingClientRect()
    return {
      overhead: Math.max(0, input.direction === 'row' ? sideBox.width - termBox.width : sideBox.height - termBox.height),
      leaf: true,
    }
  }
  const first = axis(sides[0])
  const second = axis(sides[1])
  return { overhead: { first: first.overhead, second: second.overhead }, leaf: { first: first.leaf, second: second.leaf } }
}

type SideMetrics = { overhead: { first: number; second: number }; leaf: { first: boolean; second: boolean } }

export function PaneGrid({
  root,
  cell,
  renderGroup,
  onCommitRatio,
  onResetRun,
  maximizedGroupId,
}: {
  root: GroupNode
  /** 셀 한 칸 px — 경계를 셀에 붙이는 데 쓴다 (F1-2). */
  cell: CellSize
  renderGroup: (group: TabGroup) => React.JSX.Element
  onCommitRatio: GroupDragCommit
  /** LIFE-825 C2 — 경계 더블클릭: 그 경계를 가진 같은 방향 줄을 고르게. */
  onResetRun: (splitId: string) => void
  /**
   * LIFE-825 C4 — 최대화된 영역. 그 영역 상자만 격자 전체를 덮고(`.tab-group.is-maximized` 절대 배치) 나머지 영역·경계는 `visibility: hidden` —
   * 숨은 영역 상자의 크기는 그대로라 격자 요청이 안 나간다(display:none·0 크기면 cols 2·rows 1 이 나간다 — 설정 페이지 덮기와 같은 이유).
   */
  maximizedGroupId: string | null
}): React.JSX.Element {
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  /**
   * 드래그는 **문서에 건다** — 커서가 경계선을 벗어나도 따라와야 하고, 터미널 위를 지날 때
   * xterm 이 마우스를 가로채지 않게 해야 한다(`.is-group-drag` 가 pointer-events 를 끈다).
   */
  const beginDrag = useCallback(
    (input: { splitId: string; direction: 'row' | 'column'; box: DOMRect; ratio: number; metrics: SideMetrics }) => {
      const row = input.direction === 'row'
      const total = Math.max(1, row ? input.box.width : input.box.height)
      const unit = Math.max(1, row ? cell.width : cell.height)
      // 격자 산식의 바닥과 같은 수를 쓴다 (`gridForBox`: 가로 2 · 세로 1).
      const common = { total, unit, minCells: row ? 2 : 1, clamp: { min: RATIO_MIN, max: RATIO_MAX } }
      const leaf = input.metrics.leaf
      const head = { splitId: input.splitId, direction: input.direction, leaf }
      /**
       * **영역 하나인 쪽**에 셀을 맞춘다. 반 칸 비켜서는 보정(`snapSplitRatio`)은 첫 쪽 기준이라,
       * 첫 쪽이 중첩 분할이면 좌우를 뒤집어 재고 결과를 되돌린다 — 안 그러면 리프인 둘째 쪽이
       * 다시 한 칸씩 어긋난다(배지 54, 화면 53 과 같은 사고). 양쪽 다 중첩이면 붙일 셀이 없다.
       */
      const snap = (wanted: number): DragState => {
        if (leaf.first) return { ...head, ...snapSplitRatio({ ...common, wanted, overhead: input.metrics.overhead }) }
        if (leaf.second) {
          const mirrored = snapSplitRatio({
            ...common,
            wanted: total - wanted,
            overhead: { first: input.metrics.overhead.second, second: input.metrics.overhead.first },
          })
          return { ...head, ratio: 1 - mirrored.ratio, first: mirrored.second, second: mirrored.first }
        }
        return { ...head, ratio: Math.min(Math.max(wanted / total, RATIO_MIN), RATIO_MAX), first: 0, second: 0 }
      }
      setDrag(snap(total * input.ratio))
      document.body.classList.add('is-group-drag')
      const onMove = (event: MouseEvent): void => {
        setDrag(snap(row ? event.clientX - input.box.left : event.clientY - input.box.top))
      }
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.classList.remove('is-group-drag')
        const last = dragRef.current
        setDrag(null)
        // **여기서 딱 한 번** 커밋한다 — 드래그 중에는 격자 요청이 한 번도 안 나간다 (F1-2·S3).
        if (last !== null) onCommitRatio({ splitId: last.splitId, ratio: last.ratio })
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [onCommitRatio, cell.width, cell.height],
  )

  useEffect(() => () => document.body.classList.remove('is-group-drag'), [])

  return (
    <div className={`pane-grid${maximizedGroupId === null ? '' : ' has-maximized'}`} data-pane-grid data-maximized-group={maximizedGroupId ?? undefined}>
      <GridNode node={root} renderGroup={renderGroup} drag={drag} beginDrag={beginDrag} onResetRun={onResetRun} />
    </div>
  )
}

/** 고스트·배지. 배지는 **셀 수**를 보인다 — 비율 %(는) 화면에 서는 격자와 한 칸씩 어긋난다. */
function DragGhost({ drag }: { drag: DragState }): React.JSX.Element {
  const at = `${(drag.ratio * 100).toFixed(4)}%`
  const place = drag.direction === 'row' ? { left: at } : { top: at }
  const unit = drag.direction === 'row' ? 'cols' : 'rows'
  // 중첩된 쪽은 셀 수가 없다 — 지어내는 대신 `—` 다.
  const show = (cells: number, leaf: boolean): string => (leaf ? String(cells) : '—')
  return (
    <>
      <div className={`group-divider-ghost dir-${drag.direction}`} style={place} />
      <div className={`group-divider-badge dir-${drag.direction}`} data-group-divider-badge={drag.splitId} style={place}>
        {show(drag.first, drag.leaf.first)} · {show(drag.second, drag.leaf.second)} {unit}
      </div>
    </>
  )
}

type BeginDrag = (input: { splitId: string; direction: 'row' | 'column'; box: DOMRect; ratio: number; metrics: SideMetrics }) => void

function GridNode({
  node,
  renderGroup,
  drag,
  beginDrag,
  onResetRun,
}: {
  node: GroupNode
  renderGroup: (group: TabGroup) => React.JSX.Element
  drag: DragState | null
  beginDrag: BeginDrag
  onResetRun: (splitId: string) => void
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  switch (node.kind) {
    case 'leaf':
      return renderGroup(node.group)
    case 'split': {
      const splitId = splitIdOf(node)
      const dragging = drag !== null && drag.splitId === splitId
      // 드래그 중에도 **실제 비율은 안 바꾼다** — 고스트만 움직인다 (F1-2).
      const percent = `${(node.ratio * 100).toFixed(4)}%`
      return (
        <div className={`group-split dir-${node.direction}`} data-group-split={splitId} ref={boxRef}>
          <div className="group-split-side" style={{ flexBasis: percent }}>
            <GridNode node={node.first} renderGroup={renderGroup} drag={drag} beginDrag={beginDrag} onResetRun={onResetRun} />
          </div>
          <div
            className={`group-divider dir-${node.direction} ${dragging ? 'is-dragging' : ''}`}
            data-group-divider={splitId}
            onMouseDown={(event) => {
              event.preventDefault()
              // LIFE-825 C2(fix1 B6) — 더블클릭의 둘째 누름은 드래그를 걸지 않는다: 걸면 리셋 직전에 고스트·셀 배지가 한 번 뜨고 mouseup 이 셀 스냅된
              // 옛 비율을 한 번 더 커밋한다(저장 1회 + 격자 요청 1회 — 바로 뒤 리셋이 덮지만 헛일). 리셋은 `onDoubleClick` 이 한다(mouseup 뒤라 늘 마지막).
              if (event.detail >= 2) return
              const element = boxRef.current
              if (element === null) return
              beginDrag({
                splitId,
                direction: node.direction,
                box: element.getBoundingClientRect(),
                ratio: node.ratio,
                metrics: overheadOf({ box: element, direction: node.direction }),
              })
            }}
            onDoubleClick={(event) => {
              event.preventDefault()
              onResetRun(splitId)
            }}
          >
            <div className="group-divider-line" />
          </div>
          <div className="group-split-side" style={{ flexBasis: `${(100 - node.ratio * 100).toFixed(4)}%` }}>
            <GridNode node={node.second} renderGroup={renderGroup} drag={drag} beginDrag={beginDrag} onResetRun={onResetRun} />
          </div>
          {/* 고스트·배지는 **분할 상자 기준**이다 — 12px 히트 띠 안에 두면 끌어도 안 따라온다. */}
          {dragging && drag !== null ? <DragGhost drag={drag} /> : null}
        </div>
      )
    }
  }
}
