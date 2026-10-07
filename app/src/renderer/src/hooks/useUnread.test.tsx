// @vitest-environment happy-dom
// LIFE-471 `useUnread` — K1 창 신호(visibilityState·hasFocus → `<html data-window-attention>`) · K8ⓑ 벨 저장 왕복
// (렌더러 `setUiPrefs` 패치 → 저장소 → 재시작 → 렌더러 hydrate) · r1 L2 하이드레이션 경계 · 터미널 입력 키 판정.
// 저장소는 main `UiPrefsStore` 의 부분 갱신과 같은 모양의 가짜다(렌더러 tsconfig 는 main 파일을 못 싣는다) — 그 칸을 main 이
// 파일에서 읽고 쓰는 왕복은 `main/ui-prefs.test.ts` 「안 읽음 벨 영속」 이 본다. 둘이 같은 칸 이름(`unreadWorktrees`)을 쓰는 것은
// 타입(`Partial<UiPrefs>`)이 강제한다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type UiPrefs } from '../../../shared/types.js'
import { isTerminalInputKey, promptedOf, useUnread, type UnreadView } from './useUnread.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
const probe: { view: UnreadView | null } = { view: null }
/** main 스토어처럼 부분 갱신을 덮어쓰는 저장소 — 재시작 = 같은 디스크 값에서 새로 읽기. */
let disk: Partial<UiPrefs> = {}
const store = {
  get: (): Partial<UiPrefs> => ({ unreadWorktrees: [], pinnedWorktrees: [], ...disk }),
  update: (patch: Partial<UiPrefs>): void => {
    disk = JSON.parse(JSON.stringify({ ...disk, ...patch }))
  },
}
let focused = true
let visibility: DocumentVisibilityState = 'visible'

function Probe(): null {
  probe.view = useUnread({ state: null, viewedPaneId: null, activeWorktree: null })
  return null
}
async function mount(): Promise<void> {
  root = createRoot(host)
  await act(async () => {
    root.render(createElement(Probe))
  })
  // getUiPrefs 의 then 이 돌고 hydrate 렌더까지.
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  disk = {}
  focused = true
  visibility = 'visible'
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  Reflect.set(window, 'corral', {
    getUiPrefs: (): Promise<Partial<UiPrefs>> => Promise.resolve(store.get()),
    setUiPrefs: (patch: Partial<UiPrefs>): void => store.update(patch),
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('K1 창 신호 — renderer visibilityState + hasFocus', () => {
  it('ⓐⓑ 보임+포커스 = watched · 앱 blur(다른 앱이 앞) = away · 숨김/최소화(visibilitychange hidden) = away · 복귀 = watched', async () => {
    await mount()
    expect(document.documentElement.dataset['windowAttention']).toBe('watched')
    focused = false
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(document.documentElement.dataset['windowAttention']).toBe('away')
    focused = true
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(document.documentElement.dataset['windowAttention']).toBe('watched')
    visibility = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(document.documentElement.dataset['windowAttention']).toBe('away')
  })
})

describe('K8ⓑ 벨 저장 왕복 (렌더러 패치 → main 스토어 → 재시작 → 렌더러)', () => {
  it('켠 벨이 재시작 뒤 그대로 · 끈 벨은 사라진다 · 파일의 다른 칸은 그대로', async () => {
    store.update({ pinnedWorktrees: ['/r/p'] })
    await mount()
    act(() => probe.view?.markUnread('/r/a'))
    act(() => probe.view?.markUnread('/r/b'))
    act(() => probe.view?.markRead('/r/b'))
    expect(disk.unreadWorktrees).toEqual(['/r/a'])
    act(() => root.unmount())
    // 재시작 — 새 렌더러가 저장소에서 hydrate 한다.
    await mount()
    expect([...(probe.view?.worktrees ?? [])]).toEqual(['/r/a'])
    expect(store.get().pinnedWorktrees).toEqual(['/r/p'])
  })
  it('hydrate 전에는 쓰지 않는다 — 저장된 벨을 빈 집합으로 덮지 않는다', async () => {
    store.update({ unreadWorktrees: ['/r/kept'] })
    const writes: Array<Partial<UiPrefs>> = []
    Reflect.set(window, 'corral', {
      getUiPrefs: (): Promise<Partial<UiPrefs>> => Promise.resolve(store.get()),
      setUiPrefs: (patch: Partial<UiPrefs>): void => {
        writes.push(patch)
        store.update(patch)
      },
    })
    await mount()
    expect(writes).toEqual([])
    expect([...(probe.view?.worktrees ?? [])]).toEqual(['/r/kept'])
    act(() => probe.view?.toggle('/r/kept'))
    expect(writes).toEqual([{ unreadWorktrees: [] }])
  })
})

describe('r1 L2 하이드레이션 경계', () => {
  it('ⓐ ui-prefs 읽기가 실패하면 이번 실행 동안 벨을 저장하지 않는다 — 저장값을 덮지 않는다', async () => {
    const writes: Array<Partial<UiPrefs>> = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Reflect.set(window, 'corral', {
      getUiPrefs: (): Promise<Partial<UiPrefs>> => Promise.reject(new Error('ipc down')),
      setUiPrefs: (patch: Partial<UiPrefs>): void => {
        writes.push(patch)
      },
    })
    await mount()
    act(() => probe.view?.markUnread('/r/a'))
    act(() => probe.view?.toggle('/r/a'))
    expect(writes).toEqual([])
  })
  it('ⓑ 읽기 전에 누른 Mark Read 는 저장값과 합친 뒤에 다시 적용된다 — 읽음 처리한 벨이 되살아나지 않는다', async () => {
    store.update({ unreadWorktrees: ['/r/a', '/r/b'] })
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    Reflect.set(window, 'corral', {
      getUiPrefs: async (): Promise<Partial<UiPrefs>> => {
        await gate
        return store.get()
      },
      setUiPrefs: (patch: Partial<UiPrefs>): void => store.update(patch),
    })
    root = createRoot(host)
    await act(async () => {
      root.render(createElement(Probe))
    })
    act(() => probe.view?.markRead('/r/a'))
    act(() => probe.view?.markUnread('/r/c'))
    await act(async () => {
      release?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect([...(probe.view?.worktrees ?? [])].sort()).toEqual(['/r/b', '/r/c'])
    expect(disk.unreadWorktrees).toEqual(['/r/b', '/r/c'])
  })
})

describe('r2 F-D 읽기 재시도', () => {
  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
    })
  }
  it('첫 읽기가 실패하면 한 번 다시 읽는다 — 다시 읽기가 되면 저장값과 합치고 그 뒤 변경은 저장된다', async () => {
    store.update({ unreadWorktrees: ['/r/kept'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let reads = 0
    Reflect.set(window, 'corral', {
      getUiPrefs: (): Promise<Partial<UiPrefs>> => {
        reads += 1
        return reads === 1 ? Promise.reject(new Error('ipc down')) : Promise.resolve(store.get())
      },
      setUiPrefs: (patch: Partial<UiPrefs>): void => store.update(patch),
    })
    await mount()
    await settle()
    expect(reads).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect([...(probe.view?.worktrees ?? [])]).toEqual(['/r/kept'])
    act(() => probe.view?.markUnread('/r/a'))
    expect(disk.unreadWorktrees).toEqual(['/r/a', '/r/kept'])
  })
  it('다시 읽기도 실패하면 두 번에서 멈추고 남긴다 — 저장값을 덮지 않는다', async () => {
    const writes: Array<Partial<UiPrefs>> = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let reads = 0
    Reflect.set(window, 'corral', {
      getUiPrefs: (): Promise<Partial<UiPrefs>> => {
        reads += 1
        return Promise.reject(new Error('ipc down'))
      },
      setUiPrefs: (patch: Partial<UiPrefs>): void => {
        writes.push(patch)
      },
    })
    await mount()
    await settle()
    act(() => probe.view?.markUnread('/r/a'))
    act(() => probe.view?.toggle('/r/a'))
    await settle()
    expect(reads).toBe(2)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[1]?.[0])).toContain('다시 읽기도 실패')
    expect(writes).toEqual([])
  })
})

describe('터미널 입력 키 (198 terminal-keydown-fit)', () => {
  it('수식키 단독·자동 반복·⌘ 조합은 입력이 아니다', () => {
    expect(isTerminalInputKey({ key: 'a', repeat: false, metaKey: false })).toBe(true)
    expect(isTerminalInputKey({ key: 'Enter', repeat: false, metaKey: false })).toBe(true)
    expect(isTerminalInputKey({ key: 'Shift', repeat: false, metaKey: false })).toBe(false)
    expect(isTerminalInputKey({ key: 'a', repeat: true, metaKey: false })).toBe(false)
    expect(isTerminalInputKey({ key: 'c', repeat: false, metaKey: true })).toBe(false)
  })
})

describe('promptedOf (LIFE-502) — transcript 에 사람 발화가 있나', () => {
  it('transcript provider 는 firstPrompt·lastPrompt 로 · 그 밖(셸·미지원 provider)은 판단 불가(null)', () => {
    expect(promptedOf({ agent: null, digest: EMPTY_SESSION_DIGEST })).toBe(null)
    expect(promptedOf({ agent: 'opencode', digest: { ...EMPTY_SESSION_DIGEST, lastPrompt: 'x' } })).toBe(null)
    for (const agent of ['claude', 'codex', 'grok']) {
      expect(promptedOf({ agent, digest: EMPTY_SESSION_DIGEST })).toBe(false)
      expect(promptedOf({ agent, digest: { ...EMPTY_SESSION_DIGEST, firstPrompt: '안녕' } })).toBe(true)
      expect(promptedOf({ agent, digest: { ...EMPTY_SESSION_DIGEST, lastPrompt: '안녕' } })).toBe(true)
    }
  })
})
