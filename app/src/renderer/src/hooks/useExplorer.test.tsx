// @vitest-environment happy-dom
// LIFE-589 수정 r1 — 탐색기 훅의 요청·응답·변경 경쟁(R1-D), 링크로 펼친 목록의 실경로 변경(R1-G), 보이는 펼침만 읽기(리뷰어 관찰).
// 리뷰어 `renderer-probes.mts`·`alias-probe.mts` 와 같은 모양: 실제 훅을 마운트하고 IPC 응답만 손으로 늦춘다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExplorerEntry, ExplorerListResult, ExplorerPush } from '../../../shared/explorer.js'
import { useExplorer, visibleExpanded, type ExplorerApi } from './useExplorer.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const file = (name: string): ExplorerEntry => ({ name, kind: 'file', link: 'none' })
const dir = (name: string, link: ExplorerEntry['link'] = 'none'): ExplorerEntry => ({ name, kind: 'dir', link })

let host: HTMLDivElement
let root: Root
let api: ExplorerApi | null = null
let listener: ((event: ExplorerPush) => void) | null = null
let calls: string[] = []
/** 논리 경로 → [실경로, 항목]. 응답은 요청 시점 스냅샷이다. */
let fsView = new Map<string, { real: string; entries: ExplorerEntry[] }>()
/** 이 폴더 요청은 손으로 풀 때까지 붙든다. */
let hold = new Set<string>()
let held: (() => void)[] = []

function Probe(): null {
  api = useExplorer({ root: '/fixture', active: true })
  return null
}
const current = (): ExplorerApi => {
  if (api === null) throw new Error('훅 마운트 전')
  return api
}
const push = (event: ExplorerPush): void => {
  if (listener === null) throw new Error('리스너 없음')
  listener(event)
}
const names = (rel: string): string[] | undefined => current().state?.listings.get(rel)?.map((entry) => entry.name)

beforeEach(async () => {
  calls = []
  hold = new Set()
  held = []
  fsView = new Map([
    ['', { real: '', entries: [dir('dir'), dir('src'), dir('alias', 'ok')] }],
    ['dir', { real: 'dir', entries: [file('before.txt')] }],
    ['src', { real: 'src', entries: [file('before.txt')] }],
    ['alias', { real: 'src', entries: [file('before.txt')] }],
  ])
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ explorerShowDotfiles: true, explorerShowIgnored: true }),
    setUiPrefs: () => {},
    explorerWatch: async () => ({ ok: true }),
    explorerRefreshGit: () => {},
    onExplorerEvent: (fn: (event: ExplorerPush) => void) => {
      listener = fn
      return () => {}
    },
    explorerList: ({ rel }: { root: string; rel: string }): Promise<ExplorerListResult> => {
      calls.push(rel)
      const view = fsView.get(rel)
      const result: ExplorerListResult = view === undefined ? { ok: false, dir: rel, code: 'not_found', error: '없음' } : { ok: true, dir: rel, real: view.real, entries: [...view.entries] }
      if (!hold.has(rel)) return Promise.resolve(result)
      return new Promise((resolve) => held.push(() => resolve(result)))
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(Probe)))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  api = null
  listener = null
})

const releaseAll = async (): Promise<void> => {
  const pending = held
  held = []
  hold = new Set()
  await act(async () => {
    for (const resolve of pending) resolve()
  })
}
const grow = (rel: string, name: string): void => {
  const view = fsView.get(rel)
  if (view === undefined) throw new Error(`fixture 없음 ${rel}`)
  view.entries = [...view.entries, file(name)]
}

describe('R1-D 조회 중 도착한 변경', () => {
  it('펼친 폴더 첫 조회 중 변경 → 낡은 응답 뒤 한 번 더 읽어 새 항목이 보인다', async () => {
    hold.add('dir')
    await act(async () => current().expand('dir'))
    grow('dir', 'new.txt')
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['dir/new.txt', 'dir'] }))
    await releaseAll()
    expect(calls.filter((rel) => rel === 'dir')).toHaveLength(2)
    expect(names('dir')).toEqual(['before.txt', 'new.txt'])
  })
  it('읽어 둔 폴더 재조회 중 변경 → 끝난 뒤 한 번 더', async () => {
    await act(async () => current().expand('dir'))
    hold.add('dir')
    await act(async () => current().refresh())
    grow('dir', 'late.txt')
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['dir'] }))
    await releaseAll()
    expect(names('dir')).toEqual(['before.txt', 'late.txt'])
  })
  it('겹친 변경이 여러 번 와도 끝난 뒤 한 번만 더 읽는다(폭주 없음)', async () => {
    await act(async () => current().expand('dir'))
    hold.add('dir')
    calls = []
    await act(async () => current().refresh())
    for (let i = 0; i < 5; i += 1) await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['dir'] }))
    await releaseAll()
    expect(calls.filter((rel) => rel === 'dir')).toHaveLength(2)
  })
})

describe('R1-G 루트 안 디렉터리 링크', () => {
  it('alias(→ src) 만 펼친 상태에서 실경로 src 변경 → alias 목록을 다시 읽는다', async () => {
    await act(async () => current().expand('alias'))
    grow('alias', 'new.txt')
    calls = []
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['src/new.txt', 'src'] }))
    expect(calls).toEqual(['alias'])
    expect(names('alias')).toEqual(['before.txt', 'new.txt'])
  })
})

describe('보이는 펼침만 읽는다 (리뷰어 관찰 — 조상을 접은 뒤 남은 하위 펼침)', () => {
  it('조상을 접으면 새로고침이 하위 펼침을 읽지 않고, 다시 펼치면 기억한 하위도 읽는다', async () => {
    fsView.set('dir', { real: 'dir', entries: [dir('sub')] })
    fsView.set('dir/sub', { real: 'dir/sub', entries: [file('leaf')] })
    await act(async () => current().expand('dir'))
    await act(async () => current().expand('dir/sub'))
    await act(async () => current().collapse('dir'))
    calls = []
    await act(async () => current().refresh())
    expect(calls).toEqual([''])
    expect([...(current().state?.expanded ?? [])]).toEqual(['dir/sub'])
    calls = []
    await act(async () => current().expand('dir'))
    expect(calls.sort()).toEqual(['dir', 'dir/sub'])
  })
  it('visibleExpanded — 조상이 전부 펼쳐진 것만', () => {
    expect(visibleExpanded(new Set(['a', 'a/b', 'c/d', 'a/b/c']))).toEqual(['a', 'a/b', 'a/b/c'])
  })
})
