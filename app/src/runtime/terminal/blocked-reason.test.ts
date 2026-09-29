// LIFE-456 fix-r1 F3 — **같은 pane 에 두 사유가 나오지 않는다.**
//
// 결함이었던 모양: GUI 는 `agent.explain` 의 규칙 id 로 사유를 채우고, CLI(`terminal show`)는
// `state_labels` 로 채웠다. herdr 0.9.0 은 claude·codex·grok 에 labels 를 **안 싣는다** —
// 그래서 같은 pane 이 창에서는 `permission`, CLI 에서는 `unknown` 이었다. 한 함수에서 두 판정이
// 나온 것이고 S6 「한 어휘」가 금지하는 자리다.
//
// 이 파일은 **두 호출부의 조합을 그대로 재현해** 값이 같은지 본다. 한쪽만 호출해서는 그 갈림을
// 못 잡는다 — 갈림은 함수가 아니라 **무엇을 먹였나**에 있었다.

import { describe, expect, it } from 'vitest'
import { blockedReason, pickBlockedRule } from '../../shared/agent-state.js'
import { blockedReasonOf } from './index.js'

/** GUI 경로: explain 에서 규칙을 고르고 그 id 로 판정해 `agentState.blockedReason` 에 넣는다. */
const guiReason = (explain: Record<string, unknown> | null, labels: Record<string, string>) =>
  blockedReason({ labels, ruleId: pickBlockedRule(explain).ruleId })

/** CLI 경로: `terminal show` 의 `blocked.reason` 문자열. */
const cliReason = (explain: Record<string, unknown> | null, labels: Record<string, string>) =>
  blockedReasonOf({ labels, ruleId: pickBlockedRule(explain).ruleId })

describe('F3 — 같은 pane 이면 GUI 와 CLI 가 같은 사유를 말한다', () => {
  const cases: Array<{ name: string; explain: Record<string, unknown> | null; labels: Record<string, string>; expect: string }> = [
    {
      name: '규칙 id 만 있다 (실측상 claude·codex·grok 이 늘 이 갈래다)',
      explain: { matched_rule: { id: 'bash_permission_prompt' }, evaluated_rules: [] },
      labels: {},
      expect: 'permission',
    },
    {
      name: '거친 규칙이 이겼지만 구체적 규칙이 같이 맞았다 (F2)',
      explain: {
        matched_rule: { id: 'osc_title_blocked' },
        evaluated_rules: [{ id: 'osc_title_blocked', matched: true }, { id: 'question_dialog_hints_blocked', matched: true }],
      },
      labels: {},
      expect: 'question',
    },
    {
      name: '갈래 없는 규칙 — 양쪽 다 unknown',
      explain: { matched_rule: { id: 'live_blocked_form' }, evaluated_rules: [{ id: 'live_blocked_form', matched: true }] },
      labels: {},
      expect: 'unknown',
    },
    {
      name: 'herdr 가 labels 만 준다면 (지금은 안 오지만 오면 양쪽이 같이 읽어야 한다)',
      explain: null,
      labels: { a: 'Do you trust this directory?' },
      expect: 'trust',
    },
  ]

  for (const item of cases) {
    it(item.name, () => {
      expect(guiReason(item.explain, item.labels)).toBe(item.expect)
      expect(cliReason(item.explain, item.labels)).toBe(item.expect)
    })
  }

  it('herdr 가 아무 말도 안 하면: GUI 는 공백(null), CLI 는 문자열 `unknown` — **유일한 의도적 차이**', () => {
    // CLI 의 `blocked.reason` 은 처음부터 평문 문자열 칸이라 null 을 실을 자리가 없다.
    // GUI 는 「출처에 없다(null)」와 「못 읽는다(unknown)」를 구분해 들고 간다.
    expect(guiReason(null, {})).toBeNull()
    expect(cliReason(null, {})).toBe('unknown')
  })
})
