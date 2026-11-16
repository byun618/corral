// 탐색기 파일 끌어서 열기 (LIFE-823 C1·C2) — 탐색기 끌기가 트리 밖으로 나가면 탭 끌기와 **같은 판정·오버레이**를 쓴다.
//
// 포인터는 탐색기가 본다(트리 안 이동 끌기·Esc·blur 취소가 이미 거기 있다) — 여기는 탐색기가 알려 주는 위치로 판정만 하고
// 놓을 때 1회 커밋한다(`useTabDrag` 와 같은 결). 판정은 `resolveDropTarget` 을 `source: file` 로 부른다.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DropTarget, Point } from '../tab-drag.js'
import { resolveDropTarget, type TabDragVisual } from './useTabDrag.js'

/** 탐색기가 알리는 끌기 — 트리 밖에서 움직임(`move`)·트리 밖에 놓음(`drop`)·끝(`end` — 트리 안으로 돌아옴·Esc·blur·취소). */
export type ExplorerDragEvent = { kind: 'move' | 'drop'; rel: string; isDir: boolean; point: Point } | { kind: 'end' }

/** 오버레이가 그릴 것 — `TabDragState` 와 같은 `point`·`visual` 을 든다(`DropZoneOverlay` 가 둘 다 그린다). */
export type FileDragState = { rel: string; isDir: boolean; point: Point; target: DropTarget; visual: TabDragVisual }

const BODY_CLASS = 'is-tab-drag'
const BLOCKED_CLASS = 'is-file-drag-blocked'

/** 판정 — 폴더는 어디 위든 무효(814 게이트 ⓪), 존 강조 없이 `blocked`. 파일은 탭 끌기와 같은 판정. */
function resolveFileDrop(input: { isDir: boolean; point: Point }): { target: DropTarget; visual: TabDragVisual } {
  if (input.isDir) return { target: { kind: 'invalid' }, visual: { kind: 'blocked' } }
  return resolveDropTarget({ point: input.point, source: { kind: 'file' } })
}

export function useFileDrag(input: { onDrop: (input: { rel: string; target: DropTarget }) => void }): {
  dragState: FileDragState | null
  onExplorerDrag: (event: ExplorerDragEvent) => void
} {
  const [dragState, setDragState] = useState<FileDragState | null>(null)
  const onDropRef = useRef(input.onDrop)
  onDropRef.current = input.onDrop

  const clearBody = (): void => {
    document.body.classList.remove(BODY_CLASS)
    document.body.classList.remove(BLOCKED_CLASS)
  }
  useEffect(() => clearBody, [])

  const onExplorerDrag = useCallback((event: ExplorerDragEvent): void => {
    switch (event.kind) {
      case 'move': {
        // 동기로 붙여 첫 판정이 dock(sticky) 풀린 사각형을 읽게 한다(탭 끌기와 같다 — styles.css).
        document.body.classList.add(BODY_CLASS)
        document.body.classList.toggle(BLOCKED_CLASS, event.isDir)
        const { target, visual } = resolveFileDrop(event)
        setDragState({ rel: event.rel, isDir: event.isDir, point: event.point, target, visual })
        return
      }
      case 'drop': {
        const { target } = resolveFileDrop(event)
        clearBody()
        setDragState(null)
        if (!event.isDir) onDropRef.current({ rel: event.rel, target })
        return
      }
      case 'end':
        clearBody()
        setDragState(null)
        return
    }
  }, [])

  return { dragState, onExplorerDrag }
}
