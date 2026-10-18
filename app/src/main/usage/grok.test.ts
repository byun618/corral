// LIFE-636 E5 Grok 수집기 — issuer 우선·만료면 요청 0·헤더·응답 형태·percent 없음 = parse(사유: 지어낸 0% 금지)·401/403.
import { describe, expect, it } from 'vitest'
import { GROK_USAGE_URL, grokCollector, parseGrokUsage, pickGrokEntry } from './grok.js'
import { NOW, TEST_TOKEN, fakeDeps, fixture, response } from './fake-deps.test-helper.js'

const FILE = '/home/tester/.grok/auth.json'
const future = new Date(NOW + 60 * 60_000).toISOString()
const past = new Date(NOW - 60_000).toISOString()
const auth = (expiresAt: string): string => JSON.stringify({ 'https://auth.x.ai::client-1': { key: TEST_TOKEN, user_id: 'user-SECRET', email: 'person@example.com', first_name: 'P', expires_at: expiresAt, refresh_token: 'refresh-SECRET' } })

describe('parseGrokUsage(E5ⓒ)', () => {
  it('실측(c12): 주간 20%, 창 = currentPeriod 7일, 초기화 = end', () => {
    expect(parseGrokUsage(fixture('grok-billing.json'))).toEqual({ windows: [{ label: '7d', windowMinutes: 10080, usedPercent: 20, resetsAt: Date.parse('2026-10-23T23:09:35.051329+00:00') }], skipped: 0 })
  })
  it('평면 형태(config 없음)도 읽는다 · 기간 없으면 라벨 credits', () => {
    expect(parseGrokUsage({ creditUsagePercent: 42 })).toEqual({ windows: [{ label: 'credits', windowMinutes: null, usedPercent: 42, resetsAt: null }], skipped: 0 })
  })
  it('percent 없음 → null(= error(parse)) — Orca 의 0% 폴백을 따르지 않는다', () => {
    expect(parseGrokUsage({ config: { currentPeriod: { start: '2026-10-16T00:00:00Z', end: '2026-10-23T00:00:00Z' } } })).toBeNull()
    expect(parseGrokUsage('x')).toBeNull()
  })
})

describe('pickGrokEntry(E5ⓐ)', () => {
  it('auth.x.ai(::* 포함) 우선, 신선한 것 먼저', () => {
    const value = {
      'https://other.example': { key: 'other', expires_at: future },
      'https://auth.x.ai::old': { key: 'stale', expires_at: past },
      'https://auth.x.ai::new': { key: 'fresh', expires_at: future },
    }
    expect(pickGrokEntry({ value, now: NOW })?.token).toBe('fresh')
    expect(pickGrokEntry({ value: { 'https://other.example': { key: 'other' } }, now: NOW })?.token).toBe('other')
    expect(pickGrokEntry({ value: { a: { nokey: 1 } }, now: NOW })).toBeNull()
  })
})

describe('Grok 수집기', () => {
  it('요청 — Bearer·X-XAI-Token-Auth·x-userid·corral UA', async () => {
    const { deps, calls } = fakeDeps({ files: { [FILE]: auth(future) }, http: () => response({ status: 200, body: fixture('grok-billing.json') }) })
    expect((await grokCollector.fetch(deps)).kind).toBe('ok')
    const http = calls[1]
    if (http?.kind !== 'http') throw new Error('http 없음')
    expect(http.url).toBe(GROK_USAGE_URL)
    expect(http.headers).toMatchObject({ Authorization: `Bearer ${TEST_TOKEN}`, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-userid': 'user-SECRET', 'User-Agent': 'corral/test' })
  })
  it('expires_at 지남 → 요청하지 않고 만료(「grok 실행 시 갱신」)', async () => {
    const { deps, calls } = fakeDeps({ files: { [FILE]: auth(past) } })
    expect(await grokCollector.fetch(deps)).toMatchObject({ kind: 'error', error: { kind: 'expired', message: '로그인 만료 — grok 실행 시 갱신' } })
    expect(calls.some((call) => call.kind === 'http')).toBe(false)
  })
  it('GROK_HOME 을 따른다 · 파일 없음 → unavailable', async () => {
    const { deps, calls } = fakeDeps({ env: { GROK_HOME: '/gh' } })
    expect((await grokCollector.fetch(deps)).kind).toBe('unavailable')
    expect(calls).toEqual([{ kind: 'file', file: '/gh/auth.json' }])
  })
  for (const [status, kind] of [[401, 'expired'], [403, 'forbidden']] as const) {
    it(`HTTP ${status} → ${kind}`, async () => {
      const { deps } = fakeDeps({ files: { [FILE]: auth(future) }, http: () => response({ status }) })
      expect(await grokCollector.fetch(deps)).toMatchObject({ kind: 'error', error: { kind } })
    })
  }
  it('percent 없는 응답 → error(parse)', async () => {
    const { deps } = fakeDeps({ files: { [FILE]: auth(future) }, http: () => response({ status: 200, body: { config: {} } }) })
    expect(await grokCollector.fetch(deps)).toMatchObject({ kind: 'error', error: { kind: 'parse' } })
  })
  it('결과에 토큰·user_id·email·이름 0', async () => {
    const { deps } = fakeDeps({ files: { [FILE]: auth(future) }, http: () => response({ status: 200, body: fixture('grok-billing.json') }) })
    const text = JSON.stringify(await grokCollector.fetch(deps))
    for (const secret of [TEST_TOKEN, 'user-SECRET', 'person@example.com', 'refresh-SECRET']) expect(text).not.toContain(secret)
  })
})
