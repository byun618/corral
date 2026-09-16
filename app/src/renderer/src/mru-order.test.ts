// MRU 순서 모델 단위 시험 (F3-2·F3-4). 키·화면은 하네스가 본다 — 여기서는 순서와 자리만.

import { describe, expect, it } from 'vitest'
import { groupGlyphs, MRU_LIMIT, openMru, orderMru, stepMru, touchMru } from './mru-order.js'

const many = (count: number): string[] => Array.from({ length: count }, (_, index) => `p${index + 1}`)

describe('최근 순서 (touchMru)', () => {
  it('고른 pane 이 맨 앞으로 오고 중복은 남지 않는다', () => {
    expect(touchMru({ history: ['p1', 'p2', 'p3'], paneId: 'p3' })).toEqual(['p3', 'p1', 'p2'])
  })

  it('처음 보는 pane 도 맨 앞이다', () => {
    expect(touchMru({ history: ['p1'], paneId: 'p9' })).toEqual(['p9', 'p1'])
  })
})

describe('목록 만들기 (orderMru)', () => {
  it('기록 순 뒤에 **아직 안 고른 pane** 이 받은 순서대로 붙는다', () => {
    expect(orderMru({ history: ['p3', 'p1'], livePaneIds: ['p1', 'p2', 'p3', 'p4'] })).toEqual(['p3', 'p1', 'p2', 'p4'])
  })

  it('죽은 pane 은 기록에 있어도 빠진다', () => {
    expect(orderMru({ history: ['p9', 'p1'], livePaneIds: ['p1', 'p2'] })).toEqual(['p1', 'p2'])
  })

  it('기록이 비어도 목록은 선다 (방금 켠 창)', () => {
    expect(orderMru({ history: [], livePaneIds: ['p1', 'p2'] })).toEqual(['p1', 'p2'])
  })
})

describe('여는 자리 (openMru)', () => {
  it('앞으로 열면 1번 — 직전 pane 이다', () => {
    expect(openMru({ count: 4, backward: false })).toBe(1)
  })

  it('뒤로 열면 맨 끝이다', () => {
    expect(openMru({ count: 4, backward: true })).toBe(3)
  })

  it('한 줄뿐이면 갈 곳이 없다', () => {
    expect(openMru({ count: 1, backward: false })).toBe(0)
    expect(openMru({ count: 0, backward: true })).toBe(0)
  })

  it('상한을 넘는 목록에서는 상한 끝이 끝이다', () => {
    expect(openMru({ count: 30, backward: true })).toBe(MRU_LIMIT - 1)
  })
})

describe('홀드 중 이동 (stepMru)', () => {
  it('끝에서 앞으로 가면 처음으로 돈다', () => {
    expect(stepMru({ index: 2, count: 3, backward: false })).toBe(0)
  })

  it('처음에서 뒤로 가면 끝으로 돈다', () => {
    expect(stepMru({ index: 0, count: 3, backward: true })).toBe(2)
  })

  it('상한 12 밖으로는 못 나간다', () => {
    expect(stepMru({ index: MRU_LIMIT - 1, count: many(30).length, backward: false })).toBe(0)
  })

  it('목록이 비면 0 이다', () => {
    expect(stepMru({ index: 0, count: 0, backward: false })).toBe(0)
  })
})

describe('위치 글리프 (groupGlyphs)', () => {
  it('영역이 하나면 빈 표다', () => {
    expect(groupGlyphs({ groupIds: ['g1'], direction: null }).size).toBe(0)
  })

  it('둘이면 방향대로 반쪽 글리프다', () => {
    expect([...groupGlyphs({ groupIds: ['g1', 'g2'], direction: 'row' }).values()]).toEqual(['◧', '◨'])
    expect([...groupGlyphs({ groupIds: ['g1', 'g2'], direction: 'column' }).values()]).toEqual(['⬒', '⬓'])
  })

  it('셋 이상이면 번호다', () => {
    expect([...groupGlyphs({ groupIds: ['g1', 'g2', 'g3'], direction: 'row' }).values()]).toEqual(['1', '2', '3'])
  })
})
