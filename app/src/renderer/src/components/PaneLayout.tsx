// 탭 하나 안의 pane 들을 영역 상자에 편다 (LIFE-373 ②).
//
// **기하의 주인은 herdr 다.** 이 파일은 `pane.layout` 이 서피스로 실어 준 셀 사각형에 바닥 셀
// px 을 곱할 뿐, 픽셀에서 칸 수를 되짚지 않는다 (§10-R13: `herdr rect → DOM` 이 진실 방향).
// 그래서 ① 의 영역 경계가 쓰는 `parseInt` 절삭 보정(반 칸 비켜서기)이 **여기엔 없다** — 손실이
// 생기는 방향이 반대다. 여기서 지킬 것은 **배지가 말한 칸 수 == 커밋 뒤 `pane.layout`** 이다.
//
// 좌표 원점은 **내용의 왼쪽 위 모서리**다 — 서피스의 (0,0) 이 아니다.
//
// herdr 서피스는 영역 상자보다 크다: main 이 가장자리 장식(`edgeWaste`)만큼 격자를 늘려 요청해서
// **안쪽 사각형들의 합집합이 정확히 상자 격자**가 되게 맞춰 놓는다(`group-session.learnEdgeWaste`).
// 그래서 `min(innerRect)` 을 원점으로 잡고 거기서 셀을 곱한다. 바깥 사각형은 그 원점보다 왼쪽·
// 위로, 또 오른쪽·아래로 장식 칸만큼 삐져나가는데 **잘라 낸다**(`.term-pane-stack` overflow).
// 삐져나간 부분을 상자에 맞춰 눌러 담으면 그 pane 의 내용이 장식 칸 수만큼 좁아진다 —
// 실측에서 마지막 pane 이 64칸이어야 하는데 486px(≈62칸) 상자를 받았다.
//
// 상자는 전부 **셀 배수 px** 이다. 이웃한 두 pane 이 같은 수(경계 칸)를 쓰므로 틈도 겹침도 없다.

import type { PaneRow, TerminalCellRect, TerminalPaneView } from '../../../shared/types.js'
import { AGENT_ICON, agentIcon } from '../session-glyphs.js'
import { TerminalPane } from '../TerminalPane.js'
import type { CellSize } from '../term-metrics.js'

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
  cell,
  zoomedPaneId,
  selectedPaneId,
  focusable,
  focusToken,
  diagnostics,
  onSelect,
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
}): React.JSX.Element {
  const decorated = seats.length > 1
  const origin = originOf(seats)
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

export const __test = { originOf, placeOf, geometryOf, kindLabel }
