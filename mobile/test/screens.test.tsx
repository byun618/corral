// @vitest-environment happy-dom
// 화면 시험 (리뷰 r1 R1-A5·A6·A7·A4) — RN·expo-router 를 DOM 가짜로 바꾸고 실제 화면 코드를 그린다. 네이티브 실행이 아니다.
// 카메라 권한 훅은 expo-modules-core 의 실제 `createPermissionHook`(복귀 갱신을 스스로 하지 않는 그 훅)을 쓴다.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RootLayout from '../app/_layout'
import PairIntro from '../app/pair/index'
import PairProgress from '../app/pair/progress'
import PairScan from '../app/pair/scan'
import type { Snapshot } from '../src/core/connection'

/** OS 권한 칸 중 화면이 보는 둘 — 응답 모양(status·expires)은 가짜 훅이 채운다. */
type Permission = { granted: boolean; canAskAgain: boolean }

const ctx = vi.hoisted(() => {
  const appStateListeners: ((state: string) => void)[] = []
  const snapshot: Snapshot = { conn: { kind: 'loading' }, pair: { kind: 'idle' }, info: null, appVersion: 'test' }
  const segments: string[] = ['pair', 'progress']
  const permission: Permission = { granted: false, canAskAgain: false }
  return {
    snapshot,
    segments,
    replace: vi.fn(),
    push: vi.fn(),
    back: vi.fn(),
    permission,
    getCalls: 0,
    requestCalls: 0,
    appStateListeners,
    connection: { resetPair: vi.fn(), pair: vi.fn(), retryPair: vi.fn(), retryUnpair: vi.fn(), acknowledgeUnpair: vi.fn(), unpair: vi.fn(), reconnectNow: vi.fn() },
  }
})

vi.mock('../src/runtime/connection', () => ({
  startConnection: () => {},
  useConnection: () => ctx.snapshot,
  connection: ctx.connection,
}))
vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: ctx.replace, push: ctx.push, back: ctx.back }),
  useSegments: () => ctx.segments,
  Stack: () => null,
}))
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SafeAreaView: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}))
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress?: () => void }) => <button onClick={onPress}>{children}</button>,
  ActivityIndicator: () => <i>spinner</i>,
  Platform: { select: (value: { android: string }) => value.android },
  Linking: { openSettings: vi.fn() },
  AppState: {
    currentState: 'active',
    addEventListener: (_type: string, listener: (state: string) => void) => {
      ctx.appStateListeners.push(listener)
      return { remove: () => ctx.appStateListeners.splice(ctx.appStateListeners.indexOf(listener), 1) }
    },
  },
}))
vi.mock('expo-clipboard', () => ({ getStringAsync: async () => '' }))
vi.mock('expo-camera', async () => {
  const { createPermissionHook } = await import('../node_modules/expo-modules-core/src/PermissionsHook')
  const { PermissionStatus } = await import('../node_modules/expo-modules-core/src/PermissionsInterface')
  const response = () => ({
    ...ctx.permission,
    status: ctx.permission.granted ? PermissionStatus.GRANTED : PermissionStatus.DENIED,
    expires: 'never' as const,
  })
  return {
    CameraView: () => <i>camera-preview</i>,
    useCameraPermissions: createPermissionHook({
      getMethod: async () => {
        ctx.getCalls += 1
        return response()
      },
      requestMethod: async () => {
        ctx.requestCalls += 1
        return response()
      },
    }),
  }
})


let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  ctx.replace.mockClear()
  for (const fn of Object.values(ctx.connection)) fn.mockClear()
  ctx.getCalls = 0
  ctx.requestCalls = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve() })
}

describe('R1-A5 — 해지·해제는 어느 화면에서든 A1 로', () => {
  it('A4(/pair/progress) 에서 revoked → /pair 로 바꾼다', async () => {
    ctx.snapshot = { conn: { kind: 'unpaired', reason: 'revoked' }, pair: { kind: 'idle' }, info: null, appVersion: 'test' }
    ctx.segments = ['pair', 'progress']
    await act(async () => root.render(<RootLayout />))
    expect(ctx.replace).toHaveBeenCalledWith('/pair')
  })

  it('홈에서 해제 중(unpairing) → /pair', async () => {
    ctx.snapshot = { conn: { kind: 'unpairing', reason: 'user' }, pair: { kind: 'idle' }, info: null, appVersion: 'test' }
    ctx.segments = ['home']
    await act(async () => root.render(<RootLayout />))
    expect(ctx.replace).toHaveBeenCalledWith('/pair')
  })

  it('양성 대조 — 진행 중 페어링(이유 없는 unpaired)의 A3 에서는 그대로', async () => {
    ctx.snapshot = { conn: { kind: 'unpaired', reason: null }, pair: { kind: 'pairing', host: 'h', startedAt: 1 }, info: null, appVersion: 'test' }
    ctx.segments = ['pair', 'progress']
    await act(async () => root.render(<RootLayout />))
    expect(ctx.replace).not.toHaveBeenCalled()
  })
})

describe('R1-A4 — A1 은 삭제가 끝나기 전 「해제했습니다」 를 보이지 않는다', () => {
  it('unpair_failed → 실패 안내 + 「다시 지우기」, QR 버튼·「해제했습니다」 없음', async () => {
    ctx.snapshot = { conn: { kind: 'unpair_failed', reason: 'user' }, pair: { kind: 'idle' }, info: null, appVersion: 'test' }
    ctx.segments = ['pair']
    await act(async () => root.render(<PairIntro />))
    expect(container.textContent).toContain('기기 토큰을 지우지 못했습니다')
    expect(container.textContent).not.toContain('해제했습니다')
    expect(buttons().some((b) => b.textContent === 'QR 찍기')).toBe(false)
    await act(async () => buttons().find((b) => b.textContent === '다시 지우기')?.click())
    expect(ctx.connection.retryUnpair).toHaveBeenCalledTimes(1)
  })

  it('unpairing → 지우는 중, 「해제했습니다」 없음 · unpaired(user) → 「해제했습니다」 + QR 찍기(누르면 이유를 내려놓는다)', async () => {
    ctx.snapshot = { conn: { kind: 'unpairing', reason: 'user' }, pair: { kind: 'idle' }, info: null, appVersion: 'test' }
    await act(async () => root.render(<PairIntro />))
    expect(container.textContent).toContain('지우는 중')
    expect(container.textContent).not.toContain('해제했습니다')
    ctx.snapshot = { conn: { kind: 'unpaired', reason: 'user' }, pair: { kind: 'idle' }, info: null, appVersion: 'test' }
    await act(async () => root.render(<PairIntro />))
    expect(container.textContent).toContain('해제했습니다')
    await act(async () => buttons().find((b) => b.textContent === 'QR 찍기')?.click())
    expect(ctx.connection.acknowledgeUnpair).toHaveBeenCalledTimes(1)
    expect(ctx.push).toHaveBeenCalledWith('/pair/scan')
  })
})

describe('R1-A6 — 설정에서 권한을 허용하고 돌아오면 카메라', () => {
  it('A5(영구 거부) → 앱 복귀(active) → 권한을 다시 읽고(요청 아님) 카메라를 보인다', async () => {
    ctx.permission = { granted: false, canAskAgain: false }
    await act(async () => root.render(<PairScan />))
    await settle()
    expect(container.textContent).toContain('카메라를 쓸 수 없습니다')
    const getsBefore = ctx.getCalls
    // 시스템 설정에서 허용
    ctx.permission = { granted: true, canAskAgain: true }
    await act(async () => {
      for (const listener of [...ctx.appStateListeners]) listener('background')
      for (const listener of [...ctx.appStateListeners]) listener('active')
    })
    await settle()
    expect(ctx.getCalls).toBeGreaterThan(getsBefore)
    expect(ctx.requestCalls).toBe(0)
    expect(container.textContent).toContain('camera-preview')
    expect(container.textContent).not.toContain('카메라를 쓸 수 없습니다')
  })

  it('양성 대조 — 복귀했어도 여전히 거부면 A5 그대로, 자동 요청 없음', async () => {
    ctx.permission = { granted: false, canAskAgain: false }
    await act(async () => root.render(<PairScan />))
    await settle()
    await act(async () => {
      for (const listener of [...ctx.appStateListeners]) listener('active')
    })
    await settle()
    expect(container.textContent).toContain('카메라를 쓸 수 없습니다')
    expect(ctx.requestCalls).toBe(0)
  })
})

describe('R1-A7 — A8 「다시 시도」', () => {
  it('unreachable → 주 버튼 「다시 시도」(retryPair) + 보조 「다시 찍기」', async () => {
    ctx.snapshot = {
      conn: { kind: 'unpaired', reason: null },
      pair: { kind: 'failed', reason: 'unreachable', host: 'mac.tailnet.ts.net:8577', supported: [] },
      info: null,
      appVersion: 'test',
    }
    await act(async () => root.render(<PairProgress />))
    const labels = buttons().map((b) => b.textContent)
    expect(labels).toEqual(['다시 시도', '다시 찍기'])
    await act(async () => buttons()[0]?.click())
    expect(ctx.connection.retryPair).toHaveBeenCalledTimes(1)
    expect(ctx.connection.resetPair).not.toHaveBeenCalled()
  })
})
