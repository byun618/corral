// 탭 드래그 시각 피드백 (LIFE-387 A1 · design-handoff.md §2 DropZoneOverlay·TabDrag).
//
// 고스트(=탭 칩, "얼굴")와 존 강조(=칠, "선") 를 **다른 모양**으로 낸다(핸드오프 §1 Q5) — 리사이즈
// 고스트(`PaneGrid.DragGhost`, 얇은 선+배지)와 헷갈리면 "지금 뭘 끄는 중인가"가 흐려진다.
//
// 판정(`DropTarget`)은 이미 끝나 왔다 — 여기는 그 결과가 가리키는 사각형만 그린다.

import type { TabDragVisual } from '../hooks/useTabDrag.js'
import type { Point } from '../tab-drag.js'

/** 그릴 것 — 탭 끌기(`TabDragState`)·탐색기 파일 끌기(`FileDragState`, LIFE-823) 둘 다 이 모양을 든다. */
type OverlayState = { point: Point; visual: TabDragVisual }

/**
 * 미리보기 사각형 크기 — **판정 폭(`DROPZONE_BAND` 0.25, `tab-drag.ts` `resolveBodyZone`)과는
 * 다른 값이다.** 판정은 "포인터가 얼마나 가까이 가야 그 방향으로 잡히는가"(히트존)이고, 이건
 * "드롭하면 실제로 얼마를 차지하는가"(결과 미리보기)다. 핸드오프 §2 DropZoneOverlay: "본문
 * 가장자리 → 그 절반 사각(inset 6)" — 결과가 50:50 분할이니 미리보기도 50% 여야 한다. 이전엔
 * 이 값 자리에 `DROPZONE_BAND`(0.25)를 그대로 써서 미리보기가 실제 결과보다 훨씬 좁게 보였다
 * (게이트 ① 수정, 04-manual-check-notes.md §1).
 */
const PREVIEW_FRACTION = 0.5

function edgeBandStyle(bodyRect: DOMRect, zone: 'left' | 'right' | 'up' | 'down'): React.CSSProperties {
  const band = PREVIEW_FRACTION
  switch (zone) {
    case 'left':
      return { left: bodyRect.left, top: bodyRect.top, width: bodyRect.width * band, height: bodyRect.height }
    case 'right':
      return { left: bodyRect.left + bodyRect.width * (1 - band), top: bodyRect.top, width: bodyRect.width * band, height: bodyRect.height }
    case 'up':
      return { left: bodyRect.left, top: bodyRect.top, width: bodyRect.width, height: bodyRect.height * band }
    case 'down':
      return { left: bodyRect.left, top: bodyRect.top + bodyRect.height * (1 - band), width: bodyRect.width, height: bodyRect.height * band }
  }
}

function rectStyle(rect: DOMRect): React.CSSProperties {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

/** 존 강조 — split 은 가장자리 띠, merge 는 본문 전체, tabbar 는 삽입선, invalid 는 포인터 둘레, self-noop·blocked(폴더 — LIFE-823) 은 없음. */
function DropZoneFill({ state }: { state: OverlayState }): React.JSX.Element | null {
  const { visual } = state
  switch (visual.kind) {
    case 'split':
      return <div className="dropzone-fill" data-dropzone-fill style={edgeBandStyle(visual.bodyRect, visual.zone)} />
    case 'merge':
      return <div className={`dropzone-fill ${visual.empty ? 'is-empty' : ''}`} data-dropzone-fill style={rectStyle(visual.bodyRect)} />
    case 'tabbar':
      return (
        <div
          className="dropzone-tabbar-marker"
          data-dropzone-tabbar-marker
          style={{ left: visual.x, top: visual.headerRect.top, height: visual.headerRect.height }}
        />
      )
    case 'invalid':
      return <div className="dropzone-fill is-invalid" data-dropzone-fill style={{ left: state.point.x - 60, top: state.point.y - 20, width: 120, height: 40 }} />
    case 'self-noop':
    case 'blocked':
      return null
  }
}

/** 드래그 중인 탭 자신 — 커서를 따라간다("얼굴"). */
export function DropZoneOverlay({ state, tabLabel, tabColor = null }: { state: OverlayState; tabLabel: string; tabColor?: string | null }): React.JSX.Element {
  return (
    <div className="drop-zone-overlay" data-drop-zone-overlay aria-hidden="true">
      <DropZoneFill state={state} />
      <div className="tab-drag-ghost" data-tab-drag-ghost style={{ left: state.point.x + 12, top: state.point.y + 12 }}>
        {tabLabel}
        {/* LIFE-495 K4ⓑ — 탭 색 점은 드래그 고스트에도 따라온다(220 `tab-bar-item-surface.tsx:96`). */}
        {tabColor === null ? null : <span className="main-tab-color-dot" data-tab-drag-ghost-color={tabColor} style={{ backgroundColor: tabColor }} />}
      </div>
    </div>
  )
}
