// LIFE-824 C3 — 활성 영역 표시 규칙(기존 토큰만). 화면 판정은 G1 캡처가 하고, 여기서는 규칙이 있는가·쓰는 토큰이 이미 있는 것인가를 본다.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const tokens = readFileSync(new URL('./design-tokens.css', import.meta.url), 'utf8')

describe('styles.css — 활성 영역 표시 (C3·P3)', () => {
  it('ⓐ 비활성 영역의 선택 pane(pane 1개 영역 포함)은 비활성 투명도', () => {
    expect(css).toMatch(/^\.tab-group:not\(\.is-active-group\) \.term-pane,\n\.tab-group:not\(\.is-active-group\) \.term-group\[data-pane-count="1"\] > \.term-pane-stack > \.term-pane \{ opacity: var\(--term-inactive-opacity\); \}/m)
  })
  it('ⓑ 활성 탭 선은 활성 영역에만 — 비활성 영역은 숨기고(배경만), 영역이 둘 이상일 때 활성 영역 선은 accent', () => {
    expect(css).toMatch(/^\.tab-group:not\(\.is-active-group\) \.main-tab-indicator \{ display: none; \}/m)
    expect(css).toMatch(/^\.main-area:has\(\.tab-group:not\(\.is-active-group\)\) \.tab-group\.is-active-group \.main-tab\.is-active \.main-tab-indicator \{ background: var\(--accent\); \}/m)
  })
  it('ⓒ 영역 1개면 base — 새 규칙은 전부 비활성 영역이 있을 때만 걸린다(선택자에 `:not(.is-active-group)` 이 들어 있다)', () => {
    const added = css.split('\n').filter((line) => line.includes('is-active-group') && /^\.(tab-group|main-area)/.test(line))
    expect(added.length).toBeGreaterThanOrEqual(4)
    for (const line of added) expect(line).toContain(':not(.is-active-group)')
  })
  it('ⓓ 새 색 토큰 0 — 쓰는 토큰은 이미 정의돼 있다', () => {
    expect(tokens).toMatch(/--accent:/)
    expect(css).toMatch(/--term-inactive-opacity/)
  })
})
