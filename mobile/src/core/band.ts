// 연결 상태 → 화면 표시(띠·앱 바 둘째 줄). 순수 함수 — 단위 시험 대상(P5ⓐ).
import type { ConnState } from './connection'

/** design-handoff §3 --m-reconnect-grace-ms — 재연결 중 띠는 3초 넘을 때만. */
export const RECONNECT_GRACE_MS = 3_000

export type BandView =
  | { kind: 'none' }
  | { kind: 'reconnecting'; since: number | null }
  | { kind: 'offline'; since: number | null }
  | { kind: 'mismatch' }

/** 상태 → 띠. 3초 유예는 `now` 로 판단한다(순수 — 단위 시험 대상). */
export function bandFor(conn: ConnState, now: number): BandView {
  switch (conn.kind) {
    case 'loading':
    case 'unpaired':
    case 'connected':
      return { kind: 'none' }
    case 'checking':
      return now - conn.since < RECONNECT_GRACE_MS ? { kind: 'none' } : { kind: 'reconnecting', since: conn.lastConnectedAt }
    case 'reconnecting':
      if (conn.offline) return { kind: 'offline', since: conn.lastConnectedAt }
      return now - conn.since < RECONNECT_GRACE_MS ? { kind: 'none' } : { kind: 'reconnecting', since: conn.lastConnectedAt }
    case 'mismatch':
      return { kind: 'mismatch' }
  }
}

/** 앱 바 둘째 줄 — 「연결됨」 은 최근 프로브 성공(conn.kind === 'connected') 위에서만. */
export function statusLine(conn: ConnState, macName: string): { text: string; tone: 'ok' | 'muted' | 'error' } {
  switch (conn.kind) {
    case 'connected':
      return { text: `${macName} · 연결됨`, tone: 'ok' }
    case 'checking':
      return { text: `${macName} · 연결 확인 중`, tone: 'muted' }
    case 'reconnecting':
      return conn.offline ? { text: `${macName} · 끊김`, tone: 'error' } : { text: `${macName} · 재연결 중`, tone: 'muted' }
    case 'mismatch':
      return { text: `${macName} · 버전 불일치`, tone: 'error' }
    case 'loading':
    case 'unpaired':
      return { text: macName, tone: 'muted' }
  }
}
