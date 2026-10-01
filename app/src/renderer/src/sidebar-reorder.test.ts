// 사이드바 끌기 판정 단위 시험 (LIFE-469 K1·K2·K3) — 사각형은 손으로 준다. 실제 화면은 격리·네이티브 실행이 본다.

import { describe, expect, it } from 'vitest'
import {
  hasCrossedReorderThreshold,
  nextAutoscrollTop,
  REORDER_DRAG_THRESHOLD_PX,
  resolveCardDropSlot,
  resolveRepoDropSlot,
  type RepoSlotRect,
} from './sidebar-reorder.js'

describe('시작 임계 (K3ⓐ, 198 4px)', () => {
  it('4px 미만은 클릭, 4px 부터 드래그', () => {
    expect(REORDER_DRAG_THRESHOLD_PX).toBe(4)
    expect(hasCrossedReorderThreshold({ start: { x: 0, y: 0 }, current: { x: 0, y: 3 } })).toBe(false)
    expect(hasCrossedReorderThreshold({ start: { x: 0, y: 0 }, current: { x: 2, y: 2 } })).toBe(false)
    expect(hasCrossedReorderThreshold({ start: { x: 0, y: 0 }, current: { x: 0, y: 4 } })).toBe(true)
  })
})

// 레포 셋: 0 = 펼친 레포(헤더 28 + 카드 영역 200), 1 = 접힌 레포, 2 = 펼친 레포. 묶음 사이 4px 틈 포함.
const REPOS: RepoSlotRect[] = [
  { top: 0, bottom: 228, headTop: 0, headBottom: 28 },
  { top: 228, bottom: 260, headTop: 228, headBottom: 260 },
  { top: 260, bottom: 400, headTop: 260, headBottom: 292 },
]

describe('레포 드롭 경계 (K1·K3ⓓ C5)', () => {
  it('헤더 띠 위 — 헤더 중점 위면 그 앞, 아래면 그 뒤', () => {
    expect(resolveRepoDropSlot({ rects: REPOS, y: 10 })?.slot).toBe(0)
    expect(resolveRepoDropSlot({ rects: REPOS, y: 20 })?.slot).toBe(1)
    expect(resolveRepoDropSlot({ rects: REPOS, y: 240 })?.slot).toBe(1)
    expect(resolveRepoDropSlot({ rects: REPOS, y: 250 })?.slot).toBe(2)
  })

  it('C5 — 펼친 레포의 카드 영역 위에서도 표시가 사라지지 않고 가까운 경계로 잡힌다', () => {
    const upper = resolveRepoDropSlot({ rects: REPOS, y: 60 })
    const lower = resolveRepoDropSlot({ rects: REPOS, y: 200 })
    expect(upper).not.toBeNull()
    expect(lower).not.toBeNull()
    expect(upper?.slot).toBe(0)
    expect(lower?.slot).toBe(1)
    expect(lower?.indicatorY).toBe(228)
  })

  it('맨 위·맨 아래 — 끝 56px 안이면 끝 슬롯, 더 멀면 null(놓으면 취소)', () => {
    expect(resolveRepoDropSlot({ rects: REPOS, y: 440 })?.slot).toBe(3)
    expect(resolveRepoDropSlot({ rects: REPOS, y: 500 })).toBeNull()
    const shifted = REPOS.map((rect) => ({ top: rect.top + 100, bottom: rect.bottom + 100, headTop: rect.headTop + 100, headBottom: rect.headBottom + 100 }))
    expect(resolveRepoDropSlot({ rects: shifted, y: 60 })?.slot).toBe(0)
    expect(resolveRepoDropSlot({ rects: shifted, y: 10 })).toBeNull()
  })

  it('R1-05 — 붙은(sticky) 헤더는 묶음 윗변이 아니라 헤더 실제 범위의 중점으로 가른다', () => {
    // 리뷰 재현: A 묶음 0..600, scrollTop 300 이라 A 헤더가 300..328 에 붙어 있다. 상반부(305) = A 앞.
    const stuck: RepoSlotRect[] = [
      { top: 0, bottom: 600, headTop: 300, headBottom: 328 },
      { top: 600, bottom: 750, headTop: 600, headBottom: 628 },
    ]
    const upper = resolveRepoDropSlot({ rects: stuck, y: 305 })
    expect(upper?.slot).toBe(0)
    // 앞 경계(0)는 화면 위로 숨었다 — 표시 줄은 붙은 헤더 윗변 바로 안쪽에.
    expect(upper?.indicatorY).toBe(305)
    expect(resolveRepoDropSlot({ rects: stuck, y: 320 })?.slot).toBe(1)
    // 붙은 헤더 아래 카드 영역은 그대로 가까운 경계(C5).
    expect(resolveRepoDropSlot({ rects: stuck, y: 400 })?.slot).toBe(1)
  })

  it('표시 줄 y 는 경계(틈 가운데·첫 윗변·끝 아랫변)', () => {
    expect(resolveRepoDropSlot({ rects: REPOS, y: 5 })?.indicatorY).toBe(0)
    expect(resolveRepoDropSlot({ rects: REPOS, y: 380 })?.indicatorY).toBe(400)
  })
})

// 같은 레포 연결 카드 셋(주 체크아웃은 0~50, 레포 묶음 0~260).
const CARDS = [
  { top: 56, bottom: 106 },
  { top: 112, bottom: 162 },
  { top: 168, bottom: 218 },
]
const GROUP = { top: 0, bottom: 260 }

describe('카드 드롭 경계 (K2)', () => {
  it('카드 중점 기준 위·아래 — 맨 위·가운데·맨 아래', () => {
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 60 })?.slot).toBe(0)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 100 })?.slot).toBe(1)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 140 })?.slot).toBe(2)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 210 })?.slot).toBe(3)
  })

  it('ⓑ 주 체크아웃 위로는 놓을 수 없다 — 그 아래(slot 0)까지만, 더 위는 취소', () => {
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 30 })?.slot).toBe(0)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 30 })?.indicatorY).toBe(56)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: -5 })).toBeNull()
  })

  it('ⓓ 다른 레포 위(묶음 밖) = null — 놓으면 취소', () => {
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 300 })).toBeNull()
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: { top: 0, bottom: 230 }, y: 240 })).toBeNull()
  })

  it('카드 사이 틈은 경계 가운데에 표시', () => {
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 100 })?.indicatorY).toBe(109)
  })
})

describe('자동 스크롤 (K3ⓕ, 198 56px · 960px/s)', () => {
  const base = { containerRect: { left: 0, right: 280, top: 100, bottom: 700 }, scrollTop: 300, scrollHeight: 2000, clientHeight: 600, elapsedMs: 16 }

  it('가장자리 56px 안에서만 움직인다 — 아래로·위로', () => {
    expect(nextAutoscrollTop({ ...base, point: { x: 100, y: 400 } })).toBeNull()
    expect(nextAutoscrollTop({ ...base, point: { x: 100, y: 699 } })).toBeGreaterThan(300)
    expect(nextAutoscrollTop({ ...base, point: { x: 100, y: 101 } })).toBeLessThan(300)
  })

  it('최대 속도 960px/s — 한 프레임(32ms 상한) 최대 30.72px', () => {
    expect(nextAutoscrollTop({ ...base, point: { x: 100, y: 740 }, elapsedMs: 1000 })).toBeCloseTo(300 + 960 * 0.032)
  })

  it('목록 좌우 밖·바깥 48px 넘어·끝에 닿으면 멈춘다', () => {
    expect(nextAutoscrollTop({ ...base, point: { x: 400, y: 699 } })).toBeNull()
    expect(nextAutoscrollTop({ ...base, point: { x: 100, y: 760 } })).toBeNull()
    expect(nextAutoscrollTop({ ...base, scrollTop: 1400, point: { x: 100, y: 699 } })).toBeNull()
    expect(nextAutoscrollTop({ ...base, scrollHeight: 600, point: { x: 100, y: 699 } })).toBeNull()
  })
})
