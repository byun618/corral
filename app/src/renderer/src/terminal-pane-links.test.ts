// @vitest-environment happy-dom
// LIFE-835 — pane 이름 판정(C1ⓐⓑⓒ)·누른 순간 재확인(C3ⓒ)·기존 이동 길(C2ⓘ)·이름 없는 행의 비용(C5ⓒ)·툴팁 자리(C4ⓒ 보조).
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState, PaneRow, RepoRow, TabRow, TerminalGroupState, WorktreeRow } from '../../shared/types.js'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import { emptyAgentState } from '../../shared/agent-state.js'
import { findLinksOnRow, registerTerminalLinks, type LinkCell, type ReadRow } from './terminal-links.js'
import {
  activatePaneLink,
  findPaneLinksOnRow,
  findPaneNames,
  livePaneIdsOf,
  publishLivePaneIds,
  paneLinkTooltipLines,
  placeTooltip,
  registerPaneNameLinks,
  resolvePaneLinkTarget,
  setPaneLinkDirectory,
  type PaneLinkDirectory,
  type PaneLinkTarget,
} from './terminal-pane-links.js'

/** 문자열 한 행을 칸으로 — 한글은 2칸(뒤 칸 width 0), 나머지는 1칸. 짧으면 빈 칸으로 채운다. */
function row(input: { cols: number; text: string }): LinkCell[] {
  const cells: LinkCell[] = []
  for (const chars of input.text) {
    if (/[가-힣]/.test(chars)) cells.push({ chars, width: 2 }, { chars: '', width: 0 })
    else cells.push({ chars, width: 1 })
  }
  while (cells.length < input.cols) cells.push({ chars: '', width: 1 })
  return cells
}
const oneRow = (text: string): ReadRow => {
  const cells = row({ cols: Math.max(80, text.length * 2), text })
  return (y) => (y === 0 ? cells : undefined)
}
const liveSet = (...ids: string[]) => (paneId: string) => ids.includes(paneId)
const names = (text: string, ...live: string[]): string[] => findPaneNames({ text, isLive: liveSet(...live) }).map((found) => found.paneId)

describe('findPaneNames — 살아 있는 이름만 링크 (C1ⓐⓑ)', () => {
  // 기대는 순서 있는 배열이다 — 한 행에 둘이면 둘 다 단언한다(r1 E③).
  it.each([
    ['숫자형', 'pane wZ3:p1 에서', ['wZ3:p1']],
    ['base-32 글자형', 'pane wS:pR', ['wS:pR']],
    ['base-32 끝 글자', 'w11:p1A 끝', ['w11:p1A']],
    ['맨 앞', 'wZ3:p1', ['wZ3:p1']],
    ['괄호', '(wZ3:p1)', ['wZ3:p1']],
    ['따옴표 둘', `'wZ3:p1' "wZ3:p1"`, ['wZ3:p1', 'wZ3:p1']],
    ['백틱', '`wZ3:p1`', ['wZ3:p1']],
    ['쉼표', 'wZ3:p1, 다음', ['wZ3:p1']],
    ['마침표', '끝은 wZ3:p1.', ['wZ3:p1']],
    ['한글 조사 붙음', '지금 wZ3:p1에 있다', ['wZ3:p1']],
    ['한글 조사 띄움', 'wZ3:p1 이라고', ['wZ3:p1']],
    ['JSON', '{"paneId":"wZ4:p2"}', ['wZ4:p2']],
    // D1′ — 문장 콜론·대시 뒤가 이름 글자가 아니면 링크
    ['뒤 문장 콜론', 'wZ3:p1: 완료', ['wZ3:p1']],
    ['행 끝 콜론', '워커 wZ3:p1:', ['wZ3:p1']],
    ['뒤 콜론 + 한글', 'wZ3:p1:완료', ['wZ3:p1']],
    ['뒤 대시 + 공백', 'wZ3:p1 - 끝, wZ3:p1-', ['wZ3:p1', 'wZ3:p1']],
    // D1″ — 앞 `:`·`-` 는 그 앞 글자가 이름 글자가 아니면 링크
    ['앞 레이블 콜론(한글)', '대상:wZ3:p1', ['wZ3:p1']],
    ['괄호 안 레이블 콜론', '(코디:wZ3:p1)', ['wZ3:p1']],
    ['행 첫머리 콜론', ':wZ3:p1', ['wZ3:p1']],
    ['공백 뒤 콜론·대시', 'a :wZ3:p1 b -wZ3:p1', ['wZ3:p1', 'wZ3:p1']],
  ])('%s — %s', (_label, text, expected) => {
    expect(names(text, 'wZ3:p1', 'wS:pR', 'w11:p1A', 'wZ4:p2')).toEqual(expected)
  })

  it.each([
    ['살아 있지 않은 이름', 'wZ9:p1 은 닫혔다'],
    ['더 긴 이름 안의 접두사', 'wZ3:p1A 는 다른 pane'],
    ['앞에 영숫자', 'xwZ3:p1'],
    ['뒤 `:`·`-`·`_` 다음이 이름 글자', 'wZ3:p1-x wZ3:p1_x wZ3:p1:x wZ3:p1:2 wZ3:p1-_'],
    ['앞에 이름 문자', '_wZ3:p1 1wZ3:p1'],
    ['앞 `:`·`-` 너머가 이름 글자 (D1″)', 'pane:wZ3:p1 x-wZ3:p1 _:wZ3:p1 9-wZ3:p1'],
    ['tab id', 'wZ3:t1'],
    ['workspace id', 'wZ3 하나'],
    ['대소문자만 다름', 'wz3:p1 WZ3:p1 wZ3:P1'],
  ])('링크 아님 — %s', (_label, text) => {
    expect(names(text, 'wZ3:p1')).toEqual([])
  })

  it('붙은 두 이름 `wZ3:p1:wZ3:p2` 는 둘 다 아님 (모호, D1″)', () => {
    expect(names('wZ3:p1:wZ3:p2', 'wZ3:p1', 'wZ3:p2')).toEqual([])
  })

  it('한 행에 여럿이면 각각', () => {
    expect(names('wZ3:p1 → wS:pR', 'wZ3:p1', 'wS:pR')).toEqual(['wZ3:p1', 'wS:pR'])
  })
})

describe('findPaneLinksOnRow — 범위는 이름 글자만 (C1ⓒ)', () => {
  it('ASCII 앞뒤 — 1 기반·끝 포함', () => {
    const links = findPaneLinksOnRow({ readRow: oneRow('go (wZ3:p1).'), y: 0, isLive: liveSet('wZ3:p1') })
    expect(links).toEqual([{ text: 'wZ3:p1', range: { start: { x: 5, y: 1 }, end: { x: 10, y: 1 } } }])
  })

  it('앞의 넓은 글자는 칸 두 개로 센다 — 범위가 밀리지 않는다', () => {
    // `지금 ` = 지(2칸)+금(2칸)+공백 → 이름은 6번째 칸(0 기반 5)에서 시작
    const links = findPaneLinksOnRow({ readRow: oneRow('지금 wZ3:p1에'), y: 0, isLive: liveSet('wZ3:p1') })
    expect(links).toEqual([{ text: 'wZ3:p1', range: { start: { x: 6, y: 1 }, end: { x: 11, y: 1 } } }])
  })

  it('행이 없으면 빈 목록', () => {
    expect(findPaneLinksOnRow({ readRow: () => undefined, y: 0, isLive: liveSet('wZ3:p1') })).toEqual([])
  })

  it('URL 안의 이름은 두 provider 가 겹친다 — URL provider 가 먼저 등록돼 이긴다(D5, xterm `_removeIntersectingLinks`)', () => {
    const readRow = oneRow('see https://example.com/wZ3:p1 now')
    const url = findLinksOnRow({ readRow, y: 0 })
    const pane = findPaneLinksOnRow({ readRow, y: 0, isLive: liveSet('wZ3:p1') })
    expect(url.map((link) => link.text)).toEqual(['https://example.com/wZ3:p1'])
    expect(pane).toHaveLength(1)
    // 겹침 확인 — pane 범위가 URL 범위 안에 있다
    expect(pane[0]!.range.start.x).toBeGreaterThanOrEqual(url[0]!.range.start.x)
    expect(pane[0]!.range.end.x).toBeLessThanOrEqual(url[0]!.range.end.x)
  })
})

describe('이름 없는 행의 비용 (C5ⓒ)', () => {
  it('후보가 없으면 살아 있는지 한 번도 묻지 않는다', () => {
    const isLive = vi.fn(() => true)
    findPaneLinksOnRow({ readRow: oneRow('plain output https://x.y/a w3 :p1 wZ3: p1'), y: 0, isLive })
    expect(isLive).not.toHaveBeenCalled()
  })

  it('후보 하나에 한 번만 묻는다', () => {
    const isLive = vi.fn(() => false)
    findPaneLinksOnRow({ readRow: oneRow('wZ3:p1 and wZ9:p2'), y: 0, isLive })
    expect(isLive.mock.calls).toEqual([['wZ3:p1'], ['wZ9:p2']])
  })
})

const target = (paneId: string): PaneLinkTarget => ({ paneId, worktreeName: 'main', tabTitle: 'claude 1', paneNumber: 2 })

function directoryOf(live: Set<string>): PaneLinkDirectory & { reveal: ReturnType<typeof vi.fn>; notifyGone: ReturnType<typeof vi.fn> } {
  return {
    lookup: (paneId) => (live.has(paneId) ? target(paneId) : null),
    reveal: vi.fn(),
    notifyGone: vi.fn(),
  }
}

describe('activatePaneLink — ⌘ 한정·누른 순간 재확인·자기 pane (C2ⓕⓖⓘ·C3ⓒ)', () => {
  let release: (() => void) | null = null
  afterEach(() => {
    release?.()
    release = null
  })

  it('⌘+클릭 → 기존 이동 길(reveal) 1회', () => {
    const directory = directoryOf(new Set(['wZ3:p1']))
    release = setPaneLinkDirectory(directory)
    activatePaneLink({ event: { metaKey: true }, paneId: 'wZ3:p1', ownPaneId: 'wZ4:p1' })
    expect(directory.reveal.mock.calls).toEqual([['wZ3:p1']])
    expect(directory.notifyGone).not.toHaveBeenCalled()
  })

  it('수식키 없는 클릭은 이동 0', () => {
    const directory = directoryOf(new Set(['wZ3:p1']))
    release = setPaneLinkDirectory(directory)
    activatePaneLink({ event: { metaKey: false }, paneId: 'wZ3:p1', ownPaneId: 'wZ4:p1' })
    expect(directory.reveal).not.toHaveBeenCalled()
    expect(directory.notifyGone).not.toHaveBeenCalled()
  })

  it('링크가 잡힌 뒤 대상이 닫혔으면 — 캐시를 믿지 않고 다시 묻는다: 안내 1회·이동 0', () => {
    const live = new Set(['wZ3:p1'])
    const directory = directoryOf(live)
    release = setPaneLinkDirectory(directory)
    const links = findPaneLinksOnRow({ readRow: oneRow('wZ3:p1'), y: 0, isLive: (id) => directory.lookup(id) !== null })
    expect(links).toHaveLength(1)
    live.delete('wZ3:p1')
    activatePaneLink({ event: { metaKey: true }, paneId: links[0]!.text, ownPaneId: 'wZ4:p1' })
    expect(directory.notifyGone).toHaveBeenCalledTimes(1)
    expect(directory.reveal).not.toHaveBeenCalled()
  })

  it('자기 pane 이름은 머문다 — 이동·안내 0', () => {
    const directory = directoryOf(new Set(['wZ4:p1']))
    release = setPaneLinkDirectory(directory)
    activatePaneLink({ event: { metaKey: true }, paneId: 'wZ4:p1', ownPaneId: 'wZ4:p1' })
    expect(directory.reveal).not.toHaveBeenCalled()
    expect(directory.notifyGone).not.toHaveBeenCalled()
  })

  it('끊은 뒤 남의 등록은 지우지 않는다', () => {
    const first = directoryOf(new Set(['wZ3:p1']))
    const second = directoryOf(new Set(['wZ3:p1']))
    const releaseFirst = setPaneLinkDirectory(first)
    release = setPaneLinkDirectory(second)
    releaseFirst()
    activatePaneLink({ event: { metaKey: true }, paneId: 'wZ3:p1', ownPaneId: 'wZ4:p1' })
    expect(second.reveal).toHaveBeenCalledTimes(1)
    expect(first.reveal).not.toHaveBeenCalled()
  })
})

function pane(input: { paneId: string; tabId: string; workspaceId: string }): PaneRow {
  return {
    ...input,
    title: '',
    agent: 'claude',
    agentStatus: 'idle',
    agentState: emptyAgentState(0),
    cwd: null,
    focused: false,
    agentSession: null,
    digest: EMPTY_SESSION_DIGEST,
  }
}
function tab(input: { tabId: string; workspaceId: string; label: string; paneIds: string[] }): TabRow {
  return {
    tabId: input.tabId,
    workspaceId: input.workspaceId,
    label: input.label,
    number: 1,
    order: 0,
    agentStatus: 'idle',
    focused: false,
    panes: input.paneIds.map((paneId) => pane({ paneId, tabId: input.tabId, workspaceId: input.workspaceId })),
    digest: EMPTY_SESSION_DIGEST,
  }
}

describe('resolvePaneLinkTarget — 툴팁 대상 (D3)', () => {
  const worktree: WorktreeRow = {
    path: '/r/wt-a',
    branch: 'LIFE-1-a',
    head: null,
    repoName: 'r',
    isLinked: true,
    openWorkspaceId: 'wA',
    workspace: {
      workspaceId: 'wA',
      label: 'a',
      number: 1,
      agentStatus: 'idle',
      focused: false,
      tabs: [tab({ tabId: 'wA:t1', workspaceId: 'wA', label: '빌드', paneIds: ['wA:p1', 'wA:p2'] })],
    },
    gitStatus: { branch: 'LIFE-1-a', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
    displayName: null,
    comment: null,
    parentPath: null,
  }
  const rect = (x: number) => ({ x, y: 0, width: 10, height: 10 })
  const group = (panes: Array<{ paneId: string; x: number }>): TerminalGroupState => ({
    groupId: 'g1',
    tabId: 'wA:t1',
    phase: 'streaming',
    grid: null,
    panes: panes.map(({ paneId, x }) => ({ paneId, rect: rect(x), innerRect: rect(x), focused: false, mouseReporting: false })),
    zoomedPaneId: null,
    lastError: null,
  })
  const state = (terminalGroups: TerminalGroupState[]): Pick<AppState, 'repos' | 'terminalGroups' | 'home'> => ({
    repos: [{ root: '/r', name: 'r', error: null, worktrees: [worktree] }],
    terminalGroups,
    home: '/home',
  })

  it('그려진 pane 은 pane 띠와 같은 번호(그린 자리)', () => {
    const resolved = resolvePaneLinkTarget({ state: state([group([{ paneId: 'wA:p2', x: 0 }, { paneId: 'wA:p1', x: 20 }])]), paneId: 'wA:p1', ordinalFor: () => 1 })
    expect(resolved).toEqual({ paneId: 'wA:p1', worktreeName: 'LIFE-1-a', tabTitle: '빌드', paneNumber: 2 })
  })

  it('그려지지 않은 pane 은 탭 안 자리', () => {
    expect(resolvePaneLinkTarget({ state: state([]), paneId: 'wA:p2', ordinalFor: () => 1 })?.paneNumber).toBe(2)
  })

  it('없는 pane 은 null', () => {
    expect(resolvePaneLinkTarget({ state: state([]), paneId: 'wA:p9', ordinalFor: () => 1 })).toBeNull()
  })

  it('툴팁 문구 — worktree · 탭 · pane 번호 + ⌘+클릭으로 이동', () => {
    expect(paneLinkTooltipLines(target('wZ3:p1'))).toEqual(['main · claude 1 · pane 2', '⌘+클릭으로 이동'])
  })
})

describe('livePaneIdsOf — 상태 → 살아 있는 pane 이름 (r2 F①)', () => {
  const gitStatus = { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
  const worktree = (input: { path: string; workspaceId: string | null; tabs: TabRow[] }): WorktreeRow => ({
    path: input.path,
    branch: null,
    head: null,
    repoName: 'r',
    isLinked: true,
    openWorkspaceId: input.workspaceId,
    workspace:
      input.workspaceId === null ? null : { workspaceId: input.workspaceId, label: 'w', number: 1, agentStatus: 'idle', focused: false, tabs: input.tabs },
    gitStatus,
    displayName: null,
    comment: null,
    parentPath: null,
  })
  const repos: RepoRow[] = [
    {
      root: '/a',
      name: 'a',
      error: null,
      worktrees: [
        worktree({
          path: '/a/main',
          workspaceId: 'wA',
          tabs: [tab({ tabId: 'wA:t1', workspaceId: 'wA', label: '1', paneIds: ['wA:p1', 'wA:p2'] }), tab({ tabId: 'wA:t2', workspaceId: 'wA', label: '2', paneIds: ['wA:p3'] })],
        }),
        // 열리지 않은 worktree — pane 없음
        worktree({ path: '/a/closed', workspaceId: null, tabs: [] }),
      ],
    },
    { root: '/b', name: 'b', error: null, worktrees: [worktree({ path: '/b/main', workspaceId: 'wB', tabs: [tab({ tabId: 'wB:t1', workspaceId: 'wB', label: '1', paneIds: ['wB:pR'] })] })] },
    { root: '/c', name: 'c', error: 'git 실패', worktrees: [] },
  ]

  it('여러 레포·worktree·탭의 모든 pane, 닫힌 worktree 는 0', () => {
    expect(livePaneIdsOf(repos)).toEqual(['wA:p1', 'wA:p2', 'wA:p3', 'wB:pR'])
  })

  it('빈 상태는 빈 목록', () => {
    expect(livePaneIdsOf([])).toEqual([])
  })
})

describe('publishLivePaneIds — 집합이 바뀐 때만 터미널을 부른다 (r2 F②)', () => {
  it('리스너 호출 수 — 같은 집합 0 · 순서만 다른 집합 0 · 바뀐 집합 1', () => {
    publishLivePaneIds(['dedupe-reset'])
    const term = new Terminal({ cols: 20, rows: 2, allowProposedApi: true })
    const reevaluate = vi.fn()
    const handle = registerPaneNameLinks({ term, paneId: 'wZ4:p1', reevaluate })
    publishLivePaneIds(['wZ3:p1', 'wZ4:p1'])
    expect(reevaluate).toHaveBeenCalledTimes(1)
    publishLivePaneIds(['wZ3:p1', 'wZ4:p1'])
    publishLivePaneIds(['wZ4:p1', 'wZ3:p1'])
    expect(reevaluate).toHaveBeenCalledTimes(1)
    publishLivePaneIds(['wZ4:p1'])
    expect(reevaluate).toHaveBeenCalledTimes(2)
    handle.dispose()
    publishLivePaneIds(['wZ9:p9'])
    expect(reevaluate).toHaveBeenCalledTimes(2) // dispose 뒤엔 안 부른다
    term.dispose()
  })
})

describe('placeTooltip — 창 밖으로 안 나간다 (C4ⓒ 보조)', () => {
  const size = { width: 200, height: 40 }
  const viewport = { width: 800, height: 600 }
  it('가운데면 포인터 아래 가운데', () => {
    expect(placeTooltip({ pointer: { x: 400, y: 100 }, size, viewport })).toEqual({ left: 300, top: 114 })
  })
  it('오른쪽 끝이면 창 안으로 민다', () => {
    expect(placeTooltip({ pointer: { x: 795, y: 100 }, size, viewport }).left).toBe(800 - 200 - 8)
  })
  it('맨 아래면 포인터 위로 뒤집는다', () => {
    expect(placeTooltip({ pointer: { x: 400, y: 590 }, size, viewport }).top).toBe(590 - 14 - 40)
  })
})

describe('registerPaneNameLinks — 실제 xterm 버퍼', () => {
  function write(term: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => term.write(data, resolve))
  }
  let release: (() => void) | null = null
  afterEach(() => {
    release?.()
    release = null
    document.querySelectorAll('[data-pane-link-tip]').forEach((element) => element.remove())
  })

  it('URL provider 뒤에 등록되고, 링크를 내고, ⌘+클릭은 이동·hover 는 툴팁·leave 는 걷는다', async () => {
    const directory = directoryOf(new Set(['wZ3:p1']))
    release = setPaneLinkDirectory(directory)
    const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    const providers: Array<Parameters<Terminal['registerLinkProvider']>[0]> = []
    vi.spyOn(term, 'registerLinkProvider').mockImplementation((p) => {
      providers.push(p)
      return { dispose: () => {} }
    })
    // TerminalPane 과 같은 순서 — URL 먼저(D5).
    registerTerminalLinks(term)
    const handle = registerPaneNameLinks({ term, paneId: 'wZ4:p1', reevaluate: () => {} })
    expect(providers).toHaveLength(2)
    await write(term, '\x1b[1;1Hworker wZ3:p1 done')
    const links = await new Promise<Parameters<Parameters<(typeof providers)[number]['provideLinks']>[1]>[0]>((resolve) => providers[1]!.provideLinks(1, resolve))
    expect(links?.map((link) => link.text)).toEqual(['wZ3:p1'])
    const link = links![0]!
    link.hover?.(new MouseEvent('mousemove', { clientX: 50, clientY: 20 }), link.text)
    const tip = document.querySelector<HTMLElement>('[data-pane-link-tip="wZ3:p1"]')
    expect(tip?.textContent).toBe('main · claude 1 · pane 2⌘+클릭으로 이동')
    link.leave?.(new MouseEvent('mouseleave'), link.text)
    expect(document.querySelector('[data-pane-link-tip]')).toBeNull()
    link.activate(new MouseEvent('click', { metaKey: true }), link.text)
    expect(directory.reveal.mock.calls).toEqual([['wZ3:p1']])
    handle.dispose()
    term.dispose()
  })

  it('이름 없는 행은 링크 없음(undefined)', async () => {
    release = setPaneLinkDirectory(directoryOf(new Set(['wZ3:p1'])))
    const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    let provider: Parameters<Terminal['registerLinkProvider']>[0] | undefined
    vi.spyOn(term, 'registerLinkProvider').mockImplementation((p) => {
      provider = p
      return { dispose: () => {} }
    })
    registerPaneNameLinks({ term, paneId: 'wZ4:p1', reevaluate: () => {} })
    await write(term, '\x1b[1;1Hno names here')
    const links = await new Promise<unknown>((resolve) => provider?.provideLinks(1, resolve))
    expect(links).toBeUndefined()
    term.dispose()
  })
})
