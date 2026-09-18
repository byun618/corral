import { describe, expect, it } from 'vitest'
import {
  hasCrossedDragThreshold,
  isWithinTabbarGrace,
  resolveBodyDropTarget,
  resolveBodyZone,
  resolveTabbarIndex,
  splitParamsOfZone,
} from './tab-drag.js'

describe('hasCrossedDragThreshold (F-A1-1 — 6px)', () => {
  it('5px 미만은 클릭', () => expect(hasCrossedDragThreshold({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(false))
  it('6px 이상은 드래그', () => expect(hasCrossedDragThreshold({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true))
})

describe('isWithinTabbarGrace (F-A1-2 — 33+8)', () => {
  const headerRect = { left: 0, top: 0, width: 400, height: 33 }
  it('헤더 안이면 탭바', () => expect(isWithinTabbarGrace({ headerRect, point: { x: 10, y: 20 } })).toBe(true))
  it('헤더+grace 경계 안쪽이면 탭바', () => expect(isWithinTabbarGrace({ headerRect, point: { x: 10, y: 40 } })).toBe(true))
  it('헤더+grace 밖이면 본문', () => expect(isWithinTabbarGrace({ headerRect, point: { x: 10, y: 42 } })).toBe(false))
})

describe('resolveBodyZone (F-A1-5 — 5존, 모서리 애매함 없음)', () => {
  const bodyRect = { left: 0, top: 0, width: 200, height: 100 }
  it('왼쪽 25% 안은 left', () => expect(resolveBodyZone({ bodyRect, point: { x: 10, y: 50 } })).toBe('left'))
  it('오른쪽 25% 안은 right', () => expect(resolveBodyZone({ bodyRect, point: { x: 190, y: 50 } })).toBe('right'))
  it('위 25% 안은 up', () => expect(resolveBodyZone({ bodyRect, point: { x: 100, y: 5 } })).toBe('up'))
  it('아래 25% 안은 down', () => expect(resolveBodyZone({ bodyRect, point: { x: 100, y: 95 } })).toBe('down'))
  it('가운데는 center', () => expect(resolveBodyZone({ bodyRect, point: { x: 100, y: 50 } })).toBe('center'))
  it('왼쪽 위 모서리는 더 가까운 변 하나만 이긴다(폭이 넓어 left)', () => {
    // width 200 → left band 50px, height 100 → up band 25px. (5,5) 는 x-frac .025, y-frac .05 → left 가 더 가깝다
    expect(resolveBodyZone({ bodyRect, point: { x: 5, y: 5 } })).toBe('left')
  })
})

describe('splitParamsOfZone (왼/위 = 앞)', () => {
  it('left → row/before', () => expect(splitParamsOfZone('left')).toEqual({ direction: 'row', edge: 'before' }))
  it('right → row/after', () => expect(splitParamsOfZone('right')).toEqual({ direction: 'row', edge: 'after' }))
  it('up → column/before', () => expect(splitParamsOfZone('up')).toEqual({ direction: 'column', edge: 'before' }))
  it('down → column/after', () => expect(splitParamsOfZone('down')).toEqual({ direction: 'column', edge: 'after' }))
})

describe('resolveTabbarIndex', () => {
  it('첫 탭보다 왼쪽이면 0', () => expect(resolveTabbarIndex([50, 150, 250], 10)).toBe(0))
  it('중간이면 그 자리', () => expect(resolveTabbarIndex([50, 150, 250], 100)).toBe(1))
  it('전부보다 오른쪽이면 length', () => expect(resolveTabbarIndex([50, 150, 250], 300)).toBe(3))
})

describe('resolveBodyDropTarget (§4 동작 계약 표)', () => {
  it('제 영역 중앙은 self-noop', () =>
    expect(resolveBodyDropTarget({ zone: 'center', targetGroupId: 'g1', fromGroupId: 'g1', ownTabCount: 3, targetIsEmpty: false })).toEqual({
      kind: 'self-noop',
    }))
  it('다른 영역 중앙은 merge', () =>
    expect(resolveBodyDropTarget({ zone: 'center', targetGroupId: 'g2', fromGroupId: 'g1', ownTabCount: 3, targetIsEmpty: false })).toEqual({
      kind: 'merge',
      groupId: 'g2',
    }))
  it('제 영역 가장자리 + 탭 1개는 invalid', () =>
    expect(resolveBodyDropTarget({ zone: 'right', targetGroupId: 'g1', fromGroupId: 'g1', ownTabCount: 1, targetIsEmpty: false })).toEqual({
      kind: 'invalid',
    }))
  it('제 영역 가장자리 + 탭 2개 이상은 split(기존 splitGroup 이 처리)', () =>
    expect(resolveBodyDropTarget({ zone: 'right', targetGroupId: 'g1', fromGroupId: 'g1', ownTabCount: 2, targetIsEmpty: false })).toEqual({
      kind: 'split',
      groupId: 'g1',
      direction: 'row',
      edge: 'after',
    }))
  it('다른 영역 가장자리는 원 영역 탭 수와 무관하게 split(크로스그룹)', () =>
    expect(resolveBodyDropTarget({ zone: 'down', targetGroupId: 'g2', fromGroupId: 'g1', ownTabCount: 1, targetIsEmpty: false })).toEqual({
      kind: 'split',
      groupId: 'g2',
      direction: 'column',
      edge: 'after',
    }))
  it('빈 영역은 존 계산과 무관하게 merge(다른 영역)', () =>
    expect(resolveBodyDropTarget({ zone: 'left', targetGroupId: 'g2', fromGroupId: 'g1', ownTabCount: 1, targetIsEmpty: true })).toEqual({
      kind: 'merge',
      groupId: 'g2',
    }))
  it('빈 영역이 제 영역이면(있을 수 없지만 방어적으로) self-noop', () =>
    expect(resolveBodyDropTarget({ zone: 'left', targetGroupId: 'g1', fromGroupId: 'g1', ownTabCount: 1, targetIsEmpty: true })).toEqual({
      kind: 'self-noop',
    }))
})
