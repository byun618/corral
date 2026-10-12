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
let fsView = new Map<string, { real: string; entries: ExplorerEntry[]; id?: string }>()
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
      const result: ExplorerListResult = view === undefined ? { ok: false, dir: rel, code: 'not_found', error: '없음' } : { ok: true, dir: rel, real: view.real, id: view.id ?? `id:${view.real}`, stamp: '', entries: [...view.entries] }
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

describe('R2-A·R3-C 전환당 한 번 — 감시 준비와 무관 (E1ⓓ·E3ⓐ)', () => {
  it('감시 구독이 끝나지 않아도(늦음·안 옴) 활성화 즉시 루트 + 펼친 폴더를 한 번씩 읽고, 늦게 끝나도 더 읽지 않는다', async () => {
    await act(async () => current().expand('dir'))
    let finishWatch: (() => void)[] = []
    Reflect.set(window.corral, 'explorerWatch', ({ on }: { on: boolean }) => (on ? new Promise((resolve) => finishWatch.push(() => resolve({ ok: true }))) : Promise.resolve({ ok: true })))
    for (let i = 0; i < 4; i += 1) {
      probeRoot = i % 2 === 0 ? '/other' : '/fixture'
      calls = []
      finishWatch = []
      await act(async () => root.render(createElement(Probe)))
      // 첫 표시는 감시 준비에 묶이지 않는다.
      expect(calls.length).toBe(probeRoot === '/fixture' ? 2 : 1)
      await act(async () => {
        for (const resolve of finishWatch) resolve()
      })
      const expanded = current().state?.expanded.size ?? 0
      expect(calls.length).toBeLessThanOrEqual(expanded + 1)
    }
  })
})

describe('R3-A 첫 git 스냅샷', () => {
  it('목록·활성화보다 먼저 온 git 스냅샷도 받아 두고, 그 루트를 열면 바로 쓴다', async () => {
    await act(async () => push({ kind: 'git', root: '/fresh', git: { marks: [['new.txt', 'U']], ignored: ['ignored'] }, error: null }))
    probeRoot = '/fresh'
    await act(async () => root.render(createElement(Probe)))
    expect([...(current().state?.git?.marks ?? [])]).toEqual([['new.txt', 'U']])
    expect([...(current().state?.git?.ignored ?? [])]).toEqual(['ignored'])
  })
})

describe('R3-B 부모 실경로·정체가 바뀌면 자손 캐시를 버린다', () => {
  const retarget = (): void => {
    fsView.set('alias', { real: 'dest', id: 'id:dest', entries: [dir('sub')] })
    fsView.set('alias/sub', { real: 'dest/sub', id: 'id:dest/sub', entries: [file('new.txt')] })
  }
  beforeEach(() => {
    fsView.set('alias', { real: 'src', id: 'id:src', entries: [dir('sub')] })
    fsView.set('alias/sub', { real: 'src/sub', id: 'id:src/sub', entries: [file('old.txt')] })
  })
  it('보이는 펼친 자손 — 링크 대상 교체(alias 이벤트만 옴) 뒤 자손을 다시 읽어 새 대상 내용·실경로가 된다', async () => {
    await act(async () => current().expand('alias'))
    await act(async () => current().expand('alias/sub'))
    retarget()
    calls = []
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['alias', ''] }))
    expect(calls.sort()).toEqual(['', 'alias', 'alias/sub'])
    expect(names('alias/sub')).toEqual(['new.txt'])
    expect(current().state?.real.get('alias/sub')).toBe('dest/sub')
  })
  it('접힌 자손 — 읽지 않고 무효 표시, 다시 펼칠 때 새 대상을 읽는다', async () => {
    await act(async () => current().expand('alias'))
    await act(async () => current().expand('alias/sub'))
    await act(async () => current().collapse('alias/sub'))
    retarget()
    calls = []
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['alias', ''] }))
    expect(calls.sort()).toEqual(['', 'alias'])
    expect(current().state?.invalid.has('alias/sub')).toBe(true)
    expect(current().state?.real.has('alias/sub')).toBe(false)
    calls = []
    await act(async () => current().expand('alias/sub'))
    expect(calls).toEqual(['alias/sub'])
    expect(names('alias/sub')).toEqual(['new.txt'])
  })
  it('같은 경로를 지우고 다시 만든 폴더(정체 바뀜)도 자손을 버린다', async () => {
    await act(async () => current().expand('alias'))
    await act(async () => current().expand('alias/sub'))
    fsView.set('alias', { real: 'src', id: 'id:src-recreated', entries: [dir('sub')] })
    fsView.set('alias/sub', { real: 'src/sub', id: 'id:src/sub-2', entries: [file('fresh.txt')] })
    calls = []
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['src'] }))
    expect(calls.sort()).toEqual(['alias', 'alias/sub'])
    expect(names('alias/sub')).toEqual(['fresh.txt'])
  })
})

describe('R4-C 안 보이는 목록의 진행 중 요청 — 늦은 옛 응답이 무효 표시를 지우지 못한다', () => {
  it('자손을 다시 읽는 중에 접고 부모 대상이 바뀐 뒤 옛 응답이 와도 무효로 남고, 다시 펼치면 새 대상을 읽는다', async () => {
    fsView.set('alias', { real: 'src', id: 'id:src', entries: [dir('sub')] })
    fsView.set('alias/sub', { real: 'src/sub', id: 'id:src/sub', entries: [file('old.txt')] })
    await act(async () => current().expand('alias'))
    await act(async () => current().expand('alias/sub'))
    hold.add('alias/sub')
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['src/sub'] }))
    expect(held).toHaveLength(1)
    await act(async () => current().collapse('alias/sub'))
    fsView.set('alias', { real: 'dest', id: 'id:dest', entries: [dir('sub')] })
    fsView.set('alias/sub', { real: 'dest/sub', id: 'id:dest/sub', entries: [file('new.txt')] })
    hold.delete('alias/sub')
    calls = []
    await act(async () => push({ kind: 'changed', root: '/fixture', dirs: ['alias', ''] }))
    // 접힌 자손은 즉시 다시 읽지 않는다(R2-C).
    expect(calls.sort()).toEqual(['', 'alias'])
    await act(async () => held.splice(0).forEach((release) => release()))
    expect(current().state?.invalid.has('alias/sub')).toBe(true)
    calls = []
    await act(async () => current().expand('alias/sub'))
    expect(calls).toEqual(['alias/sub'])
    expect(names('alias/sub')).toEqual(['new.txt'])
    expect(current().state?.real.get('alias/sub')).toBe('dest/sub')
  })
})
