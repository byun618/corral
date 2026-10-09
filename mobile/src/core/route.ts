// 어느 화면에 있든 A1(안내)으로 보내야 하는가 — 루트 레이아웃의 가드가 쓴다(순수 — 시험 대상, 리뷰 r1 R1-A5).
import type { ConnState } from './connection'

/** expo-router `useSegments()` 값. A1 은 `['pair']`(또는 `['pair','index']`). */
export function isIntro(segments: readonly string[]): boolean {
  return segments[0] === 'pair' && (segments.length === 1 || segments[1] === 'index')
}

/**
 * - 해지·인증 실패·사용자 해제(이유가 있는 `unpaired`)와 삭제 중·삭제 실패 → A1 이 아닌 모든 화면에서 A1 로. 페어링 화면(A3·A4)도 포함.
 * - 이유 없는 `unpaired`(첫 실행·새 페어링 진행 중) → 페어링 흐름 밖에서만 A1 로.
 */
export function shouldGoToIntro(conn: ConnState, segments: readonly string[]): boolean {
  if (segments.length === 0 || isIntro(segments)) return false
  switch (conn.kind) {
    case 'unpairing':
    case 'unpair_failed':
      return true
    case 'unpaired':
      return conn.reason !== null || segments[0] !== 'pair'
    case 'loading':
    case 'connected':
    case 'checking':
    case 'reconnecting':
    case 'mismatch':
      return false
  }
}
