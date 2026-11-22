// @vitest-environment happy-dom
// LIFE-830 B1·B6 — 비교 기준은 루트별(기본 작업 트리), base 대비 + 활성일 때만 main 에 켜 달라고 하고(ref 없이 루트·켜짐만), 바꾸거나 숨으면 끈다.
// base 대비 목록은 `git` push 뒤 `scmBase` push 로 따로 와 루트 상태에 든다(수정 r1 A6) — 다음 `git` push 가 지우지 않고, 다시 켤 때 버린다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExplorerPush } from '../../../shared/explorer.js'
import { useScm, type ScmApi } from './useScm.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let baseCalls: unknown[]
let listener: ((event: ExplorerPush) => void) | null
let api: ScmApi | null

function Probe({ scmRoot, active }: { scmRoot: string | null; active: boolean }): null {
  api = useScm({ root: scmRoot, active })
  return null
}

beforeEach(() => {
  baseCalls = []
  listener = null
  api = null
  Reflect.set(window, 'corral', {
    explorerWatch: async () => ({ ok: true }),
    explorerRefreshGit: () => {},
    onExplorerEvent: (next: (event: ExplorerPush) => void) => {
      listener = next
      return () => {}
    },
    getUiPrefs: async () => ({}),
    setUiPrefs: () => {},
    scmBaseMode: (input: unknown) => baseCalls.push(input),
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (scmRoot: string | null, active = true): void => act(() => root.render(createElement(Probe, { scmRoot, active })))

describe('useScm 비교 기준 (LIFE-830)', () => {
  it('기본 작업 트리 — main 호출 없음, base 대비로 바꾸면 켜고, 작업 트리로 돌아가면 끈다', () => {
    render('/a')
    expect(api?.compare).toBe('working')
    expect(baseCalls).toEqual([])
    act(() => api?.setCompare('base'))
    expect(api?.compare).toBe('base')
    expect(baseCalls).toEqual([{ root: '/a', on: true }])
    act(() => api?.setCompare('working'))
    expect(baseCalls).toEqual([
      { root: '/a', on: true },
      { root: '/a', on: false },
    ])
  })
  it('루트별 선택 — 다른 worktree 로 가면 그 worktree 의 선택(기본 작업 트리), 돌아오면 다시 base 대비', () => {
    render('/a')
    act(() => api?.setCompare('base'))
    render('/b')
    expect(api?.compare).toBe('working')
    expect(baseCalls.at(-1)).toEqual({ root: '/a', on: false })
    render('/a')
    expect(api?.compare).toBe('base')
    expect(baseCalls.at(-1)).toEqual({ root: '/a', on: true })
  })
  it('보기가 숨으면(비활성) 끈다 — 선택은 남는다', () => {
    render('/a')
    act(() => api?.setCompare('base'))
    render('/a', false)
    expect(baseCalls.at(-1)).toEqual({ root: '/a', on: false })
    expect(api?.compare).toBe('base')
  })
  it('scmBase push 를 루트 상태에 든다 — 뒤따르는 git push 는 지우지 않고, base 대비를 다시 켜면 버린다', () => {
    render('/a')
    const info = { name: 'main', source: 'default' as const, mergeBase: 'a'.repeat(40) }
    const git: ExplorerPush = { kind: 'git', root: '/a', git: { marks: [], ignored: [] }, error: null, changes: [], changesTotal: 0 }
    act(() => listener?.({ kind: 'scmBase', root: '/a', base: { ok: true, info, changes: [], total: 0 } }))
    expect(api?.state).toBeNull()
    act(() => listener?.(git))
    expect(api?.state?.base).toBeNull()
    const stamp = api?.state?.stamp
    act(() => listener?.({ kind: 'scmBase', root: '/a', base: { ok: true, info, changes: [], total: 0 } }))
    expect(api?.state?.base).toEqual({ ok: true, info, changes: [], total: 0 })
    expect(api?.state?.stamp).toBe(stamp)
    act(() => listener?.(git))
    expect(api?.state?.base).toEqual({ ok: true, info, changes: [], total: 0 })
    act(() => api?.setCompare('base'))
    expect(api?.state?.base).toBeNull()
  })
})
