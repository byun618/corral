// @vitest-environment happy-dom
// LIFE-577 A8 — 설정 › 원격 호스트 › Mobile. 가짜 preload 로 스위치 쓰기·상태 push·QR·해지를 본다.
// 서버·serve·페어링 규칙은 main 쪽(`main/mobile/*.test.ts`)이 본다 — 여기는 화면이 그것을 그대로 보여 주는지만.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { MobilePairingResult, MobileStatus } from '../../../shared/mobile.js'
import { DEFAULT_SETTINGS, readSettings, type Settings, type SettingsWriteResult } from '../../../shared/terminal-settings.js'
import { resetSettingsStoreForTest } from '../settings-store.js'
import { MobileSection } from './MobileSection.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const OFF: MobileStatus = {
  enabled: false,
  serverPort: null,
  checklist: {
    cli: { state: 'unknown', detail: '확인 안 함' },
    loggedIn: { state: 'unknown', detail: '확인 안 함' },
    https: { state: 'unknown', detail: '확인 안 함' },
    funnelOff: { state: 'unknown', detail: '확인 안 함' },
  },
  exposure: { kind: 'off' },
  warning: null,
  devices: [],
  maxDevices: 5,
  pairingExpiresAt: null,
}
const URL_ = 'wss://mac.example.ts.net:8577/ws'
const EXPOSED: MobileStatus = {
  ...OFF,
  enabled: true,
  serverPort: 50000,
  checklist: {
    cli: { state: 'ok', detail: '/usr/local/bin/tailscale' },
    loggedIn: { state: 'ok', detail: 'mac.example.ts.net' },
    https: { state: 'ok', detail: '인증서' },
    funnelOff: { state: 'ok', detail: '꺼짐' },
  },
  exposure: { kind: 'exposed', url: URL_, host: 'mac.example.ts.net', httpsPort: 8577 },
}
const PAIRING: Extract<MobilePairingResult, { ok: true }> = {
  ok: true,
  code: 'ABCD2345',
  expiresAt: Date.now() + 600_000,
  url: URL_,
  payload: JSON.stringify({ kind: 'corral-pair', v: 1, url: URL_, code: 'ABCD2345' }),
  qr: { size: 3, cells: '101010101' },
}

let host: HTMLDivElement
let root: Root
let stored: Settings
let status: MobileStatus
let mobileListeners: Array<(next: MobileStatus) => void>
const writes: Array<Partial<Settings>> = []
const revoked: string[] = []

function pushStatus(next: MobileStatus): void {
  status = next
  act(() => { for (const listener of mobileListeners) listener(next) })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  stored = { ...DEFAULT_SETTINGS }
  status = OFF
  mobileListeners = []
  writes.length = 0
  revoked.length = 0
  const settingsListeners: Array<(next: unknown) => void> = []
  Reflect.set(window, 'corral', {
    getSettingsSync: () => stored,
    onSettings: (listener: (next: unknown) => void) => { settingsListeners.push(listener); return () => {} },
    setSettings: async (patch: Partial<Settings>): Promise<SettingsWriteResult> => {
      writes.push(patch)
      stored = readSettings({ ...stored, ...patch })
      for (const listener of settingsListeners) listener(stored)
      return { status: 'saved', settings: stored }
    },
    getMobileStatus: async () => status,
    onMobileStatus: (listener: (next: MobileStatus) => void) => { mobileListeners.push(listener); return () => {} },
    createMobilePairing: async (): Promise<MobilePairingResult> => PAIRING,
    revokeMobileDevice: async (input: { id: string }) => { revoked.push(input.id); return { ok: true } },
    recheckMobile: async () => status,
  })
  resetSettingsStoreForTest(null)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'corral')
  resetSettingsStoreForTest(null)
})

async function mount(): Promise<void> {
  await act(async () => { root.render(createElement(MobileSection)) })
}
function q(selector: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(selector)
  if (found === null) throw new Error(`${selector} 없음`)
  return found
}

it('꺼짐 — 스위치 꺼짐, 점검표 4줄(확인 안 함), QR 버튼 비활성, 기기 없음', async () => {
  await mount()
  expect(q('[data-settings-mobile-row="enabled"] [role="switch"]').getAttribute('aria-checked')).toBe('false')
  expect([...host.querySelectorAll('[data-mobile-check]')].map((el) => el.getAttribute('data-mobile-check'))).toEqual(['cli', 'loggedIn', 'https', 'funnelOff'])
  expect([...host.querySelectorAll('[data-mobile-check]')].every((el) => el.getAttribute('data-mobile-check-state') === 'unknown')).toBe(true)
  expect(q('[data-mobile-create-pairing]').hasAttribute('disabled')).toBe(true)
  expect(host.querySelector('[data-mobile-devices-empty]')).not.toBeNull()
})

it('스위치를 누르면 mobileEnabled 하나만 쓴다 (A8ⓐ)', async () => {
  await mount()
  await act(async () => { q('[data-settings-mobile-row="enabled"] [role="switch"]').click() })
  expect(writes).toEqual([{ mobileEnabled: true }])
})

it('거부 상태 — 실패 줄과 이유 문구가 보인다 (A7ⓐⓑ)', async () => {
  stored = { ...stored, mobileEnabled: true }
  await mount()
  pushStatus({
    ...EXPOSED,
    checklist: { ...EXPOSED.checklist, https: { state: 'fail', detail: 'Tailscale 관리 콘솔 › DNS › HTTPS Certificates 를 켠다' } },
    exposure: { kind: 'blocked', reason: 'https', message: 'tailnet HTTPS 인증서가 꺼져 있다' },
  })
  expect(q('[data-mobile-check="https"]').getAttribute('data-mobile-check-state')).toBe('fail')
  expect(q('[data-mobile-check="https"]').textContent).toContain('HTTPS Certificates')
  expect(q('[data-mobile-exposure]').getAttribute('data-mobile-exposure')).toBe('blocked')
  expect(q('[data-mobile-exposure]').textContent).toContain('HTTPS 인증서가 꺼져')
  expect(q('[data-mobile-create-pairing]').hasAttribute('disabled')).toBe(true)
})

it('노출 — 주소 표시, QR 만들기 → SVG QR(이미지 태그 없음) + 주소·코드·QR 내용 텍스트, 코드가 사용되면 지운다 (A4ⓐ·A8ⓒ)', async () => {
  stored = { ...stored, mobileEnabled: true }
  await mount()
  pushStatus(EXPOSED)
  expect(q('[data-mobile-address]').textContent).toBe(URL_)
  await act(async () => { q('[data-mobile-create-pairing]').click() })
  pushStatus({ ...EXPOSED, pairingExpiresAt: PAIRING.expiresAt })
  const svg = q('[data-mobile-qr]')
  expect(svg.tagName.toLowerCase()).toBe('svg')
  expect(host.querySelector('img')).toBeNull()
  // 3×3 격자 중 '1' 다섯 칸 → 사각형 경로 다섯.
  expect(svg.querySelector('path')?.getAttribute('d')?.match(/M/g)).toHaveLength(5)
  expect(q('[data-mobile-pairing-code]').textContent).toBe('ABCD2345')
  expect(q('[data-mobile-pairing-url]').textContent).toBe(URL_)
  expect(q('[data-mobile-pairing-payload]').textContent).toBe(PAIRING.payload)
  pushStatus({ ...EXPOSED, pairingExpiresAt: null })
  expect(host.querySelector('[data-mobile-pairing]')).toBeNull()
  expect(host.textContent).not.toContain('ABCD2345')
})

it('기기 목록 — 이름·시각·연결 표시, 해지 버튼은 그 id 로 부른다 (A4ⓓⓔ)', async () => {
  stored = { ...stored, mobileEnabled: true }
  await mount()
  pushStatus({
    ...EXPOSED,
    devices: [
      { id: 'd1', name: '내 폰', pairedAt: Date.now() - 1000, lastSeenAt: Date.now(), connected: true },
      { id: 'd2', name: '태블릿', pairedAt: Date.now() - 2000, lastSeenAt: null, connected: false },
    ],
  })
  expect(host.querySelector('[data-settings-block="mobile-devices"] h3')?.textContent).toBe('기기 (2/5)')
  expect(q('[data-mobile-device="d1"]').textContent).toContain('내 폰')
  expect(q('[data-mobile-device="d1"]').querySelector('[aria-label="연결됨"]')).not.toBeNull()
  expect(q('[data-mobile-device="d2"]').textContent).toContain('마지막 접속 없음')
  await act(async () => { q('[data-mobile-revoke="d2"]').click() })
  expect(revoked).toEqual(['d2'])
})

it('경고 — Funnel 로 내렸을 때 alert 로 보인다 (A7ⓒ)', async () => {
  await mount()
  pushStatus({ ...EXPOSED, exposure: { kind: 'blocked', reason: 'funnel', message: 'Funnel 이 켜져 있다' }, warning: 'Funnel 이 켜져 corral 항목을 내렸다' })
  expect(q('[data-mobile-warning]').getAttribute('role')).toBe('alert')
})
