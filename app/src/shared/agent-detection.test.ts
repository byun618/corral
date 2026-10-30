// LIFE-520 final R3-03(a) — 렌더러가 main 푸시·응답을 다시 읽는 방어선(`readAgentDetection`). 모양이 틀린 항목은 버리고, 모양이 틀린 전체는 unknown.
import { describe, expect, it } from 'vitest'
import { readAgentDetection } from './agent-detection.js'

const ok = { agent: 'claude', path: '/x/claude', source: 'login-shell' }

describe('readAgentDetection', () => {
  it('정상 모양은 그대로', () => {
    expect(readAgentDetection({ kind: 'detected', agents: [ok], shell: { ok: true }, at: 5 })).toEqual({ kind: 'detected', agents: [ok], shell: { ok: true }, at: 5 })
  })
  it('항목 단위로 거른다 — 경로가 문자열이 아니거나, 모르는 에이전트·출처면 그 항목만 빠진다', () => {
    const read = readAgentDetection({
      kind: 'detected',
      agents: [ok, { agent: 'codex', path: 42, source: 'fallback' }, { agent: 'gemini', path: '/x/g', source: 'fallback' }, { agent: 'grok', path: '/x/grok', source: 'elsewhere' }, null],
      shell: { ok: false, reason: 'timeout' },
      at: 1,
    })
    expect(read).toEqual({ kind: 'detected', agents: [ok], shell: { ok: false, reason: 'timeout' }, at: 1 })
  })
  it('kind 가 detected 가 아니거나 객체가 아니면 unknown(Ⓟ, base 화면)', () => {
    expect(readAgentDetection(null)).toEqual({ kind: 'unknown' })
    expect(readAgentDetection('detected')).toEqual({ kind: 'unknown' })
    expect(readAgentDetection({ kind: 'other', agents: [ok] })).toEqual({ kind: 'unknown' })
  })
  it('모르는 실패 사유는 exit 로 읽는다 · aborted 는 그대로', () => {
    expect(readAgentDetection({ kind: 'detected', agents: [], shell: { ok: false, reason: 'weird' }, at: 0 })).toMatchObject({ shell: { ok: false, reason: 'exit' } })
    expect(readAgentDetection({ kind: 'detected', agents: [], shell: { ok: false, reason: 'aborted' }, at: 0 })).toMatchObject({ shell: { ok: false, reason: 'aborted' } })
  })
})
