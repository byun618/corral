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
import { clampRatio, splitIdOf, type GroupNode, type TabGroup } from '../group-tree.js'

export type GroupDragCommit = (input: { splitId: string; ratio: number }) => void

/** 드래그 중인 경계 — 고스트만 그리고 **mouseup 에 1회 커밋**한다 (F1-2). */
type DragState = { splitId: string; direction: 'row' | 'column'; ratio: number }

export function PaneGrid({
  root,
  renderGroup,
  onCommitRatio,
}: {
  root: GroupNode
  renderGroup: (group: TabGroup) => React.JSX.Element
  onCommitRatio: GroupDragCommit
}): React.JSX.Element {
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  /**
   * 드래그는 **문서에 건다** — 커서가 경계선을 벗어나도 따라와야 하고, 터미널 위를 지날 때
   * xterm 이 마우스를 가로채지 않게 해야 한다(`.is-group-drag` 가 pointer-events 를 끈다).
   */
  const beginDrag = useCallback(
    (input: { splitId: string; direction: 'row' | 'column'; box: DOMRect; ratio: number }) => {
      const start: DragState = { splitId: input.splitId, direction: input.direction, ratio: input.ratio }
      setDrag(start)
      document.body.classList.add('is-group-drag')
      const onMove = (event: MouseEvent): void => {
        const ratio =
          input.direction === 'row'
            ? (event.clientX - input.box.left) / Math.max(1, input.box.width)
            : (event.clientY - input.box.top) / Math.max(1, input.box.height)
        setDrag({ ...start, ratio: clampRatio(ratio) })
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
    [onCommitRatio],
  )

  useEffect(() => () => document.body.classList.remove('is-group-drag'), [])

  return (
    <div className="pane-grid" data-pane-grid>
      <GridNode node={root} renderGroup={renderGroup} drag={drag} beginDrag={beginDrag} />
    </div>
  )
}

function DragGhost({
  splitId,
  direction,
  ratio,
}: {
  splitId: string
  direction: 'row' | 'column'
  ratio: number
}): React.JSX.Element {
  const at = `${(ratio * 100).toFixed(4)}%`
  const place = direction === 'row' ? { left: at } : { top: at }
  return (
    <>
      <div className={`group-divider-ghost dir-${direction}`} style={place} />
      <div className={`group-divider-badge dir-${direction}`} data-group-divider-badge={splitId} style={place}>
        {Math.round(ratio * 100)}%
      </div>
    </>
  )
}

function GridNode({
  node,
  renderGroup,
  drag,
  beginDrag,
}: {
  node: GroupNode
  renderGroup: (group: TabGroup) => React.JSX.Element
  drag: DragState | null
  beginDrag: (input: { splitId: string; direction: 'row' | 'column'; box: DOMRect; ratio: number }) => void
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
            <GridNode node={node.first} renderGroup={renderGroup} drag={drag} beginDrag={beginDrag} />
          </div>
          <div
            className={`group-divider dir-${node.direction} ${dragging ? 'is-dragging' : ''}`}
            data-group-divider={splitId}
            onMouseDown={(event) => {
              event.preventDefault()
              const box = boxRef.current?.getBoundingClientRect()
              if (box === undefined) return
              beginDrag({ splitId, direction: node.direction, box, ratio: node.ratio })
            }}
          >
            <div className="group-divider-line" />
          </div>
          <div className="group-split-side" style={{ flexBasis: `${(100 - node.ratio * 100).toFixed(4)}%` }}>
            <GridNode node={node.second} renderGroup={renderGroup} drag={drag} beginDrag={beginDrag} />
          </div>
          {/* 고스트·배지는 **분할 상자 기준**이다 — 12px 히트 띠 안에 두면 끌어도 안 따라온다. */}
          {dragging && drag !== null ? <DragGhost splitId={splitId} direction={node.direction} ratio={drag.ratio} /> : null}
        </div>
      )
    }
  }
}
