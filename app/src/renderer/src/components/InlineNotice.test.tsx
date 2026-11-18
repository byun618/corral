// @vitest-environment happy-dom
// LIFE-822 G1-2 — InlineNotice 문구는 한 줄(줄바꿈 없음·넘치면 말줄임), 전문은 `title`. 모든 tone 같다. 해제 단추는 늘 있다.
import fs from 'node:fs'
import path from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { LifecycleNotice } from '../lifecycle-types.js'
import { InlineNotice } from './InlineNotice.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function render(notice: LifecycleNotice): HTMLElement {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(createElement(InlineNotice, { notice, onDismiss: () => {} })))
  const element = host.querySelector<HTMLElement>('.inline-notice-text')
  if (element === null) throw new Error('문구 없음')
  return element
}

const LONG = '파일 탭은 pane 으로 나눌 수 없다 — 이 영역에 탭이 하나뿐이라 새 영역으로 옮길 수도 없다'

describe('InlineNotice 한 줄 (G1-2)', () => {
  it.each([
    { notice: { kind: 'info', message: LONG }, full: LONG },
    { notice: { kind: 'error', message: LONG }, full: `실패: ${LONG}` },
    { notice: { kind: 'rejected', code: 'busy', message: LONG }, full: `herdr 거절 (busy): ${LONG}` },
  ] satisfies { notice: LifecycleNotice; full: string }[])('$notice.kind — title 이 화면 문구 전문과 같다 · 해제 단추가 있다', ({ notice, full }) => {
    const text = render(notice)
    expect(text.textContent).toBe(full)
    expect(text.getAttribute('title')).toBe(full)
    expect(host?.querySelector('[data-notice-dismiss]')).not.toBeNull()
  })

  it('styles.css — 문구는 줄바꿈 없음·넘침 숨김·말줄임, 해제 단추는 줄지 않는다', () => {
    const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8')
    const text = /\.inline-notice-text \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(text).toMatch(/white-space:\s*nowrap/)
    expect(text).toMatch(/overflow:\s*hidden/)
    expect(text).toMatch(/text-overflow:\s*ellipsis/)
    expect(text).toMatch(/min-width:\s*0/)
    expect(text).not.toMatch(/overflow-wrap/)
    const dismiss = /\.inline-notice-dismiss \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(dismiss).toMatch(/flex:\s*0 0 auto/)
  })
})
