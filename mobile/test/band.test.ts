// 연결 띠·앱 바 표시 (P5ⓐ) — 연결됨 띠 없음 · 재연결 중은 3초 넘을 때만 · 끊김 · 버전 불일치.
import { describe, expect, it } from 'vitest'
import { RECONNECT_GRACE_MS, bandFor, statusLine } from '../src/core/band'
import type { ConnState } from '../src/core/connection'

const T = 1_000_000

describe('bandFor', () => {
  it('연결됨 → 띠 없음', () => {
    expect(bandFor({ kind: 'connected', since: T, lastAliveAt: T }, T + 99_999)).toEqual({ kind: 'none' })
  })
  it('재연결 중 — 3초 미만 띠 없음, 3초부터 띠', () => {
    const conn: ConnState = { kind: 'reconnecting', since: T, lastConnectedAt: T - 5_000, attempt: 0, reason: 'network', offline: false }
    expect(bandFor(conn, T + RECONNECT_GRACE_MS - 1)).toEqual({ kind: 'none' })
    expect(bandFor(conn, T + RECONNECT_GRACE_MS)).toEqual({ kind: 'reconnecting', since: T - 5_000 })
  })
  it('확인 중(복귀 프로브)도 3초 유예', () => {
    const conn: ConnState = { kind: 'checking', since: T, lastConnectedAt: T - 60_000 }
    expect(bandFor(conn, T + 1_000)).toEqual({ kind: 'none' })
    expect(bandFor(conn, T + 3_500)).toEqual({ kind: 'reconnecting', since: T - 60_000 })
  })
  it('끊김 → 유예 없이 띠', () => {
    const conn: ConnState = { kind: 'reconnecting', since: T, lastConnectedAt: T - 1, attempt: 3, reason: 'shutdown', offline: true }
    expect(bandFor(conn, T)).toEqual({ kind: 'offline', since: T - 1 })
  })
  it('버전 불일치 → 띠', () => {
    expect(bandFor({ kind: 'mismatch', at: T, supported: [2] }, T)).toEqual({ kind: 'mismatch' })
  })
})

describe('statusLine — 「연결됨」 은 connected 에서만', () => {
  const cases: [ConnState, string, string][] = [
    [{ kind: 'connected', since: T, lastAliveAt: T }, '맥 · 연결됨', 'ok'],
    [{ kind: 'checking', since: T, lastConnectedAt: T }, '맥 · 연결 확인 중', 'muted'],
    [{ kind: 'reconnecting', since: T, lastConnectedAt: null, attempt: 0, reason: 'launch', offline: false }, '맥 · 재연결 중', 'muted'],
    [{ kind: 'reconnecting', since: T, lastConnectedAt: null, attempt: 0, reason: 'launch', offline: true }, '맥 · 끊김', 'error'],
    [{ kind: 'mismatch', at: T, supported: [] }, '맥 · 버전 불일치', 'error'],
  ]
  it.each(cases)('%o', (conn, text, tone) => {
    expect(statusLine(conn, '맥')).toEqual({ text, tone })
  })
})
