// useSidebarReorder 계보 시험 (LIFE-576 K3ⓐⓑⓒⓔ · K4ⓑⓒ) — 끌어서 상위 지정·덩어리 끌기·중첩된 자식 끌기.
// 가짜 React·DOM 은 469 시험과 같은 것(fake-react.test-helper.mjs). 실제 브라우저 경로는 최종 관문 네이티브 실행이 본다.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', () => import('./fake-react.test-helper.mjs'))

const { HookHost, fakeDom } = await import('./fake-react.test-helper.mjs')
const { useSidebarReorder } = await import('./useSidebarReorder.js')

let dom
let host
let commits
let nests
let render

/**
 * 레포 하나 — a 0..50 · b 56..106 · p 112..250(카드 행 = 내용 112..160 + 안에 그린 자식 c1 166..206 · c2 210..250) · z 256..306.
 * `pContent` 를 주지 않으면 p 내용 영역 = 행 전체(자식 행까지 덮는 옛 카드 — Orca 「Legacy cards include descendants」).
 */
function cards(options = {}) {
  return [
    { path: '/a', top: 0, bottom: 50 },
    { path: '/b', top: 56, bottom: 106 },
    { path: '/p', top: 112, bottom: 250, ...(options.pContent === null ? {} : { content: options.pContent ?? [112, 160] }) },
    { path: '/c1', top: 166, bottom: 206, parent: '/p', depth: 1 },
    { path: '/c2', top: 210, bottom: 250, parent: '/p', depth: 1 },
    { path: '/z', top: 256, bottom: 306 },
  ]
}

function mount(options = {}) {
  dom = fakeDom({ repos: [{ root: '/r', top: 0, bottom: 600, head: [0, 0], cards: cards(options) }], listTop: 0, listBottom: 600 })
  for (const [name, value] of Object.entries(dom.globals)) vi.stubGlobal(name, value)
  host = new HookHost()
  commits = []
  nests = []
  const canNest = options.canNest ?? (() => true)
  render = () =>
    host.render(() =>
      useSidebarReorder({ listRef: { current: dom.list }, onCommit: (commit) => commits.push(commit), canNest, onNest: (nest) => nests.push(nest) }),
    )
  return render()
}

/** 카드 `path` 를 (40, fromY) 에서 잡아 y 들로 차례로 끈다. */
function drag(api, input) {
  api.onCardMouseDown({ event: dom.down(40, input.fromY), repoRoot: '/r', path: input.path })
  for (const y of input.ys) dom.doc.emit('mousemove', { clientX: 40, clientY: y, buttons: 1 })
}
const release = (y) => dom.doc.emit('mouseup', { clientX: 40, clientY: y })
const FLAT = ['/a', '/b', '/p', '/c1', '/c2', '/z']

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('K3ⓐⓑ 카드 안쪽에 놓으면 상위 지정 — 표시 줄·행 밀림 없이 카드 강조만', () => {
  it('a 를 b 가운데로 → 대상 b, 표시 줄 없음, 밀림 없음 → 놓으면 onNest 만', () => {
    const api = mount()
    drag(api, { path: '/a', fromY: 25, ys: [40, 81] })
    const state = render().state
    expect(state?.lineageTarget).toBe('/b')
    expect(state?.indicatorY).toBeNull()
    expect(dom.shifts()).toEqual({})
    release(81)
    expect(nests).toEqual([{ path: '/a', parentPath: '/b' }])
    expect(commits).toEqual([])
    // 놓은 뒤 click 하나는 삼킨다(순서 끌기와 같다).
    expect(dom.win.emit('click').defaultPrevented).toBe(true)
  })

  it('가장자리(위 8px) = 순서 줄 — 대상이 허락돼도 상위 지정이 아니다', () => {
    const api = mount()
    drag(api, { path: '/a', fromY: 25, ys: [40, 59] })
    expect(render().state?.lineageTarget).toBeUndefined()
    expect(render().state?.indicatorY).not.toBeNull()
    release(59)
    expect(nests).toEqual([])
    expect(commits).toEqual([{ source: { kind: 'card', repoRoot: '/r', path: '/a' }, keys: FLAT, slot: 1 }])
  })
})

describe('K3ⓒ 무효 대상(canNest 거짓) — 상위 지정 표시 없음, 순서 끌기로', () => {
  it('가운데여도 canNest 가 거짓이면 대상 없음 → 순서 commit, onNest 없음', () => {
    const api = mount({ canNest: () => false })
    drag(api, { path: '/a', fromY: 25, ys: [40, 81] })
    expect(render().state?.lineageTarget).toBeUndefined()
    release(81)
    expect(nests).toEqual([])
    expect(commits).toHaveLength(1)
  })

  it('canNest 는 (끄는 카드, 후보) 로 불리고 끄는 카드 자신은 묻지 않는다', () => {
    const asked = []
    const api = mount({
      canNest: (nest) => {
        asked.push(`${nest.path}>${nest.parentPath}`)
        return false
      },
    })
    drag(api, { path: '/a', fromY: 25, ys: [40, 81] })
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((entry) => entry.startsWith('/a>'))).toBe(true)
    expect(asked).not.toContain('/a>/a')
  })
})

describe('K3 부모 카드 안 자식 행은 부모 hit 영역이 아니다(Orca main #20412)', () => {
  it('자식 행 위 = 그 자식이 대상, 부모 내용 영역 안쪽 = 부모, 부모 아래 가장자리 = 순서 줄', () => {
    let api = mount()
    drag(api, { path: '/a', fromY: 25, ys: [40, 186] })
    expect(render().state?.lineageTarget).toBe('/c1')
    release(186)
    expect(nests).toEqual([{ path: '/a', parentPath: '/c1' }])

    api = mount()
    drag(api, { path: '/a', fromY: 25, ys: [40, 150] })
    expect(render().state?.lineageTarget).toBe('/p')
    release(150)

    api = mount()
    drag(api, { path: '/a', fromY: 25, ys: [40, 157] })
    expect(render().state?.lineageTarget).toBeUndefined()
  })

  it('내용 영역이 자식 행까지 덮는 카드 — 아랫변을 첫 자식 윗변(166)에서 자른다', () => {
    const api = mount({ pContent: null })
    drag(api, { path: '/a', fromY: 25, ys: [40, 163] })
    // p 범위 112..166(높이 54 → 가장자리 8) — 163 은 아래 가장자리.
    expect(render().state?.lineageTarget).toBeUndefined()
    dom.doc.emit('mousemove', { clientX: 40, clientY: 157, buttons: 1 })
    expect(render().state?.lineageTarget).toBe('/p')
    dom.doc.emit('mousemove', { clientX: 40, clientY: 180, buttons: 1 })
    expect(render().state?.lineageTarget).toBe('/c1')
  })
})

describe('K3ⓔ 정적 기하 — 순서 미리보기로 밀린 자리가 상위 지정 판정을 흔들지 않는다', () => {
  it('b 가 밀려 올라간 뒤에도 판정은 b 의 원래 자리로, 대상이 서면 밀림을 거둔다', () => {
    const api = mount({ canNest: (nest) => nest.parentPath === '/b' })
    // b 아래 가장자리(98..106) — 순서 slot 2 → b 가 a 자리로 밀려 올라간다.
    drag(api, { path: '/a', fromY: 25, ys: [40, 103] })
    expect(dom.shifts()['/b']).toBeLessThan(0)
    expect(render().state?.lineageTarget).toBeUndefined()
    // 포인터 81 = b 의 **원래** 가운데(밀린 b 는 지금 25..75 근처에 보인다).
    dom.doc.emit('mousemove', { clientX: 40, clientY: 81, buttons: 1 })
    expect(render().state?.lineageTarget).toBe('/b')
    expect(dom.shifts()).toEqual({})
    // 프레임이 돌아도(매 프레임 재측정) 대상이 진동하지 않는다.
    dom.runFrame(16)
    dom.runFrame(32)
    expect(render().state?.lineageTarget).toBe('/b')
    // 밀린 b 가 보이던 자리(25) = a 의 원래 자리 — 자기 자신이라 대상이 아니다.
    dom.doc.emit('mousemove', { clientX: 40, clientY: 25, buttons: 1 })
    expect(render().state?.lineageTarget).toBeUndefined()
  })
})

describe('K4ⓑ 부모를 끌면 펼친 후손이 함께 — commit 에 덩어리', () => {
  it('p 를 맨 위 가장자리로 → slot 0, block = p + c1 + c2, 밀림은 덩어리 단위', () => {
    const api = mount({ canNest: () => false })
    drag(api, { path: '/p', fromY: 130, ys: [120, 2] })
    // 덩어리 단위 밀림 — a·b 가 p 덩어리 높이만큼 내려가고, 자식 행은 따로 밀리지 않는다.
    const shifts = dom.shifts()
    expect(shifts['/a']).toBeGreaterThan(0)
    expect(shifts['/c1']).toBeUndefined()
    release(2)
    expect(commits).toEqual([{ source: { kind: 'card', repoRoot: '/r', path: '/p' }, keys: FLAT, slot: 0, block: ['/p', '/c1', '/c2'] }])
  })
})

describe('K4ⓒ 중첩된 자식을 순서 줄에 놓기 — 그 자리로 순서 commit(부모 풀기는 Sidebar 가 같은 commit 에서 `hasValidLineage`)', () => {

  it('M4 + K3ⓔ — 자식 끌기로 덩어리가 밀린 뒤에도 상위 지정은 밀리기 전 자리로 판정한다', () => {
    const api = mount({ canNest: (nest) => nest.parentPath === '/b' })
    // c2 를 b 위 가장자리(56..64)로 → slot 1 → b·p·z 가 c2 높이(40)+6 만큼 내려간다.
    drag(api, { path: '/c2', fromY: 230, ys: [240, 58] })
    expect(dom.shifts()['/b']).toBe(46)
    // 포인터 81 = b 의 원래 가운데(밀린 b 는 102..152 에 보인다) → 대상 b, 밀림을 거둔다.
    dom.doc.emit('mousemove', { clientX: 40, clientY: 81, buttons: 1 })
    expect(render().state?.lineageTarget).toBe('/b')
    expect(dom.shifts()).toEqual({})
    dom.runFrame(16)
    expect(render().state?.lineageTarget).toBe('/b')
    release(81)
    expect(nests).toEqual([{ path: '/c2', parentPath: '/b' }])
    expect(commits).toEqual([])
  })

  it('c2 를 z 아래 가장자리로 → slot 6(평면 끝), block 없음, 끝이라 밀 행 없음 · 표시 줄 = 마지막 아랫변 + 틈', () => {
    const api = mount({ canNest: () => false })
    drag(api, { path: '/c2', fromY: 230, ys: [240, 303] })
    expect(dom.shifts()).toEqual({})
    expect(render().state?.indicatorY).toBe(312)
    release(303)
    expect(commits).toEqual([{ source: { kind: 'card', repoRoot: '/r', path: '/c2' }, keys: FLAT, slot: 6 }])
    expect(nests).toEqual([])
  })

  it('M4 c1 을 a 위 가장자리로 → slot 0 · 모든 덩어리가 c1 높이(40) + 틈(6) 만큼 밀린다(Orca drag unit 미리보기)', () => {
    const api = mount({ canNest: () => false })
    drag(api, { path: '/c1', fromY: 186, ys: [180, 2] })
    expect(dom.shifts()).toEqual({ '/a': 46, '/b': 46, '/p': 46, '/z': 46 })
    release(2)
    expect(commits).toEqual([{ source: { kind: 'card', repoRoot: '/r', path: '/c1' }, keys: FLAT, slot: 0 }])
  })

  it('Escape — 상위 지정 대상 위에서 취소하면 아무것도 안 쓴다', () => {
    const api = mount()
    drag(api, { path: '/a', fromY: 25, ys: [40, 81] })
    dom.doc.emit('keydown', { key: 'Escape' })
    release(81)
    expect(nests).toEqual([])
    expect(commits).toEqual([])
  })
})

describe('R1-B 하위 카드를 끌면 그 카드의 보이는 후손(손자)도 함께 — Orca `expandDraggedWorktreeIdsForVisibleLineage`', () => {
  /** p 덩어리 = p 112..160 · c1 166..206 · g1(c1 의 자식, 깊이 2) 210..250 · c2 254..294, 뒤에 z 300..350. 후손은 전부 p 행 안에 평평하게. */
  function mountWithGrandchild() {
    dom = fakeDom({
      repos: [{ root: '/r', top: 0, bottom: 600, head: [0, 0], cards: [
        { path: '/a', top: 0, bottom: 50 },
        { path: '/b', top: 56, bottom: 106 },
        { path: '/p', top: 112, bottom: 294, content: [112, 160] },
        { path: '/c1', top: 166, bottom: 206, parent: '/p', depth: 1 },
        { path: '/g1', top: 210, bottom: 250, parent: '/p', depth: 2 },
        { path: '/c2', top: 254, bottom: 294, parent: '/p', depth: 1 },
        { path: '/z', top: 300, bottom: 350 },
      ] }],
      listTop: 0,
      listBottom: 600,
    })
    for (const [name, value] of Object.entries(dom.globals)) vi.stubGlobal(name, value)
    host = new HookHost()
    commits = []
    nests = []
    render = () => host.render(() => useSidebarReorder({ listRef: { current: dom.list }, onCommit: (commit) => commits.push(commit), canNest: () => false, onNest: (nest) => nests.push(nest) }))
    return render()
  }

  it('c1 을 a 위 가장자리로 → block = c1 + g1, 미리 보기 높이 = c1 윗변 ~ g1 아랫변(84) + 틈 6', () => {
    const api = mountWithGrandchild()
    drag(api, { path: '/c1', fromY: 186, ys: [180, 2] })
    expect(dom.shifts()).toEqual({ '/a': 90, '/b': 90, '/p': 90, '/z': 90 })
    release(2)
    expect(commits).toEqual([{ source: { kind: 'card', repoRoot: '/r', path: '/c1' }, keys: ['/a', '/b', '/p', '/c1', '/g1', '/c2', '/z'], slot: 0, block: ['/c1', '/g1'] }])
  })

  it('형제 c2 는 c1 의 덩어리가 아니다 — c2 를 끌면 c2 하나', () => {
    const api = mountWithGrandchild()
    drag(api, { path: '/c2', fromY: 274, ys: [270, 2] })
    release(2)
    expect(commits[0]?.block).toBeUndefined()
  })

  it('부모 p 를 끌면 손자까지 덩어리 전체', () => {
    const api = mountWithGrandchild()
    drag(api, { path: '/p', fromY: 130, ys: [120, 2] })
    release(2)
    expect(commits[0]?.block).toEqual(['/p', '/c1', '/g1', '/c2'])
  })
})
