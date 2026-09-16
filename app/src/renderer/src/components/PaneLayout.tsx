// 탭 하나 안의 pane 들을 영역 상자에 편다 (LIFE-373 ②).
//
// **기하의 주인은 herdr 다.** 이 파일은 `pane.layout` 이 서피스로 실어 준 셀 사각형에 바닥 셀
// px 을 곱할 뿐, 픽셀에서 칸 수를 되짚지 않는다 (§10-R13: `herdr rect → DOM` 이 진실 방향).
// 그래서 ① 의 영역 경계가 쓰는 `parseInt` 절삭 보정(반 칸 비켜서기)이 **여기엔 없다** — 손실이
// 생기는 방향이 반대다. 여기서 지킬 것은 **배지가 말한 칸 수 == 커밋 뒤 `pane.layout`** 이다.
//
// 상자를 px 이 아니라 **CSS 값**으로 만든다:
//   · 안쪽 경계는 셀 배수 px — 양쪽 pane 이 **같은 수**를 쓰므로 틈도 겹침도 안 생긴다
//     (pane 마다 폭을 따로 반올림하면 7.825px 셀에서 1px 이 샌다)
//   · 바깥 모서리는 `0` 과 `100%` — 격자는 `floor(상자/셀)` 이라 셀 배수가 상자보다 최대 한 칸
//     짧다. 그 나머지를 남기면 오른쪽·아래에 빈 띠가 보인다
// 덕분에 창이 바뀌어도 **React 가 상자를 다시 잴 필요가 없다** — CSS 가 100% 를 따라간다.

import type { PaneRow, TerminalCellRect, TerminalPaneView } from '../../../shared/types.js'
import { AGENT_ICON, agentIcon } from '../session-glyphs.js'
import { TerminalPane } from '../TerminalPane.js'
import type { CellSize, Grid } from '../term-metrics.js'

export type PaneSeat = {
  view: TerminalPaneView
  /** 같은 pane 의 목록 행 — 종류의 출처다 (rect 쪽에는 없다). */
  row: PaneRow | null
  /** 탭 안 순번 (1-기반). 메타 행의 `{n}`. */
  number: number
}

type Placement = { left: string; top: string; width: string; height: string }

/** 한 축의 시작·길이를 CSS 값으로. 끝이 격자 끝에 닿으면 `100%` 로 붙인다. */
function axis(input: { start: number; span: number; total: number; unit: number }): { offset: string; size: string } {
  const startPx = input.start <= 0 ? 0 : input.start * input.unit
  const offset = `${startPx}px`
  if (input.start + input.span >= input.total) return { offset, size: `calc(100% - ${startPx}px)` }
  return { offset, size: `${(input.start + input.span) * input.unit - startPx}px` }
}

/** 셀 사각형 → 상자. 안쪽 경계는 셀 배수, 바깥 모서리는 상자 끝. */
function placeOf(input: { rect: TerminalCellRect; cell: CellSize; grid: Grid }): Placement {
  const x = axis({ start: input.rect.x, span: input.rect.width, total: input.grid.cols, unit: input.cell.width })
  const y = axis({ start: input.rect.y, span: input.rect.height, total: input.grid.rows, unit: input.cell.height })
  return { left: x.offset, top: y.offset, width: x.size, height: y.size }
}

/**
 * pane 하나의 바깥·안쪽 상자.
 *
 * 줌 중에는 **서버 rect 가 안 바뀐다**(F2-3). 대신 영역이 역산 격자를 요청해서 그 pane 의 rect 가
 * 상자 하나를 채우는 크기가 된다 — 그래서 바깥 상자는 통째로 주고, 장식(rect − inner)만 셀 px 로
 * 깎는다. 장식 띠를 남겨야 메타 행이 터미널 내용 위에 겹치지 않는다.
 */
function geometryOf(input: { view: TerminalPaneView; cell: CellSize; grid: Grid; zoomed: boolean }): {
  outer: Placement
  inner: Placement
} {
  const { view, cell, grid, zoomed } = input
  if (!zoomed) {
    return { outer: placeOf({ rect: view.rect, cell, grid }), inner: placeOf({ rect: view.innerRect, cell, grid }) }
  }
  const left = (view.innerRect.x - view.rect.x) * cell.width
  const top = (view.innerRect.y - view.rect.y) * cell.height
  const trimX = (view.rect.width - view.innerRect.width) * cell.width
  const trimY = (view.rect.height - view.innerRect.height) * cell.height
  return {
    outer: { left: '0px', top: '0px', width: '100%', height: '100%' },
    inner: { left: `${left}px`, top: `${top}px`, width: `calc(100% - ${trimX}px)`, height: `calc(100% - ${trimY}px)` },
  }
}

/**
 * 종류 라벨 — corral 어휘로만 말한다 (herdr 타입을 렌더러로 흘리지 않는다, C1).
 * 필요한 것은 `agent` 한 칸뿐이라 `PaneRow` 전체를 요구하지 않는다.
 */
function kindLabel(row: { agent: string | null } | null): string {
  // 모르는 종류는 지어내지 않고 **셸**로 떨어뜨린다 — 탭바와 같은 표를 쓴다(라벨도 그 표의 것).
  return agentIcon(row?.agent ?? 'shell')?.label ?? AGENT_ICON.shell.label
}

/**
 * 장식 행에 얹는 pane 메타 (§10-R17-1). **추가 픽셀 0** — herdr 가 pane ≥ 2 에서 강제로 비우는
 * 상단 장식 행을 그대로 쓴다. 단일 pane 은 장식이 0 행이라 이 줄도 없다(C2 기하 불변).
 */
function PaneMeta({ seat, zoomed, cell }: { seat: PaneSeat; zoomed: boolean; cell: CellSize }): React.JSX.Element {
  const inner = seat.view.innerRect
  // 높이·왼쪽 들여쓰기는 **실측 셀**에서 나온다. 토큰(`--lh-term × --fs-term`)은 목업의 셀
  // 크기(20.4px)라 실제 xterm 셀(15px)과 다르다 — 그걸 쓰면 메타 행이 장식 행을 넘어 내용을 덮는다.
  const band = { left: (inner.x - seat.view.rect.x) * cell.width, height: (inner.y - seat.view.rect.y) * cell.height }
  if (band.height <= 0) return <></>
  return (
    <div className="term-pane-meta" data-term-pane-meta={seat.view.paneId} style={{ left: band.left, height: band.height }}>
      {zoomed ? '⤢ ' : ''}
      {seat.number} · {kindLabel(seat.row)} · {inner.width}×{inner.height}
    </div>
  )
}

export function PaneLayout({
  seats,
  grid,
  cell,
  zoomedPaneId,
  selectedPaneId,
  focusable,
  focusToken,
  diagnostics,
  onSelect,
}: {
  seats: PaneSeat[]
  /** 이 영역이 요청한 탭 격자 — 바깥 모서리를 상자 끝에 붙일지 판단하는 기준이다. */
  grid: Grid
  cell: CellSize
  zoomedPaneId: string | null
  selectedPaneId: string | null
  /** 이 영역이 활성인가 — DOM 포커스를 가져가도 되는 pane 은 활성 영역의 선택 pane 뿐이다 (①). */
  focusable: boolean
  focusToken: number
  diagnostics: boolean
  onSelect: (paneId: string) => void
}): React.JSX.Element {
  const decorated = seats.length > 1
  return (
    <>
      {seats.map((seat) => {
        const zoomed = zoomedPaneId === seat.view.paneId
        const { outer, inner } = geometryOf({ view: seat.view, cell, grid, zoomed })
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
            {decorated ? <PaneMeta seat={seat} zoomed={zoomed} cell={cell} /> : null}
            <div className="term-pane-inner" style={inner}>
              <TerminalPane
                paneId={seat.view.paneId}
                diagnostics={diagnostics}
                focusable={focusable && selected}
                focusToken={focusable && selected ? focusToken : 0}
                announceFocus={selected}
              />
            </div>
          </div>
        )
      })}
    </>
  )
}

export const __test = { axis, placeOf, geometryOf, kindLabel }
