// @vitest-environment happy-dom
// LIFE-803 r1 R1-03·R1-04 — 검색 결과 열기의 App 연결(상태 표 행): 다른 탭 활성화 → 권리 삭제(effect), 다음 프레임 적용 전 탭·worktree 확인,
// 마크다운 미리보기 탭은 요청 없음(C5ⓗ), 포커스는 「요청 뒤 포커스 순번·활성 요소가 그대로」 일 때만(한 규칙).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSearchOpen, type SearchOpenDeps, type SearchOpenRequest } from './useSearchOpen.js'
import { RevealSlot } from '../file-reveal.js'
import type { ViewStateStore } from '../components/FileView.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let open: (input: SearchOpenRequest) => void = () => undefined
let slot: RevealSlot
let frames: (() => void)[]
let log: string[]
let seq: number
let path: string | null
let active: Element | null
let preview: boolean
const store: ViewStateStore = new Map()

function Harness({ activeTabId, worktreePath = '/w' }: { activeTabId: string | null; worktreePath?: string | null }): null {
  const deps: SearchOpenDeps = {
    worktreePath,
    store: worktreePath === null ? null : store,
    activeTabId,
    currentWorktreePath: () => path,
    markdownPreview: () => preview,
    openFile: (input) => log.push(`open ${input.rel} ${input.preview}`),
    focusOpened: (input) => {
      seq += 1
      log.push(`focusOpened ${input.rel} held=${input.held()}`)
      return seq
    },
    focusSeq: () => seq,
    revealLive: (input) => log.push(`revealLive ${input.tabId}`),
    frame: (run) => frames.push(run),
    activeElement: () => active,
    slot,
  }
  open = useSearchOpen(deps)
  return null
}
const render = (props: { activeTabId: string | null; worktreePath?: string | null }): void => act(() => root.render(<Harness {...props} />))
const ROW: SearchOpenRequest = { rel: 'a.ts', line: 12, column: 3, preview: true }

beforeEach(() => {
  slot = new RevealSlot()
  frames = []
  log = []
  seq = 0
  path = '/w'
  preview = false
  active = document.createElement('button')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('상태 표 — 결과 행 클릭', () => {
  it('요청을 세우고 탐색기와 같은 열기·포커스 루프를 부른다', () => {
    render({ activeTabId: 'term:1' })
    open(ROW)
    expect(slot.current).toMatchObject({ store, tabId: 'file:a.ts', target: { line: 12, column: 3 } })
    expect(log).toEqual(['open a.ts true', 'focusOpened a.ts held=true'])
  })
  it('worktree 가 없으면 아무것도 안 한다', () => {
    render({ activeTabId: null, worktreePath: null })
    open(ROW)
    expect(slot.current).toBeNull()
    expect(log).toEqual([])
  })
})

describe('상태 표 — 사용자가 다른 탭·다른 그룹을 활성화 (App effect 연결)', () => {
  it('활성 탭이 요청 탭이 되면 남고, 다른 탭이 되면 지운다', () => {
    render({ activeTabId: 'term:1' })
    open(ROW)
    render({ activeTabId: 'file:a.ts' })
    expect(slot.current?.tabId).toBe('file:a.ts')
    render({ activeTabId: 'file:other.ts' })
    expect(slot.current).toBeNull()
  })
  it('worktree 가 바뀌어도(저장소가 다름) 지운다', () => {
    render({ activeTabId: 'file:a.ts' })
    open(ROW)
    render({ activeTabId: 'file:a.ts', worktreePath: null })
    expect(slot.current).toBeNull()
  })
})

describe('상태 표 — 이미 붙은 편집기(다음 프레임 적용 전 확인)', () => {
  it('요청이 그대로고 worktree 가 그대로면 적용', () => {
    render({ activeTabId: 'file:a.ts' })
    open(ROW)
    frames.splice(0).forEach((run) => run())
    expect(log.at(-1)).toBe('revealLive file:a.ts')
  })
  it('그 사이 활성 worktree 가 바뀌었으면 적용 0', () => {
    render({ activeTabId: 'file:a.ts' })
    open(ROW)
    path = '/other'
    frames.splice(0).forEach((run) => run())
    expect(log.some((line) => line.startsWith('revealLive'))).toBe(false)
  })
  it('그 사이 다른 결과를 눌렀으면 앞 프레임은 적용 0(뒤 것만)', () => {
    render({ activeTabId: 'file:a.ts' })
    open(ROW)
    open({ ...ROW, rel: 'b.ts' })
    frames.splice(0).forEach((run) => run())
    expect(log.filter((line) => line.startsWith('revealLive'))).toEqual(['revealLive file:b.ts'])
  })
})

describe('r1 보강 — 포커스(요청 뒤 포커스가 옮겨 갔으면 커서·보이기만)', () => {
  it('포커스 순번·활성 요소가 그대로면 mayFocus 참', () => {
    render({ activeTabId: 'term:1' })
    open(ROW)
    expect(slot.current?.mayFocus()).toBe(true)
  })
  it('그 뒤 포커스 이동(⌘⇧F 등 — 순번 상승)이 있었으면 거짓', () => {
    render({ activeTabId: 'term:1' })
    open(ROW)
    seq += 1
    expect(slot.current?.mayFocus()).toBe(false)
  })
  it('사용자가 검색 입력칸을 눌러 활성 요소가 옮겨 갔으면 거짓 — 포커스 루프의 held 도 같은 판정', () => {
    const captured: { held: () => boolean } = { held: () => true }
    const deps: SearchOpenDeps = {
      worktreePath: '/w', store, activeTabId: null, currentWorktreePath: () => '/w', markdownPreview: () => false,
      openFile: () => undefined, focusOpened: (input) => { captured.held = input.held; return 1 }, focusSeq: () => 1, revealLive: () => undefined,
      frame: () => undefined, activeElement: () => active, slot,
    }
    function One(): null {
      open = useSearchOpen(deps)
      return null
    }
    act(() => root.render(<One />))
    open(ROW)
    const view = document.createElement('div')
    view.setAttribute('data-search-view', '')
    const input = document.createElement('input')
    view.append(input)
    document.body.append(view)
    active = input
    expect(slot.current?.mayFocus()).toBe(false)
    expect(captured.held()).toBe(false)
    view.remove()
  })
})

describe('r1 보강 C5ⓗ — 마크다운 미리보기 모드 탭', () => {
  it('요청을 남기지 않고(앞 요청도 그 탭이면 버림) base 처럼 연다', () => {
    render({ activeTabId: 'term:1' })
    slot.request({ store, tabId: 'file:a.ts', target: { line: 1, column: 1 }, mayFocus: () => true })
    preview = true
    open(ROW)
    expect(slot.current).toBeNull()
    expect(frames).toHaveLength(0)
    expect(log).toEqual(['open a.ts true', 'focusOpened a.ts held=true'])
  })
})
