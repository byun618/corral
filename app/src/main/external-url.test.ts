// LIFE-565 — 외부 열기 허용 술어 (D2: http + https, C3ⓑ).
import { describe, expect, it } from 'vitest'
import { externalOpenLogUrl, isExternalOpenAllowed } from './external-url.js'

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

describe('externalOpenLogUrl — 허용 로그는 origin + pathname 만 (R1-07)', () => {
  it.each([
    ['https://claude.ai/oauth/authorize?code=SECRET&state=XYZ#frag', 'https://claude.ai/oauth/authorize'],
    ['https://user:pw@example.com/l565-c1?t=1', 'https://example.com/l565-c1'],
    ['http://localhost:5173/', 'http://localhost:5173/'],
  ])('%s → %s', (url, expected) => {
    expect(externalOpenLogUrl(url)).toBe(expected)
  })

  it('200자 상한 · 파싱 불가는 원문을 남기지 않는다', () => {
    expect(externalOpenLogUrl('https://example.com/' + 'a'.repeat(300)).length).toBe(200)
    expect(externalOpenLogUrl('https://')).toBe('(unparsable)')
  })
})

describe('externalOpenLogUrl — 거절 로그도 비밀 없이 (R2-02)', () => {
  it.each([
    ['postgres://user:secretpw@localhost:5432/db?sslmode=x', 'postgres://localhost:5432/db'],
    ['redis://:pw@cache.local:6379/0', 'redis://cache.local:6379/0'],
    ['s3://bucket/key?sig=SECRET', 's3://bucket/key'],
    ['file:///etc/hosts', 'file:///etc/hosts'],
    ['javascript:window.__l565=1', 'javascript:'],
    ['data:text/html,<script>secret</script>', 'data:'],
    ['about:blank', 'about:blank'],
    ['ftp://example.com/l565', 'ftp://example.com/l565'],
  ])('%s → %s', (url, expected) => {
    expect(externalOpenLogUrl(url)).toBe(expected)
  })
})
