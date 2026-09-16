/// <reference types="vite/client" />
import type { CorralApi } from '../../shared/types.js'

/** 계측 프로브(term-read)가 읽는 xterm 버퍼 실물 스냅샷 — 읽기 전용 훅. */
type CorralTermProbe = {
  cellWidth: (text: string) => number | null
  /** R13-a — 살아 있는 xterm 의 셀 px 과 오프스크린 측정치. 둘이 다르면 격자가 통째로 어긋난다. */
  cell: () => { live: { width: number; height: number } | null; measured: { width: number; height: number } | null }
  /** L2 — DECRQM 질의를 xterm 에 먹이고 그 DECRPM 응답 문자열을 돌려준다 (#5800 우회 직접 관측). */
  decrqm: (mode: number) => Promise<string>
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
    inputs: Array<{ data: string; at: number }>
    at: number
  }
}

declare global {
  interface Window {
    corral: CorralApi
    corralTermProbe?: CorralTermProbe
  }
}
