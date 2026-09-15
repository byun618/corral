// 2차 줄 갈래 고르기 — **진행 중 도구 게이트** (기준 B9, 수정 라운드 5).
//
// B9 의 반례가 곧 이 파일이다: *같은 꼬리*에 **상태만** 바꾸면 도구 갈래가 걸리고 안 걸린다.
// 지문(도구 값)은 그대로 두고 `agentStatus` 만 움직이는 테스트라, 게이트를 빼면 전부 깨진다.

import { describe, expect, it } from 'vitest'
import type { AgentStatus, PaneRow, SessionDigest, TabRow } from '../../shared/types.js'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import { secondaryLine } from './session-activity.js'

function pane(input: { agent?: string | null; agentStatus?: AgentStatus }): PaneRow {
  // `??` 를 안 쓴다 — `agent: null`(셸 pane)을 「안 줬다」와 구분해야 한다.
  const agent = 'agent' in input ? (input.agent ?? null) : 'claude'
  return {
    paneId: 'wA:p1',
    tabId: 'wA:t1',
    workspaceId: 'wA',
    title: '',
    agent,
    agentStatus: input.agentStatus ?? 'idle',
    cwd: null,
    focused: false,
    agentSession: null,
  }
}

function tab(input: { digest: SessionDigest; panes?: PaneRow[] }): TabRow {
  return {
    tabId: 'wA:t1',
    workspaceId: 'wA',
    label: '1',
    number: 1,
    order: 0,
    agentStatus: 'idle',
    focused: false,
    panes: input.panes ?? [pane({})],
    digest: input.digest,
  }
}

/** 같은 꼬리 — 도구도 있고 마지막 말도 있다. 갈리는 것은 **상태뿐**이다. */
const DIGEST: SessionDigest = {
  ...EMPTY_SESSION_DIGEST,
  activity: { state: 'text', text: '고쳤다', at: 1 },
  tool: { name: 'Bash', input: 'npm run typecheck' },
}

describe('2차 줄 — 진행 중 도구 (B9)', () => {
  it('`working` 이면 도구가 마지막 말보다 앞이다', () => {
    const row = tab({ digest: DIGEST, panes: [pane({ agentStatus: 'working' })] })
    expect(secondaryLine({ tab: row, integrations: [] })).toEqual({ kind: 'text', text: 'Bash: npm run typecheck' })
  })

  it('반례: 같은 꼬리에 상태만 `idle` 이면 도구 갈래가 안 걸린다 — 마지막 말이 나온다', () => {
    const row = tab({ digest: DIGEST, panes: [pane({ agentStatus: 'idle' })] })
    expect(secondaryLine({ tab: row, integrations: [] })).toEqual({ kind: 'text', text: '고쳤다' })
  })

  it('반례: `unknown` 에서도 지어내지 않는다', () => {
    const row = tab({ digest: DIGEST, panes: [pane({ agentStatus: 'unknown' })] })
    expect(secondaryLine({ tab: row, integrations: [] })).toEqual({ kind: 'text', text: '고쳤다' })
  })

  it('`blocked`(승인 대기)는 도구를 돌리는 중이 아니다 — Orca 의 `waiting` 을 안 따른다', () => {
    const row = tab({ digest: DIGEST, panes: [pane({ agentStatus: 'blocked' })] })
    expect(secondaryLine({ tab: row, integrations: [] })).toEqual({ kind: 'text', text: '고쳤다' })
  })

  it('입력 미리보기가 없으면 도구 이름만 쓴다', () => {
    const digest: SessionDigest = { ...DIGEST, tool: { name: 'mcp__playwright__browser_click', input: null } }
    const row = tab({ digest, panes: [pane({ agentStatus: 'working' })] })
    expect(secondaryLine({ tab: row, integrations: [] })).toEqual({ kind: 'text', text: 'mcp__playwright__browser_click' })
  })

  it('도구가 없으면 working 이어도 마지막 말이다', () => {
    const digest: SessionDigest = { ...DIGEST, tool: null }
    const row = tab({ digest, panes: [pane({ agentStatus: 'working' })] })
    expect(secondaryLine({ tab: row, integrations: [] })).toEqual({ kind: 'text', text: '고쳤다' })
  })

  it('상태를 보는 것은 **에이전트가 붙은 pane** 이다 — 셸 pane 이 앞에 있어도 흔들리지 않는다', () => {
    const panes = [pane({ agent: null, agentStatus: 'idle' }), pane({ agent: 'claude', agentStatus: 'working' })]
    const row = tab({ digest: DIGEST, panes })
    expect(secondaryLine({ tab: row, integrations: [] })).toEqual({ kind: 'text', text: 'Bash: npm run typecheck' })
  })

  it('읽을 것이 아무것도 없으면 빈 슬롯이다 (B4 — 행 높이가 안 튄다)', () => {
    const row = tab({ digest: EMPTY_SESSION_DIGEST, panes: [pane({ agent: null })] })
    expect(secondaryLine({ tab: row, integrations: [] })).toEqual({ kind: 'empty' })
  })
})
