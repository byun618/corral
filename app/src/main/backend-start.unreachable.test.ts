// LIFE-532 K1·K2·K3 — 연결 실패(조회 오류 지속 · 링크 최종 실패) 결정 표 ①~⑪, 연속 계수, 「다시 시도」 손.
import { describe, expect, it } from 'vitest'
import type { BackendStatus, RestoreSummary } from '../shared/types.js'
import { BackendRetry, decideBackend, nextScanErrorStreak, SCAN_ERROR_THRESHOLD, type BackendInput, type RetryDeps } from './backend-start.js'

const zero: RestoreSummary = { known: true, total: 0, agents: [] }
const runningDefault = { name: 'default', isDefault: true, running: true }
const stoppedDefault = { name: 'default', isDefault: true, running: false }

function input(patch: Partial<BackendInput>): BackendInput {
  return {
    bound: null,
    binary: { kind: 'found' },
    sessions: [runningDefault],
    selected: 'default',
    link: { phase: 'idle', attempt: 0 },
    restore: zero,
    starter: { phase: 'idle' },
    autoStartUsed: false,
    scan: 'ok',
    scanErrorStreak: 0,
    scanError: null,
    linkError: null,
    ...patch,
  }
}

/** 조회 오류 n 회 연속 — 폴백 목록은 비어 있다(멈춤의 증거가 아니다). */
const scanErrors = (n: number): Partial<BackendInput> => ({ scan: 'error', scanErrorStreak: n, scanError: 'herdr session list: unexpected JSON', sessions: [] })
const status = (patch: Partial<BackendInput>): BackendStatus => decideBackend(input(patch)).status
const scanCard = (session: string | null): BackendStatus => ({ kind: 'unreachable', cause: 'scan', session, error: 'herdr session list: unexpected JSON' })
const linkCard = (session: string): BackendStatus => ({ kind: 'unreachable', cause: 'link', session, error: 'unknown_subscription: nope' })
const linkFailed: Partial<BackendInput> = { link: { phase: 'failed', attempt: 1 }, linkError: 'unknown_subscription: nope' }

describe('decideBackend 연결 실패 (LIFE-532 K1)', () => {
  it('임계는 상수 3', () => {
    expect(SCAN_ERROR_THRESHOLD).toBe(3)
  })
  it('① 조회 오류 1·2회 · 링크 not live → 기존 결과 그대로(ok · 재연결 배너)', () => {
    for (const n of [1, 2]) {
      expect(status({ ...scanErrors(n), link: { phase: 'connecting', attempt: 1 } })).toEqual({ kind: 'ok' })
      expect(status({ ...scanErrors(n), selected: null })).toEqual({ kind: 'ok' })
      expect(status({ ...scanErrors(n), link: { phase: 'reconnecting', attempt: 2 } })).toEqual({ kind: 'reconnecting', session: 'default', attempt: 2 })
    }
  })
  it('② 연속 3회 이상 · 링크 not live → 원인 scan (붙은 세션이 없으면 session null)', () => {
    expect(status({ ...scanErrors(3), link: { phase: 'connecting', attempt: 1 } })).toEqual(scanCard('default'))
    expect(status({ ...scanErrors(7), selected: null })).toEqual(scanCard(null))
    expect(decideBackend(input({ ...scanErrors(3), selected: null })).autostart).toBe(false)
  })
  it('③ 연속 ≥3 이어도 링크 live → ok', () => {
    expect(status({ ...scanErrors(5), link: { phase: 'live', attempt: 1 } })).toEqual({ kind: 'ok' })
  })
  it('④ 연속 ≥3 + 띄우기 실패 → 기존 failed · 띄우는 중 → starting', () => {
    expect(status({ ...scanErrors(3), starter: { phase: 'failed', error: 'boom', logPath: '/l' } })).toEqual({ kind: 'failed', session: 'default', error: 'boom', logPath: '/l' })
    expect(status({ ...scanErrors(3), starter: { phase: 'starting' } })).toEqual({ kind: 'starting', session: 'default' })
  })
  it('⑤ 연속 ≥3 + 바이너리 missing → 기존 missing · stale → 기존 stale', () => {
    expect(status({ ...scanErrors(3), selected: null, binary: { kind: 'missing', searched: ['/x/herdr'], bundled: false } })).toEqual({ kind: 'missing', searched: ['/x/herdr'], bundled: false })
    expect(status({ ...scanErrors(3), binary: { kind: 'stale', path: '/r/herdr', reason: 'r' } })).toEqual({ kind: 'stale', path: '/r/herdr', reason: 'r' })
  })
  it('⑥ 링크 failed + 선택 세션 running(조회 ok) → 원인 link', () => {
    expect(status({ ...linkFailed })).toEqual(linkCard('default'))
    expect(status({ ...linkFailed, selected: 'work', sessions: [stoppedDefault, { name: 'work', isDefault: false, running: true }] })).toEqual(linkCard('work'))
  })
  it('⑦ 링크 failed + 조회 오류(running 모름) → 원인 link — 원인 scan 보다 먼저', () => {
    expect(status({ ...scanErrors(1), ...linkFailed })).toEqual(linkCard('default'))
    expect(status({ ...scanErrors(4), ...linkFailed })).toEqual(linkCard('default'))
  })
  it('⑦ 링크 오류 원문이 없으면 자리 문구', () => {
    expect(status({ link: { phase: 'failed', attempt: 1 }, linkError: null })).toEqual({ kind: 'unreachable', cause: 'link', session: 'default', error: '(링크 오류 원문 없음)' })
  })
  it('⑧ 링크 failed + 세션 멈춤 확인 → 기존 멈춤 카드', () => {
    expect(status({ ...linkFailed, sessions: [stoppedDefault] })).toEqual({ kind: 'confirm', reason: 'exited', session: 'default', restore: zero })
    expect(status({ ...linkFailed, selected: 'work', sessions: [{ name: 'work', isDefault: false, running: false }] })).toEqual({ kind: 'bound-stopped', session: 'work', reason: 'attached' })
  })
  it('⑨ 바인딩 분기 — ② 와 ⑥ 과 같은 결과', () => {
    const bound = { bound: 'work', selected: 'work' }
    expect(status({ ...bound, ...scanErrors(2) })).toEqual({ kind: 'ok' })
    expect(status({ ...bound, ...scanErrors(3) })).toEqual(scanCard('work'))
    expect(status({ ...bound, ...linkFailed, sessions: [{ name: 'work', isDefault: false, running: true }] })).toEqual(linkCard('work'))
    expect(status({ ...bound, ...scanErrors(1), ...linkFailed })).toEqual(linkCard('work'))
    expect(status({ ...bound, ...scanErrors(3), link: { phase: 'live', attempt: 1 } })).toEqual({ kind: 'ok' })
    // 멈춤 확인이면 기존 지정 세션 카드 (⑧ 과 같은 규칙)
    expect(status({ ...bound, ...linkFailed, sessions: [{ name: 'work', isDefault: false, running: false }] })).toEqual({ kind: 'bound-stopped', session: 'work', reason: 'bound' })
  })
  it('⑩ 연속 ≥3 + 재연결 중 → 배너 대신 원인 scan 카드', () => {
    expect(status({ ...scanErrors(3), link: { phase: 'reconnecting', attempt: 4 } })).toEqual(scanCard('default'))
    expect(status({ bound: 'work', selected: 'work', ...scanErrors(3), link: { phase: 'reconnecting', attempt: 4 } })).toEqual(scanCard('work'))
  })
  it('⑪ 조회 성공 1회 뒤 → 계수 0, 카드 걷힘', () => {
    const streak = nextScanErrorStreak({ streak: 5, scan: 'ok' })
    expect(streak).toBe(0)
    expect(status({ scan: 'ok', scanErrorStreak: streak, scanError: null, link: { phase: 'reconnecting', attempt: 1 } })).toEqual({ kind: 'reconnecting', session: 'default', attempt: 1 })
    expect(status({ scan: 'ok', scanErrorStreak: streak, scanError: null })).toEqual({ kind: 'ok' })
  })
})

describe('연속 조회 오류 계수 (LIFE-532 K2)', () => {
  const run = (scans: readonly ('ok' | 'error')[]): number => scans.reduce((streak, scan) => nextScanErrorStreak({ streak, scan }), 0)
  it('오류·오류·성공·오류 → 1', () => {
    expect(run(['error', 'error', 'ok', 'error'])).toBe(1)
  })
  it('오류×3 → 3', () => {
    expect(run(['error', 'error', 'error'])).toBe(3)
  })
  it('첫 조회 전(pending) → 0', () => {
    expect(run([])).toBe(0)
    expect(nextScanErrorStreak({ streak: 0, scan: 'pending' })).toBe(0)
  })
})

describe('「다시 시도」 손 (LIFE-532 K3)', () => {
  function harness(initial: BackendStatus): { retry: BackendRetry; events: string[]; set: (next: BackendStatus) => void; release: () => void } {
    let current = initial
    const events: string[] = []
    let releasePoll: () => void = () => undefined
    const deps: RetryDeps = {
      status: () => current,
      reopenLink: (session) => {
        events.push(`reopen:${session}`)
        return true
      },
      poll: () => {
        events.push('poll')
        return new Promise<void>((resolve) => {
          releasePoll = resolve
        })
      },
      log: (event) => events.push(event),
    }
    return { retry: new BackendRetry(deps), events, set: (next) => { current = next }, release: () => releasePoll() }
  }

  it('ⓐ 원인 scan → 재조회 1회, 링크는 다시 열지 않는다', async () => {
    const h = harness(scanCard(null))
    const done = h.retry.retry()
    h.release()
    await done
    expect(h.events).toEqual(['backend.retry', 'poll'])
  })
  it('ⓑ 원인 link → 선택 세션 링크를 다시 연 뒤 재조회', async () => {
    const h = harness(linkCard('default'))
    const done = h.retry.retry()
    h.release()
    await done
    expect(h.events).toEqual(['backend.retry', 'reopen:default', 'poll'])
  })
  it('ⓑ 다시 열 세션을 못 찾으면 기록하고 재조회만', async () => {
    const events: string[] = []
    const retry = new BackendRetry({ status: () => linkCard('gone'), reopenLink: () => false, poll: async () => { events.push('poll') }, log: (event) => events.push(event) })
    await retry.retry()
    expect(events).toEqual(['backend.retry', 'backend.retry.link_missing', 'poll'])
  })
  it('ⓒ 연결 실패가 아니면 아무것도 하지 않는다 (확인·실패·ok·재연결)', async () => {
    const others: BackendStatus[] = [
      { kind: 'ok' },
      { kind: 'confirm', reason: 'stopped', session: 'default', restore: zero },
      { kind: 'failed', session: 'default', error: 'boom', logPath: null },
      { kind: 'reconnecting', session: 'default', attempt: 1 },
    ]
    for (const other of others) {
      const h = harness(other)
      await h.retry.retry()
      expect(h.events).toEqual(['backend.retry.ignored'])
    }
  })
  it('ⓓ 연타·동시 호출은 진행 중인 한 번으로 합친다 — 링크를 겹쳐 열지 않는다', async () => {
    const h = harness(linkCard('default'))
    const calls = [h.retry.retry(), h.retry.retry(), h.retry.retry()]
    h.release()
    await Promise.all(calls)
    expect(h.events.filter((event) => event === 'reopen:default')).toHaveLength(1)
    expect(h.events.filter((event) => event === 'poll')).toHaveLength(1)
    expect(h.events.filter((event) => event === 'backend.retry.joined')).toHaveLength(2)
    // 끝난 뒤의 새 클릭은 다시 정한다 — 이제 연결 실패가 아니면 무시
    h.set({ kind: 'ok' })
    await h.retry.retry()
    expect(h.events.at(-1)).toBe('backend.retry.ignored')
  })
})
