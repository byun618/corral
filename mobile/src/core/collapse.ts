// 작업 접힘 (LIFE-580 · 디자인 Q2) — 기본 규칙 + 사용자가 바꾼 것만 폰에 기억한다. RN 을 모른다(저장 주입).
// 기본: 한가·확인 불가 세션만 있는 작업은 접힘, 그 외 펼침. 사용자가 누르면 그 작업의 값을 기억해 기본보다 앞선다(앱 재시작 뒤에도, L5ⓓ).
// 저장은 토큰 금고와 섞지 않는다 — 앱 문서 폴더의 평범한 JSON(`runtime/phone-store.ts`).
import type { Dot } from './list'

export const COLLAPSE_CAPACITY = 300

/** 기본 접힘 — 열린 세션의 (표시) 점이 전부 한가·확인 불가. */
export function defaultCollapsed(dots: readonly Dot[]): boolean {
  return dots.length > 0 && dots.every((dot) => dot === 'idle' || dot === 'unverifiable')
}

export type CollapseData = { v: 1; tasks: Record<string, { collapsed: boolean; at: number }> }
export type CollapseStore = { load(): CollapseData | null; save(data: CollapseData): void }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readCollapseData(value: unknown): CollapseData {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.tasks)) return { v: 1, tasks: {} }
  const tasks: CollapseData['tasks'] = {}
  for (const [id, entry] of Object.entries(value.tasks)) {
    if (isRecord(entry) && typeof entry.collapsed === 'boolean' && typeof entry.at === 'number') tasks[id] = { collapsed: entry.collapsed, at: entry.at }
  }
  return { v: 1, tasks }
}

export class CollapseMemory {
  private data: CollapseData
  private readonly store: CollapseStore
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor(input: { store: CollapseStore; now: () => number }) {
    this.store = input.store
    this.now = input.now
    this.data = input.store.load() ?? { v: 1, tasks: {} }
  }

  isCollapsed(taskId: string, dots: readonly Dot[]): boolean {
    return this.data.tasks[taskId]?.collapsed ?? defaultCollapsed(dots)
  }

  /** 누름 — 지금 보이는 값의 반대를 기억한다. */
  toggle(taskId: string, dots: readonly Dot[]): void {
    this.data.tasks[taskId] = { collapsed: !this.isCollapsed(taskId, dots), at: this.now() }
    const ids = Object.keys(this.data.tasks)
    if (ids.length > COLLAPSE_CAPACITY) {
      const drop = ids.sort((a, b) => (this.data.tasks[a]?.at ?? 0) - (this.data.tasks[b]?.at ?? 0)).slice(0, ids.length - COLLAPSE_CAPACITY)
      for (const id of drop) delete this.data.tasks[id]
    }
    this.store.save(this.data)
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version
}
