// hook 수준 시험용 가짜 React·DOM (LIFE-469 수정 라운드 1). 렌더러에는 jsdom·testing-library 가 없어 실제 hook 을
// 그대로 돌리되, React 의 상태·효과 스케줄과 DOM 사각형·이벤트 전달만 손으로 흉내 낸다. 브라우저 실제 click 생성·레이아웃은
// 격리 실행(`scripts/l469/reorder-isolated.mjs`)이 본다.
//
// 쓰는 법: 시험 파일에서 `vi.mock('react', () => import('./fake-react.test-helper.mjs'))` 로 갈아 끼운다.

let current = null

export const useState = (initial) => current.useState(initial)
export const useRef = (initial) => current.useRef(initial)
export const useEffect = (effect, deps) => current.useEffect(effect, deps)
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
      current = this
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

const box = (top, bottom) => ({ top, bottom, left: 0, right: 280, width: 280, height: bottom - top })

/**
 * 가짜 사이드바 목록. 좌표는 **스크롤 내용 기준**으로 주고 화면 좌표는 `top − scrollTop` 으로 만든다.
 * repos: [{ root, top, bottom, head: [top, bottom] | 'sticky', cards: [{ path, top, bottom }] }]
 * `head: 'sticky'` = 헤더가 목록 윗변에 붙었다(묶음 범위 안에서) — 헤더 높이 28.
 */
export function fakeDom(options) {
  const doc = new FakeTarget()
  const win = new FakeTarget()
  const timers = []
  const frames = new Map()
  const classes = new Set()
  let nextFrame = 0
  doc.body = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } }
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
  }
  const screen = (top, bottom) => () => box(listTop + top - list.scrollTop, listTop + bottom - list.scrollTop)
  const headRect = (repo) => () => {
    if (repo.head !== 'sticky') return screen(repo.head[0], repo.head[1])()
    const stuckTop = Math.min(Math.max(repo.top, list.scrollTop), repo.bottom - 28)
    return screen(stuckTop, stuckTop + 28)()
  }
  const group = (repo) => ({
    getAttribute: () => repo.root,
    getBoundingClientRect: screen(repo.top, repo.bottom),
    querySelector: () => ({ getBoundingClientRect: headRect(repo) }),
    querySelectorAll: () =>
      (repo.cards ?? []).map((card) => ({ getAttribute: () => card.path, getBoundingClientRect: screen(card.top, card.bottom) })),
  })
  return {
    doc,
    win,
    list,
    classes,
    timers,
    frames,
    globals: {
      document: doc,
      window: win,
      Element: FakeElement,
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
