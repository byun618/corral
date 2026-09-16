// 탭 하나 안의 pane 들을 영역 상자에 편다 (LIFE-373 ②).
//
// **기하의 주인은 herdr 다.** 이 파일은 `pane.layout` 이 서피스로 실어 준 셀 사각형에 바닥 셀
// px 을 곱할 뿐, 픽셀에서 칸 수를 되짚지 않는다 (§10-R13: `herdr rect → DOM` 이 진실 방향).
// 그래서 ① 의 영역 경계가 쓰는 `parseInt` 절삭 보정(반 칸 비켜서기)이 **여기엔 없다** — 손실이
// 생기는 방향이 반대다. 여기서 지킬 것은 **배지가 말한 칸 수 == 커밋 뒤 `pane.layout`** 이다.
//
// 좌표 원점은 **내용의 왼쪽 위 모서리**다 — 서피스의 (0,0) 이 아니다.
//
// pane 메타 행(R17-1)은 **여기 없다**. herdr 장식 링이 상자 밖으로 나가 잘리므로 바깥 줄 pane 은
// 그 행이 화면에 안 선다 — 2분할에서는 하나도 안 보였다(실측). "추가 픽셀 0" 이라는 전제가
// 거짓이었다는 뜻이라 코디네이터가 R17-1 을 철회했다(§10-R21-1a). pane 식별은 **힌트줄 스트립**,
// 격자 수는 **영역 헤더**가 진다.
//
// herdr 서피스는 영역 상자보다 크다: main 이 가장자리 장식(`edgeWaste`)만큼 격자를 늘려 요청해서
// **안쪽 사각형들의 합집합이 정확히 상자 격자**가 되게 맞춰 놓는다(`group-session.learnEdgeWaste`).
// 그래서 `min(innerRect)` 을 원점으로 잡고 거기서 셀을 곱한다. 바깥 사각형은 그 원점보다 왼쪽·
// 위로, 또 오른쪽·아래로 장식 칸만큼 삐져나가는데 **잘라 낸다**(`.term-pane-stack` overflow).
// 삐져나간 부분을 상자에 맞춰 눌러 담으면 그 pane 의 내용이 장식 칸 수만큼 좁아진다 —
// 실측에서 마지막 pane 이 64칸이어야 하는데 486px(≈62칸) 상자를 받았다.
//
// 상자는 전부 **셀 배수 px** 이다. 이웃한 두 pane 이 같은 수(경계 칸)를 쓰므로 틈도 겹침도 없다.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaneDirection, PaneRow, TerminalCellRect, TerminalPaneView } from '../../../shared/types.js'
import { firstCellsOf, innerCellsOf, seamsOf, snapPaneSeam, type PaneSeam } from '../pane-geometry.js'
import { TerminalPane } from '../TerminalPane.js'
import type { CellSize } from '../term-metrics.js'

export type PaneResizeCommit = (input: { paneId: string; direction: PaneDirection; amount: number }) => void

export type PaneSeat = {
  view: TerminalPaneView
  /** 같은 pane 의 목록 행 — 종류의 출처다 (rect 쪽에는 없다). */
  row: PaneRow | null
  /** 탭 안 순번 (1-기반). 메타 행의 `{n}`. */
  number: number
}

type Placement = { left: string; top: string; width: string; height: string }

/** 내용의 왼쪽 위 모서리 — 모든 상자가 여기서 센다 (위 주석). */
export type PaneOrigin = { x: number; y: number }

/** 안쪽 사각형들의 왼쪽 위 모서리. 비어 있으면 서피스 원점 그대로. */
function originOf(seats: PaneSeat[]): PaneOrigin {
  if (seats.length === 0) return { x: 0, y: 0 }
  return {
    x: Math.min(...seats.map((seat) => seat.view.innerRect.x)),
    y: Math.min(...seats.map((seat) => seat.view.innerRect.y)),
  }
}

/** 셀 사각형 → 상자 px. 원점보다 앞서면 음수 — 잘려 나갈 장식 칸이다. */
function placeOf(input: { rect: TerminalCellRect; cell: CellSize; origin: PaneOrigin }): Placement {
  const { rect, cell, origin } = input
  return {
    left: `${(rect.x - origin.x) * cell.width}px`,
    top: `${(rect.y - origin.y) * cell.height}px`,
    width: `${rect.width * cell.width}px`,
    height: `${rect.height * cell.height}px`,
  }
}

/**
 * pane 하나의 바깥·안쪽 상자.
 *
 * ⚠ 안쪽 상자는 **바깥 상자 기준**이다 — `.term-pane-inner` 가 `.term-pane` 안에 있으므로
 * 격자 원점 기준 좌표를 그대로 넣으면 형제 폭만큼 밀려 화면 밖으로 나간다(실측: pG 의 안쪽
 * 상자가 x=1103px·폭 0 이었다). 그래서 `innerRect − rect` 로만 만든다. 바깥이 `100%` 로 붙는
 * 쪽이어도 `calc(100% − 장식)` 이면 따라간다.
 *
 * 줌 중에는 **서버 rect 가 안 바뀐다**(F2-3). 대신 영역이 역산 격자를 요청해서 그 pane 의 rect 가
 * 상자 하나를 채우는 크기가 된다 — 그래서 바깥 상자만 통째로 주고, 안쪽은 같은 식을 쓴다.
 */
function geometryOf(input: { view: TerminalPaneView; cell: CellSize; origin: PaneOrigin; zoomed: boolean }): {
  outer: Placement
  inner: Placement
} {
  const { view, cell, origin, zoomed } = input
  const outer = zoomed ? { left: '0px', top: '0px', width: '100%', height: '100%' } : placeOf({ rect: view.rect, cell, origin })
  const left = (view.innerRect.x - view.rect.x) * cell.width
  const top = (view.innerRect.y - view.rect.y) * cell.height
  const trimX = (view.rect.width - view.innerRect.width) * cell.width
  const trimY = (view.rect.height - view.innerRect.height) * cell.height
  return {
    outer,
    inner: { left: `${left}px`, top: `${top}px`, width: `calc(100% - ${trimX}px)`, height: `calc(100% - ${trimY}px)` },
  }
}

/**
 * 끄는 중인 pane 경계 — 고스트·배지만 움직이고 **mouseup 에 `pane.resize` 1회**다 (F2-2).
 *
 * 끄는 동안 서버에 아무것도 안 보내므로 `resize request` 도 `stream.sync` 도 0 이어야 한다.
 * `cells` 는 **커밋 뒤 그 쪽 상자가 받을 칸 수**다 — 겨눈 수가 아니라 도달 구간에 갇힌 수라,
 * 배지가 말한 수와 커밋 결과가 갈릴 자리가 없다.
 */
type SeamDrag = { seam: PaneSeam; cells: { first: number; second: number } }

/** 경계선(1px + 12px 히트). 상자는 셀 배수라 선은 두 pane rect 경계에 정확히 선다. */
function PaneDivider({
  seam,
  cell,
  origin,
  dragging,
  onGrab,
}: {
  seam: PaneSeam
  cell: CellSize
  origin: PaneOrigin
  dragging: boolean
  onGrab: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const row = seam.direction === 'row'
  const unit = row ? cell.width : cell.height
  const crossUnit = row ? cell.height : cell.width
  const at = (seam.at - (row ? origin.x : origin.y)) * unit
  const from = (seam.band.start - (row ? origin.y : origin.x)) * crossUnit
  const length = (seam.band.end - seam.band.start) * crossUnit
  const place = row ? { left: at, top: from, height: length } : { top: at, left: from, width: length }
  return (
    <div
      className={`pane-divider dir-${seam.direction} ${dragging ? 'is-dragging' : ''}`}
      data-pane-divider={seam.id}
      style={place}
      onMouseDown={onGrab}
    >
      <div className="pane-divider-line" />
    </div>
  )
}

/** 고스트·배지. 배지는 **내용 칸 수**다 — 메타 행이 보이는 것과 같은 수. */
function SeamGhost({
  drag,
  panes,
  cell,
  origin,
}: {
  drag: SeamDrag
  panes: TerminalPaneView[]
  cell: CellSize
  origin: PaneOrigin
}): React.JSX.Element {
  const { seam, cells } = drag
  const row = seam.direction === 'row'
  const unit = row ? cell.width : cell.height
  const crossUnit = row ? cell.height : cell.width
  const at = (seam.start + cells.first - (row ? origin.x : origin.y)) * unit
  const from = (seam.band.start - (row ? origin.y : origin.x)) * crossUnit
  const length = (seam.band.end - seam.band.start) * crossUnit
  const line = row ? { left: at, top: from, height: length } : { top: at, left: from, width: length }
  const badge = row ? { left: at, top: from + length / 2 } : { top: at, left: from + length / 2 }
  const show = (paneId: string, blockNow: number, want: number): string => {
    const pane = panes.find((view) => view.paneId === paneId)
    if (pane === undefined) return '—'
    const inner = innerCellsOf({ pane, direction: seam.direction, blockNow, cells: want })
    // 그 쪽 상자 안이 또 쪼개져 있으면 셀 수가 그 pane 의 것이 아니다 — 지어내지 않는다 (①).
    return inner === null ? '—' : String(inner)
  }
  const now = firstCellsOf(seam)
  return (
    <>
      <div className={`pane-divider-ghost dir-${seam.direction}`} style={line} />
      <div className={`pane-divider-badge dir-${seam.direction}`} data-pane-divider-badge={seam.id} style={badge}>
        {show(seam.first, now, cells.first)} · {show(seam.second, seam.span - now, cells.second)} {row ? 'cols' : 'rows'}
      </div>
    </>
  )
}

export function PaneLayout({
  seats,
  cell,
  zoomedPaneId,
  selectedPaneId,
  focusable,
  focusToken,
  diagnostics,
  onSelect,
  onCommitResize,
}: {
  seats: PaneSeat[]
  cell: CellSize
  zoomedPaneId: string | null
  selectedPaneId: string | null
  /** 이 영역이 활성인가 — DOM 포커스를 가져가도 되는 pane 은 활성 영역의 선택 pane 뿐이다 (①). */
  focusable: boolean
  focusToken: number
  diagnostics: boolean
  onSelect: (paneId: string) => void
  onCommitResize: PaneResizeCommit
}): React.JSX.Element {
  const origin = originOf(seats)
  const views = seats.map((seat) => seat.view)
  // 줌 중에는 경계를 안 그린다 — 보이는 pane 이 하나뿐이라 끌 경계가 없다.
  const seams = zoomedPaneId === null ? seamsOf(views) : []
  const { drag, beginDrag } = useSeamDrag({ cell, onCommitResize })
  return (
    <>
      {seats.map((seat) => {
        const zoomed = zoomedPaneId === seat.view.paneId
        const { outer, inner } = geometryOf({ view: seat.view, cell, origin, zoomed })
        const selected = selectedPaneId === seat.view.paneId
        // 줌 중에는 나머지를 **감추되 마운트는 유지**한다. 다시 만들면 xterm 과 쓰기 링이 통째로
        // 날아가는데, 서버 rect 가 그대로라 프레임은 계속 온다 — 껐다 켤 이유가 없다.
        const hidden = zoomedPaneId !== null && !zoomed
        return (
          <div
            key={seat.view.paneId}
            className={`term-pane ${selected ? 'is-selected' : ''} ${zoomed ? 'is-zoomed' : ''}`}
            data-term-pane-box={seat.view.paneId}
            data-pane-selected={selected ? 'true' : 'false'}
            hidden={hidden}
            style={outer}
            onMouseDown={() => onSelect(seat.view.paneId)}
          >
            <div className="term-pane-inner" style={inner}>
              <TerminalPane
                paneId={seat.view.paneId}
                diagnostics={diagnostics}
                focusable={focusable && selected}
                focusToken={focusable && selected ? focusToken : 0}
                // **창 전체의 포커스 pane 일 때만** herdr 에 알린다 (S2-b).
                // `selected` 는 **영역 안**의 선택이라, 영역이 둘이면 두 pane 이 동시에 참이다.
                // 그것으로 알리면 활성 영역이 바뀐 순간(영역 클릭·worktree 복귀)에 두 pane 의
                // `selected` 가 그대로라 아무도 안 알리고, herdr 세션 포커스가 옛 영역에 남는다.
                announceFocus={focusable && selected}
              />
            </div>
          </div>
        )
      })}
      {seams.map((seam) => (
        <PaneDivider
          key={seam.id}
          seam={seam}
          cell={cell}
          origin={origin}
          dragging={drag !== null && drag.seam.id === seam.id}
          onGrab={(event) => beginDrag({ seam, event })}
        />
      ))}
      {drag === null ? null : <SeamGhost drag={drag} panes={views} cell={cell} origin={origin} />}
    </>
  )
}

/**
 * 경계 드래그 — ① 과 같은 모양이다. 문서에 걸어야 커서가 경계를 벗어나도 따라오고,
 * `.is-group-drag` 가 터미널의 `pointer-events` 를 꺼서 xterm 이 마우스를 안 가로챈다.
 */
function useSeamDrag(input: { cell: CellSize; onCommitResize: PaneResizeCommit }): {
  drag: SeamDrag | null
  beginDrag: (grab: { seam: PaneSeam; event: React.MouseEvent }) => void
} {
  const { cell, onCommitResize } = input
  const [drag, setDrag] = useState<SeamDrag | null>(null)
  const dragRef = useRef<SeamDrag | null>(null)
  dragRef.current = drag

  const beginDrag = useCallback(
    (grab: { seam: PaneSeam; event: React.MouseEvent }) => {
      grab.event.preventDefault()
      const { seam } = grab
      const row = seam.direction === 'row'
      const unit = Math.max(1, row ? cell.width : cell.height)
      // 경계의 화면 좌표 — 여기서 움직인 px 을 칸으로 환산한다. 상자가 셀 배수라 나누어떨어진다.
      const base = grab.event.currentTarget.getBoundingClientRect()
      const anchor = row ? base.left + base.width / 2 : base.top + base.height / 2
      const at = (wanted: number): SeamDrag => {
        const moved = Math.round((wanted - anchor) / unit)
        const snapped = snapPaneSeam({ seam, wantedFirstCells: firstCellsOf(seam) + moved })
        return { seam, cells: { first: snapped.firstCells, second: snapped.secondCells } }
      }
      setDrag(at(anchor))
      document.body.classList.add('is-group-drag')
      const onMove = (event: MouseEvent): void => setDrag(at(row ? event.clientX : event.clientY))
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.classList.remove('is-group-drag')
        const last = dragRef.current
        setDrag(null)
        if (last === null) return
        // **여기서 딱 한 번** 보낸다. 끄는 동안은 서버에 아무것도 안 갔다 (F2-2).
        const snapped = snapPaneSeam({ seam: last.seam, wantedFirstCells: last.cells.first })
        if (snapped.commit === null) return
        onCommitResize({ paneId: last.seam.first, ...snapped.commit })
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [cell.width, cell.height, onCommitResize],
  )

  useEffect(() => () => document.body.classList.remove('is-group-drag'), [])
  return { drag, beginDrag }
}

export const __test = { originOf, placeOf, geometryOf }
