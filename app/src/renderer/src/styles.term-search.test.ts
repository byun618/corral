// LIFE-812 fix2 R2-4 — 좁은 pane 에서도 검색 입력칸이 보이게 하는 축소 규칙. 실제 폭 판정(300px 대 pane 에서 ⌘F)은 G1 회차가 한다 — 여기서는 규칙이 있는가만.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
const rule = (selector: string): string => {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`${selector} 규칙 없음`)
  return css.slice(start, css.indexOf('}', start))
}

describe('styles.css — 검색 막대 축소 (R2-4)', () => {
  it('막대는 pane 폭 안으로 준다', () => {
    expect(rule('.term-search')).toMatch(/max-width: calc\(100% - \d+px\)/)
  })
  it('입력칸은 줄되 최소 폭을 지킨다', () => {
    expect(rule('.term-search-input')).toMatch(/flex: 0 1 200px/)
    expect(rule('.term-search-input')).toMatch(/min-width: 48px/)
  })
  it('상태 문구는 말줄임으로 먼저 지고, 단추는 줄지 않는다', () => {
    expect(rule('.term-search-status')).toMatch(/min-width: 0/)
    expect(rule('.term-search-status')).toMatch(/text-overflow: ellipsis/)
    expect(rule('.term-search .explorer-tool')).toMatch(/flex: none/)
  })
})
