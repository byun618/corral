// LIFE-636 E3 Claude 수집기 — 자격 증명 순서·요청 헤더·응답 4형태·오류 분류·읽기 전용(E6ⓐ)·토큰 비노출(E6ⓑ).
import { describe, expect, it } from 'vitest'
import { CLAUDE_USAGE_URL, claudeCollector, claudeKeychainAccount, claudeKeychainService, parseClaudeUsage } from './claude.js'
import { TEST_TOKEN, fakeDeps, fixture, response } from './fake-deps.test-helper.js'

const credentials = JSON.stringify({ claudeAiOauth: { accessToken: TEST_TOKEN, refreshToken: 'refresh-SECRET', expiresAt: 1 } })
const KEYCHAIN = { 'Claude Code-credentials': credentials }

describe('parseClaudeUsage — 응답 4형태(E3ⓒ)', () => {
  it('실측(c10): limits[] + 평면 칸 합침, 같은 창(5h·7d)은 한 번 — 5h·7d·Fable 7d, 초기화 시각 ISO', () => {
    expect(parseClaudeUsage(fixture('claude-usage.json'))?.windows).toEqual([
      { label: '5h', windowMinutes: 300, usedPercent: 10, resetsAt: Date.parse('2026-10-18T14:20:00.475906+00:00') },
      { label: '7d', windowMinutes: 10080, usedPercent: 67, resetsAt: Date.parse('2026-10-19T01:00:00.475926+00:00') },
      { label: 'Fable 7d', windowMinutes: 10080, usedPercent: 12, resetsAt: Date.parse('2026-10-19T01:00:00.476062+00:00') },
    ])
  })
  it('평면 칸만(five_hour·seven_day) — limits 없음', () => {
    expect(parseClaudeUsage({ five_hour: { utilization: 23.5, resets_at: 1738425600 }, seven_day: { utilization: 41.2, resets_at: null }, seven_day_opus: null })).toEqual({ windows: [
      { label: '5h', windowMinutes: 300, usedPercent: 23.5, resetsAt: 1738425600 * 1000 },
      { label: '7d', windowMinutes: 10080, usedPercent: 41.2, resetsAt: null },
    ], skipped: 0 })
  })
  it('limits[] 만 — 평면 칸 null, 모르는 kind 는 라벨 = kind, 범위 밖 % 는 0–100 으로, 못 읽은 항목은 skipped', () => {
    expect(parseClaudeUsage({ five_hour: null, seven_day: null, limits: [{ kind: 'weekly_all', group: 'weekly', percent: 140, resets_at: '2026-10-19T01:00:00Z' }, { kind: 'mystery', percent: 3 }, { kind: 'session' }] })).toEqual({ windows: [
      { label: '7d', windowMinutes: 10080, usedPercent: 100, resetsAt: Date.parse('2026-10-19T01:00:00Z') },
      { label: 'mystery', windowMinutes: null, usedPercent: 3, resetsAt: null },
    ], skipped: 1 })
  })
  it('r1 P5 — 평면 5h 95%·7d 80% + limits[Fable 5%] 를 합친다(평면 칸을 버리지 않는다)', () => {
    const parsed = parseClaudeUsage({ five_hour: { utilization: 95 }, seven_day: { utilization: 80 }, limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 5, scope: { model: { display_name: 'Fable' } } }] })
    expect(parsed?.windows.map((window) => [window.label, window.usedPercent])).toEqual([['5h', 95], ['7d', 80], ['Fable 7d', 5]])
  })
  it('r1 P6 → r2 R2-3 — limits[] 안의 weekly_all 과 이름 없는 weekly_scoped 는 합치지 않는다(범위 창은 「7d 범위」)', () => {
    const parsed = parseClaudeUsage({ limits: [{ kind: 'weekly_all', percent: 30 }, { kind: 'weekly_scoped', percent: 70, scope: { model: { id: null, display_name: null }, surface: 'x' } }] })
    expect(parsed?.windows.map((window) => [window.label, window.usedPercent])).toEqual([['7d', 30], ['7d 범위', 70]])
  })
  it('r2 R2-3 — 평면 칸 ↔ limits[] 만 합친다: 평면 7d 50 + limits weekly_all 60 = 7d 60 하나(평면 자리), limits 의 같은 라벨 둘째는 남는다', () => {
    const parsed = parseClaudeUsage({ seven_day: { utilization: 50 }, limits: [{ kind: 'weekly_all', percent: 60 }, { kind: 'weekly_all', percent: 20 }] })
    expect(parsed?.windows.map((window) => [window.label, window.usedPercent])).toEqual([['7d', 60], ['7d', 20]])
  })
  it('실측(c10) 결과 그대로 — 5h 10% · 7d 67% · Fable 7d 12%', () => {
    expect(parseClaudeUsage(fixture('claude-usage.json'))?.windows.map((window) => [window.label, window.usedPercent])).toEqual([['5h', 10], ['7d', 67], ['Fable 7d', 12]])
  })
  it('평면 칸이 기록이 아니면(모양이 바뀜) skipped 로 센다', () => {
    expect(parseClaudeUsage({ five_hour: '10%', limits: [{ kind: 'session', percent: 10 }] })).toEqual({ windows: [{ label: '5h', windowMinutes: 300, usedPercent: 10, resetsAt: null }], skipped: 1 })
  })
  it('모르는 형태 → null(= error(parse)) — 숫자를 지어내지 않는다', () => {
    expect(parseClaudeUsage({ usage: { session: '10%' } })).toBeNull()
    expect(parseClaudeUsage([])).toBeNull()
    expect(parseClaudeUsage({ limits: [{ kind: 'session', percent: '10' }] })).toBeNull()
  })
})

describe('Claude 자격 증명(E3ⓐ) — 키체인 → 파일, 읽기만', () => {
  it('키체인 service·account — 기본 / CLAUDE_CONFIG_DIR 접미사(sha256 8 hex) / $USER 허용 문자', () => {
    expect(claudeKeychainService(null)).toBe('Claude Code-credentials')
    expect(claudeKeychainService('/Users/x/.claude-work')).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
    expect(claudeKeychainAccount('byun')).toBe('byun')
    expect(claudeKeychainAccount('a b')).toBe('claude-code-user')
    expect(claudeKeychainAccount(undefined)).toBe('claude-code-user')
  })
  it('키체인에서 찾으면 요청 — Bearer·anthropic-beta·corral UA(위장 없음)', async () => {
    const { deps, calls } = fakeDeps({ keychain: KEYCHAIN, http: () => response({ status: 200, body: fixture('claude-usage.json') }) })
    const outcome = await claudeCollector.fetch(deps)
    expect(outcome.kind).toBe('ok')
    expect(calls.map((call) => call.kind)).toEqual(['keychain', 'http'])
    const http = calls[1]
    if (http?.kind !== 'http') throw new Error('http 호출 없음')
    expect(http.url).toBe(CLAUDE_USAGE_URL)
    expect(http.headers).toMatchObject({ Authorization: `Bearer ${TEST_TOKEN}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'corral/test' })
    expect(http.headers['User-Agent']).not.toMatch(/claude/i)
  })
  it('키체인 없음(exit 44) → .credentials.json, CLAUDE_CONFIG_DIR 를 따른다', async () => {
    const { deps, calls } = fakeDeps({ env: { USER: 'tester', CLAUDE_CONFIG_DIR: '/cfg' }, files: { '/cfg/.credentials.json': credentials }, http: () => response({ status: 200, body: fixture('claude-usage.json') }) })
    expect((await claudeCollector.fetch(deps)).kind).toBe('ok')
    expect(calls[0]).toEqual({ kind: 'keychain', service: claudeKeychainService('/cfg'), account: 'tester' })
    expect(calls[1]).toEqual({ kind: 'file', file: '/cfg/.credentials.json' })
  })
  it('USER 폴백 — $USER 가 없거나 비면 OS 사용자 이름, 둘 다 없으면 claude-code-user', async () => {
    for (const [env, username, account] of [[{}, 'osuser', 'osuser'], [{ USER: '' }, 'osuser', 'osuser'], [{ USER: 'envuser' }, 'osuser', 'envuser'], [{}, null, 'claude-code-user']] as const) {
      const { deps, calls } = fakeDeps({ env: { ...env }, username, keychain: KEYCHAIN, http: () => response({ status: 200, body: fixture('claude-usage.json') }) })
      await claudeCollector.fetch(deps)
      expect(calls[0]).toEqual({ kind: 'keychain', service: 'Claude Code-credentials', account })
    }
  })
  it('macOS 가 아니면 키체인을 부르지 않는다', async () => {
    const { deps, calls } = fakeDeps({ platform: 'linux' })
    expect(await claudeCollector.fetch(deps)).toEqual({ kind: 'unavailable', reason: 'Claude 로그인 정보 없음' })
    expect(calls).toEqual([{ kind: 'file', file: '/home/tester/.claude/.credentials.json' }])
  })
  it('키체인·파일 모두 없음 → unavailable, 요청 0', async () => {
    const { deps, calls } = fakeDeps({})
    expect((await claudeCollector.fetch(deps)).kind).toBe('unavailable')
    expect(calls.some((call) => call.kind === 'http')).toBe(false)
  })
  it('키체인 오류 → error(credential), 요청 0', async () => {
    const { deps, calls } = fakeDeps({ keychain: 'error' })
    const outcome = await claudeCollector.fetch(deps)
    expect(outcome).toMatchObject({ kind: 'error', error: { kind: 'credential' } })
    expect(calls.some((call) => call.kind === 'http')).toBe(false)
  })
  it('손상된 .credentials.json → error(credential)', async () => {
    const { deps } = fakeDeps({ files: { '/home/tester/.claude/.credentials.json': '{not json' } })
    expect(await claudeCollector.fetch(deps)).toMatchObject({ kind: 'error', error: { kind: 'credential' } })
  })
})

describe('Claude 오류 분류(E3ⓓ) — 상태 문구 고정, 토큰·본문 비노출', () => {
  const cases: { name: string; http: () => ReturnType<typeof response> | Promise<never>; kind: string; message: RegExp; retryAfterMs?: number | null }[] = [
    { name: '401', http: () => response({ status: 401 }), kind: 'expired', message: /claude 실행 시 갱신/ },
    { name: '403 scope', http: () => response({ status: 403, body: { error: { message: 'OAuth token does not meet scope requirement user:profile' } } }), kind: 'forbidden', message: /권한 범위 부족/ },
    { name: '403 기타', http: () => response({ status: 403, body: 'nope' }), kind: 'forbidden', message: /HTTP 403/ },
    { name: '429 Retry-After 초', http: () => response({ status: 429, headers: { 'Retry-After': '180' } }), kind: 'rate_limited', message: /3분 뒤 다시/, retryAfterMs: 180_000 },
    { name: '429 Retry-After 없음', http: () => response({ status: 429 }), kind: 'rate_limited', message: /HTTP 429/, retryAfterMs: null },
    { name: '5xx', http: () => response({ status: 503 }), kind: 'server', message: /HTTP 503/ },
    { name: '418 기타', http: () => response({ status: 418 }), kind: 'http', message: /HTTP 418/ },
    { name: '네트워크', http: () => Promise.reject(new TypeError(`fetch failed ${TEST_TOKEN}`)), kind: 'network', message: /네트워크/ },
    { name: 'JSON 아님', http: () => response({ status: 200, body: '<html>' }), kind: 'parse', message: /응답 형태/ },
    { name: '모르는 형태', http: () => response({ status: 200, body: { hello: 1 } }), kind: 'parse', message: /응답 형태/ },
  ]
  for (const entry of cases) {
    it(entry.name, async () => {
      const { deps } = fakeDeps({ keychain: KEYCHAIN, http: entry.http })
      const outcome = await claudeCollector.fetch(deps)
      if (outcome.kind !== 'error') throw new Error(`error 가 아님: ${outcome.kind}`)
      expect(outcome.error.kind).toBe(entry.kind)
      expect(outcome.error.message).toMatch(entry.message)
      if (entry.retryAfterMs !== undefined) expect(outcome.retryAfterMs).toBe(entry.retryAfterMs)
      expect(JSON.stringify(outcome)).not.toContain(TEST_TOKEN)
    })
  }
  it('타임아웃 — signal 이 끊긴 뒤의 예외는 timeout', async () => {
    const controller = new AbortController()
    const { deps } = fakeDeps({ keychain: KEYCHAIN, signal: controller.signal, http: () => { controller.abort(); return Promise.reject(new Error('aborted')) } })
    expect(await claudeCollector.fetch(deps)).toMatchObject({ kind: 'error', error: { kind: 'timeout' } })
  })
  it('Retry-After HTTP 날짜', async () => {
    const at = new Date(Date.parse('2026-10-18T12:30:00Z') + 120_000).toUTCString()
    const { deps } = fakeDeps({ keychain: KEYCHAIN, http: () => response({ status: 429, headers: { 'Retry-After': at } }) })
    expect(await claudeCollector.fetch(deps)).toMatchObject({ kind: 'error', retryAfterMs: 120_000 })
  })
})

describe('E3ⓔ·E6ⓐⓑ — 갱신 0 · 읽기만 · 토큰은 결과에 없다', () => {
  it('요청은 usage GET 하나뿐 — refresh 엔드포인트·refresh token 사용 0', async () => {
    const { deps, calls } = fakeDeps({ keychain: KEYCHAIN, http: () => response({ status: 401 }) })
    await claudeCollector.fetch(deps)
    const http = calls.filter((call) => call.kind === 'http')
    expect(http).toHaveLength(1)
    expect(JSON.stringify(calls)).not.toContain('refresh-SECRET')
  })
  it('ok 결과 직렬화에 토큰 0', async () => {
    const { deps } = fakeDeps({ keychain: KEYCHAIN, http: () => response({ status: 200, body: fixture('claude-usage.json') }) })
    expect(JSON.stringify(await claudeCollector.fetch(deps))).not.toContain(TEST_TOKEN)
  })
})
