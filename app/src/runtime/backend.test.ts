// LIFE-556 B6 단위 — 런타임 backend 바인딩의 우선순위. 명시 바인딩이 언제나 먼저고, 동봉 서버는 그것이 없을 때만.
import { afterEach, describe, expect, it } from 'vitest'
import { backendBinding, paneSessionName, useBundledBackend } from './backend.js'

afterEach(() => useBundledBackend(null))

describe('backendBinding', () => {
  it('명시 바인딩(socket+session)이 동봉 서버보다 먼저다 — 개발 경로 회귀 없음', () => {
    useBundledBackend(() => ({ socket: '/b/herdr.sock', session: 'default' }))
    expect(backendBinding({ CORRAL_BACKEND_SOCKET: '/dev.sock', CORRAL_SESSION: 'life' })).toEqual({ socket: '/dev.sock', session: 'life', source: 'explicit' })
  })
  it('명시 바인딩이 없으면 GUI 가 지금 붙은 동봉 서버', () => {
    useBundledBackend(() => ({ socket: '/b/herdr.sock', session: 'default' }))
    expect(backendBinding({})).toEqual({ socket: '/b/herdr.sock', session: 'default', source: 'bundled' })
  })
  it('GUI 가 아직 붙지 않았으면 없음 — 추측한 소켓을 쓰지 않는다', () => {
    useBundledBackend(() => null)
    expect(backendBinding({})).toBeNull()
  })
  it('반쪽 바인딩은 동봉 서버로 메우지 않는다 — 소켓만이면 종전대로 그 소켓, 세션만이면 없음', () => {
    useBundledBackend(() => ({ socket: '/b/herdr.sock', session: 'default' }))
    expect(backendBinding({ CORRAL_SESSION: 'life' })).toBeNull()
    expect(backendBinding({ CORRAL_BACKEND_SOCKET: '/dev.sock' })).toEqual({ socket: '/dev.sock', session: null, source: 'explicit' })
  })
  it('개발 실행(동봉 없음)·바인딩 없음 → 없음 (종전 backend_unavailable)', () => {
    expect(backendBinding({})).toBeNull()
  })
})

describe('paneSessionName', () => {
  it('default 세션은 기록하지 않는다 — herdr 가 default pane 에 HERDR_SESSION 을 싣지 않는다', () => {
    expect(paneSessionName({ socket: '/s', session: 'default', source: 'bundled' })).toBeNull()
    expect(paneSessionName({ socket: '/s', session: 'default', source: 'explicit' })).toBeNull()
  })
  it('이름 세션은 그대로', () => {
    expect(paneSessionName({ socket: '/s', session: 'life417-native', source: 'explicit' })).toBe('life417-native')
    expect(paneSessionName(null)).toBeNull()
    expect(paneSessionName({ socket: '/s', session: null, source: 'explicit' })).toBeNull()
  })
})
