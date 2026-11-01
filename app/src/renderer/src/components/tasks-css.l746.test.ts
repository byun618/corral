// LIFE-746 게이트 ① 수정 1 — 레인 머리 sticky 가 가로 스크롤 끝에서 왼쪽이 잘리지 않게 보이는 폭으로 묶였는지(표식 수준).
// jsdom·happy-dom 은 sticky 배치를 계산하지 않는다 — 실제 위치 판정은 설치본 CDP 측정(raw/claude/g1r1/).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./tasks.css', import.meta.url), 'utf8')
const rule = (selector: string): string => {
  const at = css.indexOf(`${selector} {`)
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
}

describe('레인 머리 폭 (LIFE-746 g1r1)', () => {
  it('보드 스크롤 그릇이 크기 그릇이다', () => {
    expect(rule('[data-tasks-scroll="board"]')).toMatch(/container-type:\s*inline-size/)
  })
  it('레인 머리 최대 폭이 보이는 폭(100cqi)을 넘지 않는다', () => {
    expect(rule('.tasks-lane-head')).toMatch(/position:\s*sticky/)
    expect(rule('.tasks-lane-head')).toMatch(/max-width:\s*min\(100%,\s*100cqi\)/)
  })
})
