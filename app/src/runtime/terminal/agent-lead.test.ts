// 경로별 리드 (LIFE-832 리뷰 r1 A1) — `sameBody`·`countSubmissions` 의 `lead`. 이름 없는 호출(오케스트레이션·CLI)은 규칙 그대로.
import { describe, expect, it } from 'vitest'
import { bodyIdentity, countSubmissions, PROMPT_LEAD, sameBody, unwrapPasted } from './agent.js'

const BODY = 'diff 리뷰 메모 1개\n\nFile: "a.ts"\nLine: 1\nCode: "x"\nNote: "y"'
const LEAD = '아래에 붙여 넣은 메모를 반영:'
const wrap = (body: string, id = 'ab12'): string => `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">\n`
const id = bodyIdentity(BODY)

describe('sameBody — 이름 붙인 리드', () => {
  it('그 리드 + 블록 하나 = 같음 · 리드 바로 뒤 본문(블록 없이) = 같음', () => {
    expect(sameBody(id, `${LEAD}\n\n${wrap(BODY)}`, LEAD)).toBe(true)
    expect(sameBody(id, `${LEAD}${BODY}`, LEAD)).toBe(true)
  })
  it('리드 없는 블록 · 본문만 · 다른 리드 · 블록 둘 · 리드 앞 다른 글 = 다름', () => {
    expect(sameBody(id, wrap(BODY), LEAD)).toBe(false)
    expect(sameBody(id, BODY, LEAD)).toBe(false)
    expect(sameBody(id, `${PROMPT_LEAD}\n\n${wrap(BODY)}`, LEAD)).toBe(false)
    expect(sameBody(id, `${LEAD}\n\n${wrap('other', 'cd34')}${wrap(BODY)}`, LEAD)).toBe(false)
    expect(sameBody(id, `내 말 ${LEAD}\n\n${wrap(BODY)}`, LEAD)).toBe(false)
    expect(sameBody(id, `${LEAD}${BODY} 덧붙임`, LEAD)).toBe(false)
  })
  it('이름 없는 호출은 그대로 — 본문만 = 같음, PROMPT_LEAD 블록 = 같음, 이 경로 리드 블록·리드+본문 = 다름', () => {
    expect(sameBody(id, BODY)).toBe(true)
    expect(sameBody(id, `${PROMPT_LEAD}\n\n${wrap(BODY)}`)).toBe(true)
    expect(sameBody(id, `${LEAD}\n\n${wrap(BODY)}`)).toBe(false)
    expect(sameBody(id, `${PROMPT_LEAD}${BODY}`)).toBe(false)
    expect(unwrapPasted(`${PROMPT_LEAD}\n\n${wrap(BODY)}`)).toBe(BODY)
  })
  it('countSubmissions 가 lead 를 넘긴다', () => {
    const line = (content: string): string => JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content }, uuid: `u-${content.length}`, timestamp: new Date(2_000_000_000_000).toISOString(), sessionId: 's' })
    const text = `${line(`${LEAD}\n\n${wrap(BODY)}`)}\n`
    const count = (lead?: string) => countSubmissions({ kind: 'claude', files: ['f'], identity: id, submittedAtMs: 2_000_000_000_000, cursor: [], read: () => text, ...(lead === undefined ? {} : { lead }) }).matchCount
    expect(count(LEAD)).toBe(1)
    expect(count()).toBe(0)
  })
})
