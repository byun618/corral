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

let probeRoot = '/fixture'
function Probe(): null {
  api = useExplorer({ root: probeRoot, active: true })
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
  probeRoot = '/fixture'
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

describe('R2-B 링크 첫 응답 전 변경', () => {
  it('alias(→ src) 첫 읽기 중 실경로 src 변경 → 응답 뒤 한 번 더 읽어 새 항목이 보인다', async () => {
    hold.add('alias')
    await act(async () => current().expand('alias'))
    grow('alias', 'during.txt')
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['src/during.txt', 'src'] }))
    await releaseAll()
    expect(calls.filter((rel) => rel === 'alias')).toHaveLength(2)
    expect(names('alias')).toEqual(['before.txt', 'during.txt'])
  })
})

describe('R2-C 변경도 보이는 폴더만 — 안 보이는 캐시는 무효 표시, 다시 펼칠 때 읽는다', () => {
  it('조상을 접은 뒤 하위 변경은 읽지 않고, 다시 펼치면 최신을 읽는다', async () => {
    fsView.set('dir', { real: 'dir', entries: [dir('sub')] })
    fsView.set('dir/sub', { real: 'dir/sub', entries: [file('leaf')] })
    await act(async () => current().expand('dir'))
    await act(async () => current().expand('dir/sub'))
    await act(async () => current().collapse('dir'))
    calls = []
    fsView.set('dir/sub', { real: 'dir/sub', entries: [file('leaf'), file('hidden-change.txt')] })
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['dir/sub/hidden-change.txt', 'dir/sub'] }))
    expect(calls).toEqual([])
    expect(current().state?.invalid.has('dir/sub')).toBe(true)
    await act(async () => current().expand('dir'))
    expect(calls).toEqual(['dir/sub'])
    expect(names('dir/sub')).toEqual(['leaf', 'hidden-change.txt'])
    expect(current().state?.invalid.has('dir/sub')).toBe(false)
  })
})

describe('R2-D 펼친 폴더 삭제 → 재생성', () => {
  it('not_found 뒤 같은 경로가 다시 생기면 changed 로 복구한다', async () => {
    await act(async () => current().expand('dir'))
    fsView.delete('dir')
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['dir', ''] }))
    expect(current().state?.errors.get('dir')).toMatch(/^not_found/)
    fsView.set('dir', { real: 'dir', entries: [file('recreated.txt')] })
    calls = []
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['dir', ''] }))
    expect(calls.sort()).toEqual(['', 'dir'])
    expect(names('dir')).toEqual(['recreated.txt'])
    expect(current().state?.errors.has('dir')).toBe(false)
  })
  it('일시적 읽기 오류 뒤에도 그 폴더 변경으로 회복한다', async () => {
    await act(async () => current().expand('dir'))
    const list = Reflect.get(window.corral, 'explorerList')
    Reflect.set(window.corral, 'explorerList', (input: { root: string; rel: string }): Promise<ExplorerListResult> =>
      input.rel === 'dir' ? Promise.resolve({ ok: false, dir: 'dir', code: 'io_error', error: 'EIO' }) : list(input))
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['dir'] }))
    expect(current().state?.errors.get('dir')).toMatch(/^io_error/)
    Reflect.set(window.corral, 'explorerList', list)
    grow('dir', 'after.txt')
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['dir'] }))
    expect(names('dir')).toEqual(['before.txt', 'after.txt'])
  })
})

describe('R2-A 감시 시작 확인 뒤 한 번만 읽는다 (E1ⓓ)', () => {
  it('감시 구독이 끝나기 전에는 읽지 않고, 끝나면 루트 + 펼친 폴더를 한 번씩 — 전환마다 펼친 폴더 수 + 1', async () => {
    await act(async () => current().expand('dir'))
    let finishWatch: (() => void)[] = []
    Reflect.set(window.corral, 'explorerWatch', ({ on }: { on: boolean }) => (on ? new Promise((resolve) => finishWatch.push(() => resolve({ ok: true }))) : Promise.resolve({ ok: true })))
    for (let i = 0; i < 4; i += 1) {
      probeRoot = i % 2 === 0 ? '/other' : '/fixture'
      calls = []
      finishWatch = []
      await act(async () => root.render(createElement(Probe)))
      expect(calls).toEqual([])
      await act(async () => {
        for (const resolve of finishWatch) resolve()
      })
      const expanded = current().state?.expanded.size ?? 0
      expect(calls.length).toBeLessThanOrEqual(expanded + 1)
      expect(calls.length).toBe(probeRoot === '/fixture' ? 2 : 1)
    }
  })
})
