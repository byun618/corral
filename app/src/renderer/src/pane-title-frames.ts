// 스피너 프레임을 안 따라간다 (LIFE-366 **C12**, 수정 라운드 8).
//
// ## 왜 이 라운드에 필요해졌나
//
// r7 까지 corral 은 herdr 의 `terminal_title_stripped` 를 먼저 읽었다. 그 값은 `✳` 를 이미 벗긴
// 뒤라 제목이 프레임마다 흔들릴 일이 없었다 — 그래서 억제가 필요 없었다. C11ⓑ 가 **원문
// `terminal_title`** 로 바꾸는 순간 스피너 글리프가 그대로 들어오고, 에이전트는 그걸 **초당 여러 번**
// 쏜다. 억제를 같이 넣지 않으면 탭 제목이 깜빡인다 (P11 이 "같이 넣어라" 인 이유).
//
// ## 규칙은 Orca 의 것이다
//
// `shared/agent-decorative-title-signature.ts:5-23,49-52`:
//
// ```ts
// // Why: agent spinners can emit OSC title frames many times per second; the
// // spinner glyph is live decoration, not meaningful tab or sort state.
// return `${status}:${normalizeDecorativeAgentTitleText(title)}`
// ...
// // Why: braille (most agents) plus quarter circles (Claude Code 2.1.228+, #13889).
// function isSpinnerFrameGlyph(code: number): boolean {
//   return (code >= 0x2800 && code <= 0x28ff) || (code >= 0x25d0 && code <= 0x25d3)
// }
// ```
//
// **한 자리만 corral 의 것으로 바꿨다**: Orca 는 서명의 `status` 를 *제목 글자에서* 뽑는다
// (`detectAgentStatusFromTitle`). corral 은 그 상태를 herdr 가 **따로** 준다(`PaneRow.agentStatus`) —
// 글자에서 다시 추측하는 것은 A9("관측 안 된 형식을 미리 처리하지 마라")를 어기는 쪽이라
// 오는 값을 쓴다. 서명이 `상태:본문` 이라는 모양은 같다.
//
// 억제는 **장식 글리프가 있는 제목에서만** 건다(Orca 가 "상태가 안 잡히면 보통 변경" 으로 두는
// 자리와 같다). 그래야 평범한 제목이 바뀌는 것은 그대로 화면에 온다.

import type { AgentStatus, PaneRow, RepoRow } from '../../shared/types.js'

/** 스피너 글리프 — 점자 + 사분원. Orca `isSpinnerFrameGlyph` 그대로다. */
function isSpinnerFrameGlyph(code: number): boolean {
  return (code >= 0x2800 && code <= 0x28ff) || (code >= 0x25d0 && code <= 0x25d3)
}

/** Orca `isDecorativeTitleWhitespace` — 좁은 공백·제로폭까지 본다(스피너 뒤에 자주 붙는다). */
function isDecorativeTitleWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

/** 앞쪽 스피너·공백을 떼고 가운데 공백을 한 칸으로 줄인다 (Orca `normalizeDecorativeAgentTitleText`). */
function normalizeDecorativeTitle(title: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index)
    if (normalized.length === 0 && (isDecorativeTitleWhitespace(code) || isSpinnerFrameGlyph(code))) continue
    if (isDecorativeTitleWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += title.charAt(index)
  }
  return normalized
}

/** 제목에 스피너 글리프가 있나 — 없으면 서명을 안 만든다(= 억제 대상이 아니다). */
function hasSpinnerFrameGlyph(title: string): boolean {
  for (let index = 0; index < title.length; index += 1) {
    if (isSpinnerFrameGlyph(title.charCodeAt(index))) return true
  }
  return false
}

/**
 * `상태:본문` 서명 — 스피너 글자만 다른 두 제목은 **같은 서명**이 된다. 장식이 없으면 `null`.
 */
export function decorativeTitleSignature(input: { title: string; status: AgentStatus }): string | null {
  if (!hasSpinnerFrameGlyph(input.title)) return null
  return `${input.status}:${normalizeDecorativeTitle(input.title)}`
}

/** pane 별 「지금 보여주는 제목」 장부. */
export type TitleFrameBook = {
  /** 이 pane 이 화면에 낼 제목. 앞 값과 **서명이 같으면 앞 값을 그대로** 돌려준다. */
  stableTitle: (input: { paneId: string; title: string; status: AgentStatus }) => string
  /** 살아 있는 pane 만 남긴다. */
  keepOnly: (paneIds: readonly string[]) => void
  entries: () => { paneId: string; title: string; status: AgentStatus }[]
}

export function createTitleFrameBook(): TitleFrameBook {
  const book = new Map<string, { title: string; status: AgentStatus }>()
  return {
    stableTitle: ({ paneId, title, status }) => {
      const held = book.get(paneId)
      if (held !== undefined) {
        const heldSignature = decorativeTitleSignature({ title: held.title, status: held.status })
        // **앞 값에 장식이 있어야** 억제한다 — 평범한 제목의 변화는 그대로 통과시킨다.
        if (heldSignature !== null && heldSignature === decorativeTitleSignature({ title, status })) {
          return held.title
        }
      }
      book.set(paneId, { title, status })
      return title
    },
    keepOnly: (paneIds) => {
      const live = new Set(paneIds)
      for (const paneId of [...book.keys()]) if (!live.has(paneId)) book.delete(paneId)
    },
    entries: () => [...book.entries()].map(([paneId, held]) => ({ paneId, ...held })),
  }
}

/**
 * 들어온 상태의 pane 제목을 **안정된 제목으로 갈아끼운다** — 화면에 오기 전 한 자리에서.
 *
 * 표시 함수(`session-title.ts`)를 순수하게 두려고 여기서 한 번에 한다. Orca 도 제목 결정을
 * "한 주인" 에 모은다(`title-spawn-bell.ts` 의 `resolvePaneTitleDecision`) — 여러 자리에서
 * 각자 억제하면 사이드바와 탭바가 다른 프레임에 멈춘다.
 *
 * 안 바뀐 pane·worktree 는 **같은 객체로** 돌려준다(쓸데없는 리렌더를 안 만든다).
 * 훑는 김에 사라진 pane 을 장부에서 지운다 — 상태가 곧 살아 있는 pane 의 목록이다.
 */
export function stabilizePaneTitles(input: { repos: readonly RepoRow[]; frames: TitleFrameBook }): RepoRow[] {
  const { repos, frames } = input
  const live: string[] = []
  const stabilizePane = (pane: PaneRow): PaneRow => {
    live.push(pane.paneId)
    const title = frames.stableTitle({ paneId: pane.paneId, title: pane.title, status: pane.agentStatus })
    return title === pane.title ? pane : { ...pane, title }
  }
  const next = repos.map((repo) => ({
    ...repo,
    worktrees: repo.worktrees.map((worktree) => {
      const workspace = worktree.workspace
      if (workspace === null) return worktree
      return {
        ...worktree,
        workspace: {
          ...workspace,
          tabs: workspace.tabs.map((tab) => ({ ...tab, panes: tab.panes.map(stabilizePane) })),
        },
      }
    }),
  }))
  frames.keepOnly(live)
  return next
}

/** 렌더러 한 벌이 공유하는 장부 — 사이드바와 탭바가 **같은 프레임**을 봐야 한다 (B6). */
export const paneTitleFrames = createTitleFrameBook()
