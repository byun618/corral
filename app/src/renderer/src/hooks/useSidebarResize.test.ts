// K2 — 저장된 폭은 새 경계(Orca 220–500, LIFE-468 A 안)로 clamp 된다.
// vitest 는 DOM 없이 돌므로 경계는 토큰 폴백(`TOKEN_FALLBACK`)에서 온다 — 토큰 값과 같아야 한다(design-tokens.css).
import { describe, expect, it } from 'vitest'
import { clampSidebarWidth } from './useSidebarResize.js'

describe('clampSidebarWidth — 기본 경계 220–500', () => {
  it('540 → 500 (옛 최대 560 경계에서 저장된 폭)', () => expect(clampSidebarWidth(540)).toBe(500))
  it('200 → 220', () => expect(clampSidebarWidth(200)).toBe(220))
  it('322 → 322 (옛 기본값은 새 경계 안)', () => expect(clampSidebarWidth(322)).toBe(322))
  it('경계값 그대로', () => {
    expect(clampSidebarWidth(220)).toBe(220)
    expect(clampSidebarWidth(500)).toBe(500)
  })
})
