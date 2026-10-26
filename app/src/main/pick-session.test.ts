// LIFE-556 fix2 M2 — 설치본은 동봉 서버의 default 세션 하나에 고정한다. 다른 세션이 돌아도 고르기·기동 결정이 그쪽으로 가지 않는다.
import { describe, expect, it } from 'vitest'
import { decideBackend, type BackendInput } from './backend-start.js'
import { pickSessionName, pinnedSessions } from './pick-session.js'

const handle = (name: string, running: boolean) => ({ name, isDefault: name === 'default', running, socketPath: `/s/${name}.sock`, sessionDir: null })
const backend = (sessions: BackendInput['sessions'], selected: string | null): BackendInput => ({
  bound: null, binary: { kind: 'found' }, sessions, selected, link: { phase: 'idle', attempt: 0 },
  restore: { known: true, total: 0, agents: [] }, starter: { phase: 'idle' }, autoStartUsed: false, scan: 'ok',
  scanErrorStreak: 0, scanError: null, linkError: null,
})

describe('pinnedSessions (LIFE-556 fix2 M2)', () => {
  it('bundled: default stopped, another session running → no fallback; default is autostarted instead', () => {
    const sessions = pinnedSessions({ sessions: [handle('default', false), handle('other', true)], pinDefault: true, bound: null })
    expect(sessions.map((session) => session.name)).toEqual(['default'])
    expect(pickSessionName({ sessions, wanted: undefined }).name).toBeNull()
    expect(decideBackend(backend(sessions, null)).autostart).toBe(true)
  })

  it('bundled: with default running, a newly running session never becomes the choice', () => {
    const before = pinnedSessions({ sessions: [handle('default', true)], pinDefault: true, bound: null })
    const after = pinnedSessions({ sessions: [handle('other', true), handle('default', true)], pinDefault: true, bound: null })
    expect(pickSessionName({ sessions: before, wanted: undefined }).name).toBe('default')
    expect(pickSessionName({ sessions: after, wanted: undefined }).name).toBe('default')
    expect(after.some((session) => session.name === 'other')).toBe(false)
  })

  it('development (not bundled): list and fallback unchanged', () => {
    const sessions = pinnedSessions({ sessions: [handle('default', false), handle('other', true)], pinDefault: false, bound: null })
    expect(sessions.map((session) => session.name)).toEqual(['default', 'other'])
    expect(pickSessionName({ sessions, wanted: undefined }).name).toBe('other')
  })

  it('explicit binding wins over the pin', () => {
    const sessions = pinnedSessions({ sessions: [handle('work', true)], pinDefault: true, bound: 'work' })
    expect(pickSessionName({ sessions, wanted: 'work' }).name).toBe('work')
  })
})

describe('pinnedSessions — 레포 guard 개발 실행 (LIFE-561 G2, C4ⓑ)', () => {
  it('돌고 있는 이름 세션만 있고 default 가 없으면 붙지 않고 default 를 기동한다', () => {
    const sessions = pinnedSessions({ sessions: [handle('life417-native', true), handle('life373-a', true)], pinDefault: true, bound: null })
    expect(sessions).toEqual([])
    expect(pickSessionName({ sessions, wanted: undefined }).name).toBeNull()
    expect(decideBackend(backend(sessions, null))).toEqual({ status: { kind: 'starting', session: 'default' }, autostart: true })
  })
  it('default 가 멈췄고 이름 세션이 돌면 이름 세션으로 내려가지 않는다 — 재개 대상이 있으면 확인 카드', () => {
    const sessions = pinnedSessions({ sessions: [handle('default', false), handle('life417-native', true)], pinDefault: true, bound: null })
    expect(pickSessionName({ sessions, wanted: undefined }).name).toBeNull()
    const input: BackendInput = { ...backend(sessions, null), restore: { known: true, total: 2, agents: [{ kind: 'claude', count: 2 }] } }
    expect(decideBackend(input).status.kind).toBe('confirm')
  })
  it('default 가 돌면 default 에 붙는다', () => {
    const sessions = pinnedSessions({ sessions: [handle('life417-native', true), handle('default', true)], pinDefault: true, bound: null })
    expect(pickSessionName({ sessions, wanted: undefined }).name).toBe('default')
  })
  it('종전 경로(로그인 셸 herdr)는 고르기 규칙 그대로 — 이름 세션 폴백 유지', () => {
    const sessions = pinnedSessions({ sessions: [handle('default', false), handle('other', true)], pinDefault: false, bound: null })
    expect(pickSessionName({ sessions, wanted: undefined }).name).toBe('other')
  })
})
