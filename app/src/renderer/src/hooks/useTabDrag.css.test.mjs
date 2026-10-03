// LIFE-494 r1 R1-01 — `useTabDrag.test.tsx` 의 가짜 레이아웃이 흉내 내는 CSS 규칙이 실제로 있는가.
// 문턱에서 동기로 붙는 `body.is-tab-drag` 가 dock(sticky)을 풀어야 첫 mousemove 의 드롭 판정이 제자리 사각형을 읽는다.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

describe('styles.css — 드래그 중 dock 해제 (R1-01)', () => {
  it('dock 은 sticky, `body.is-tab-drag` 아래에선 제자리(relative)·이음매 없음', () => {
    expect(css).toMatch(/^\.main-tab\[data-active-tab-dock\] \{ position: sticky;/m)
    expect(css).toMatch(/^body\.is-tab-drag \.main-tab\[data-active-tab-dock\] \{ position: relative;/m)
    expect(css).toMatch(/^body\.is-tab-drag \.main-tab\[data-active-tab-dock\]::before \{ content: none; \}/m)
  })
})
