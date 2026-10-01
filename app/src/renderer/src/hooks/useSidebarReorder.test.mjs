// useSidebarReorder hook 수준 시험 (LIFE-469 수정 라운드 1 — 리뷰 CDX-R1-01·02·03·05 재현을 실제 hook 에).
// React 스케줄·DOM 사각형·이벤트 전달만 가짜다(fake-react.test-helper.mjs). 실제 브라우저 경로는 격리 실행이 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', () => import('./fake-react.test-helper.mjs'))

const { HookHost, fakeDom } = await import('./fake-react.test-helper.mjs')
const { useSidebarReorder } = await import('./useSidebarReorder.js')
const { applyRepoMove, applyWorktreeMove } = await import('../manual-order.js')

let dom
let host
let commits
let render

function mount(options) {
  dom = fakeDom(options)
  for (const [name, value] of Object.entries(dom.globals)) vi.stubGlobal(name, value)
  host = new HookHost()
  commits = []
  render = () => host.render(() => useSidebarReorder({ listRef: { current: dom.list }, onCommit: (commit) => commits.push(commit) }))
  return render()
}

beforeEach(() => {
  commits = []
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// 레포 셋 — 목록 화면 100..700, 레포 내용 범위 A 0..300 · B 300..600 · C 600..900.
const THREE_REPOS = [
  { root: '/a', top: 0, bottom: 300, head: [0, 28] },
  { root: '/b', top: 300, bottom: 600, head: [300, 328] },
  { root: '/c', top: 600, bottom: 900, head: [600, 628] },
]

describe('대조 — 정상 경로', () => {
  it('문턱 미만 움직임은 click 을 삼키지 않는다', () => {
    const api = mount({ repos: THREE_REPOS, listTop: 0, listBottom: 600 })
    api.onRepoMouseDown({ event: dom.down(40, 310), root: '/b' })
    dom.doc.emit('mousemove', { clientX: 42, clientY: 310, buttons: 1 })
    dom.doc.emit('mouseup', { clientX: 42, clientY: 310 })
    expect(dom.win.emit('click').defaultPrevented).toBe(false)
    expect(commits).toEqual([])
  })

  it('목록 안에서 끝난 드래그는 commit 하고 바로 뒤 click 하나를 삼키고 rAF 를 정리한다', () => {
    const api = mount({ repos: THREE_REPOS, listTop: 0, listBottom: 600 })
    api.onRepoMouseDown({ event: dom.down(40, 310), root: '/b' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 5, buttons: 1 })
    dom.doc.emit('mouseup', { clientX: 40, clientY: 5 })
    expect(commits).toEqual([{ source: { kind: 'repo', root: '/b' }, keys: ['/a', '/b', '/c'], slot: 0 }])
    expect(dom.win.emit('click').defaultPrevented).toBe(true)
    expect(dom.frames.size).toBe(0)
    expect(dom.doc.count('mousemove')).toBe(0)
  })
})

describe('R1-01 — 보이는 목록의 위·아래 바깥 놓기는 취소', () => {
  it('목록 위 80px(자동 스크롤 허용 띠도 넘음)에서 놓으면 commit 없음 — 리뷰 재현', () => {
    const api = mount({ repos: THREE_REPOS, listTop: 100, listBottom: 700, scrollTop: 300 })
    api.onRepoMouseDown({ event: dom.down(40, 410), root: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 20, buttons: 1 })
    expect(render().state?.indicatorY).toBeNull()
    dom.doc.emit('mouseup', { clientX: 40, clientY: 20 })
    expect(commits).toEqual([])
  })

  it('자동 스크롤 띠 안이라도 목록 바깥(위 10px·아래 10px)에서 놓으면 취소 — 헤더·카드 모두', () => {
    let api = mount({ repos: THREE_REPOS, listTop: 100, listBottom: 700, scrollTop: 300 })
    api.onRepoMouseDown({ event: dom.down(40, 410), root: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 90, buttons: 1 })
    dom.doc.emit('mouseup', { clientX: 40, clientY: 90 })
    expect(commits).toEqual([])

    api = mount({
      repos: [{ root: '/r', top: 0, bottom: 600, head: [0, 28], cards: [{ path: '/x', top: 300, bottom: 350 }, { path: '/y', top: 360, bottom: 410 }] }],
      listTop: 0,
      listBottom: 600,
      scrollTop: 0,
    })
    api.onCardMouseDown({ event: dom.down(40, 385), repoRoot: '/r', path: '/y' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 610, buttons: 1 })
    dom.doc.emit('mouseup', { clientX: 40, clientY: 610 })
    expect(commits).toEqual([])
  })

  it('목록 안 같은 x 로 돌아와 놓으면 정상 commit(양성 대조)', () => {
    const api = mount({ repos: THREE_REPOS, listTop: 100, listBottom: 700, scrollTop: 300 })
    api.onRepoMouseDown({ event: dom.down(40, 410), root: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 20, buttons: 1 })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 105, buttons: 1 })
    dom.doc.emit('mouseup', { clientX: 40, clientY: 105 })
    expect(commits).toHaveLength(1)
  })
})

describe('R1-02 — Escape 로 취소한 뒤 늦게 놓은 버튼의 click 은 막고, 그 뒤 click 은 통과', () => {
  it('같은 헤더 안 6px → Escape → 타이머 지남 → 놓기 = 그 click 삼킴 · 다음 정상 클릭 통과', () => {
    const api = mount({ repos: THREE_REPOS, listTop: 0, listBottom: 600 })
    api.onRepoMouseDown({ event: dom.down(40, 310), root: '/b' })
    dom.doc.emit('mousemove', { clientX: 46, clientY: 310, buttons: 1 })
    dom.doc.emit('keydown', { key: 'Escape' })
    expect(render().state).toBeNull()
    dom.runTimers()
    dom.runTimers()
    dom.doc.emit('mouseup', { clientX: 46, clientY: 310 })
    expect(dom.win.emit('click').defaultPrevented).toBe(true)
    expect(commits).toEqual([])
    dom.runTimers()
    // 다음 정상 클릭.
    dom.doc.emit('mousedown', {})
    dom.doc.emit('mouseup', {})
    expect(dom.win.emit('click').defaultPrevented).toBe(false)
    expect(dom.doc.count('mouseup')).toBe(0)
  })

  it('해제가 창 밖에서 일어나 mouseup 이 안 오면 — 다음 mousedown 이 기다림을 내린다(정상 클릭을 삼키지 않는다)', () => {
    const api = mount({ repos: THREE_REPOS, listTop: 0, listBottom: 600 })
    api.onRepoMouseDown({ event: dom.down(40, 310), root: '/b' })
    dom.doc.emit('mousemove', { clientX: 46, clientY: 310, buttons: 1 })
    dom.win.emit('blur')
    dom.doc.emit('mousedown', {})
    dom.doc.emit('mouseup', {})
    expect(dom.win.emit('click').defaultPrevented).toBe(false)
  })

  it('버튼이 떼어진 mousemove(buttons 0)도 기다림을 내린다', () => {
    const api = mount({ repos: THREE_REPOS, listTop: 0, listBottom: 600 })
    api.onRepoMouseDown({ event: dom.down(40, 310), root: '/b' })
    dom.doc.emit('mousemove', { clientX: 46, clientY: 310, buttons: 1 })
    dom.doc.emit('keydown', { key: 'Escape' })
    dom.doc.emit('mousemove', { clientX: 50, clientY: 310, buttons: 0 })
    expect(dom.doc.count('mouseup')).toBe(0)
    expect(dom.doc.count('mousemove')).toBe(0)
  })
})

describe('R1-03 — 드래그 중 목록이 바뀌면 지금 DOM 으로 다시 잰다', () => {
  const cards = (list) => [{ root: '/r', top: 0, bottom: 560, head: [0, 28], cards: list }]

  it('C 를 맨 위로 끌고 멈춘 사이 D 가 맨 위에 생기면 — 놓은 자리 기준 [C,D,A,B] (리뷰 재현 listUpdatedDuringDrag)', () => {
    const api = mount({
      repos: cards([{ path: '/a', top: 180, bottom: 230 }, { path: '/b', top: 240, bottom: 290 }, { path: '/c', top: 300, bottom: 350 }]),
      listTop: 0,
      listBottom: 600,
    })
    api.onCardMouseDown({ event: dom.down(40, 325), repoRoot: '/r', path: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 182, buttons: 1 })
    dom.setRepos(cards([{ path: '/d', top: 180, bottom: 230 }, { path: '/a', top: 240, bottom: 290 }, { path: '/b', top: 300, bottom: 350 }, { path: '/c', top: 360, bottom: 410 }]))
    dom.doc.emit('mouseup', { clientX: 40, clientY: 182 })
    expect(commits).toHaveLength(1)
    const commit = commits[0]
    expect(commit.keys).toEqual(['/d', '/a', '/b', '/c'])
    const applied = applyWorktreeMove({
      order: { repos: ['/r'], worktrees: { '/r': ['/d', '/a', '/b', '/c'] } },
      repoRoot: '/r',
      visiblePaths: commit.keys,
      path: '/c',
      slot: commit.slot,
    })
    expect(applied?.worktrees['/r']).toEqual(['/c', '/d', '/a', '/b'])
  })

  it('프레임마다 다시 재므로 멈춘 포인터에서도 표시 줄이 새 목록을 따라간다', () => {
    const api = mount({
      repos: cards([{ path: '/a', top: 180, bottom: 230 }, { path: '/b', top: 240, bottom: 290 }, { path: '/c', top: 300, bottom: 350 }]),
      listTop: 0,
      listBottom: 600,
    })
    api.onCardMouseDown({ event: dom.down(40, 325), repoRoot: '/r', path: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 182, buttons: 1 })
    expect(render().state?.indicatorY).toBe(180)
    dom.setRepos(cards([{ path: '/d', top: 120, bottom: 170 }, { path: '/a', top: 180, bottom: 230 }, { path: '/b', top: 240, bottom: 290 }, { path: '/c', top: 300, bottom: 350 }]))
    dom.runFrame(16)
    // 포인터 182 는 이제 A 의 윗부분 — D 와 A 사이 경계(175).
    expect(render().state?.indicatorY).toBe(175)
  })

  it('끄는 행이 사라지면 드래그를 취소하고 표시 줄·rAF·리스너를 정리한다', () => {
    const api = mount({
      repos: cards([{ path: '/a', top: 180, bottom: 230 }, { path: '/c', top: 300, bottom: 350 }]),
      listTop: 0,
      listBottom: 600,
    })
    api.onCardMouseDown({ event: dom.down(40, 325), repoRoot: '/r', path: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 182, buttons: 1 })
    expect(render().state).not.toBeNull()
    dom.setRepos(cards([{ path: '/a', top: 180, bottom: 230 }]))
    dom.runFrame(16)
    expect(render().state).toBeNull()
    expect(dom.frames.size).toBe(0)
    expect(dom.classes.has('is-sidebar-reorder')).toBe(false)
    expect(dom.doc.count('keydown')).toBe(0)
    dom.doc.emit('mouseup', { clientX: 40, clientY: 182 })
    expect(commits).toEqual([])
    // 사라진 행의 그 버튼 해제 click 도 삼킨다(R1-02 와 같은 결).
    expect(dom.win.emit('click').defaultPrevented).toBe(true)
  })
})

describe('R1-05 — 붙은(sticky) 헤더 상반부 = 그 레포 앞', () => {
  it('A 가 길게 펼쳐져 scrollTop 300 에서 A 헤더가 붙었을 때, 그 상반부에 B 를 놓으면 [B, A]', () => {
    const repos = [
      { root: '/a', top: 0, bottom: 600, head: 'sticky' },
      { root: '/b', top: 600, bottom: 750, head: [600, 628] },
    ]
    const api = mount({ repos, listTop: 100, listBottom: 700, scrollTop: 300 })
    api.onRepoMouseDown({ event: dom.down(40, 410), root: '/b' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 105, buttons: 1 })
    const state = render().state
    // 표시 줄은 화면 위로 숨은 경계(0)가 아니라 붙은 헤더 윗변 바로 안쪽(내용 좌표 300 + 5).
    expect(state?.indicatorY).toBe(305)
    // 이 시험은 자동 스크롤 프레임을 돌리지 않는다 — 놓기 직전 스크롤이 움직이지 않은 상태의 판정.
    dom.doc.emit('mouseup', { clientX: 40, clientY: 105 })
    expect(commits).toHaveLength(1)
    const moved = applyRepoMove({ order: { repos: ['/a', '/b'], worktrees: {} }, visibleRoots: commits[0].keys, root: '/b', slot: commits[0].slot })
    expect(moved?.repos).toEqual(['/b', '/a'])
  })
})
