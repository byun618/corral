// hook 수준 시험용 가짜 React·DOM (LIFE-469 수정 라운드 1). 렌더러에는 jsdom·testing-library 가 없어 실제 hook 을
// 그대로 돌리되, React 의 상태·효과 스케줄과 DOM 사각형·이벤트 전달만 손으로 흉내 낸다. 브라우저 실제 click 생성·레이아웃은
// 격리 실행(`scripts/l469/reorder-isolated.mjs`)이 본다.
//
// 쓰는 법: 시험 파일에서 `vi.mock('react', () => import('./fake-react.test-helper.mjs'))` 로 갈아 끼운다.

/** 지금 그리는 host — 가짜 hook 이 여기로 위임한다. */
const active = { host: null }

export const useState = (initial) => active.host.useState(initial)
export const useRef = (initial) => active.host.useRef(initial)
export const useEffect = (effect, deps) => active.host.useEffect(effect, deps)
export const useCallback = (fn) => fn

/** 렌더 한 번 = hook 호출 → 바뀐 deps 의 효과 실행. 효과가 상태를 바꾸면 안정될 때까지 다시 그린다. */
export class HookHost {
  slots = []
  index = 0
  effects = []
  dirty = false

  useState(initial) {
    const i = this.index++
    if (!(i in this.slots)) this.slots[i] = initial
    const set = (value) => {
      const next = typeof value === 'function' ? value(this.slots[i]) : value
      if (next !== this.slots[i]) this.dirty = true
      this.slots[i] = next
    }
    return [this.slots[i], set]
  }

  useRef(initial) {
    const i = this.index++
    if (!(i in this.slots)) this.slots[i] = { current: initial }
    return this.slots[i]
  }

  /** 효과가 돌려준 정리 함수 — deps 가 바뀌어 다시 돌기 전에 부른다(React 와 같다, LIFE-470 R1-05 타이머 정리). */
  cleanups = []

  useEffect(effect, deps) {
    const i = this.index++
    const old = this.slots[i]
    if (old === undefined || deps.some((value, j) => value !== old[j]))
      this.effects.push(() => {
        const cleanup = this.cleanups[i]
        if (typeof cleanup === 'function') cleanup()
        this.cleanups[i] = effect()
      })
    this.slots[i] = deps
  }

  /** 언마운트 — 남은 정리 함수를 모두 부른다. */
  unmount() {
    for (const cleanup of this.cleanups.splice(0)) if (typeof cleanup === 'function') cleanup()
  }

  render(fn) {
    for (let pass = 0; pass < 20; pass++) {
      active.host = this
      this.index = 0
      this.dirty = false
      const value = fn()
      for (const effect of this.effects.splice(0)) effect()
      if (!this.dirty) return value
    }
    throw new Error('효과가 안정되지 않는다')
  }
}

/** 이벤트 대상 — 등록 순서대로, 전달 중 추가된 리스너는 그 이벤트를 받지 않는다(DOM 과 같다). */
export class FakeTarget {
  handlers = new Map()
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type).add(fn)
  }
  removeEventListener(type, fn) {
    this.handlers.get(type)?.delete(fn)
  }
  count(type) {
    return this.handlers.get(type)?.size ?? 0
  }
  emit(type, extra = {}) {
    const event = { type, button: 0, buttons: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...extra }
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn(event)
    return event
  }
}

export class FakeElement {
  closest() {
    return null
  }
}

/** 사본·틀 노드 — 붙이기·떼기·속성만. `HTMLElement` 자리에 끼운다(hook 의 `instanceof HTMLElement`). */
export class FakeNode {
  constructor(tag, attrs = {}, classes = []) {
    this.tag = tag
    this.attrs = { ...attrs }
    this.children = []
    this.parent = null
    this.style = fakeStyle()
    this.classes = new Set(classes)
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c) }
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }
  getAttribute(name) {
    return this.attrs[name] ?? null
  }
  removeAttribute(name) {
    delete this.attrs[name]
  }
  /** 단순 선택자만 — 쉼표 목록의 `*` · `.class` · `[attr="value"]`. 자손을 문서 순서로. */
  matches(selector) {
    return selector.split(',').some((part) => {
      const one = part.trim()
      if (one === '*') return true
      if (one.startsWith('.')) return this.classes.has(one.slice(1))
      const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(one)
      return attr !== null && this.attrs[attr[1]] === attr[2]
    })
  }
  querySelectorAll(selector) {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  appendChild(child) {
    child.parent = this
    this.children.push(child)
    return child
  }
  remove() {
    if (this.parent === null) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
}

/** 인라인 style — `transform` 칸과 `removeProperty` 만 실제로 쓴다. */
function fakeStyle() {
  const style = { transform: '' }
  style.removeProperty = (name) => {
    style[name] = ''
  }
  return style
}

/** `translateY(Npx)` 의 N. 다른 모양·빈 값은 0. */
function translateYOfStyle(element) {
  const match = /translateY\((-?[\d.]+)px\)/.exec(element?.style?.transform ?? '')
  return match === null ? 0 : Number(match[1])
}

class FakeMatrix {
  constructor(text) {
    const values = /matrix\(([^)]*)\)/.exec(text)?.[1].split(',').map(Number) ?? [1, 0, 0, 1, 0, 0]
    this.m42 = values[5] ?? 0
  }
}

const box = (top, bottom) => ({ top, bottom, left: 0, right: 280, width: 280, height: bottom - top })

/**
 * 가짜 사이드바 목록. 좌표는 **스크롤 내용 기준**으로 주고 화면 좌표는 `top − scrollTop` 으로 만든다.
 * repos: [{ root, top, bottom, head: [top, bottom] | 'sticky', cards: [{ path, top, bottom, parent?, content? }] }]
 * 카드 `depth` = 계보 깊이(`data-lineage-depth`, 루트는 생략). 카드 `parent` = 그 카드를 품은 카드 경로(LIFE-576 — 중첩 후손은 부모 카드 행 안에 그려진다, 목록에서 부모보다 뒤에 둔다).
 * `content: [top, bottom]` = 카드 내용 영역(`[data-worktree-card-parent-content]`), 없으면 카드 범위 그대로.
 * `head: 'sticky'` = 헤더가 목록 윗변에 붙었다(묶음 범위 안에서) — 헤더 높이 28.
 * 카드·레포에 `menu: true` 면 그 사본(cloneNode)에 열린 `⋯` 메뉴(`.repo-row-menu`)가 든다 — 복제 순간 메뉴가 열려 있던 상태(R6-01).
 * `noise` = getComputedStyle 이 돌려주는 이동에 읽을 때마다 달라지는 소수 오차(±noise)를 섞는다(브라우저 전환 중 실측 오차 흉내).
 */
export function fakeDom(options) {
  const doc = new FakeTarget()
  const win = new FakeTarget()
  const timers = []
  const frames = new Map()
  const classes = new Set()
  const listClasses = new Set()
  let nextFrame = 0
  let noiseCalls = 0
  const body = new FakeNode('body')
  body.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c) }
  doc.body = body
  doc.createElement = (tag) => new FakeNode(tag)
  /** `.sidebar` — 사본이 붙는 곳. */
  const sidebar = new FakeNode('div', { 'data-sidebar': '' })
  win.getSelection = () => ({ removeAllRanges() {} })
  win.setTimeout = (fn) => timers.push(fn)
  const listTop = options.listTop ?? 0
  const listBottom = options.listBottom ?? 600
  let repos = options.repos
  const list = {
    scrollTop: options.scrollTop ?? 0,
    scrollHeight: options.scrollHeight ?? 1200,
    clientHeight: listBottom - listTop,
    getBoundingClientRect: () => box(listTop, listBottom),
    querySelectorAll: () => repos.map(group),
    closest: () => sidebar,
    classList: { add: (c) => listClasses.add(c), remove: (c) => listClasses.delete(c) },
  }
  /** 화면 사각형 — 자기와 조상(묶음)에 걸린 translateY 를 더한다(브라우저 getBoundingClientRect 처럼). */
  const screen = (top, bottom, element) => () => {
    let shift = 0
    for (let node = element; node !== undefined && node !== null && node !== list; node = node.parentElement) shift += translateYOfStyle(node)
    return box(listTop + top - list.scrollTop + shift, listTop + bottom - list.scrollTop + shift)
  }
  const headRect = (repo, head) => () => {
    if (repo.head !== 'sticky') return screen(repo.head[0], repo.head[1], head)()
    const stuckTop = Math.min(Math.max(repo.top, list.scrollTop), repo.bottom - 28)
    return screen(stuckTop, stuckTop + 28, head)()
  }
  // 요소는 키마다 한 번 만든다 — hook 이 건 style.transform 이 다음 질의에도 남아 있게(실제 DOM 처럼).
  const groups = new Map()
  const cardElements = new Map()
  const group = (repo) => {
    let element = groups.get(repo.root)
    if (element === undefined) {
      element = { style: fakeStyle(), parentElement: list }
      groups.set(repo.root, element)
    }
    const current = element
    const head = { style: fakeStyle(), parentElement: current }
    head.getBoundingClientRect = headRect(repo, head)
    Object.assign(current, {
      getAttribute: () => repo.root,
      getBoundingClientRect: screen(repo.top, repo.bottom, current),
      querySelector: () => head,
      querySelectorAll: () => (repo.cards ?? []).map((card) => cardElement(card, card.parent === undefined ? current : (cardElements.get(card.parent) ?? current))),
      cloneNode: () => {
        const node = new FakeNode('div', { 'data-repo': repo.root }, ['repo-row-group'])
        const headNode = node.appendChild(new FakeNode('div', { 'data-repo-head': '' }, repo.menu ? ['repo-row-head', 'is-menu-open'] : ['repo-row-head']))
        if (repo.menu) headNode.appendChild(new FakeNode('div', { 'data-repo-menu': repo.root }, ['repo-row-menu']))
        for (const card of repo.cards ?? []) node.appendChild(cardElement(card, current).cloneNode())
        return node
      },
    })
    return current
  }
  const cardElement = (card, parent) => {
    let element = cardElements.get(card.path)
    if (element === undefined) {
      element = { style: fakeStyle() }
      cardElements.set(card.path, element)
    }
    const current = element
    const content = { style: fakeStyle(), parentElement: current }
    const [contentTop, contentBottom] = card.content ?? [card.top, card.bottom]
    content.getBoundingClientRect = screen(contentTop, contentBottom, content)
    Object.assign(current, {
      parentElement: parent,
      // `data-lineage-depth` 만 카드 `depth`(없으면 속성 없음 = null), 그 밖 속성은 경로(`data-reorder-card` 등).
      getAttribute: (name) => (name === 'data-lineage-depth' ? (card.depth === undefined ? null : String(card.depth)) : card.path),
      getBoundingClientRect: screen(card.top, card.bottom, current),
      querySelector: () => content,
      // 조상 사슬로 포함 판정(브라우저 `Node.contains`) — 사본이 끄는 행 밖 후손(평면 배치된 손자)을 따로 싣는지 본다(R2-C).
      contains: (other) => {
        for (let node = other; node !== undefined && node !== null; node = node.parentElement) if (node === current) return true
        return false
      },
      cloneNode: () => {
        // `data-fake-card` 는 사본에서 지우지 않는 시험용 표식 — 사본에 어느 카드가 실렸는지 읽는다.
        const node = new FakeNode('div', { 'data-reorder-card': card.path, 'data-fake-card': card.path }, ['worktree-row'])
        if (card.menu) node.appendChild(new FakeNode('div', { 'data-worktree-menu': card.path }, ['repo-row-menu', 'worktree-menu']))
        return node
      },
    })
    return current
  }
  return {
    doc,
    win,
    list,
    classes,
    listClasses,
    sidebar,
    timers,
    frames,
    /** 지금 걸린 행 밀림 — 키 → px(0 은 빼고). */
    shifts() {
      const out = {}
      for (const [key, element] of [...groups, ...cardElements]) {
        const y = translateYOfStyle(element)
        if (y !== 0) out[key] = y
      }
      return out
    },
    /** 붙어 있는 사본 틀들. */
    previews() {
      return [...sidebar.children, ...body.children].filter((node) => node.getAttribute('data-sidebar-drag-preview') === 'true')
    },
    globals: {
      document: doc,
      window: win,
      Element: FakeElement,
      HTMLElement: FakeNode,
      DOMMatrixReadOnly: FakeMatrix,
      getComputedStyle: (element) => {
        const y = translateYOfStyle(element)
        noiseCalls++
        return { transform: y === 0 ? 'none' : `matrix(1, 0, 0, 1, 0, ${y + Math.sin(noiseCalls) * (options.noise ?? 0)})` }
      },
      requestAnimationFrame: (fn) => {
        frames.set(++nextFrame, fn)
        return nextFrame
      },
      cancelAnimationFrame: (id) => frames.delete(id),
    },
    setRepos(next) {
      repos = next
    },
    runFrame(now) {
      for (const [id, fn] of [...frames]) {
        frames.delete(id)
        fn(now)
      }
    },
    runTimers() {
      for (const fn of timers.splice(0)) fn()
    },
    /** React 의 mousedown 이벤트 모양. */
    down(x, y) {
      return { button: 0, target: new FakeElement(), clientX: x, clientY: y, preventDefault() {} }
    },
  }
}
