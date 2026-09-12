/// <reference types="vite/client" />
import type { CorralApi } from '../../shared/types.js'

/** 계측 프로브(term-read)가 읽는 xterm 버퍼 실물 스냅샷 — 읽기 전용 훅. */
type CorralTermProbe = {
  cellWidth: (text: string) => number | null
  read: () => {
    paneId: string
    cols: number
    rows: number
    cursorX: number
    cursorY: number
    cursorHidden: boolean | null
    lastSeq: number
    lines: string[]
    writes: Array<{ paneId: string; seq: number; at: number }>
    at: number
  }
}

declare global {
  interface Window {
    corral: CorralApi
    corralTermProbe?: CorralTermProbe
  }
}
