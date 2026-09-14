// 제목 3단의 **순서를 못박는 테스트** (기준 C1) + LIFE-357 거절 목록 회귀 (기준 C3).
//
// C1 이 "순서가 이대로임을 단위 테스트로 고정" 이라고 쓴 이유는, 티어를 하나 더 끼우는 변경이
// 조용히 순서를 뒤집기 쉬워서다. 그래서 각 티어마다 **위 티어를 하나씩 벗기며** 다음 티어로
// 내려오는지 확인한다 — 한 티어만 단독으로 확인하면 순서는 안 고정된다.

import { describe, expect, it } from 'vitest'
import type { AgentSessionRef, PaneRow, SessionDigest, TabRow } from '../../shared/types.js'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import { paneTitleLabel, providerTitle, sessionTitle, tabAgent, userLabel } from './session-title.js'

function pane(input: { title?: string; agent?: string | null; agentSession?: AgentSessionRef | null }): PaneRow {
  return {
    paneId: 'wA:p1',
    tabId: 'wA:t1',
    workspaceId: 'wA',
    title: input.title ?? '',
    agent: input.agent ?? null,
    agentStatus: 'idle',
    cwd: null,
    focused: false,
    agentSession: input.agentSession ?? null,
  }
}

function tab(input: { label?: string; number?: number; panes?: PaneRow[]; digest?: SessionDigest }): TabRow {
  return {
    tabId: 'wA:t1',
    workspaceId: 'wA',
    label: input.label ?? String(input.number ?? 1),
    number: input.number ?? 1,
    order: 0,
    agentStatus: 'idle',
    focused: false,
    panes: input.panes ?? [],
    digest: input.digest ?? EMPTY_SESSION_DIGEST,
  }
}

function withProviderTitle(title: string | null): SessionDigest {
  return { ...EMPTY_SESSION_DIGEST, providerTitle: title }
}

describe('sessionTitle — 3단 우선순위 (C1)', () => {
  const panes = [pane({ title: 'SUMMARY.md 작성', agent: 'claude' })]
  const digest = withProviderTitle('리뷰 지적 취합')

  it('① 사용자가 준 이름이 맨 위다 — provider 제목·터미널 제목이 다 있어도 이긴다', () => {
    expect(sessionTitle(tab({ label: '내 세션', number: 2, panes, digest }))).toBe('내 세션')
  })

  it('② 사용자 이름이 없으면 provider 세션 제목 — 터미널 제목보다 위다', () => {
    expect(sessionTitle(tab({ number: 2, panes, digest }))).toBe('리뷰 지적 취합')
  })

  it('③ provider 제목이 없으면 정제된 터미널 제목으로 내려온다', () => {
    expect(sessionTitle(tab({ number: 2, panes, digest: withProviderTitle(null) }))).toBe('SUMMARY.md 작성')
  })

  it('④ 셋 다 없으면 폴백 — 에이전트 이름 + 표찰 번호', () => {
    expect(sessionTitle(tab({ number: 3, panes: [pane({ agent: 'codex' })] }))).toBe('codex 3')
  })

  it('④ 에이전트가 없는 셸 탭의 폴백', () => {
    expect(sessionTitle(tab({ number: 4 }))).toBe('세션 4')
  })

  it('provider 제목이 공백뿐이면 티어를 건너뛴다 — 빈 제목을 그리지 않는다', () => {
    expect(sessionTitle(tab({ number: 2, panes, digest: withProviderTitle('   ') }))).toBe('SUMMARY.md 작성')
  })
})

describe('거절 목록 회귀 — LIFE-357 이 그대로다 (C3)', () => {
  it('pane ID 는 제목이 아니다', () => {
    expect(paneTitleLabel(tab({ panes: [pane({ title: 'wG:p3', agent: 'claude' })] }))).toBeNull()
  })

  it('셸 프롬프트 제목(절대경로)은 제목이 아니다', () => {
    const title = 'byun@sanghyunui-MacBookPro:/private/var/folders/q4/T/x'
    expect(paneTitleLabel(tab({ panes: [pane({ title })] }))).toBeNull()
  })

  it('유휴 기본값(에이전트 이름 자체·`Claude Code`)은 제목이 아니다', () => {
    expect(paneTitleLabel(tab({ panes: [pane({ title: 'claude', agent: 'claude' })] }))).toBeNull()
    expect(paneTitleLabel(tab({ panes: [pane({ title: 'Claude Code', agent: 'claude' })] }))).toBeNull()
  })

  it('거절당한 pane 다음에 쓸 만한 제목이 있으면 그것을 쓴다', () => {
    const panes = [pane({ title: 'wG:p3', agent: 'claude' }), pane({ title: '테스트 고치기', agent: 'claude' })]
    expect(paneTitleLabel(tab({ panes }))).toBe('테스트 고치기')
  })

  it('herdr 기본 label(표찰 번호 문자열)은 사용자 이름이 아니다', () => {
    expect(userLabel(tab({ label: '2', number: 2 }))).toBeNull()
    expect(userLabel(tab({ label: '357', number: 2 }))).toBe('357')
  })

  it('사용자 이름이 지워지면 다음 티어로 되돌아간다 (F1 의 화면 쪽 계약)', () => {
    const panes = [pane({ title: 'SUMMARY.md 작성', agent: 'claude' })]
    const digest = withProviderTitle('리뷰 지적 취합')
    expect(sessionTitle(tab({ label: '내 세션', number: 2, panes, digest }))).toBe('내 세션')
    // herdr 가 빈 label 을 받으면 표찰 번호로 되돌린다 — 그때 제목은 provider 티어로 내려온다.
    expect(sessionTitle(tab({ label: '2', number: 2, panes, digest }))).toBe('리뷰 지적 취합')
  })
})

describe('tabAgent · providerTitle', () => {
  it('tabAgent 는 처음 붙은 에이전트를 준다', () => {
    expect(tabAgent(tab({ panes: [pane({}), pane({ agent: 'grok' })] }))).toBe('grok')
  })

  it('providerTitle 은 앞뒤 공백을 턴다', () => {
    expect(providerTitle(tab({ digest: withProviderTitle('  이름  ') }))).toBe('이름')
  })
})
