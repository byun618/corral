// 사이드바 끌기 판정 단위 시험 (LIFE-469 K1·K2·K3) — 사각형은 손으로 준다. 실제 화면은 격리·네이티브 실행이 본다.

import { describe, expect, it } from 'vitest'
import {
  buildReorderPreview,
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
    expect(resolveRepoDropSlot({ rects: REPOS, y: 10 })).toBe(0)
    expect(resolveRepoDropSlot({ rects: REPOS, y: 20 })).toBe(1)
    expect(resolveRepoDropSlot({ rects: REPOS, y: 240 })).toBe(1)
    expect(resolveRepoDropSlot({ rects: REPOS, y: 250 })).toBe(2)
  })

  it('C5 — 펼친 레포의 카드 영역 위에서도 표시가 사라지지 않고 가까운 경계로 잡힌다', () => {
    const upper = resolveRepoDropSlot({ rects: REPOS, y: 60 })
    const lower = resolveRepoDropSlot({ rects: REPOS, y: 200 })
    expect(upper).not.toBeNull()
    expect(lower).not.toBeNull()
    expect(upper).toBe(0)
    expect(lower).toBe(1)
  })

  it('맨 위·맨 아래 — 끝 56px 안이면 끝 슬롯, 더 멀면 null(놓으면 취소)', () => {
    expect(resolveRepoDropSlot({ rects: REPOS, y: 440 })).toBe(3)
    expect(resolveRepoDropSlot({ rects: REPOS, y: 500 })).toBeNull()
    const shifted = REPOS.map((rect) => ({ top: rect.top + 100, bottom: rect.bottom + 100, headTop: rect.headTop + 100, headBottom: rect.headBottom + 100 }))
    expect(resolveRepoDropSlot({ rects: shifted, y: 60 })).toBe(0)
    expect(resolveRepoDropSlot({ rects: shifted, y: 10 })).toBeNull()
  })

  it('R1-05 — 붙은(sticky) 헤더는 묶음 윗변이 아니라 헤더 실제 범위의 중점으로 가른다', () => {
    // 리뷰 재현: A 묶음 0..600, scrollTop 300 이라 A 헤더가 300..328 에 붙어 있다. 상반부(305) = A 앞.
    const stuck: RepoSlotRect[] = [
      { top: 0, bottom: 600, headTop: 300, headBottom: 328 },
      { top: 600, bottom: 750, headTop: 600, headBottom: 628 },
    ]
    expect(resolveRepoDropSlot({ rects: stuck, y: 305 })).toBe(0)
    expect(resolveRepoDropSlot({ rects: stuck, y: 320 })).toBe(1)
    // 붙은 헤더 아래 카드 영역은 그대로 가까운 경계(C5).
    expect(resolveRepoDropSlot({ rects: stuck, y: 400 })).toBe(1)
  })
})

// 같은 레포 카드 셋 — 0 = 주 체크아웃(28~50, 헤더 0~28 아래), 1~3 = 연결 워크트리. 레포 묶음 0~260.
const CARDS = [
  { top: 28, bottom: 50 },
  { top: 56, bottom: 106 },
  { top: 112, bottom: 162 },
  { top: 168, bottom: 218 },
]
const GROUP = { top: 0, bottom: 260 }

describe('카드 드롭 경계 (K2)', () => {
  it('카드 중점 기준 위·아래 — 맨 위·가운데·맨 아래', () => {
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 60 })).toBe(1)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 100 })).toBe(2)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 140 })).toBe(3)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 210 })).toBe(4)
  })

  it("ⓑ' 주 체크아웃 위(경계 0)에도 놓인다 — 주 체크아웃 상반부·헤더 띠, 묶음 위 바깥은 취소(게이트 ① 수정 1)", () => {
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 35 })).toBe(0)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 10 })).toBe(0)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 45 })).toBe(1)
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: -5 })).toBeNull()
  })

  it('ⓓ 다른 레포 위(묶음 밖) = null — 놓으면 취소', () => {
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: GROUP, y: 300 })).toBeNull()
    expect(resolveCardDropSlot({ rects: CARDS, groupRange: { top: 0, bottom: 230 }, y: 240 })).toBeNull()
  })
})

// 카드 셋(높이 50, 틈 6): 0 = 0..50 · 1 = 56..106 · 2 = 112..162 · 3 = 168..218. 보이는 범위 0..600.
const ROWS = [
  { top: 0, bottom: 50 },
  { top: 56, bottom: 106 },
  { top: 112, bottom: 162 },
  { top: 168, bottom: 218 },
]
const VIEW = { top: 0, bottom: 600 }

describe('미리 보기 — 행 밀림·표시 줄 (K3ⓗⓑⓒ, 198 buildWorktreeDragPreviewOffsets)', () => {
  it('아래로 — 0 을 경계 3(2 와 3 사이)으로: 1·2 가 한 칸(56) 위로, 3 은 그대로, 표시 줄 = 들어갈 자리 윗변', () => {
    const built = buildReorderPreview({ rects: ROWS, from: 0, slot: 3, view: VIEW })
    expect(built.offsets).toEqual([0, -56, -56, 0])
    expect(built.indicatorY).toBe(112)
  })

  it('위로 — 3 을 맨 앞(경계 0)으로: 0·1·2 가 한 칸 아래로, 표시 줄 = 첫 윗변(보이는 범위 안쪽 5px 로 당김)', () => {
    const built = buildReorderPreview({ rects: ROWS, from: 3, slot: 0, view: VIEW })
    expect(built.offsets).toEqual([56, 56, 56, 0])
    expect(built.indicatorY).toBe(5)
  })

  it('높이가 다른 항목 — 실측 높이로 다시 쌓는다(인덱스×간격이 아니다)', () => {
    const tall = [{ top: 0, bottom: 150 }, { top: 156, bottom: 206 }, { top: 212, bottom: 262 }]
    const built = buildReorderPreview({ rects: tall, from: 0, slot: 3, view: VIEW })
    // 1·2 가 끄는 항목 높이+틈(156)만큼 위로, 끄는 항목 자리 = 0 + 50 + 6 + 50 + 6.
    expect(built.offsets).toEqual([0, -156, -156])
    expect(built.indicatorY).toBe(112)
  })

  it('제자리(경계 = 자기 앞·뒤) — 밀림 없음, 표시 줄 = 끄는 항목 윗변', () => {
    expect(buildReorderPreview({ rects: ROWS, from: 1, slot: 1, view: VIEW })).toEqual({ offsets: [0, 0, 0, 0], indicatorY: 56 })
    expect(buildReorderPreview({ rects: ROWS, from: 1, slot: 2, view: VIEW })).toEqual({ offsets: [0, 0, 0, 0], indicatorY: 56 })
  })

  it('표시 줄 = 놓은 뒤 그 항목의 실제 윗변 — 모든 (from, slot) 조합에서 moveKey 결과를 다시 쌓은 자리와 같다', () => {
    for (let from = 0; from < ROWS.length; from++) {
      for (let slot = 0; slot <= ROWS.length; slot++) {
        const order = ROWS.map((_, index) => index).filter((index) => index !== from)
        const to = slot > from ? slot - 1 : slot
        order.splice(to, 0, from)
        const landedTop = order.indexOf(from) * 56
        const built = buildReorderPreview({ rects: ROWS, from, slot, view: { top: -100, bottom: 600 } })
        expect(built.indicatorY).toBe(landedTop)
        // 다른 행의 밀린 자리 = 놓은 뒤 그 행의 자리.
        order.forEach((index, position) => {
          if (index !== from) expect((ROWS[index]?.top ?? 0) + (built.offsets[index] ?? 0)).toBe(position * 56)
        })
      }
    }
  })

  it('들어갈 자리가 보이는 범위 밖이면 범위 끝 안쪽 5px — 붙은 헤더 앞 경계가 화면 위로 숨은 때(R1-05)', () => {
    const stuck = [{ top: 0, bottom: 600 }, { top: 600, bottom: 750 }]
    // 1 을 0 앞으로 — 들어갈 자리 0 은 scrollTop 300 위라 숨었다.
    expect(buildReorderPreview({ rects: stuck, from: 1, slot: 0, view: { top: 300, bottom: 900 } }).indicatorY).toBe(305)
    expect(buildReorderPreview({ rects: ROWS, from: 0, slot: 4, view: { top: 0, bottom: 100 } }).indicatorY).toBe(95)
  })
})

// R6-02 — 레포 묶음 배치 모형(styles.css): 목록 윗변 pt-px → 첫 묶음 윗변 1, 묶음 **사이** margin-top 4px(위치와 무관한 높이).
function layoutGroups(heights: readonly number[]): Array<{ top: number; bottom: number }> {
  let top = 1
  return heights.map((height, index) => {
    if (index > 0) top += 4
    const rect = { top, bottom: top + height }
    top += height
    return rect
  })
}
/** 옛 CSS(R6-02 전) — 둘째 묶음부터 묶음 **안** padding-top 4px: 묶음 높이가 자리에 따라 4px 바뀐다. */
function layoutGroupsPadding(heights: readonly number[]): Array<{ top: number; bottom: number }> {
  let top = 1
  return heights.map((height, index) => {
    const rect = { top, bottom: top + height + (index > 0 ? 4 : 0) }
    top = rect.bottom
    return rect
  })
}
function moved(keys: readonly number[], from: number, slot: number): number[] {
  const to = slot > from ? slot - 1 : slot
  const rest = keys.filter((key) => key !== from)
  rest.splice(to, 0, from)
  return rest
}
/** 미리 보기(밀린 윗변·표시 줄)가 놓은 뒤 배치와 같은가 — 어긋난 px 목록(빈 배열 = 같음). */
function previewMismatch(input: { layout: typeof layoutGroups; heights: readonly number[]; from: number; slot: number }): number[] {
  const { layout, heights, from, slot } = input
  const before = layout(heights)
  const built = buildReorderPreview({ rects: before, from, slot, view: { top: -1000, bottom: 10_000 } })
  const order = moved(heights.map((_, index) => index), from, slot)
  const after = layout(order.map((index) => heights[index] ?? 0))
  const errors: number[] = []
  order.forEach((index, position) => {
    const landed = after[position]?.top ?? NaN
    const shown = index === from ? built.indicatorY : (before[index]?.top ?? 0) + (built.offsets[index] ?? 0)
    if (shown !== landed) errors.push(shown - landed)
  })
  return errors
}

describe('R6-02 — 첫 레포가 바뀌는 이동도 미리 보기 = 놓은 뒤 기하 (묶음 사이 margin 4px)', () => {
  // 접힌 28 · 펼친 228 · 오류 표시 32 · 펼친 140 — 높이가 다른 묶음.
  const HEIGHTS = [28, 228, 32, 140]

  it('첫 레포 A 를 맨 뒤로 · 맨 뒤를 맨 앞으로 — 밀린 윗변·표시 줄이 놓은 뒤 윗변과 같다', () => {
    expect(previewMismatch({ layout: layoutGroups, heights: HEIGHTS, from: 0, slot: 4 })).toEqual([])
    expect(previewMismatch({ layout: layoutGroups, heights: HEIGHTS, from: 3, slot: 0 })).toEqual([])
    // 리뷰 재현(접힌 A/B/C 28px): A → 맨 뒤 = 표시 줄 65 · 놓은 뒤 A 윗변 65.
    const before = layoutGroups([28, 28, 28])
    const built = buildReorderPreview({ rects: before, from: 0, slot: 3, view: { top: -100, bottom: 1000 } })
    expect(built).toEqual({ offsets: [0, -32, -32], indicatorY: 65 })
    expect(layoutGroups([28, 28, 28])[2]?.top).toBe(65)
  })

  it('모든 (from, slot) 조합에서 같다', () => {
    for (let from = 0; from < HEIGHTS.length; from++)
      for (let slot = 0; slot <= HEIGHTS.length; slot++) expect(previewMismatch({ layout: layoutGroups, heights: HEIGHTS, from, slot }), `from ${from} slot ${slot}`).toEqual([])
  })

  it('대조 — 옛 padding 배치였다면 첫 레포가 바뀌는 이동에서 4px 어긋났다(리뷰 r6 재현)', () => {
    expect(previewMismatch({ layout: layoutGroupsPadding, heights: [28, 28, 28], from: 0, slot: 3 })).toEqual([4, 4]) // C 미리 보기 33 · 최종 29, A 표시 줄 65 · 최종 61(B 는 맞다)
    // 첫 레포가 그대로인 이동은 옛 배치에서도 맞았다 — 그래서 격리 K3h-c-repo([gamma,beta,alpha] → [gamma,alpha,beta])가 놓쳤다.
    expect(previewMismatch({ layout: layoutGroupsPadding, heights: [28, 28, 28], from: 2, slot: 1 })).toEqual([])
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
