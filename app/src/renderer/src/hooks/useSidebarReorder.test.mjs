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
    dom.setRepos(cards([{ path: '/d', top: 150, bottom: 200 }, { path: '/a', top: 210, bottom: 260 }, { path: '/b', top: 270, bottom: 320 }, { path: '/c', top: 330, bottom: 380 }]))
    dom.runFrame(16)
    // 포인터 182 는 이제 D 의 아랫부분 — D 뒤 경계, C 가 들어갈 자리 윗변 = A 윗변(210). (게이트 ① 수정 1: 표시 줄 = 들어갈 자리)
    expect(render().state?.indicatorY).toBe(210)
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

// 게이트 ① 사용자 수정 1 — K3ⓗ 미리 보기(사본·행 밀림·밀리기 전 판정·취소 정리)와 K2ⓑ'(주 체크아웃 끌기).
describe('K3ⓗ — 드래그 미리 보기 (198 createSidebarDragPreview·buildWorktreeDragPreviewOffsets)', () => {
  // 한 레포 카드 넷(높이 50, 틈 10): main 30..80 · a 90..140 · b 150..200 · c 210..260.
  const FOUR = [{ root: '/r', top: 0, bottom: 300, head: [0, 28], cards: [
    { path: '/r', top: 30, bottom: 80 },
    { path: '/a', top: 90, bottom: 140 },
    { path: '/b', top: 150, bottom: 200 },
    { path: '/c', top: 210, bottom: 260 },
  ] }]

  it('ⓐ 문턱을 넘으면 사본 하나가 .sidebar 에 붙고 커서를 따라온다(잡은 점 유지·scale 1.015) — 문턱 전에는 없다', () => {
    const api = mount({ repos: FOUR, listTop: 0, listBottom: 600 })
    api.onCardMouseDown({ event: dom.down(40, 230), repoRoot: '/r', path: '/c' })
    dom.doc.emit('mousemove', { clientX: 41, clientY: 231, buttons: 1 })
    expect(dom.previews()).toHaveLength(0)
    dom.doc.emit('mousemove', { clientX: 40, clientY: 200, buttons: 1 })
    const [preview] = dom.previews()
    expect(dom.previews()).toHaveLength(1)
    expect(preview.parent).toBe(dom.sidebar)
    expect(preview.getAttribute('data-sidebar-drag-preview-kind')).toBe('card')
    expect(preview.style.width).toBe('280px')
    expect(preview.style.height).toBe('50px')
    // 잡은 점 = 카드 윗변에서 20px 아래 — 문턱을 넘은 그 점(200) 기준으로 사본 윗변 = 180.
    expect(preview.style.transform).toBe('translate3d(0px, 180px, 0) scale(1.015)')
    dom.doc.emit('mousemove', { clientX: 50, clientY: 120, buttons: 1 })
    expect(preview.style.transform).toBe('translate3d(10px, 100px, 0) scale(1.015)')
    // 복제본의 순서 표식은 지웠다 — 측정이 사본을 원래 행으로 착각하지 않는다.
    expect(preview.children[0].getAttribute('data-reorder-card')).toBeNull()
  })

  it('ⓑ 다른 행이 밀려 자리를 벌린다 — c 를 a 앞으로: a·b 가 한 칸(60) 아래로, main 그대로, 표시 줄 = 들어갈 자리 윗변(90)', () => {
    const api = mount({ repos: FOUR, listTop: 0, listBottom: 600 })
    api.onCardMouseDown({ event: dom.down(40, 230), repoRoot: '/r', path: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 100, buttons: 1 })
    expect(dom.shifts()).toEqual({ '/a': 60, '/b': 60 })
    expect(dom.listClasses.has('is-reorder-shifting')).toBe(true)
    expect(render().state?.indicatorY).toBe(90)
  })

  it('ⓒ 판정은 밀리기 전 기하 — 밀린 a(150..200) 위로 포인터가 가도 a 의 원래 자리 기준이라 흔들리지 않는다, 표시 줄 = 놓은 결과', () => {
    const api = mount({ repos: FOUR, listTop: 0, listBottom: 600 })
    api.onCardMouseDown({ event: dom.down(40, 230), repoRoot: '/r', path: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 100, buttons: 1 })
    // 포인터 160 = 밀린 a 의 윗부분(밀린 좌표로 재면 a 앞 = slot 1)이지만, 원래 기하에서는 b 의 윗부분 = slot 2.
    for (let frame = 1; frame <= 5; frame++) {
      dom.doc.emit('mousemove', { clientX: 40, clientY: 160, buttons: 1 })
      dom.runFrame(frame * 16)
      expect(render().state?.indicatorY).toBe(150)
      expect(dom.shifts()).toEqual({ '/b': 60 })
    }
    dom.doc.emit('mouseup', { clientX: 40, clientY: 160 })
    const moved = applyWorktreeMove({ order: { repos: ['/r'], worktrees: {} }, repoRoot: '/r', visiblePaths: commits[0].keys, path: '/c', slot: commits[0].slot })
    // 표시 줄 150 = 놓은 뒤 c 의 윗변(main 30 · a 90 · c 150).
    expect(moved?.worktrees['/r']).toEqual(['/r', '/a', '/c', '/b'])
  })

  it("K2ⓑ' 주 체크아웃 카드도 끌려 맨 아래로 간다 · 다른 카드는 주 체크아웃 위(경계 0)에 놓인다", () => {
    let api = mount({ repos: FOUR, listTop: 0, listBottom: 600 })
    api.onCardMouseDown({ event: dom.down(40, 50), repoRoot: '/r', path: '/r' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 255, buttons: 1 })
    expect(dom.shifts()).toEqual({ '/a': -60, '/b': -60, '/c': -60 })
    expect(render().state?.indicatorY).toBe(210)
    dom.doc.emit('mouseup', { clientX: 40, clientY: 255 })
    expect(commits[0].keys).toEqual(['/r', '/a', '/b', '/c'])
    expect(applyWorktreeMove({ order: { repos: ['/r'], worktrees: {} }, repoRoot: '/r', visiblePaths: commits[0].keys, path: '/r', slot: commits[0].slot })?.worktrees['/r']).toEqual(['/a', '/b', '/c', '/r'])

    api = mount({ repos: FOUR, listTop: 0, listBottom: 600 })
    api.onCardMouseDown({ event: dom.down(40, 120), repoRoot: '/r', path: '/a' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 40, buttons: 1 })
    expect(dom.shifts()).toEqual({ '/r': 60 })
    expect(render().state?.indicatorY).toBe(30)
    dom.doc.emit('mouseup', { clientX: 40, clientY: 40 })
    expect(applyWorktreeMove({ order: { repos: ['/r'], worktrees: {} }, repoRoot: '/r', visiblePaths: commits[0].keys, path: '/a', slot: commits[0].slot })?.worktrees['/r']).toEqual(['/a', '/r', '/b', '/c'])
  })

  it('레포 헤더 = 묶음 사본(헤더 기준 잡은 점) + 다른 묶음 밀림', () => {
    const api = mount({ repos: THREE_REPOS, listTop: 0, listBottom: 600 })
    api.onRepoMouseDown({ event: dom.down(40, 610), root: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 10, buttons: 1 })
    const [preview] = dom.previews()
    expect(preview.getAttribute('data-sidebar-drag-preview-kind')).toBe('repo')
    expect(preview.style.height).toBe('300px')
    // 헤더 600..628 을 10px 아래에서 잡았다 → 사본 윗변 = 커서 − 10.
    expect(preview.style.transform).toBe('translate3d(0px, 0px, 0) scale(1.015)')
    expect(dom.shifts()).toEqual({ '/a': 300, '/b': 300 })
  })

  const cancels = {
    Escape: () => dom.doc.emit('keydown', { key: 'Escape' }),
    blur: () => dom.win.emit('blur'),
    '목록 밖 놓기': () => dom.doc.emit('mouseup', { clientX: 40, clientY: 700 }),
    'source 소멸': () => {
      dom.setRepos([{ ...FOUR[0], cards: FOUR[0].cards.filter((card) => card.path !== '/c') }])
      dom.runFrame(16)
    },
  }
  for (const [name, cancel] of Object.entries(cancels)) {
    it(`ⓓ ${name} — 사본 제거·행 원위치·밀림 class 해제, 잔존 없음, commit 없음`, () => {
      const api = mount({ repos: FOUR, listTop: 0, listBottom: 600 })
      api.onCardMouseDown({ event: dom.down(40, 230), repoRoot: '/r', path: '/c' })
      dom.doc.emit('mousemove', { clientX: 40, clientY: 100, buttons: 1 })
      expect(dom.previews()).toHaveLength(1)
      expect(Object.keys(dom.shifts()).length).toBeGreaterThan(0)
      cancel()
      expect(dom.previews()).toHaveLength(0)
      expect(dom.shifts()).toEqual({})
      expect(dom.listClasses.has('is-reorder-shifting')).toBe(false)
      expect(render().state).toBeNull()
      expect(commits).toEqual([])
    })
  }

  it('ⓓ 목록 밖으로 나가 있는 동안(놓기 전)에는 밀림을 거두고 표시 줄도 없다 — 돌아오면 다시 벌어진다', () => {
    const api = mount({ repos: FOUR, listTop: 0, listBottom: 600 })
    api.onCardMouseDown({ event: dom.down(40, 230), repoRoot: '/r', path: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 100, buttons: 1 })
    dom.doc.emit('mousemove', { clientX: 400, clientY: 100, buttons: 1 })
    expect(dom.shifts()).toEqual({})
    expect(render().state?.indicatorY).toBeNull()
    dom.doc.emit('mousemove', { clientX: 40, clientY: 100, buttons: 1 })
    expect(dom.shifts()).toEqual({ '/a': 60, '/b': 60 })
  })

  it('실측에 소수 오차가 섞여도 건 밀림을 다시 쓰지 않는다 — 다시 쓰면 150ms 전환이 매 프레임 재시작된다(격리 run18 K3h-c-repo)', () => {
    const api = mount({ repos: FOUR, listTop: 0, listBottom: 600, noise: 0.03 })
    api.onCardMouseDown({ event: dom.down(40, 230), repoRoot: '/r', path: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 100, buttons: 1 })
    expect(dom.shifts()).toEqual({ '/a': 60, '/b': 60 })
    for (let frame = 1; frame <= 6; frame++) {
      dom.runFrame(frame * 16)
      expect(dom.shifts()).toEqual({ '/a': 60, '/b': 60 })
    }
  })

  // R6-01 — 복제 순간 열려 있던 ⋯ 메뉴가 사본에 남지 않는다(라이브 메뉴는 reordering 효과가 렌더 뒤에 닫는다).
  it('R6-01 ⓐ 카드 ⋯ 메뉴를 연 채 그 카드를 끌면 — 사본 안 메뉴 0, 사본 자체는 있다', () => {
    const repos = [{ ...FOUR[0], cards: FOUR[0].cards.map((card) => (card.path === '/c' ? { ...card, menu: true } : card)) }]
    const api = mount({ repos, listTop: 0, listBottom: 600 })
    api.onCardMouseDown({ event: dom.down(40, 230), repoRoot: '/r', path: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 100, buttons: 1 })
    const [preview] = dom.previews()
    expect(preview.children).toHaveLength(1)
    expect(preview.querySelectorAll('.repo-row-menu')).toHaveLength(0)
  })

  it('R6-01 ⓑ 같은 레포 카드 메뉴·레포 메뉴를 연 채 그 레포 헤더를 끌면 — 묶음 사본 안 메뉴 0 · is-menu-open 없음, 카드 사본은 그대로', () => {
    const repos = THREE_REPOS.map((repo) => (repo.root === '/c' ? { ...repo, menu: true, cards: [{ path: '/c/1', top: 640, bottom: 690, menu: true }, { path: '/c/2', top: 700, bottom: 750 }] } : repo))
    const api = mount({ repos, listTop: 0, listBottom: 600 })
    api.onRepoMouseDown({ event: dom.down(40, 610), root: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 10, buttons: 1 })
    const [preview] = dom.previews()
    const clone = preview.children[0]
    expect(clone.querySelectorAll('.repo-row-menu')).toHaveLength(0)
    expect(clone.querySelectorAll('.is-menu-open')).toHaveLength(0)
    expect(clone.querySelectorAll('.worktree-row')).toHaveLength(2)
  })

  it('놓으면 사본·밀림이 정리되고 commit 한다', () => {
    const api = mount({ repos: FOUR, listTop: 0, listBottom: 600 })
    api.onCardMouseDown({ event: dom.down(40, 230), repoRoot: '/r', path: '/c' })
    dom.doc.emit('mousemove', { clientX: 40, clientY: 100, buttons: 1 })
    dom.doc.emit('mouseup', { clientX: 40, clientY: 100 })
    expect(commits).toHaveLength(1)
    expect(dom.previews()).toHaveLength(0)
    expect(dom.shifts()).toEqual({})
  })
})
