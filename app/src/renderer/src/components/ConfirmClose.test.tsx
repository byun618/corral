// @vitest-environment happy-dom
// LIFE-693 — 확인 창 구조 보조 시험. happy-dom 은 레이아웃을 계산하지 않으므로 스크롤·노출(K1·K2)은 여기서 판정하지 않고,
// 「전용 클래스가 붙는가 · 제목·버튼이 스크롤 영역 밖이고 목록·체크박스는 안인가」 만 본다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfirmClose } from './ConfirmClose.js'

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

describe('ConfirmClose (LIFE-693)', () => {
  it('전용 클래스를 붙이고 머리·바닥은 스크롤 영역 밖, 설명·목록·다시 묻지 않음은 안에 둔다', () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ key: `w${index}`, label: `~/ws-${index}`, foreground: ['claude --resume', 'node mcp'] }))
    act(() =>
      root.render(
        createElement(ConfirmClose, {
          copy: { kind: 'command', title: '실행 중인 탭을 닫을까', body: ['설명'], confirm: '닫기', dontAskAgain: { label: '다시 묻지 않음', patch: { confirmClosePinnedTab: false } } },
          rows,
          onConfirm: () => {},
          onCancel: () => {},
        }),
      ),
    )
    const modal = host.querySelector('[data-confirm-close-modal]')
    const scroll = host.querySelector('[data-confirm-close-scroll]')
    // 요소가 없으면 `contains(null)` 이 false 라 「밖」 단언이 그냥 통과한다 — 먼저 전부 있는지 본다(f1 D).
    const outside = ['[data-confirm-close-title]', '[data-confirm-close-x]', '[data-close-confirm-cancel]', '[data-close-confirm-ok]']
    const inside = ['[data-confirm-close-body="0"]', '[data-confirm-close-fg]', '[data-dont-ask-again-input]']
    for (const selector of [...outside, ...inside]) expect(host.querySelector(selector), selector).not.toBeNull()
    expect(modal?.classList.contains('modal-confirm-close')).toBe(true)
    // 공통 클래스는 그대로 — 폭·모양은 다른 확인 창과 같다.
    expect(modal?.classList.contains('modal-confirm')).toBe(true)
    expect(scroll?.classList.contains('modal-body')).toBe(true)
    expect(scroll?.parentElement).toBe(modal)
    for (const selector of outside) expect(scroll?.contains(host.querySelector(selector)), selector).toBe(false)
    for (const selector of inside) expect(scroll?.contains(host.querySelector(selector)), selector).toBe(true)
    expect(host.querySelectorAll('[data-confirm-close-fg] li')).toHaveLength(40 * 3)
  })
})
