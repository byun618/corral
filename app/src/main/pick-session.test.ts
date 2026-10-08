// LIFE-556 fix2 M2 — 설치본은 동봉 서버의 default 세션 하나에 고정한다. 다른 세션이 돌아도 고르기·기동 결정이 그쪽으로 가지 않는다.
import { describe, expect, it } from 'vitest'
import { decideBackend, type BackendInput } from './backend-start.js'
import { pickSessionName, pinnedSessions } from './pick-session.js'

const handle = (name: string, running: boolean) => ({ name, isDefault: name === 'default', running, socketPath: `/s/${name}.sock`, sessionDir: null })
const backend = (sessions: BackendInput['sessions'], selected: string | null): BackendInput => ({
  bound: null, binary: { kind: 'found' }, sessions, selected, link: { phase: 'idle', attempt: 0 },
  restore: { known: true, total: 0, agents: [] }, starter: { phase: 'idle' }, autoStartUsed: false, scan: 'ok',
})

describe('pinnedSessions (LIFE-556 fix2 M2)', () => {
  it('bundled: default stopped, another session running → no fallback; default is autostarted instead', () => {
    const sessions = pinnedSessions({ sessions: [handle('default', false), handle('other', true)], bundled: true, bound: null })
    expect(sessions.map((session) => session.name)).toEqual(['default'])
    expect(pickSessionName({ sessions, wanted: undefined }).name).toBeNull()
    expect(decideBackend(backend(sessions, null)).autostart).toBe(true)
  })

  it('bundled: with default running, a newly running session never becomes the choice', () => {
    const before = pinnedSessions({ sessions: [handle('default', true)], bundled: true, bound: null })
    const after = pinnedSessions({ sessions: [handle('other', true), handle('default', true)], bundled: true, bound: null })
    expect(pickSessionName({ sessions: before, wanted: undefined }).name).toBe('default')
    expect(pickSessionName({ sessions: after, wanted: undefined }).name).toBe('default')
    expect(after.some((session) => session.name === 'other')).toBe(false)
  })

  it('development (not bundled): list and fallback unchanged', () => {
    const sessions = pinnedSessions({ sessions: [handle('default', false), handle('other', true)], bundled: false, bound: null })
    expect(sessions.map((session) => session.name)).toEqual(['default', 'other'])
    expect(pickSessionName({ sessions, wanted: undefined }).name).toBe('other')
  })

  it('explicit binding wins over the pin', () => {
    const sessions = pinnedSessions({ sessions: [handle('work', true)], bundled: true, bound: 'work' })
    expect(pickSessionName({ sessions, wanted: 'work' }).name).toBe('work')
  })
})
