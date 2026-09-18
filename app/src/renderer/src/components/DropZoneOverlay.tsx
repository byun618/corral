// 탭 드래그 시각 피드백 (LIFE-387 A1 · design-handoff.md §2 DropZoneOverlay·TabDrag).
//
// 고스트(=탭 칩, "얼굴")와 존 강조(=칠, "선") 를 **다른 모양**으로 낸다(핸드오프 §1 Q5) — 리사이즈
// 고스트(`PaneGrid.DragGhost`, 얇은 선+배지)와 헷갈리면 "지금 뭘 끄는 중인가"가 흐려진다.
//
// 판정(`DropTarget`)은 이미 끝나 왔다 — 여기는 그 결과가 가리키는 사각형만 그린다.

import { DROPZONE_BAND } from '../tab-drag.js'
import type { TabDragState } from '../hooks/useTabDrag.js'

function edgeBandStyle(bodyRect: DOMRect, zone: 'left' | 'right' | 'up' | 'down'): React.CSSProperties {
  const band = DROPZONE_BAND
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

/** 존 강조 — split 은 가장자리 띠, merge 는 본문 전체, tabbar 는 삽입선, invalid/self-noop 은 없음. */
function DropZoneFill({ state }: { state: TabDragState }): React.JSX.Element | null {
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
      return null
  }
}

/** 드래그 중인 탭 자신 — 커서를 따라간다("얼굴"). */
export function DropZoneOverlay({ state, tabLabel }: { state: TabDragState; tabLabel: string }): React.JSX.Element {
  return (
    <div className="drop-zone-overlay" data-drop-zone-overlay aria-hidden="true">
      <DropZoneFill state={state} />
      <div className="tab-drag-ghost" data-tab-drag-ghost style={{ left: state.point.x + 12, top: state.point.y + 12 }}>
        {tabLabel}
      </div>
    </div>
  )
}
