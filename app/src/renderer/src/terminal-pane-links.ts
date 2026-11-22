// LIFE-835 — 터미널에 찍힌 pane 이름(`wZ3:p1`)을 ⌘+클릭하면 그 pane 으로 간다.
//
// 판정(D1): 이름 꼴을 추측하지 않는다 — herdr id 는 base-32 라 `p` 뒤도 글자일 수 있다(`wS:pR`, 00-analysis F1).
// 느슨한 꼴(`w`+영숫자+`:p`+영숫자, 앞뒤가 영숫자·`_`·`-`·`:` 아님)로 후보를 찾고 **지금 살아 있는 pane 이름과 정확히 같을 때만** 링크다.
// 살아 있는지는 후보가 나온 행에서만 묻는다 — 이름 없는 행은 정규식 한 번으로 끝난다(C5ⓒ).
//
// 겹침(D5): xterm 은 겹친 링크 중 먼저 등록된 provider 것을 남긴다(`Linkifier._removeIntersectingLinks`). OSC 8 은 xterm 이
// 생성자에서 먼저 등록하고, 평문 URL provider 는 `TerminalPane` 이 이 provider 보다 먼저 등록한다 — URL 안의 이름은 URL 이 이긴다.
//
// 이동(D4)은 렌더러의 기존 `revealPane` 길이다 — App 이 `setPaneLinkDirectory` 로 이어 준다. 새 IPC·새 이동 경로는 없다.
// 행 잇기는 하지 않는다(D6) — 이름은 6~10자라 두 행으로 갈릴 일이 사실상 없다(F9).
import type { IBufferRange, ILink, Terminal } from '@xterm/xterm'
import type { AppState, TabRow } from '../../shared/types.js'
import { sessionTitle } from './session-title.js'
import { worktreeDisplayName } from './worktree-name.js'
import { numbersOf } from './pane-geometry.js'
import { terminalRowReader, type LinkCell, type ReadRow } from './terminal-links.js'

const PANE_NAME_CANDIDATE = /(?<![0-9A-Za-z_:-])w[0-9A-Za-z]+:p[0-9A-Za-z]+(?![0-9A-Za-z_:-])/g

/** 툴팁·이동에 쓰는 대상 정보. */
export type PaneLinkTarget = { paneId: string; worktreeName: string; tabTitle: string; paneNumber: number }

/** App 이 잇는 길 — 이 모듈은 상태를 갖지 않고 묻기만 한다. */
export type PaneLinkDirectory = {
  /** 지금 살아 있으면 그 대상, 아니면 null. 부를 때마다 최신 상태를 본다. */
  lookup: (paneId: string) => PaneLinkTarget | null
  /** 그 pane 으로 간다 — 기존 `revealPane` 길. */
  reveal: (paneId: string) => void
  /** 누른 순간 대상이 사라졌을 때(D2). */
  notifyGone: () => void
}

let directory: PaneLinkDirectory | null = null

/** App 이 마운트 때 잇는다. 반환값으로 끊는다(같은 것이 아직 이어져 있을 때만). */
export function setPaneLinkDirectory(next: PaneLinkDirectory): () => void {
  directory = next
  return () => {
    if (directory === next) directory = null
  }
}

/** 한 행 글자열에서 살아 있는 pane 이름의 [시작, 끝) 글자 위치. */
export function findPaneNames(input: { text: string; isLive: (paneId: string) => boolean }): Array<{ paneId: string; start: number; end: number }> {
  const { text, isLive } = input
  const found: Array<{ paneId: string; start: number; end: number }> = []
  for (const match of text.matchAll(PANE_NAME_CANDIDATE)) {
    if (!isLive(match[0])) continue
    found.push({ paneId: match[0], start: match.index, end: match.index + match[0].length })
  }
  return found
}

/** 버퍼 행 y(0 기반)의 pane 이름 링크들. 범위는 xterm 규약(1 기반·끝 포함). */
export function findPaneLinksOnRow(input: { readRow: ReadRow; y: number; isLive: (paneId: string) => boolean }): Array<{ text: string; range: IBufferRange }> {
  const { readRow, y, isLive } = input
  const cells = readRow(y)
  if (cells === undefined) return []
  let text = ''
  const columns: number[] = []
  cells.forEach((cell: LinkCell, x) => {
    if (cell.width === 0) return
    const chars = cell.chars === '' ? ' ' : cell.chars
    text += chars
    for (let i = 0; i < chars.length; i++) columns.push(x)
  })
  return findPaneNames({ text, isLive }).flatMap(({ paneId, start, end }) => {
    const first = columns[start]
    const last = columns[end - 1]
    if (first === undefined || last === undefined) return []
    return [{ text: paneId, range: { start: { x: first + 1, y: y + 1 }, end: { x: last + 1, y: y + 1 } } }]
  })
}

/** 앱 상태에서 대상 정보를 낸다. 열린 worktree 의 pane 만 있다(main 이 거른다 — F6). */
export function resolvePaneLinkTarget(input: {
  state: Pick<AppState, 'repos' | 'terminalGroups' | 'home'>
  paneId: string
  ordinalFor: (tab: TabRow) => number
}): PaneLinkTarget | null {
  const { state, paneId, ordinalFor } = input
  for (const repo of state.repos)
    for (const worktree of repo.worktrees) {
      const tabs = worktree.workspace?.tabs ?? []
      for (const tab of tabs) {
        const paneIndex = tab.panes.findIndex((pane) => pane.paneId === paneId)
        if (paneIndex === -1) continue
        // 번호는 pane 띠·MRU 와 같은 표(`numbersOf` — 그린 자리)에서, 그려지지 않은 pane 은 탭 안 자리로(MRU 와 같은 폴백).
        const group = state.terminalGroups.find((candidate) => candidate.panes.some((pane) => pane.paneId === paneId))
        const drawn = group === undefined ? undefined : numbersOf(group.panes).get(paneId)
        return {
          paneId,
          worktreeName: worktreeDisplayName(worktree),
          tabTitle: sessionTitle({ tab, tabCount: tabs.length, ordinal: ordinalFor(tab), home: state.home, selectedPaneId: paneId }),
          paneNumber: drawn ?? paneIndex + 1,
        }
      }
    }
  return null
}

/**
 * ⌘+클릭 (D1·D2·D4). 수식키 없는 클릭은 pane 앱의 클릭이다. 누른 순간 다시 묻는다 — 링크 캐시는 믿지 않는다(C3ⓒ).
 * 자기 pane 이름이면 머문다(C2ⓖ).
 */
export function activatePaneLink(input: { event: Pick<MouseEvent, 'metaKey'>; paneId: string; ownPaneId: string }): void {
  const { event, paneId, ownPaneId } = input
  if (!event.metaKey) return
  const current = directory
  if (current === null) return
  if (current.lookup(paneId) === null) {
    current.notifyGone()
    return
  }
  if (paneId === ownPaneId) return
  current.reveal(paneId)
}

// --- 툴팁 (D3) — 한 번에 하나. 아이콘 툴팁(`.tooltip`, LIFE-755)과 같은 모양, body 에 붙여 pane 경계에 잘리지 않게 한다 ---

const TIP_OFFSET = 14
const TIP_MARGIN = 8
let openTip: HTMLDivElement | null = null

export function paneLinkTooltipLines(target: PaneLinkTarget): [string, string] {
  return [`${target.worktreeName} · ${target.tabTitle} · pane ${target.paneNumber}`, '⌘+클릭으로 이동']
}

export function hidePaneLinkTooltip(): void {
  openTip?.remove()
  openTip = null
}

/** 포인터 아래에 두고, 창 밖으로 나가면 창 안으로 민다 — 아래 자리가 없으면 포인터 위로 뒤집는다(C4ⓒ). */
export function placeTooltip(input: {
  pointer: { x: number; y: number }
  size: { width: number; height: number }
  viewport: { width: number; height: number }
}): { left: number; top: number } {
  const { pointer, size, viewport } = input
  const left = Math.max(TIP_MARGIN, Math.min(pointer.x - size.width / 2, viewport.width - size.width - TIP_MARGIN))
  const below = pointer.y + TIP_OFFSET
  const top = below + size.height + TIP_MARGIN <= viewport.height ? below : Math.max(TIP_MARGIN, pointer.y - TIP_OFFSET - size.height)
  return { left, top }
}

function showPaneLinkTooltip(input: { event: MouseEvent; paneId: string; ownerPaneId: string }): void {
  hidePaneLinkTooltip()
  const target = directory?.lookup(input.paneId) ?? null
  if (target === null) return
  const tip = document.createElement('div')
  tip.className = 'tooltip term-pane-link-tip'
  tip.setAttribute('role', 'tooltip')
  tip.dataset.paneLinkTip = target.paneId
  tip.dataset.paneLinkOwner = input.ownerPaneId
  for (const line of paneLinkTooltipLines(target)) {
    const row = document.createElement('div')
    row.textContent = line
    tip.append(row)
  }
  document.body.append(tip)
  const rect = tip.getBoundingClientRect()
  const { left, top } = placeTooltip({
    pointer: { x: input.event.clientX, y: input.event.clientY },
    size: { width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  })
  tip.style.left = `${left}px`
  tip.style.top = `${top}px`
  openTip = tip
}

/** pane 이름 provider 를 등록한다. 평문 URL provider **뒤에** 등록해야 URL 이 이긴다(D5). 반환값을 터미널과 함께 dispose 한다. */
export function registerPaneNameLinks(input: { term: Terminal; paneId: string }): { dispose(): void } {
  const { term, paneId: ownPaneId } = input
  const isLive = (paneId: string): boolean => directory?.lookup(paneId) != null
  const readRow = terminalRowReader(term)
  const provider = term.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const links: ILink[] = findPaneLinksOnRow({ readRow, y: bufferLineNumber - 1, isLive }).map((link) => ({
        ...link,
        activate: (event, text) => {
          hidePaneLinkTooltip()
          activatePaneLink({ event, paneId: text, ownPaneId })
        },
        hover: (event, text) => showPaneLinkTooltip({ event, paneId: text, ownerPaneId: ownPaneId }),
        leave: () => hidePaneLinkTooltip(),
      }))
      callback(links.length === 0 ? undefined : links)
    },
  })
  return {
    dispose: () => {
      // 이 터미널이 띄운 툴팁만 걷는다 — 다른 pane 의 툴팁은 그쪽 leave 가 걷는다.
      if (openTip?.dataset.paneLinkOwner === ownPaneId) hidePaneLinkTooltip()
      provider.dispose()
    },
  }
}
