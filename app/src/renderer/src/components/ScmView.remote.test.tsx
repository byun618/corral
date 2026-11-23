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

describe('수정 r2 D2 — 앞 요청의 늦은 응답이 다음 동작의 진행 표시를 지우지 않는다', () => {
  it('main 끝 알림 뒤·응답 전에 다음 동작을 누르면, 앞 응답이 와도 다음 동작의 진행 표시·취소가 남는다', async () => {
    const pending: ((result: ScmRemoteResult) => void)[] = []
    const listeners: ((event: { root: string; action: 'fetch' | 'pull' | 'push' | 'publish' | null }) => void)[] = []
    const cancels: { root: string }[] = []
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({}),
      setUiPrefs: () => {},
      onExplorerEvent: () => () => {},
      explorerWatch: async () => ({ ok: true }),
      explorerRefreshGit: () => {},
      scmRemoteState: async () => ({ action: null }),
      onScmRemoteEvent: (listener: (typeof listeners)[number]) => (listeners.push(listener), () => {}),
      scmRemote: () => new Promise<ScmRemoteResult>((resolve) => pending.push(resolve)),
      scmRemoteCancel: async (input: { root: string }) => (cancels.push(input), { ok: true }),
    })
    const emit = (action: 'fetch' | 'push' | null): void => listeners.forEach((listener) => listener({ root: '/A', action }))
    const Harness = (): React.JSX.Element => view(useScm({ root: '/A', active: false }), status())
    await act(async () => root.render(createElement(Harness)))
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="push"]')?.click())
    await act(async () => emit('push'))
    // main: push 끝 — 슬롯을 지우고 알림(null)을 보낸 뒤 응답은 아직.
    await act(async () => emit(null))
    expect(actions()).toEqual(['fetch', 'pull', 'push'])
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="fetch"]')?.click())
    expect(pending).toHaveLength(2)
    await act(async () => emit('fetch'))
    // 이제 앞 push 의 응답이 온다.
    await act(async () => pending[0]?.({ ok: true }))
    expect(host.querySelector('[data-scm-remote-progress]')?.getAttribute('data-scm-remote-progress')).toBe('fetch')
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-cancel]')?.click())
    expect(cancels).toEqual([{ root: '/A' }])
    // 알림이 아직 안 왔을 때(응답만 늦음)도 같다 — 다음 요청이 진행 항목을 세웠으면 앞 응답은 지우지 않는다.
    await act(async () => emit(null))
    await act(async () => pending[1]?.({ ok: false, code: 'cancelled', error: '취소됨' }))
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="pull"]')?.click())
    expect(host.querySelector('[data-scm-remote-progress]')?.getAttribute('data-scm-remote-progress')).toBe('pull')
    await act(async () => pending[2]?.({ ok: true }))
    expect(actions()).toEqual(['fetch', 'pull', 'push'])
  })
})

describe('수정 r3 E1 — 앞 요청의 늦은 응답은 안내를 쓰지 않는다(같은 루트의 마지막 요청만)', () => {
  const setup = (): { pending: ((result: ScmRemoteResult) => void)[]; emit: (action: 'fetch' | 'push' | null) => void } => {
    const pending: ((result: ScmRemoteResult) => void)[] = []
    const listeners: ((event: { root: string; action: 'fetch' | 'push' | null }) => void)[] = []
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({}),
      setUiPrefs: () => {},
      onExplorerEvent: () => () => {},
      explorerWatch: async () => ({ ok: true }),
      explorerRefreshGit: () => {},
      scmRemoteState: async () => ({ action: null }),
      onScmRemoteEvent: (listener: (typeof listeners)[number]) => (listeners.push(listener), () => {}),
      scmRemote: () => new Promise<ScmRemoteResult>((resolve) => pending.push(resolve)),
      scmRemoteCancel: async () => ({ ok: true }),
    })
    return { pending, emit: (action) => listeners.forEach((listener) => listener({ root: '/A', action })) }
  }
  const notice = (): string | null => host.querySelector('[data-scm-notice]')?.textContent ?? null
  /** push 시작 → main 끝 알림(응답은 보류) → fetch 시작. 그 뒤 두 응답의 순서를 시험이 정한다. */
  const pushThenFetch = async (emit: (action: 'fetch' | 'push' | null) => void): Promise<void> => {
    const Harness = (): React.JSX.Element => view(useScm({ root: '/A', active: false }), status())
    await act(async () => root.render(createElement(Harness)))
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="push"]')?.click())
    await act(async () => emit('push'))
    await act(async () => emit(null))
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="fetch"]')?.click())
    await act(async () => emit('fetch'))
  }
  it('다음 요청(fetch)의 실패 안내를 앞 요청(push)의 늦은 성공 응답이 지우지 않는다', async () => {
    const { pending, emit } = setup()
    await pushThenFetch(emit)
    await act(async () => pending[1]?.({ ok: false, code: 'git_error', error: 'FETCH_FAILED_MARKER' }))
    expect(notice()).toContain('FETCH_FAILED_MARKER')
    await act(async () => emit(null))
    await act(async () => pending[0]?.({ ok: true }))
    expect(notice()).toContain('FETCH_FAILED_MARKER')
  })
  it('다음 요청이 성공해 비운 안내를 앞 요청의 늦은 실패 응답이 되살리지 않는다', async () => {
    const { pending, emit } = setup()
    await pushThenFetch(emit)
    await act(async () => pending[1]?.({ ok: true }))
    await act(async () => emit(null))
    expect(notice()).toBeNull()
    await act(async () => pending[0]?.({ ok: false, code: 'git_error', error: 'OLD_PUSH_ERROR' }))
    expect(notice()).toBeNull()
  })
})

describe('수정 r4 F1·F4 — 상태 응답·취소 실패·busy 안내', () => {
  type Listener = (event: { root: string; action: 'fetch' | 'push' | null }) => void
  const setup = (input: { state: () => Promise<{ action: 'fetch' | 'push' | null }>; cancel?: () => Promise<{ ok: boolean }> }): { listeners: Listener[]; pending: ((result: ScmRemoteResult) => void)[]; states: number[] } => {
    const listeners: Listener[] = []
    const pending: ((result: ScmRemoteResult) => void)[] = []
    const states: number[] = []
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({}),
      setUiPrefs: () => {},
      onExplorerEvent: () => () => {},
      explorerWatch: async () => ({ ok: true }),
      explorerRefreshGit: () => {},
      scmRemoteState: () => (states.push(1), input.state()),
      onScmRemoteEvent: (listener: Listener) => (listeners.push(listener), () => {}),
      scmRemote: () => new Promise<ScmRemoteResult>((resolve) => pending.push(resolve)),
      scmRemoteCancel: input.cancel ?? (async () => ({ ok: true })),
    })
    return { listeners, pending, states }
  }
  const progress = (): string | null => host.querySelector('[data-scm-remote-progress]')?.getAttribute('data-scm-remote-progress') ?? null
  const notice = (): string | null => host.querySelector('[data-scm-notice]')?.textContent ?? null

  it('F1 상태 응답이 끝 알림보다 늦게 옴 — 낡은 「진행 중」 응답은 버린다(진행 표시 고착 없음)', async () => {
    let answer: (value: { action: 'fetch' | 'push' | null }) => void = () => {}
    const { listeners } = setup({ state: () => new Promise((resolve) => (answer = resolve)) })
    const Harness = (): React.JSX.Element => view(useScm({ root: '/A', active: false }), status())
    // 마운트(reload 뒤) — 상태를 묻는 동안 main 의 끝 알림이 먼저 온다.
    await act(async () => root.render(createElement(Harness)))
    await act(async () => listeners.forEach((listener) => listener({ root: '/A', action: null })))
    await act(async () => answer({ action: 'push' }))
    expect(progress()).toBeNull()
    expect(actions()).toEqual(['fetch', 'pull', 'push'])
  })

  it('F1 취소가 ok:false(main 에 그 동작 없음) — 진행 항목을 풀고 상태를 다시 묻는다', async () => {
    let calls = 0
    const { states } = setup({ state: async () => (calls += 1) === 1 ? { action: 'push' } : { action: null }, cancel: async () => ({ ok: false }) })
    const Harness = (): React.JSX.Element => view(useScm({ root: '/A', active: false }), status())
    // 끝 알림을 놓쳐 마운트 때 받은 「진행 중」 이 남은 상태.
    await act(async () => root.render(createElement(Harness)))
    expect(progress()).toBe('push')
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-cancel]')?.click())
    expect(progress()).toBeNull()
    expect(states).toHaveLength(2)
    expect(actions()).toEqual(['fetch', 'pull', 'push'])
  })

  it('F4 끝 알림은 busy 안내만 지운다 — 다른 실패 안내는 그대로', async () => {
    const { listeners, pending } = setup({ state: async () => ({ action: 'push' }) })
    const emit = (action: 'fetch' | 'push' | null): void => listeners.forEach((listener) => listener({ root: '/A', action }))
    const Harness = (): React.JSX.Element => view(useScm({ root: '/A', active: false }), status())
    await act(async () => root.render(createElement(Harness)))
    // 렌더러가 모르는 동작이 도는 중 — 끝 알림 뒤 누른 것처럼 진행 항목을 비우고 누르면 busy.
    await act(async () => emit(null))
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="fetch"]')?.click())
    await act(async () => pending[0]?.({ ok: false, code: 'busy', error: '' }))
    expect(notice()).toContain('원격 동작이 이미 진행 중입니다.')
    await act(async () => emit(null))
    expect(notice()).toBeNull()
    // 실패 안내는 끝 알림에 지워지지 않는다.
    await act(async () => host.querySelector<HTMLElement>('[data-scm-remote-action="push"]')?.click())
    await act(async () => pending[1]?.({ ok: false, code: 'git_error', error: 'PUSH_FAILED_MARKER' }))
    expect(notice()).toContain('PUSH_FAILED_MARKER')
    await act(async () => emit(null))
    expect(notice()).toContain('PUSH_FAILED_MARKER')
  })
})
