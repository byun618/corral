// LIFE-636 E4 Codex 수집기 — auth.json 읽기·헤더·플랜별 창 길이·오류·app-server 0(E4ⓔ)·토큰 비노출.
import { describe, expect, it } from 'vitest'
import { isRecord } from '../../shared/json.js'
import { CODEX_USAGE_URL, codexCollector, parseCodexUsage } from './codex.js'
import { NOW, TEST_TOKEN, fakeDeps, fixture, response } from './fake-deps.test-helper.js'

const AUTH = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: TEST_TOKEN, account_id: 'acct-SECRET', id_token: 'id-SECRET', refresh_token: 'refresh-SECRET' } })
const FILE = '/home/tester/.codex/auth.json'

describe('parseCodexUsage — 플랜별 창(E4ⓒ)', () => {
  it('실측 free(c11): 30일 창 하나, secondary null', () => {
    expect(parseCodexUsage({ value: fixture('codex-usage-free.json'), now: NOW })).toEqual({ windows: [{ label: '30d', windowMinutes: 43200, usedPercent: 0, resetsAt: 1794908330 * 1000 }], skipped: 0 })
  })
  it('prolite: 7d 하나(secondary_window null)', () => {
    const value = { plan_type: 'prolite', rate_limit: { primary_window: { used_percent: 41, limit_window_seconds: 604800, reset_at: 1_800_000_000 }, secondary_window: null } }
    expect(parseCodexUsage({ value, now: NOW })).toEqual({ windows: [{ label: '7d', windowMinutes: 10080, usedPercent: 41, resetsAt: 1_800_000_000_000 }], skipped: 0 })
  })
  it('plus(Orca fixture): 5h + 7d', () => {
    const value = { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 5 * 60 * 60, reset_at: 1_800_000_000 }, secondary_window: { used_percent: 23, limit_window_seconds: 7 * 24 * 60 * 60, reset_at: 1_800_100_000 } } }
    expect(parseCodexUsage({ value, now: NOW })?.windows.map((window) => [window.label, window.usedPercent])).toEqual([['5h', 7], ['7d', 23]])
  })
  it('reset_at 없으면 reset_after_seconds 로, 299분은 5h(1분 오차)', () => {
    const value = { rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 299 * 60, reset_after_seconds: 60 } } }
    expect(parseCodexUsage({ value, now: NOW })).toEqual({ windows: [{ label: '5h', windowMinutes: 299, usedPercent: 1, resetsAt: NOW + 60_000 }], skipped: 0 })
  })
  it('r1 P7 — secondary 칸 이름이 바뀌어 못 읽으면 primary 만 + skipped 1(값을 만들지 않는다)', () => {
    const value = { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 }, secondary_window: { usedPercent: 99, windowSeconds: 604800 } } }
    expect(parseCodexUsage({ value, now: NOW })).toEqual({ windows: [{ label: '5h', windowMinutes: 300, usedPercent: 10, resetsAt: null }], skipped: 1 })
  })
  it('모르는 형태 → null', () => {
    expect(parseCodexUsage({ value: { plan_type: 'plus' }, now: NOW })).toBeNull()
    expect(parseCodexUsage({ value: { rate_limit: { primary_window: null, secondary_window: null } }, now: NOW })).toBeNull()
    expect(parseCodexUsage({ value: { rate_limit: { primary_window: { usedPercent: 5 } } }, now: NOW })).toBeNull()
  })
})

describe('Codex 수집기(E4ⓐⓑⓓⓔ)', () => {
  it('auth.json 읽기 → GET wham/usage, Bearer·ChatGPT-Account-Id·corral UA, 키체인·자식 프로세스 0', async () => {
    const { deps, calls } = fakeDeps({ files: { [FILE]: AUTH }, http: () => response({ status: 200, body: fixture('codex-usage-free.json') }) })
    expect((await codexCollector.fetch(deps)).kind).toBe('ok')
    expect(calls.map((call) => call.kind)).toEqual(['file', 'http'])
    const http = calls[1]
    if (http?.kind !== 'http') throw new Error('http 없음')
    expect(http.url).toBe(CODEX_USAGE_URL)
    expect(http.headers).toMatchObject({ Authorization: `Bearer ${TEST_TOKEN}`, 'ChatGPT-Account-Id': 'acct-SECRET', 'User-Agent': 'corral/test' })
    expect(http.headers['User-Agent']).not.toMatch(/codex/i)
    expect(Object.keys(http.headers)).not.toContain('originator')
  })
  it('CODEX_HOME 을 따른다 · account_id 없으면 헤더 없음', async () => {
    const { deps, calls } = fakeDeps({ env: { CODEX_HOME: '/ch' }, files: { '/ch/auth.json': JSON.stringify({ tokens: { access_token: TEST_TOKEN } }) }, http: () => response({ status: 200, body: fixture('codex-usage-free.json') }) })
    await codexCollector.fetch(deps)
    expect(calls[0]).toEqual({ kind: 'file', file: '/ch/auth.json' })
    const http = calls[1]
    if (http?.kind !== 'http') throw new Error('http 없음')
    expect(Object.keys(http.headers)).not.toContain('ChatGPT-Account-Id')
  })
  it('파일 없음 → unavailable, 요청 0 · API 키 로그인(tokens 없음) → unavailable', async () => {
    const missing = fakeDeps({})
    expect(await codexCollector.fetch(missing.deps)).toEqual({ kind: 'unavailable', reason: 'Codex 로그인 정보 없음' })
    expect(missing.calls).toEqual([{ kind: 'file', file: FILE }])
    const apiKey = fakeDeps({ files: { [FILE]: JSON.stringify({ OPENAI_API_KEY: 'sk-x' }) } })
    expect((await codexCollector.fetch(apiKey.deps)).kind).toBe('unavailable')
  })
  it('손상된 auth.json → error(credential)', async () => {
    const { deps } = fakeDeps({ files: { [FILE]: '{' } })
    expect(await codexCollector.fetch(deps)).toMatchObject({ kind: 'error', error: { kind: 'credential' } })
  })
  for (const [status, kind] of [[401, 'expired'], [429, 'rate_limited'], [500, 'server']] as const) {
    it(`HTTP ${status} → ${kind}`, async () => {
      const { deps } = fakeDeps({ files: { [FILE]: AUTH }, http: () => response({ status }) })
      const outcome = await codexCollector.fetch(deps)
      expect(outcome).toMatchObject({ kind: 'error', error: { kind } })
      if (status === 401) expect(JSON.stringify(outcome)).toContain('codex 실행 시 갱신')
    })
  }
  it('네트워크 → network', async () => {
    const { deps } = fakeDeps({ files: { [FILE]: AUTH }, http: () => Promise.reject(new TypeError('fetch failed')) })
    expect(await codexCollector.fetch(deps)).toMatchObject({ kind: 'error', error: { kind: 'network' } })
  })
  it('결과에 토큰·account_id·email 0 (E6ⓒ)', async () => {
    const base = fixture('codex-usage-free.json')
    const body = { ...(isRecord(base) ? base : {}), email: 'person@example.com', account_id: 'acct-SECRET', user_id: 'user-SECRET' }
    const { deps } = fakeDeps({ files: { [FILE]: AUTH }, http: () => response({ status: 200, body }) })
    const text = JSON.stringify(await codexCollector.fetch(deps))
    for (const secret of [TEST_TOKEN, 'acct-SECRET', 'user-SECRET', 'person@example.com', 'refresh-SECRET']) expect(text).not.toContain(secret)
  })
})
