// LIFE-565 — 외부 열기 허용 술어 (D2: http + https, C3ⓑ).
import { describe, expect, it } from 'vitest'
import { isExternalOpenAllowed } from './external-url.js'

describe('isExternalOpenAllowed', () => {
  it.each(['https://example.com/?l565=1', 'http://localhost:5173/'])('허용: %s', (url) => {
    expect(isExternalOpenAllowed(url)).toBe(true)
  })

  it.each(['file:///etc/hosts', 'javascript:alert(1)', 'ftp://example.com/f', 'about:blank', '', 'xhttps://x.y', ' https://x.y'])(
    '거절: %s',
    (url) => {
      expect(isExternalOpenAllowed(url)).toBe(false)
    },
  )
})
