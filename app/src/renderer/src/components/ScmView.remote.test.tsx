// @vitest-environment happy-dom
// LIFE-831 — 소스 제어 원격 UI: 머리 아래 줄(브랜치 · ↓behind ↑ahead · 가져오기·끌어오기·밀어넣기/브랜치 게시) · 진행 중 진행 표시 + 취소 ·
// base 대비·git 상태 없음에서 숨김 · K8ⓒ 결과(안내·진행 해제)는 요청 루트의 상태에만(지금 보이는 다른 루트는 그대로).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScmRemoteInput, ScmRemoteResult } from '../../../shared/scm-remote.js'
import type { GitStatusSummary } from '../../../shared/types.js'
import { useScm, type ScmApi } from '../hooks/useScm.js'
import { ScmView } from './ScmView.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const status = (input: Partial<GitStatusSummary> = {}): GitStatusSummary => ({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null, ...input })
const api = (input: Partial<ScmApi>): ScmApi => ({
  root: '/r',
  state: { changes: [], total: 0, error: null, stamp: 1, base: null },
  version: 1,
  stampOf: () => 1,
  refresh: () => {},
  mode: 'list',
  setMode: () => {},
  compare: 'working',
  setCompare: () => {},
  write: { message: '', notice: null, committing: false },
  setMessage: () => {},
  dismissNotice: () => {},
  run: async () => {},
  remote: null,
  runRemote: async () => {},
  cancelRemote: () => {},
  ...input,
})
const view = (scm: ScmApi, git: GitStatusSummary | null): React.JSX.Element => createElement(ScmView, { scm, status: git, title: null, mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen: () => {} })
const actions = (): (string | null)[] => [...host.querySelectorAll('[data-scm-remote-action]')].map((element) => element.getAttribute('data-scm-remote-action'))

describe('원격 줄 (D1·K2·K4ⓑ)', () => {
  it('upstream 있음 — 브랜치 · ↓1 ↑2 · 가져오기·끌어오기·밀어넣기, 누르면 누른 루트로 요청', () => {
    const sent: ScmRemoteInput[] = []
    act(() => root.render(view(api({ runRemote: async (input) => void sent.push(input) }), status())))
    expect(host.querySelector('[data-scm-branch]')?.textContent).toBe('main')
    const counts = host.querySelector('[data-scm-behind]')
    expect([counts?.getAttribute('data-scm-behind'), counts?.getAttribute('data-scm-ahead'), counts?.textContent]).toEqual(['1', '2', '↓1 ↑2'])
    expect(actions()).toEqual(['fetch', 'pull', 'push'])
    expect(host.querySelector('[data-scm-remote-action="push"]')?.getAttribute('aria-label')).toBe('밀어넣기')
    for (const action of actions()) act(() => host.querySelector<HTMLElement>(`[data-scm-remote-action="${action}"]`)?.click())
    expect(sent).toEqual([
      { action: 'fetch', root: '/r' },
      { action: 'pull', root: '/r' },
      { action: 'push', root: '/r' },
    ])
  })
  it('upstream 없음 — push 단추가 「브랜치 게시」(글자 보임), 숫자 없음 · 분리된 HEAD 는 이름 자리에 표시', () => {
    act(() => root.render(view(api({}), status({ upstream: null, ahead: null, behind: null, branch: 'newb' }))))
    expect(actions()).toEqual(['fetch', 'pull', 'publish'])
    expect(host.querySelector('[data-scm-remote-action="publish"]')?.textContent).toContain('브랜치 게시')
    expect(host.querySelector('[data-scm-behind]')).toBeNull()
    act(() => root.render(view(api({}), status({ branch: null, upstream: null, ahead: null, behind: null }))))
    expect(host.querySelector('[data-scm-branch]')?.textContent).toBe('(분리된 HEAD)')
  })
  it('진행 중 — 단추 셋 대신 진행 표시 + 취소(누르면 cancelRemote), 숫자는 그대로', () => {
    let cancelled = 0
    act(() => root.render(view(api({ remote: 'push', cancelRemote: () => void (cancelled += 1) }), status())))
    expect(actions()).toEqual([])
    expect(host.querySelector('[data-scm-remote-progress]')?.getAttribute('aria-label')).toBe('밀어넣는 중…')
    expect(host.querySelector('[data-scm-remote]')?.getAttribute('data-scm-remote-busy')).toBe('push')
    act(() => host.querySelector<HTMLElement>('[data-scm-remote-cancel]')?.click())
    expect(cancelled).toBe(1)
    expect(host.querySelector('[data-scm-behind]')).not.toBeNull()
  })
  it('없음 — base 대비 · 저장소 아님(목록 오류) · git 상태 없음/오류', () => {
    act(() => root.render(view(api({ compare: 'base' }), status())))
    expect(host.querySelector('[data-scm-remote]')).toBeNull()
    act(() => root.render(view(api({ state: { changes: null, total: 0, error: 'fatal: not a git repository', stamp: 1, base: null } }), status())))
    expect(host.querySelector('[data-scm-remote]')).toBeNull()
    act(() => root.render(view(api({}), null)))
    expect(host.querySelector('[data-scm-remote]')).toBeNull()
    act(() => root.render(view(api({}), status({ error: 'git 실패' }))))
    expect(host.querySelector('[data-scm-remote]')).toBeNull()
  })
})

describe('K8ⓒ — 원격 결과는 요청 루트에만 (useScm)', () => {
  it('A 에서 밀어넣기를 누르고 B 로 옮긴 뒤 실패 = B 의 안내·단추는 그대로, A 로 돌아오면 A 의 안내 · 진행 중 연타는 요청 1번 · 취소는 지금 루트로', async () => {
    const pending: { input: ScmRemoteInput; resolve: (result: ScmRemoteResult) => void }[] = []
    const cancels: { root: string }[] = []
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({}),
      setUiPrefs: () => {},
      scmRemoteState: async () => ({ action: null }),
      onScmRemoteEvent: () => () => {},
      onExplorerEvent: () => () => {},
      explorerWatch: async () => ({ ok: true }),
      explorerRefreshGit: () => {},
      scmRemote: (input: ScmRemoteInput) => new Promise<ScmRemoteResult>((resolve) => pending.push({ input, resolve })),
      scmRemoteCancel: async (input: { root: string }) => (cancels.push(input), { ok: true }),
    })
    let scm: ScmApi | null = null
    const Harness = ({ at }: { at: string }): React.JSX.Element => {
      const value = useScm({ root: at, active: false })
      scm = value
      return view(value, status())
    }
    const current = (): ScmApi => {
      if (scm === null) throw new Error('no scm')
      return scm
    }
    await act(async () => root.render(createElement(Harness, { at: '/A' })))
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="push"]')?.click())
    expect(current().remote).toBe('push')
    await act(async () => void current().runRemote({ action: 'fetch', root: '/A' }))
    expect(pending.map((item) => item.input)).toEqual([{ action: 'push', root: '/A' }])
    // B 로 옮긴다 — B 는 진행 중이 아니다(단추 셋).
    await act(async () => root.render(createElement(Harness, { at: '/B' })))
    expect(current().remote).toBeNull()
    expect(actions()).toEqual(['fetch', 'pull', 'push'])
    act(() => current().cancelRemote())
    expect(cancels).toEqual([])
    await act(async () => pending[0]?.resolve({ ok: false, code: 'git_error', error: ' ! [rejected]        main -> main (fetch first)' }))
    expect(current().root).toBe('/B')
    expect(current().write.notice).toBeNull()
    expect(host.querySelector('[data-scm-notice]')).toBeNull()
    await act(async () => root.render(createElement(Harness, { at: '/A' })))
    expect(current().remote).toBeNull()
    expect(host.querySelector('[data-scm-notice="error"] pre')?.textContent).toContain('끌어온 뒤 다시 밀어넣으세요')
    // 진행 중 취소 — 지금 루트(A)로.
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="fetch"]')?.click())
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-cancel]')?.click())
    expect(cancels).toEqual([{ root: '/A' }])
    await act(async () => pending[1]?.resolve({ ok: false, code: 'cancelled', error: '취소됨' }))
    expect(host.querySelector('[data-scm-notice="info"] pre')?.textContent).toBe('가져오기를 취소했습니다.')
    // 성공은 앞 안내를 지운다(D10).
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="pull"]')?.click())
    await act(async () => pending[2]?.resolve({ ok: true }))
    expect(host.querySelector('[data-scm-notice]')).toBeNull()
  })
})

describe('수정 r1 C6 — 다시 그려진 렌더러가 main 의 진행 상태를 되살린다', () => {
  it('마운트 때 진행 중이면 진행 표시·취소 · main 의 끝 알림으로 단추 셋 복귀 · busy 결과면 물어서 진행 표시', async () => {
    const states = new Map<string, 'fetch' | 'pull' | 'push' | 'publish'>([['/A', 'push']])
    const listeners: ((event: { root: string; action: 'fetch' | 'pull' | 'push' | 'publish' | null }) => void)[] = []
    const cancels: { root: string }[] = []
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({}),
      setUiPrefs: () => {},
      onExplorerEvent: () => () => {},
      explorerWatch: async () => ({ ok: true }),
      explorerRefreshGit: () => {},
      scmRemoteState: async ({ root: at }: { root: string }) => ({ action: states.get(at) ?? null }),
      onScmRemoteEvent: (listener: (typeof listeners)[number]) => (listeners.push(listener), () => {}),
      scmRemote: async () => ({ ok: false, code: 'busy', error: '원격 동작 진행 중' }),
      scmRemoteCancel: async (input: { root: string }) => (cancels.push(input), { ok: true }),
    })
    const Harness = ({ at }: { at: string }): React.JSX.Element => view(useScm({ root: at, active: false }), status())
    await act(async () => root.render(createElement(Harness, { at: '/A' })))
    expect(host.querySelector('[data-scm-remote-progress]')?.getAttribute('data-scm-remote-progress')).toBe('push')
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-cancel]')?.click())
    expect(cancels).toEqual([{ root: '/A' }])
    states.delete('/A')
    await act(async () => listeners.forEach((listener) => listener({ root: '/A', action: null })))
    expect(actions()).toEqual(['fetch', 'pull', 'push'])
    // 다른 창(또는 reload 전)이 시작한 동작 — 누르면 busy, 물어서 진행 표시로.
    states.set('/A', 'fetch')
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="pull"]')?.click())
    expect(host.querySelector('[data-scm-remote-progress]')?.getAttribute('data-scm-remote-progress')).toBe('fetch')
    expect(host.querySelector('[data-scm-notice="info"] pre')?.textContent).toBe('원격 동작이 이미 진행 중입니다.')
    // 다른 루트의 알림은 지금 루트에 안 붙는다.
    await act(async () => listeners.forEach((listener) => listener({ root: '/B', action: 'push' })))
    expect(host.querySelector('[data-scm-remote-progress]')?.getAttribute('data-scm-remote-progress')).toBe('fetch')
  })
})
