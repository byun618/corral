// @vitest-environment happy-dom
// LIFE-823 C3·P4 — ⌘P ⌥Enter = 옆으로 열기, Enter = 그대로(고정·활성 영역 — `onOpen`). ⌘Enter 는 더하지 않았다.
// 결과가 따라잡기 전에 누른 Enter(대기 Enter)도 수식키를 들고 간다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickOpen } from './QuickOpen.js'

vi.mock('../file-list-client.js', () => ({
  cachedFileList: ({ root }: { root: string }) => ({ ok: true, root, includeIgnored: false, files: ['src/a.ts', 'b.ts'], truncated: false, ms: 1 }),
  requestFileList: () => ({ result: new Promise(() => {}), cancel: () => {} }),
}))

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let opened: { kind: 'open' | 'side'; rel: string }[]

const render = (): void =>
  act(() =>
    root.render(
      createElement(QuickOpen, {
        root: '/r-wt/side',
        recent: [],
        includeIgnored: false,
        onIncludeIgnored: () => {},
        onOpen: (rel: string) => opened.push({ kind: 'open', rel }),
        onOpenToSide: (rel: string) => opened.push({ kind: 'side', rel }),
        onClose: () => {},
      }),
    ),
  )
const typeQuery = (value: string): void => {
  const input = document.querySelector<HTMLInputElement>('[data-quick-open-input]')
  if (input === null) throw new Error('입력칸 없음')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const enter = (input: { altKey: boolean }): void =>
  act(() => void document.querySelector('[data-quick-open-input]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: input.altKey, bubbles: true, cancelable: true })))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 40 && opened.length === 0; i += 1) await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)))
}

beforeEach(() => {
  opened = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('⌘P 옆으로 열기', () => {
  it('⌥Enter = onOpenToSide', async () => {
    render()
    typeQuery('a.ts')
    enter({ altKey: true })
    await settle()
    expect(opened).toEqual([{ kind: 'side', rel: 'src/a.ts' }])
  })
  it('Enter = onOpen(회귀 0)', async () => {
    render()
    typeQuery('a.ts')
    enter({ altKey: false })
    await settle()
    expect(opened).toEqual([{ kind: 'open', rel: 'src/a.ts' }])
  })
})
