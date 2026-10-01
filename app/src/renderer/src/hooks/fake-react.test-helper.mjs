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

  useEffect(effect, deps) {
    const i = this.index++
    const old = this.slots[i]
    if (old === undefined || deps.some((value, j) => value !== old[j])) this.effects.push(effect)
    this.slots[i] = deps
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
  constructor(tag, attrs = {}) {
    this.tag = tag
    this.attrs = { ...attrs }
    this.children = []
    this.parent = null
    this.style = fakeStyle()
    this.classes = new Set()
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
  querySelectorAll() {
    return []
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
 * repos: [{ root, top, bottom, head: [top, bottom] | 'sticky', cards: [{ path, top, bottom }] }]
 * `head: 'sticky'` = 헤더가 목록 윗변에 붙었다(묶음 범위 안에서) — 헤더 높이 28.
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
      querySelectorAll: () => (repo.cards ?? []).map((card) => cardElement(card, current)),
      cloneNode: () => new FakeNode('div', { 'data-repo': repo.root }),
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
    Object.assign(current, {
      parentElement: parent,
      getAttribute: () => card.path,
      getBoundingClientRect: screen(card.top, card.bottom, current),
      cloneNode: () => new FakeNode('div', { 'data-reorder-card': card.path }),
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
