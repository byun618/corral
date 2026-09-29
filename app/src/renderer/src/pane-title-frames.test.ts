// 스피너 프레임 억제 (LIFE-366 **C12**, 수정 라운드 8).
//
// 반례(관문 ⑤)는 억제를 뺀 빌드다 — 같은 세션에서 제목 문자열이 **2개 이상** 관측된다.
// 여기서는 그 관측을 단위로 옮긴다: 프레임을 줄줄이 넣고 **나온 제목의 가짓수**를 센다.
//
// 실측 근거: `raw/claude/d2-d3-schema.json` 의 D3 — herdr `terminal_title` 은 `✳ Thinking… PROBE`
// 처럼 접두사가 붙은 원문이고, `_stripped` 는 `✳` **만** 벗긴다(`*`·`.` 은 안 벗긴다).
// C11ⓑ 가 원문을 집기로 한 이상 스피너는 화면까지 온다.

import { describe, expect, it } from 'vitest'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import type { PaneRow, RepoRow, TabRow } from '../../shared/types.js'
import { createTitleFrameBook, decorativeTitleSignature, stabilizePaneTitles } from './pane-title-frames.js'
import { emptyAgentState } from '../../shared/agent-state.js'

/** claude 2.1.228+ 의 사분원 + 흔한 점자 스피너. 둘 다 C12 가 장식으로 본다. */
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼']
const QUADRANT = ['◐', '◑', '◒', '◓']

describe('장식 서명 (C12)', () => {
  it('스피너 글자만 다르면 **같은 서명**이다', () => {
    const signatures = BRAILLE.map((glyph) => decorativeTitleSignature({ title: `${glyph} Thinking…`, status: 'working' }))
    expect(new Set(signatures).size).toBe(1)
  })

  it('사분원(claude 2.1.228+)도 같이 본다', () => {
    const signatures = QUADRANT.map((glyph) => decorativeTitleSignature({ title: `${glyph} Thinking…`, status: 'working' }))
    expect(new Set(signatures).size).toBe(1)
    // 점자와 사분원은 같은 본문이면 서명도 같다 — 둘 다 앞에서 떨어져 나간다.
    expect(signatures[0]).toBe(decorativeTitleSignature({ title: '⠋ Thinking…', status: 'working' }))
  })

  it('본문이 다르면 다른 서명이다 — 진짜 제목 변화는 안 먹힌다', () => {
    expect(decorativeTitleSignature({ title: '⠋ Thinking…', status: 'working' })).not.toBe(
      decorativeTitleSignature({ title: '⠋ Running tests', status: 'working' }),
    )
  })

  it('상태가 다르면 다른 서명이다 (`상태:본문`)', () => {
    expect(decorativeTitleSignature({ title: '⠋ Thinking…', status: 'working' })).not.toBe(
      decorativeTitleSignature({ title: '⠋ Thinking…', status: 'idle' }),
    )
  })

  it('장식이 없으면 서명이 없다 — 평범한 제목은 억제 대상이 아니다', () => {
    expect(decorativeTitleSignature({ title: '✳ Claude Code', status: 'idle' })).toBe(null)
    expect(decorativeTitleSignature({ title: 'SUMMARY.md 작성', status: 'working' })).toBe(null)
  })
})

describe('프레임 억제 (C12)', () => {
  it('스피너가 도는 동안 제목은 **한 가지**다 — 반례는 여기서 2개 이상이 된다', () => {
    const book = createTitleFrameBook()
    const drawn = new Set<string>()
    // 첫 프레임이 기준이 되고 그 뒤 프레임은 전부 같은 값으로 접힌다.
    for (let round = 0; round < 4; round += 1) {
      for (const glyph of BRAILLE) {
        drawn.add(book.stableTitle({ paneId: 'wA:p1', title: `${glyph} Thinking…`, status: 'working' }))
      }
    }
    expect([...drawn]).toEqual(['⠋ Thinking…'])
  })

  it('본문이 바뀌면 **따라간다** — 억제가 진짜 변화를 먹으면 안 된다', () => {
    const book = createTitleFrameBook()
    book.stableTitle({ paneId: 'wA:p1', title: '⠋ Thinking…', status: 'working' })
    expect(book.stableTitle({ paneId: 'wA:p1', title: '⠙ Running tests', status: 'working' })).toBe('⠙ Running tests')
  })

  it('상태가 바뀌면 따라간다 — 같은 글자라도 `working → idle` 은 다른 서명이다', () => {
    const book = createTitleFrameBook()
    book.stableTitle({ paneId: 'wA:p1', title: '⠋ Thinking…', status: 'working' })
    expect(book.stableTitle({ paneId: 'wA:p1', title: '⠙ Thinking…', status: 'idle' })).toBe('⠙ Thinking…')
  })

  it('장식 없는 제목의 변화는 그대로 통과한다', () => {
    const book = createTitleFrameBook()
    expect(book.stableTitle({ paneId: 'wA:p1', title: '✳ Claude Code', status: 'idle' })).toBe('✳ Claude Code')
    expect(book.stableTitle({ paneId: 'wA:p1', title: 'SUMMARY.md 작성', status: 'working' })).toBe('SUMMARY.md 작성')
  })

  it('pane 마다 따로 센다 — 옆 pane 의 프레임이 내 제목을 안 건드린다', () => {
    const book = createTitleFrameBook()
    book.stableTitle({ paneId: 'wA:p1', title: '⠋ Thinking…', status: 'working' })
    expect(book.stableTitle({ paneId: 'wA:p2', title: '⠙ Thinking…', status: 'working' })).toBe('⠙ Thinking…')
  })

  it('닫힌 pane 은 장부에서 빠진다', () => {
    const book = createTitleFrameBook()
    book.stableTitle({ paneId: 'wA:p1', title: '⠋ Thinking…', status: 'working' })
    book.stableTitle({ paneId: 'wA:p2', title: '⠋ Thinking…', status: 'working' })
    book.keepOnly(['wA:p2'])
    expect(book.entries().map((row) => row.paneId)).toEqual(['wA:p2'])
  })
})

// --- 상태 통째로 거르기 ---------------------------------------------------------

function pane(input: { paneId: string; title: string }): PaneRow {
  return {
    paneId: input.paneId,
    tabId: 'wA:t1',
    workspaceId: 'wA',
    title: input.title,
    agent: 'claude',
    agentStatus: 'working', agentState: emptyAgentState(0),
    cwd: null,
    focused: true,
    agentSession: null,
    digest: EMPTY_SESSION_DIGEST,
  }
}

function reposWith(panes: PaneRow[]): RepoRow[] {
  const tab: TabRow = {
    tabId: 'wA:t1',
    workspaceId: 'wA',
    label: '1',
    number: 1,
    order: 0,
    agentStatus: 'working',
    focused: true,
    panes,
    digest: EMPTY_SESSION_DIGEST,
  }
  return [
    {
      root: '/tmp/r',
      name: 'r',
      worktrees: [
        {
          path: '/tmp/r',
          branch: 'main',
          isLinked: false,
          openWorkspaceId: 'wA',
          workspace: { workspaceId: 'wA', label: 'main', number: 1, agentStatus: 'working', focused: true, tabs: [tab] },
          gitStatus: {
            branch: 'main',
            upstream: null,
            ahead: null,
            behind: null,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
            dirty: false,
            error: null,
          },
        },
      ],
      error: null,
    },
  ]
}

const titleOf = (repos: readonly RepoRow[]): string => repos[0]?.worktrees[0]?.workspace?.tabs[0]?.panes[0]?.title ?? ''

describe('상태 단계에서 한 번에 거른다 (C12)', () => {
  it('두 프레임이 들어와도 화면에 가는 제목은 첫 값 그대로다', () => {
    const frames = createTitleFrameBook()
    const first = stabilizePaneTitles({ repos: reposWith([pane({ paneId: 'wA:p1', title: '⠋ Thinking…' })]), frames })
    const second = stabilizePaneTitles({ repos: reposWith([pane({ paneId: 'wA:p1', title: '⠹ Thinking…' })]), frames })
    expect(titleOf(first)).toBe('⠋ Thinking…')
    expect(titleOf(second)).toBe('⠋ Thinking…')
  })

  it('안 바뀐 pane 은 **같은 객체**로 돌려준다 — 쓸데없는 리렌더를 안 만든다', () => {
    const frames = createTitleFrameBook()
    const repos = reposWith([pane({ paneId: 'wA:p1', title: 'SUMMARY.md 작성' })])
    const out = stabilizePaneTitles({ repos, frames })
    expect(out[0]?.worktrees[0]?.workspace?.tabs[0]?.panes[0]).toBe(repos[0]?.worktrees[0]?.workspace?.tabs[0]?.panes[0])
  })

  it('사라진 pane 은 장부에서 빠진다 — 상태를 훑는 김에 정리한다', () => {
    const frames = createTitleFrameBook()
    stabilizePaneTitles({ repos: reposWith([pane({ paneId: 'wA:p1', title: '⠋ Thinking…' })]), frames })
    stabilizePaneTitles({ repos: reposWith([pane({ paneId: 'wA:p2', title: '⠋ Thinking…' })]), frames })
    expect(frames.entries().map((row) => row.paneId)).toEqual(['wA:p2'])
  })
})
