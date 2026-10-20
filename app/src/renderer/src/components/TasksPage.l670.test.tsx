// @vitest-environment happy-dom
// LIFE-670 — 패널 모드 밀기(P1)·좁은 창 폴백(P4)·선택 카드 가시화(P3)·끌기 자동 스크롤 루프(P5)를 실제 `TasksPage` 경로로 본다.
// happy-dom 은 레이아웃이 없다 — `.tasks-main` 폭과 토큰은 시험이 넣고, 실제 rect 는 격리 회차(`scripts/l670/q-entry.mjs`)가 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkCall, WorkRequest, WorkSettingsState } from '../../../shared/work.js'
import { MemoryActivity } from '../../../main/work/activity-store.js'
import { mockSourceEntry, seedMockDemoState } from '../../../main/work/mock-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FakeCipher, MemoryStore } from '../../../main/work/test-kit.js'
import { TasksPage } from './TasksPage.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let mainWidth = 1280
const TOKENS: Record<string, string> = { '--w-issue-detail': '560px', '--w-tasks-body-min': '320px' }

beforeEach(() => {
  mainWidth = 1280
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // `.tasks-main` 폭만 넣는다(다른 요소는 원래 값).
  const rect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('tasks-main') ? new DOMRect(0, 0, mainWidth, 800) : rect.call(this)
  })
  const computed = window.getComputedStyle
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo)
    const read = style.getPropertyValue.bind(style)
    style.getPropertyValue = (name: string) => TOKENS[name] ?? read(name)
    return style
  })
})
afterEach(() => {
  act(() => { toast.dismiss() })
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function rig({ detailFull = false }: { detailFull?: boolean } = {}): Promise<{ calls: WorkCall[] }> {
  const state = seedMockDemoState()
  let seq = 0
  let listener: (value: WorkSettingsState) => void = () => {}
  const service = new WorkService({
    store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state })]), activity: new MemoryActivity(),
    repos: () => [], onChange: (value) => listener(value), now: () => Date.now(), newId: () => `id-${(seq += 1)}`,
  })
  const added = await service.addConnection({ sourceId: 'mock-jira', token: 'mock_l670_fixture', replaceId: null })
  if (!added.ok) throw new Error('연결 실패')
  const calls: WorkCall[] = []
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({ tasksPage: detailFull ? { detailFull: true } : undefined }),
    setUiPrefs: () => {},
    getWorkSettings: async () => service.settings(),
    onWorkSettings: (next: (value: WorkSettingsState) => void) => { listener = next; return () => {} },
    workRequest: (request: WorkRequest) => { calls.push(request.call); return service.request(request) },
    workActivity: async (query: unknown) => service.activity(query),
  })
  act(() => root.render(createElement('div', null, createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} }), createElement(Toaster))))
  await settle()
  return { calls }
}

const q = (selector: string): Element | null => document.querySelector(selector)
function el(selector: string): HTMLElement {
  const found = q(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`없음: ${selector}`)
  return found
}
function click(selector: string): void {
  const target = el(selector)
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const cards = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-tasks-board] [data-issue-card]')].map((card) => card.dataset.issueCard ?? '')
const layout = (): string | undefined => el('.tasks-main').dataset.detailLayout

describe('P1·P4 상세 배치', () => {
  it('패널 모드는 밀기 — 닫으면 none, ⤢ 는 덮기(full)·밀기 클래스 없음', async () => {
    await rig()
    expect(layout()).toBe('none')
    const [first] = cards()
    click(`[data-tasks-board] [data-issue-card="${first}"]`)
    await settle()
    expect(layout()).toBe('push')
    expect(el('.tasks-main').classList.contains('is-detail-push')).toBe(true)
    click('[data-issue-full]')
    await settle()
    expect(layout()).toBe('full')
    expect(el('.tasks-main').classList.contains('is-detail-push')).toBe(false)
    expect(el('[data-issue-detail]').classList.contains('is-full')).toBe(true)
    click('[data-issue-full]')
    await settle()
    expect(layout()).toBe('push')
    click('[data-issue-close]')
    await settle()
    expect(layout()).toBe('none')
    expect(el('.tasks-main').classList.contains('is-detail-push')).toBe(false)
  })
  it('가용 폭이 320 미만이면 덮기로 물러난다(880 은 밀기, 879 는 덮기)', async () => {
    mainWidth = 879
    await rig()
    click(`[data-tasks-board] [data-issue-card="${cards()[0]}"]`)
    await settle()
    expect(layout()).toBe('overlay')
    expect(el('.tasks-main').classList.contains('is-detail-push')).toBe(false)
    expect(q('[data-issue-detail]')).not.toBeNull()
  })
  it('전체 모드로 저장돼 있으면 열 때 full — detailFull 복원 무회귀', async () => {
    await rig({ detailFull: true })
    click(`[data-tasks-board] [data-issue-card="${cards()[0]}"]`)
    await settle()
    expect(layout()).toBe('full')
    expect(el('[data-issue-detail]').classList.contains('is-full')).toBe(true)
  })
})

describe('P3 선택 카드 가시화', () => {
  it('열 때·바꿀 때 1회씩 nearest 로 맞추고 재렌더에는 다시 부르지 않는다', async () => {
    const spy = vi.fn()
    HTMLElement.prototype.scrollIntoView = spy
    await rig()
    const [first, second] = cards()
    click(`[data-tasks-board] [data-issue-card="${first}"]`)
    await settle()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.contexts[0]).toBe(el(`[data-tasks-board] [data-issue-card="${first}"]`))
    expect(spy.mock.calls[0]?.[0]).toEqual({ block: 'nearest', inline: 'nearest' })
    // 재렌더(⤢ 두 번 · 시간 흐름) — 다시 부르지 않는다.
    click('[data-issue-full]'); await settle()
    click('[data-issue-full]'); await settle(20)
    expect(spy).toHaveBeenCalledTimes(1)
    click(`[data-tasks-board] [data-issue-card="${second}"]`)
    await settle()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.contexts[1]).toBe(el(`[data-tasks-board] [data-issue-card="${second}"]`))
  })
})

describe('P5 끌기 자동 스크롤', () => {
  function rafQueue(): { run: () => void; pending: () => number } {
    const frames = new Map<number, FrameRequestCallback>()
    let id = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { id += 1; frames.set(id, callback); return id })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => { frames.delete(handle) })
    return {
      pending: () => frames.size,
      run: () => { const now = [...frames.values()]; frames.clear(); act(() => { for (const frame of now) frame(0) }) },
    }
  }
  function scroller(): { left: () => number } {
    const box = el('[data-tasks-scroll="board"]')
    let left = 0
    Object.defineProperty(box, 'scrollLeft', { configurable: true, get: () => left, set: (value: number) => { left = Math.max(0, Math.min(2000, value)) } })
    Object.defineProperty(box, 'scrollTop', { configurable: true, get: () => 0, set: () => {} })
    box.getBoundingClientRect = () => new DOMRect(0, 40, 720, 760)
    return { left: () => left }
  }
  const mouse = (at: EventTarget, name: string, x: number, y: number): void => { act(() => { at.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })) }) }

  it('오른쪽 띠에 머물면 프레임마다 밀고, 띠 밖이면 멈추고, 놓기 뒤 루프가 남지 않는다', async () => {
    await rig()
    const raf = rafQueue()
    const box = scroller()
    const handle = el(`[data-tasks-board] [data-issue-card="${cards()[0]}"]`)
    mouse(handle, 'mousedown', 100, 300)
    mouse(document, 'mousemove', 400, 300)
    expect(raf.pending()).toBe(1)
    raf.run()
    expect(box.left()).toBe(0) // 띠 밖 — 움직이지 않고 루프도 끝
    expect(raf.pending()).toBe(0)
    mouse(document, 'mousemove', 720, 300)
    raf.run(); raf.run(); raf.run()
    expect(box.left()).toBe(60)
    expect(raf.pending()).toBe(1)
    mouse(document, 'mousemove', 400, 300)
    raf.run()
    expect(box.left()).toBe(60)
    expect(raf.pending()).toBe(0)
    mouse(document, 'mousemove', 720, 300)
    expect(raf.pending()).toBe(1)
    mouse(document, 'mouseup', 720, 300)
    expect(raf.pending()).toBe(0)
  })
  it('Esc 취소 뒤 루프가 남지 않고, 끌지 않을 때 포인터 이동은 스크롤을 걸지 않는다', async () => {
    await rig()
    const raf = rafQueue()
    scroller()
    mouse(document, 'mousemove', 720, 300)
    expect(raf.pending()).toBe(0)
    const handle = el(`[data-tasks-board] [data-issue-card="${cards()[0]}"]`)
    mouse(handle, 'mousedown', 100, 300)
    mouse(document, 'mousemove', 720, 300)
    expect(raf.pending()).toBe(1)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(raf.pending()).toBe(0)
  })
})
