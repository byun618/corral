// @vitest-environment happy-dom
// diff 줄 메모 장치 (LIFE-832 L1·L3·L4ⓕ·L7·L10ⓔ) — 가짜 Monaco 위에서 DiffView 를 그린다. main push 는 저장소 `apply` 로 흉내 낸다(구독은 모듈에 한 번).
// 오른쪽 편집기의 거터 누름 → 줄 아래 편집(view zone) → 저장 → 카드 · 머리 「메모 N · 보내기」 → 확인 단계(대상 + 본문 전체) → 보내기 IPC.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIFF_NOTES_LEAD, type DiffNotesSendInput, type DiffNotesState } from '../../../shared/diff-notes.js'
import type { ScmDiffMode, ScmDiffTarget } from '../../../shared/scm.js'
import type { PaneRow, WorktreeRow } from '../../../shared/types.js'
import { EMPTY_SESSION_DIGEST } from '../../../shared/types.js'
import { emptyAgentState } from '../../../shared/agent-state.js'

type Handler = (event: { target: { type: number; position: { lineNumber: number } | null } }) => void
type Decoration = { options: { glyphMarginClassName?: string } }
type ZoneOptions = { domNode: HTMLElement; suppressMouseDown?: boolean }
const fake: { mouseDown: Handler[]; mouseMove: Handler[]; contentChanged: (() => void)[]; decorationSets: Decoration[][]; zones: Map<string, HTMLElement>; zoneSeq: number; zoneOptions: ZoneOptions[]; lateZones: boolean; contentWidth: number; layoutChanged: (() => void)[]; viewHeight: number; scrollTop: number; scrolls: number[]; lines: string[]; modified: number } = {
  zoneOptions: [],
  lateZones: false,
  contentWidth: 600,
  layoutChanged: [],
  viewHeight: 1000,
  scrollTop: 0,
  scrolls: [],
  mouseDown: [],
  mouseMove: [],
  contentChanged: [],
  decorationSets: [],
  zones: new Map(),
  zoneSeq: 0,
  lines: ['line one', 'line two', 'line three'],
  modified: 0,
}
const listen = <T,>(list: T[], handler: T) => {
  list.push(handler)
  return { dispose: () => list.splice(list.indexOf(handler), 1) }
}

const codeEditor = () => ({
  updateOptions: () => {},
  createDecorationsCollection: () => ({ set: (items: Decoration[]) => fake.decorationSets.push(items), clear: () => {} }),
  onMouseMove: (handler: Handler) => listen(fake.mouseMove, handler),
  onMouseLeave: () => ({ dispose: () => {} }),
  onMouseDown: (handler: Handler) => {
    fake.mouseDown.push(handler)
    return { dispose: () => fake.mouseDown.splice(fake.mouseDown.indexOf(handler), 1) }
  },
  onDidChangeModelContent: (handler: () => void) => listen(fake.contentChanged, handler),
  getLayoutInfo: () => ({ contentWidth: fake.contentWidth, height: fake.viewHeight }),
  // 줄 높이 18 고정(zone 높이는 세지 않는다 — 스크롤 판단 시험에는 충분)
  getTopForLineNumber: (line: number) => (line - 1) * 18,
  getScrollHeight: () => fake.lines.length * 18,
  getScrollTop: () => fake.scrollTop,
  setScrollTop: (value: number) => {
    fake.scrollTop = value
    fake.scrolls.push(value)
  },
  onDidLayoutChange: (handler: () => void) => listen(fake.layoutChanged, handler),
  getModel: () => ({ getLineCount: () => fake.lines.length, getLineContent: (line: number) => fake.lines[line - 1] ?? '' }),
  changeViewZones: (run: (accessor: { addZone: (zone: ZoneOptions) => string; removeZone: (id: string) => void }) => void) =>
    run({
      addZone: (zone) => {
        const { domNode } = zone
        const id = `z${(fake.zoneSeq += 1)}`
        fake.zoneOptions.push(zone)
        // 실제 Monaco 는 붙인 zone 을 다음 그리기에서야 보인다 — 늦게 붙여 흉내 낸다.
        if (fake.lateZones) requestAnimationFrame(() => document.body.append(domNode))
        else document.body.append(domNode)
        fake.zones.set(id, domNode)
        return id
      },
      removeZone: (id) => {
        fake.zones.get(id)?.remove()
        fake.zones.delete(id)
      },
    }),
})

vi.mock('../editor/monaco.js', () => ({
  monaco: { editor: { MouseTargetType: { GUTTER_GLYPH_MARGIN: 2, GUTTER_LINE_NUMBERS: 3, CONTENT_TEXT: 6 } }, Range: class {} },
  languageFor: async () => 'typescript',
  createModel: ({ text }: { text: string }) => {
    const model = { value: text, getValue: () => model.value, setValue: (next: string) => (model.value = next), dispose: () => {} }
    return model
  },
  createEditor: () => ({ setModel: () => {}, saveViewState: () => null, restoreViewState: () => {}, dispose: () => {} }),
  createDiffEditor: () => {
    fake.modified += 1
    return { setModel: () => {}, saveViewState: () => null, restoreViewState: () => {}, dispose: () => {}, getModifiedEditor: codeEditor }
  },
}))

const { DiffView } = await import('./DiffView.js')
const { diffNotes } = await import('../diff-notes-store.js')
const { discardNoteDraft } = await import('./DiffNotes.js')

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let sends: DiffNotesSendInput[]
let subscriptions: number
let rootSeq = 0
let worktreePath = ''

const pane = (id: string, agent: string | null, session: boolean, tab = 1): PaneRow => ({
  paneId: id,
  tabId: `t${tab}`,
  workspaceId: 'ws',
  title: `${id} 제목`,
  agent,
  agentStatus: 'idle',
  agentState: emptyAgentState(0),
  cwd: null,
  focused: false,
  agentSession: session ? { kind: 'id', agent: agent ?? 'claude', source: 'herdr', id: `s-${id}` } : null,
  digest: EMPTY_SESSION_DIGEST,
})

const worktreeOf = (panes: PaneRow[]): WorktreeRow => ({
  path: worktreePath,
  branch: 'feat',
  head: 'abc',
  repoName: 'r',
  isLinked: true,
  openWorkspaceId: 'ws',
  workspace: {
    workspaceId: 'ws',
    label: 'feat',
    number: 1,
    agentStatus: 'idle',
    focused: false,
    tabs: [...new Set(panes.map((row) => row.tabId))].map((tabId, index) => ({ tabId, workspaceId: 'ws', label: '', number: index + 1, order: index, agentStatus: 'idle', focused: false, panes: panes.filter((row) => row.tabId === tabId), digest: EMPTY_SESSION_DIGEST })),
  },
  gitStatus: { branch: 'feat', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
  displayName: null,
  comment: null,
  parentPath: null,
})

beforeEach(() => {
  fake.mouseDown.length = 0
  fake.mouseMove.length = 0
  fake.contentChanged.length = 0
  fake.decorationSets.length = 0
  fake.lines = ['line one', 'line two', 'line three']
  fake.zones.clear()
  fake.zoneOptions = []
  fake.contentWidth = 600
  fake.layoutChanged.length = 0
  fake.viewHeight = 1000
  fake.scrollTop = 0
  fake.scrolls = []
  fake.modified = 0
  sends = []
  subscriptions = 0
  rootSeq += 1
  worktreePath = `/r${rootSeq}`
  Reflect.set(window, 'corral', {
    readFile: async () => ({ ok: true, kind: 'text', text: fake.lines.join('\n'), size: 10, bom: false, utf8: true, nlink: 1, bytesRead: 10, stamp: 's', hash: 'h' }),
    scmRead: async () => ({ ok: true, kind: 'text', text: 'old\n', size: 4 }),
    explorerWatch: async () => ({ ok: true }),
    explorerRefreshGit: () => {},
    onExplorerEvent: () => () => {},
    diffNotesSend: async (input: DiffNotesSendInput) => {
      sends.push(input)
      return { ok: true }
    },
    diffNotesCancel: () => {},
    onDiffNotesState: (listener: (state: DiffNotesState) => void) => {
      subscriptions += 1
      void listener
      return () => {}
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  act(() => root.unmount())
  await flush()
  host.remove()
  for (const zone of fake.zones.values()) zone.remove()
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await act(async () => await Promise.resolve())
}
const render = async (input: { target: ScmDiffTarget; worktree?: WorktreeRow | null }): Promise<void> => {
  const notes = input.worktree === null ? undefined : { worktree: input.worktree ?? worktreeOf([pane('c1', 'claude', true)]) }
  act(() => root.render(createElement(DiffView, { root: worktreePath, target: input.target, stamp: 1, watch: false, onOpenFile: () => {}, notes })))
  await flush()
}
const click = async (selector: string, scope: ParentNode = document): Promise<void> => {
  const element = scope.querySelector(selector)
  if (!(element instanceof HTMLElement)) throw new Error(`없음: ${selector}`)
  act(() => element.click())
  await flush()
}
const gutter = async (line: number): Promise<void> => {
  act(() => {
    for (const handler of [...fake.mouseDown]) handler({ target: { type: 3, position: { lineNumber: line } } })
  })
  await flush()
}
const type = async (text: string): Promise<void> => {
  const input = document.querySelector('[data-diff-note-editor] textarea')
  if (!(input instanceof HTMLTextAreaElement)) throw new Error('편집 없음')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

// 이 describe 가 파일에서 맨 먼저 돈다 — push 구독은 모듈에 한 번이라 다른 시험이 먼저 구독하면 셀 수 없다.
describe('메모 없는 diff 탭 (L10ⓔ)', () => {
  it('notes 를 안 주면 장치도 push 구독도 없다(L10ⓔ)', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null }, worktree: null })
    expect(host.querySelector('[data-diff-notes-head]')).toBeNull()
    expect(fake.mouseDown).toHaveLength(0)
    expect(subscriptions).toBe(0)
  })
})

describe('메모 장치가 서는 모드 (L1)', () => {
  it.each<[ScmDiffMode, boolean]>([
    ['wt', true],
    ['wtType', true],
    ['wtRename', true],
    ['base', true],
    ['idx', false],
    ['idxOnly', false],
    ['deleted', false],
    ['baseDeleted', false],
  ])('%s → 장치 %s', async (mode, shown) => {
    await render({ target: { mode, rel: 'a.ts', orig: null } })
    expect(host.querySelector('[data-diff-notes-head]') !== null).toBe(shown)
    // 거터 누름 처리는 메모 모드의 오른쪽 편집기에만 붙는다(왼쪽·다른 모드는 장치 없음).
    expect(fake.mouseDown.length > 0).toBe(shown)
  })
})

describe('달기·고치기·지우기 → 확인 단계 → 보내기 (L1·L3·L7)', () => {
  it('거터 누름 → 편집 → 빈 메모는 저장 안 됨 → 저장 → 카드 · 머리 메모 1 · 확인 단계에 대상과 본문 전체 → 보내기 = 그 본문 그대로', async () => {
    await render({ target: { mode: 'base', rel: 'src/a.ts', orig: null } })
    expect(host.querySelector('[data-diff-notes-unsent]')?.getAttribute('data-diff-notes-unsent')).toBe('0')
    expect(host.querySelector('[data-diff-notes-send]')?.hasAttribute('disabled')).toBe(true)
    await gutter(2)
    expect(document.querySelector('[data-diff-note-editor="2"]')).not.toBeNull()
    expect(document.querySelector('[data-diff-note-save]')?.hasAttribute('disabled')).toBe(true)
    await type('여기 "고쳐"\n둘째 줄')
    await click('[data-diff-note-save]')
    const card = document.querySelector('[data-diff-note="2"]')
    expect(card?.textContent).toContain('여기 "고쳐"')
    expect(host.querySelector('[data-diff-notes-unsent]')?.getAttribute('data-diff-notes-unsent')).toBe('1')
    // 고치기 → 같은 줄 편집 → 저장.
    await click('[data-diff-note-edit]', card ?? document)
    await type('고친 메모')
    await click('[data-diff-note-save]')
    expect(document.querySelector('[data-diff-note="2"]')?.textContent).toContain('고친 메모')
    await click('[data-diff-notes-send]')
    const body = document.querySelector('[data-diff-notes-body]')?.textContent ?? ''
    // 리드 한 줄과 본문을 같이 보인다(리뷰 r1 A1) — 보내기 IPC 에는 본문만(리드는 main 이 친다).
    expect(document.querySelector('[data-diff-notes-lead]')?.textContent).toBe(DIFF_NOTES_LEAD)
    expect(body).toBe('diff 리뷰 메모 1개 (비교 기준: base)\n\nFile: "src/a.ts"\nLine: 2\nCode: "line two"\nNote: "고친 메모"')
    // 대상 1개 = 기본 선택.
    expect(document.querySelector<HTMLInputElement>('[data-diff-notes-target="c1"] input')?.checked).toBe(true)
    await click('[data-diff-notes-confirm-send]')
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ worktree: worktreePath, paneId: 'c1', text: body })
    expect(document.querySelector('[data-diff-notes-confirm]')).toBeNull()
    expect(host.querySelector('[data-diff-notes-send]')?.hasAttribute('disabled')).toBe(true)
    // 결과 들어감 → 「보냄」 · 안 보낸 메모 0 · 결과 안내.
    act(() => diffNotes.apply({ requestId: sends[0]?.requestId ?? '', state: 'delivered', wait: null, reason: null }))
    await flush()
    expect(host.querySelector('[data-diff-notes-result]')?.getAttribute('data-diff-notes-result')).toBe('delivered')
    expect(document.querySelector('[data-diff-note-sent-badge]')).not.toBeNull()
    expect(host.querySelector('[data-diff-notes-unsent]')?.getAttribute('data-diff-notes-unsent')).toBe('0')
    // 지우기.
    await click('[data-diff-note-delete]')
    expect(document.querySelector('[data-diff-note="2"]')).toBeNull()
  })
  it('확인 단계 취소 → 보내기 IPC 0', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(1)
    await type('m')
    await click('[data-diff-note-save]')
    await click('[data-diff-notes-send]')
    await click('[data-diff-notes-confirm-cancel]')
    expect(sends).toHaveLength(0)
    expect(document.querySelector('[data-diff-notes-confirm]')).toBeNull()
  })
})

describe('대상 (L4ⓐ·ⓒ·ⓓ·ⓕ)', () => {
  const withNote = async (worktree: WorktreeRow): Promise<void> => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null }, worktree })
    await gutter(1)
    await type('m')
    await click('[data-diff-note-save]')
    await click('[data-diff-notes-send]')
  }
  it('후보는 있으나 고를 수 있는 pane 0개 → 「고르세요」 가 아니라 그 사유(리뷰 r1 A6)', async () => {
    await withNote(worktreeOf([pane('c1', 'claude', false), pane('c2', 'codex', false, 2)]))
    const blocked = document.querySelector('[data-diff-notes-confirm]')?.textContent ?? ''
    expect(blocked).toContain('고를 수 있는 pane 이 없습니다')
    expect(blocked).not.toContain('보낼 pane 을 고르세요')
    expect(document.querySelector('[data-diff-notes-confirm-send]')?.hasAttribute('disabled')).toBe(true)
  })
  it('ⓐ 에이전트 pane 0개 → 보내기 불가 + 사유', async () => {
    await withNote(worktreeOf([pane('s1', null, false)]))
    expect(document.querySelector('[data-diff-notes-no-target]')).not.toBeNull()
    expect(document.querySelector('[data-diff-notes-confirm-send]')?.hasAttribute('disabled')).toBe(true)
  })
  it('ⓒ 2개 → 기본 없음(막힘) → 고르면 그 pane 으로 · ⓓ 세션 없는 pane 은 고를 수 없음', async () => {
    await withNote(worktreeOf([pane('c1', 'claude', true, 1), pane('c2', 'codex', true, 2), pane('c3', 'claude', false, 3)]))
    expect(document.querySelector('[data-diff-notes-confirm-send]')?.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector<HTMLInputElement>('[data-diff-notes-target="c3"] input')?.disabled).toBe(true)
    await click('[data-diff-notes-target="c2"] input')
    await click('[data-diff-notes-confirm-send]')
    expect(sends.map((sent) => sent.paneId)).toEqual(['c2'])
  })
  it('ⓕ 확인 단계가 열린 채 요청 없이 고른 pane 이 닫히면 막히고, 새 에이전트 pane 이 생기면 후보에 나타난다(상태 발행마다 다시 계산)', async () => {
    await withNote(worktreeOf([pane('c1', 'claude', true)]))
    expect(document.querySelector('[data-diff-notes-confirm-send]')?.hasAttribute('disabled')).toBe(false)
    // 상태 발행: c1 닫힘, c9 새로 생김(세션 아직 없음).
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null }, worktree: worktreeOf([pane('c9', 'codex', false)]) })
    expect(document.querySelector('[data-diff-notes-target="c1"]')).toBeNull()
    expect(document.querySelector('[data-diff-notes-target="c9"]')).not.toBeNull()
    expect(document.querySelector('[data-diff-notes-confirm-send]')?.hasAttribute('disabled')).toBe(true)
    // 세션이 보고되면 고를 수 있다 — 하나뿐이라 기본 선택.
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null }, worktree: worktreeOf([pane('c9', 'codex', true)]) })
    expect(document.querySelector('[data-diff-notes-confirm-send]')?.hasAttribute('disabled')).toBe(false)
  })
})

describe('결과 안내 (L7)', () => {
  it('대기(turn) → 취소 단추 · 실패 → 사유 문구 · 다른 worktree 의 diff 에는 결과가 없다', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(1)
    await type('m')
    await click('[data-diff-note-save]')
    await click('[data-diff-notes-send]')
    await click('[data-diff-notes-confirm-send]')
    const requestId = sends[0]?.requestId ?? ''
    act(() => diffNotes.apply({ requestId, state: 'queued', wait: 'turn', reason: null }))
    await flush()
    expect(host.querySelector('[data-diff-notes-result]')?.textContent).toContain('에이전트가 작업 중')
    expect(host.querySelector('[data-diff-notes-cancel]')).not.toBeNull()
    act(() => diffNotes.apply({ requestId, state: 'failed', wait: null, reason: 'mac_draft' }))
    await flush()
    expect(host.querySelector('[data-diff-notes-result]')?.textContent).toContain('쓰던 글')
    expect(diffNotes.notesOf(worktreePath).some((note) => note.sent)).toBe(false)
    const mine = worktreePath
    worktreePath = `${mine}-other`
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    expect(host.querySelector('[data-diff-notes-result]')).toBeNull()
  })
})

describe('리뷰 r1 — 표지·편집·Esc·hover (A4·A7·A10)', () => {
  const markLines = (): number => (fake.decorationSets.at(-1) ?? []).filter((item) => item.options.glyphMarginClassName?.includes('diff-note-mark')).length
  it('A4 줄 수가 같은 내용 갱신(setValue)에도 표지를 다시 세운다', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(2)
    await type('m')
    await click('[data-diff-note-save]')
    expect(markLines()).toBe(1)
    const before = fake.decorationSets.length
    // setValue 는 데코레이션을 버린다 — 줄 수 3 그대로 내용만 바뀜.
    fake.lines = ['LINE ONE', 'LINE TWO', 'LINE THREE']
    act(() => {
      for (const handler of [...fake.contentChanged]) handler()
    })
    await flush()
    expect(fake.decorationSets.length).toBeGreaterThan(before)
    expect(markLines()).toBe(1)
  })
  it('A7 저장 안 한 글이 있으면 다른 줄 거터 누름이 편집을 버리지 않는다 · 빈 편집은 옮겨 간다', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(1)
    await gutter(3)
    expect(document.querySelector('[data-diff-note-editor="3"]')).not.toBeNull()
    await type('쓰던 메모')
    await gutter(1)
    expect(document.querySelector('[data-diff-note-editor="3"]')).not.toBeNull()
    expect(document.querySelector('[data-diff-note-editor="1"]')).toBeNull()
    expect(document.querySelector<HTMLTextAreaElement>('[data-diff-note-editor] textarea')?.value).toBe('쓰던 메모')
    // 안내 + 편집 칸 포커스(리뷰 r2 B3).
    expect(document.querySelector('[data-diff-note-held]')).not.toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-diff-note-editor] textarea'))
  })
  it('A7 확인 단계는 Esc 로 닫힌다 — 보내기 IPC 0', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(1)
    await type('m')
    await click('[data-diff-note-save]')
    await click('[data-diff-notes-send]')
    expect(document.querySelector('[data-diff-notes-confirm]')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    expect(document.querySelector('[data-diff-notes-confirm]')).toBeNull()
    expect(sends).toHaveLength(0)
  })
  it('B6 조합 중 Esc 는 확인 단계를 닫지 않고, 닫는 Esc 는 아래로 전파하지 않는다', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(1)
    await type('m')
    await click('[data-diff-note-save]')
    await click('[data-diff-notes-send]')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
    })
    await flush()
    expect(document.querySelector('[data-diff-notes-confirm]')).not.toBeNull()
    const below = vi.fn()
    document.addEventListener('keydown', below)
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    document.removeEventListener('keydown', below)
    expect(document.querySelector('[data-diff-notes-confirm]')).toBeNull()
    expect(below).not.toHaveBeenCalled()
  })
  it('B5 렌더러 교체 오발동 — main 의 unknown/renderer_gone 하나로 「보내는 중」 이 풀린다', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(1)
    await type('m')
    await click('[data-diff-note-save]')
    await click('[data-diff-notes-send]')
    await click('[data-diff-notes-confirm-send]')
    const requestId = sends[0]?.requestId ?? ''
    act(() => diffNotes.apply({ requestId, state: 'sending', wait: null, reason: null }))
    await flush()
    expect(diffNotes.busy(worktreePath)).toBe(true)
    act(() => diffNotes.apply({ requestId, state: 'unknown', wait: null, reason: 'renderer_gone' }))
    await flush()
    expect(diffNotes.busy(worktreePath)).toBe(false)
    expect(host.querySelector('[data-diff-notes-result]')?.textContent).toContain('결과를 받지 못했습니다')
    expect(host.querySelector('[data-diff-notes-send]')?.hasAttribute('disabled')).toBe(false)
  })
  it('B2 내용 갱신 뒤 같은 줄에 머물러도 hover 「+」 를 다시 건다', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    const move = (line: number): void => {
      act(() => {
        for (const handler of [...fake.mouseMove]) handler({ target: { type: 6, position: { lineNumber: line } } })
      })
    }
    const hovers = (): number => fake.decorationSets.filter((items) => items.some((item) => item.options.glyphMarginClassName?.includes('diff-note-add'))).length
    move(2)
    expect(hovers()).toBe(1)
    act(() => {
      for (const handler of [...fake.contentChanged]) handler()
    })
    await flush()
    move(2)
    expect(hovers()).toBe(2)
  })
  it('A10 같은 줄 위 마우스 이동은 hover 데코레이션을 다시 걸지 않는다', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    const move = (line: number): void => {
      act(() => {
        for (const handler of [...fake.mouseMove]) handler({ target: { type: 6, position: { lineNumber: line } } })
      })
    }
    const before = fake.decorationSets.length
    move(2)
    move(2)
    move(2)
    expect(fake.decorationSets.length - before).toBe(1)
    move(3)
    expect(fake.decorationSets.length - before).toBe(2)
  })
})

describe('N1 1회차 — 메모 칸 사람 클릭·첫 포커스', () => {
  afterEach(() => {
    fake.lateZones = false
  })
  it('zone 이 편집기에 누름을 넘기지 않는다 — suppressMouseDown 이면 Monaco 가 textarea 포커스를 가져간다', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(2)
    expect(fake.zoneOptions.length).toBeGreaterThan(0)
    expect(fake.zoneOptions.every((zone) => zone.suppressMouseDown !== true)).toBe(true)
  })
  it('다른 탭을 다녀와 diff 탭이 다시 그려져도 쓰던 편집 칸이 그대로 돌아온다 · 저장하면 다시 그려도 편집 없음', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(2)
    await type('쓰던 글')
    act(() => root.unmount())
    root = createRoot(host)
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    expect(document.querySelector<HTMLTextAreaElement>('[data-diff-note-editor="2"] textarea')?.value).toBe('쓰던 글')
    await click('[data-diff-note-save]')
    act(() => root.unmount())
    root = createRoot(host)
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    expect(document.querySelector('[data-diff-note-editor]')).toBeNull()
    expect(document.querySelector('[data-diff-note="2"]')).not.toBeNull()
  })
  it('zone 은 보이는 글 칸 폭으로 묶인다(긴 줄이 있어도 단추가 보이게) · 편집기 크기가 바뀌면 다시', async () => {
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(2)
    const zone = document.querySelector('[data-diff-note-editor="2"]')?.closest('.diff-note-zone')
    if (!(zone instanceof HTMLElement)) throw new Error('zone 없음')
    expect(zone.style.getPropertyValue('--diff-note-width')).toBe('600px')
    fake.contentWidth = 420
    act(() => {
      for (const handler of [...fake.layoutChanged]) handler()
    })
    expect(zone.style.getPropertyValue('--diff-note-width')).toBe('420px')
  })
  it('zone 이 늦게 문서에 붙어도 편집 칸이 첫 포커스를 받는다', async () => {
    fake.lateZones = true
    await render({ target: { mode: 'wt', rel: 'a.ts', orig: null } })
    await gutter(2)
    for (let i = 0; i < 4; i += 1) await act(async () => await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(document.activeElement).toBe(document.querySelector('[data-diff-note-editor="2"] textarea'))
  })
})

describe('정정 r4 — 쓰던 편집 보관·복원·포커스 (리뷰 r5 E1·E2·E4·E6)', () => {
  const A = { target: { mode: 'wt' as const, rel: 'a.ts', orig: null } }
  const remount = async (input = A): Promise<void> => {
    act(() => root.unmount())
    root = createRoot(host)
    await render(input)
  }
  const area = (line: number): HTMLTextAreaElement | null => document.querySelector<HTMLTextAreaElement>(`[data-diff-note-editor="${line}"] textarea`)
  const esc = (): void => {
    act(() => {
      area(2)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
  }
  it('E1 복원 마운트는 포커스를 옮기지 않는다 — 다른 입력에 있던 포커스 그대로 · 쓰던 글은 그대로 열림', async () => {
    await render(A)
    await gutter(2)
    expect(document.activeElement).toBe(area(2))
    await type('쓰던 글')
    act(() => root.unmount())
    const other = document.createElement('input')
    document.body.append(other)
    other.focus()
    root = createRoot(host)
    await render(A)
    for (let i = 0; i < 4; i += 1) await act(async () => await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(area(2)?.value).toBe('쓰던 글')
    expect(document.activeElement).toBe(other)
    other.remove()
  })
  it('E1 복원 뒤 다른 줄 「+」(nudge) 는 사람이 연 것 — 쓰던 칸으로 포커스 + 안내', async () => {
    await render(A)
    await gutter(2)
    await type('쓰던 글')
    const other = document.createElement('input')
    document.body.append(other)
    act(() => root.unmount())
    other.focus()
    root = createRoot(host)
    await render(A)
    await gutter(3)
    expect(document.activeElement).toBe(area(2))
    expect(document.querySelector('[data-diff-note-held]')).not.toBeNull()
    other.remove()
  })
  it('E2 사람이 연 편집의 줄이 화면 밖이면 그 줄로 스크롤한 뒤 포커스 — 복원 마운트는 스크롤하지 않는다', async () => {
    fake.lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`)
    fake.viewHeight = 200
    await render(A)
    await gutter(80)
    expect(fake.scrolls).toEqual([79 * 18 - 40])
    await type('먼 줄 쓰던 글')
    fake.scrollTop = 0
    fake.scrolls = []
    await remount()
    expect(area(80)?.value).toBe('먼 줄 쓰던 글')
    expect(fake.scrolls).toEqual([])
    // 위쪽 줄 「+」 → 거절되고(nudge) 먼 줄로 스크롤 · 쓰던 칸 포커스
    await gutter(3)
    expect(fake.scrolls).toEqual([79 * 18 - 40])
    expect(document.activeElement).toBe(area(80))
    expect(area(3)).toBeNull()
  })
  it('E2 보이는 줄이면 스크롤하지 않는다', async () => {
    await render(A)
    await gutter(2)
    expect(fake.scrolls).toEqual([])
  })
  it('E4 그 diff 탭 닫기 = 보관 버림 — 다시 열면 쓰던 글 없음', async () => {
    await render(A)
    await gutter(2)
    await type('버릴 글')
    act(() => root.unmount())
    discardNoteDraft({ root: worktreePath, rel: 'a.ts' })
    root = createRoot(host)
    await render(A)
    expect(document.querySelector('[data-diff-note-editor]')).toBeNull()
  })
  it('E6 취소 단추·Esc 뒤 재마운트하면 편집 없음', async () => {
    await render(A)
    await gutter(2)
    await type('취소할 글')
    await click('[data-diff-note-cancel]')
    await remount()
    expect(document.querySelector('[data-diff-note-editor]')).toBeNull()
    await gutter(2)
    await type('Esc 할 글')
    esc()
    await flush()
    expect(document.querySelector('[data-diff-note-editor]')).toBeNull()
    await remount()
    expect(document.querySelector('[data-diff-note-editor]')).toBeNull()
  })
  it('E6 키 분리 — 다른 파일·다른 worktree 의 diff 에는 쓰던 편집이 안 열린다', async () => {
    await render(A)
    await gutter(2)
    await type('a.ts 쓰던 글')
    await remount({ target: { mode: 'wt', rel: 'b.ts', orig: null } })
    expect(document.querySelector('[data-diff-note-editor]')).toBeNull()
    const own = worktreePath
    worktreePath = `${own}-other`
    await remount()
    expect(document.querySelector('[data-diff-note-editor]')).toBeNull()
    worktreePath = own
    await remount()
    expect(area(2)?.value).toBe('a.ts 쓰던 글')
  })
  it('E6 고치기 중 복원 — 카드 자리 편집이 고친 글 그대로 다시 열린다(포커스 안 옮김)', async () => {
    await render(A)
    await gutter(2)
    await type('원래 글')
    await click('[data-diff-note-save]')
    await click('[data-diff-note="2"] [data-diff-note-edit]')
    await type('고치던 글')
    const other = document.createElement('input')
    document.body.append(other)
    act(() => root.unmount())
    other.focus()
    root = createRoot(host)
    await render(A)
    expect(area(2)?.value).toBe('고치던 글')
    expect(document.querySelector('[data-diff-note="2"]')).toBeNull()
    expect(document.activeElement).toBe(other)
    other.remove()
  })
  it('E6 보관 중 그 줄 메모가 밖에서 지워지면 — 쓰던 글은 새 줄 편집으로 열린다(카드 없음)', async () => {
    await render(A)
    await gutter(2)
    await type('원래 글')
    await click('[data-diff-note-save]')
    await click('[data-diff-note="2"] [data-diff-note-edit]')
    await type('고치던 글')
    act(() => root.unmount())
    const note = diffNotes.notesOf(worktreePath).find((row) => row.line === 2)
    if (note === undefined) throw new Error('메모 없음')
    diffNotes.remove({ root: worktreePath, id: note.id })
    root = createRoot(host)
    await render(A)
    expect(area(2)?.value).toBe('고치던 글')
    expect(document.querySelector('[data-diff-note="2"]')).toBeNull()
  })
})
