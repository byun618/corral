// LIFE-670 P5 — 끌기 자동 스크롤 띠 판정·속도 순수 시험.
import { describe, expect, it } from 'vitest'
import { DRAG_SCROLL_EDGE_PX, DRAG_SCROLL_MAX_PX, dragScrollStep } from './task-drag-scroll.js'

const rect = { left: 300, top: 100, right: 1000, bottom: 700 }

describe('dragScrollStep', () => {
  it('띠 밖(가운데)이면 멈춤', () => {
    expect(dragScrollStep({ point: { x: 650, y: 400 }, rect })).toEqual({ dx: 0, dy: 0 })
    expect(dragScrollStep({ point: { x: 1000 - DRAG_SCROLL_EDGE_PX - 1, y: 400 }, rect })).toEqual({ dx: 0, dy: 0 })
  })
  it('사각형 밖이면 멈춤 — 패널 위로 나가도 스크롤하지 않는다', () => {
    expect(dragScrollStep({ point: { x: 1001, y: 400 }, rect })).toEqual({ dx: 0, dy: 0 })
    expect(dragScrollStep({ point: { x: 299, y: 400 }, rect })).toEqual({ dx: 0, dy: 0 })
    expect(dragScrollStep({ point: { x: 650, y: 701 }, rect })).toEqual({ dx: 0, dy: 0 })
  })
  it('오른쪽·왼쪽·위·아래 띠는 그 방향으로, 가장자리에서 상한', () => {
    expect(dragScrollStep({ point: { x: 1000, y: 400 }, rect })).toEqual({ dx: DRAG_SCROLL_MAX_PX, dy: 0 })
    expect(dragScrollStep({ point: { x: 300, y: 400 }, rect })).toEqual({ dx: -DRAG_SCROLL_MAX_PX, dy: 0 })
    expect(dragScrollStep({ point: { x: 650, y: 100 }, rect })).toEqual({ dx: 0, dy: -DRAG_SCROLL_MAX_PX })
    expect(dragScrollStep({ point: { x: 650, y: 700 }, rect })).toEqual({ dx: 0, dy: DRAG_SCROLL_MAX_PX })
  })
  it('가장자리에 가까울수록 빠르고 상한을 넘지 않는다', () => {
    const speeds = [961, 970, 980, 990, 1000].map((x) => dragScrollStep({ point: { x, y: 400 }, rect }).dx)
    expect(speeds).toEqual([...speeds].sort((a, b) => a - b))
    expect(speeds[0]).toBeGreaterThanOrEqual(1)
    expect(Math.max(...speeds)).toBe(DRAG_SCROLL_MAX_PX)
  })
  it('모서리면 대각선', () => {
    expect(dragScrollStep({ point: { x: 1000, y: 700 }, rect })).toEqual({ dx: DRAG_SCROLL_MAX_PX, dy: DRAG_SCROLL_MAX_PX })
  })
  it('그릇이 80px 보다 좁으면 띠를 절반으로 — 양쪽 띠가 겹치지 않는다', () => {
    const narrow = { left: 0, top: 0, right: 60, bottom: 600 }
    expect(dragScrollStep({ point: { x: 30, y: 300 }, rect: narrow }).dx).toBe(0)
    expect(dragScrollStep({ point: { x: 60, y: 300 }, rect: narrow }).dx).toBe(DRAG_SCROLL_MAX_PX)
  })
})
