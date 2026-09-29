// LIFE-456 — 상태 판정 한 벌의 단위 테스트 (기준 S1·S3·S5·S6·S15).
//
// 이 파일이 못박는 것은 **규칙**이지 화면이 아니다. 화면 모양은 448·449 몫이라 여기 없다.

import { describe, expect, it } from 'vitest'
import {
  AGENT_HISTORY_LIMIT,
  AGENT_STATUS_ROLLUP_ORDER,
  blockedReason,
  emptyAgentState,
  parseAgentStatus,
  recordAgentTransition,
  pickBlockedRule,
  rollupAgentStatus,
} from './agent-state.js'
import type { AgentState, AgentStatus } from './types.js'

describe('parseAgentStatus — herdr 다섯 값 (S1)', () => {
  it('herdr 0.9.0 의 다섯 값을 잃지 않는다', () => {
    for (const value of ['idle', 'working', 'blocked', 'done', 'unknown'] satisfies AgentStatus[]) {
      expect(parseAgentStatus(value)).toBe(value)
    }
  })

  it('`done` 이 `unknown` 으로 접히지 않는다 — 이 작업이 고친 결함', () => {
    expect(parseAgentStatus('done')).toBe('done')
    expect(parseAgentStatus('done')).not.toBe('unknown')
  })

  it('모르는 값과 비문자열은 null 이다 (호출자가 로그를 남긴다)', () => {
    expect(parseAgentStatus('waiting')).toBeNull()
    expect(parseAgentStatus(undefined)).toBeNull()
    expect(parseAgentStatus(7)).toBeNull()
  })
})

describe('blockedReason — 사유 한 벌 (S3)', () => {
  it('herdr 가 아무 말도 안 하면 null 이다 — 공백이지 unknown 이 아니다', () => {
    // 실측: claude·codex·grok 은 항상 이 갈래다 (raw/claude/s3/s3-state-labels-findings.md).
    expect(blockedReason({ labels: null })).toBeNull()
    expect(blockedReason({})).toBeNull()
    expect(blockedReason({ labels: {} })).toBeNull()
  })

  it('라벨이 있는데 어느 갈래도 아니면 unknown 이다 — null 과 구분된다', () => {
    expect(blockedReason({ labels: { a: '처음 보는 문구' } })).toBe('unknown')
  })

  it('CLI 가 쓰던 갈래를 그대로 가른다 (두 벌 판정 금지)', () => {
    expect(blockedReason({ labels: { a: 'Do you trust this directory?' } })).toBe('trust')
    expect(blockedReason({ labels: { a: 'Please sign in to continue' } })).toBe('login')
    expect(blockedReason({ labels: { a: 'Grant permission?' } })).toBe('permission')
    expect(blockedReason({ labels: { a: 'Update available!' } })).toBe('update')
  })

  it('규칙 id 가 라벨을 이긴다 — 사유의 실제 출처는 agent.explain 이다', () => {
    expect(blockedReason({ labels: { a: 'trust me' }, ruleId: 'bash_permission_prompt' })).toBe('permission')
  })

  it('매니페스트에서 갈리는 규칙만 사유가 된다 (실측 근거 있는 것만)', () => {
    // 권한 — claude 둘, grok 둘
    expect(blockedReason({ ruleId: 'bash_permission_prompt' })).toBe('permission')
    expect(blockedReason({ ruleId: 'generic_permission_prompt' })).toBe('permission')
    expect(blockedReason({ ruleId: 'permission_hints_blocked' })).toBe('permission')
    expect(blockedReason({ ruleId: 'permission_scope_selector' })).toBe('permission')
    // 질문
    expect(blockedReason({ ruleId: 'question_dialog_hints_blocked' })).toBe('question')
    expect(blockedReason({ ruleId: 'option_dialog_blocked' })).toBe('question')
    expect(blockedReason({ ruleId: 'mcp_elicitation_prompt' })).toBe('question')
    // 그 밖
    expect(blockedReason({ ruleId: 'trust_directory' })).toBe('trust')
    expect(blockedReason({ ruleId: 'startup_update' })).toBe('update')
  })

  it('**갈리지 않는 규칙은 unknown 으로 남긴다** — 없는 구분을 지어내지 않는다', () => {
    // codex `live_strong_blocker` 의 `any` 는 `allow command?`(권한)와
    // `enter to submit answer`(질문)를 함께 받는다 — 어느 쪽인지 herdr 도 말하지 않는다.
    expect(blockedReason({ ruleId: 'live_strong_blocker' })).toBe('unknown')
    // claude `live_blocked_form` 도 같은 이유다.
    expect(blockedReason({ ruleId: 'live_blocked_form' })).toBe('unknown')
    expect(blockedReason({ ruleId: 'osc_title_blocked' })).toBe('unknown')
    expect(blockedReason({ ruleId: 'weak_blocker' })).toBe('unknown')
    expect(blockedReason({ ruleId: 'legacy_no_prompt_blocker' })).toBe('unknown')
  })
})

describe('rollupAgentStatus — 탭·워크스페이스 접기 (S5·S6)', () => {
  it('blocked > working > done > unknown > idle 순이다', () => {
    expect(AGENT_STATUS_ROLLUP_ORDER).toEqual(['blocked', 'working', 'done', 'unknown', 'idle'])
  })

  it('done 은 idle·unknown 을 이기고 working·blocked 에는 진다', () => {
    expect(rollupAgentStatus(['idle', 'done'])).toBe('done')
    expect(rollupAgentStatus(['unknown', 'done'])).toBe('done')
    expect(rollupAgentStatus(['working', 'done'])).toBe('working')
    expect(rollupAgentStatus(['blocked', 'done', 'working'])).toBe('blocked')
  })

  it('pane 이 하나도 없으면 unknown 이다', () => {
    expect(rollupAgentStatus([])).toBe('unknown')
  })
})

describe('recordAgentTransition — 관측 시각·완료 시각·이력 (S1·S15)', () => {
  const base = (status: AgentStatus, at: number): { status: AgentStatus; state: AgentState } => ({
    status,
    state: emptyAgentState(at),
  })

  it('같은 값이 다시 와도 관측 시각을 밀지 않는다 — 30초 재동기가 시각을 0 에 붙이지 않게', () => {
    const before = base('working', 1000)
    const after = recordAgentTransition({
      previousStatus: before.status,
      previousState: before.state,
      nextStatus: 'working',
      blockedReason: null,
      observedAt: 9999,
      observedVia: 'snapshot',
    })
    expect(after.observedAt).toBe(1000)
    expect(after.history).toEqual([])
  })

  it('값이 바뀌면 관측 시각이 갱신되고 지난 상태가 이력에 쌓인다', () => {
    const after = recordAgentTransition({
      previousStatus: 'working',
      previousState: { ...emptyAgentState(1000), observedVia: 'event' },
      nextStatus: 'done',
      blockedReason: null,
      observedAt: 2000,
      observedVia: 'event',
    })
    expect(after.observedAt).toBe(2000)
    expect(after.history).toEqual([{ status: 'working', observedAt: 1000, observedVia: 'event' }])
  })

  it('S15ⓑ 완료 시각은 마지막 done 진입이고, done 을 떠나도 남는다', () => {
    const toDone = recordAgentTransition({
      previousStatus: 'working', previousState: emptyAgentState(1000), nextStatus: 'done',
      blockedReason: null, observedAt: 2000, observedVia: 'event',
    })
    expect(toDone.enteredDoneAt).toBe(2000)
    const toIdle = recordAgentTransition({
      previousStatus: 'done', previousState: toDone, nextStatus: 'idle',
      blockedReason: null, observedAt: 3000, observedVia: 'event',
    })
    // 봤다고 완료했던 사실이 없어지지는 않는다 — 경과 시간의 기준으로 쓰인다(Orca lastEnteredDoneAt).
    expect(toIdle.enteredDoneAt).toBe(2000)
  })

  it('S15ⓒ 이력은 최신 우선이고 상한에서 잘린다', () => {
    let state = emptyAgentState(0)
    let status: AgentStatus = 'idle'
    for (let i = 1; i <= AGENT_HISTORY_LIMIT + 5; i++) {
      const next: AgentStatus = i % 2 === 0 ? 'idle' : 'working'
      state = recordAgentTransition({
        previousStatus: status, previousState: state, nextStatus: next,
        blockedReason: null, observedAt: i * 100, observedVia: 'event',
      })
      status = next
    }
    expect(state.history).toHaveLength(AGENT_HISTORY_LIMIT)
    // 최신 우선 — 첫 칸이 가장 최근에 떠난 상태다.
    expect(state.history[0]?.observedAt).toBeGreaterThan(state.history[1]?.observedAt ?? 0)
  })

  it('재동기의 빈 사유가 explain 이 채운 사유를 지우지 않는다 (실측으로 잡은 결함)', () => {
    // agent.explain 이 permission 을 채운 뒤…
    const withReason: AgentState = { ...emptyAgentState(1000), blockedReason: 'permission' }
    // …30초 재동기가 같은 blocked 를 labels 없이(=사유 null) 다시 실어 온다.
    const afterResync = recordAgentTransition({
      previousStatus: 'blocked', previousState: withReason, nextStatus: 'blocked',
      blockedReason: null, observedAt: 2000, observedVia: 'snapshot',
    })
    expect(afterResync.blockedReason).toBe('permission')
  })

  it('상태가 바뀌면 사유는 따라서 비워진다 — 지난 상태의 사유를 들고 가지 않는다', () => {
    const withReason: AgentState = { ...emptyAgentState(1000), blockedReason: 'permission' }
    const unblocked = recordAgentTransition({
      previousStatus: 'blocked', previousState: withReason, nextStatus: 'working',
      blockedReason: null, observedAt: 2000, observedVia: 'event',
    })
    expect(unblocked.blockedReason).toBeNull()
  })

  it('observedVia 가 snapshot 이면 진입 시각이 아니라는 뜻이다 (S1 한계)', () => {
    const snap = recordAgentTransition({
      previousStatus: 'unknown', previousState: emptyAgentState(0), nextStatus: 'done',
      blockedReason: null, observedAt: 5000, observedVia: 'snapshot',
    })
    expect(snap.observedVia).toBe('snapshot')
    // 재시작 뒤 첫 스냅샷이 이 갈래다 — 화면은 이 칸을 보고 「관측 시각」이라고 말해야 한다.
    expect(snap.enteredDoneAt).toBe(5000)
  })
})

describe('pickBlockedRule — 거친 규칙이 구체적 규칙을 가리지 않게 (F2)', () => {
  const explain = (matched: string | null, evaluated: Array<{ id: string; matched: boolean; priority?: number }>) => ({
    ...(matched === null ? {} : { matched_rule: { id: matched } }),
    evaluated_rules: evaluated,
  })

  it('`matched_rule` 이 이미 사유를 주면 그걸 쓴다 — 응답을 더 뒤지지 않는다', () => {
    const picked = pickBlockedRule(explain('bash_permission_prompt', [{ id: 'trust_directory', matched: true }]))
    expect(picked).toEqual({ ruleId: 'bash_permission_prompt', matchedRuleId: 'bash_permission_prompt', source: 'matched' })
  })

  it('**거친 규칙이 이겼으면 같이 맞은 구체적 규칙을 집는다** — 이게 F2 의 반례다', () => {
    // 실제 우선순위: osc_title_blocked(1300) > bash_permission_prompt. herdr 는 앞의 것을
    // matched_rule 로 주는데 그 규칙은 「막혔다」만 뜻해서 우리 표에서 unknown 으로 떨어진다.
    const picked = pickBlockedRule(explain('osc_title_blocked', [
      { id: 'osc_title_blocked', matched: true, priority: 1300 },
      { id: 'bash_permission_prompt', matched: true, priority: 900 },
    ]))
    expect(picked.ruleId).toBe('bash_permission_prompt')
    expect(picked.source).toBe('evaluated')
    // 원래 herdr 가 고른 것도 들고 간다 — 원자료에서 대조할 수 있어야 한다.
    expect(picked.matchedRuleId).toBe('osc_title_blocked')
  })

  it('**여럿이 맞으면 가장 구체적인 것(priority 최소)을 집는다** — 네이티브 실측 그대로', () => {
    // `raw/claude/s9-r1/f2/grok-explain.json` 의 실제 응답이다. 배열 순서(우선순위 내림차순)
    // 로 훑으면 `option_dialog_blocked`(question)가 먼저 걸리는데, 화면은 **권한** 상자다.
    const picked = pickBlockedRule(explain('osc_title_blocked', [
      { id: 'osc_title_blocked', matched: true, priority: 1300 },
      { id: 'option_dialog_blocked', matched: true, priority: 1200 },
      { id: 'permission_scope_selector', matched: true, priority: 1180 },
      { id: 'osc_title_working', matched: true, priority: 1000 },
    ]))
    expect(picked.ruleId).toBe('permission_scope_selector')
    expect(blockedReason({ ruleId: picked.ruleId })).toBe('permission')
  })

  it('priority 가 없는 규칙은 맨 뒤다 — 순서를 모르는 것을 구체적이라고 우기지 않는다', () => {
    const picked = pickBlockedRule(explain('osc_title_blocked', [
      { id: 'mcp_elicitation_prompt', matched: true },
      { id: 'permission_scope_selector', matched: true, priority: 1180 },
    ]))
    expect(picked.ruleId).toBe('permission_scope_selector')
  })

  it('맞지 않은(`matched:false`) 규칙은 안 집는다', () => {
    const picked = pickBlockedRule(explain('osc_title_blocked', [
      { id: 'osc_title_blocked', matched: true },
      { id: 'bash_permission_prompt', matched: false },
    ]))
    expect(picked.ruleId).toBe('osc_title_blocked')
    expect(picked.source).toBe('matched')
  })

  it('아무 데서도 갈래가 안 나오면 `matched_rule` 을 그대로 둔다 — unknown 과 null 을 안 뭉갠다', () => {
    const picked = pickBlockedRule(explain('live_blocked_form', [{ id: 'live_blocked_form', matched: true }]))
    expect(picked.ruleId).toBe('live_blocked_form')
    expect(blockedReason({ ruleId: picked.ruleId })).toBe('unknown')
  })

  it('explain 이 없으면 아무 말도 안 한 것이다 (null ≠ unknown)', () => {
    expect(pickBlockedRule(null)).toEqual({ ruleId: null, matchedRuleId: null, source: 'none' })
    expect(blockedReason({ ruleId: null })).toBeNull()
  })
})
