// 도구 대상 한 줄 잘림 표시 (LIFE-581 R4-A1) — 수정 전 코드(189d911b0)에서 실패하는 것을 음성 대조로 남겼다(raw/claude/final).
import { describe, expect, it } from 'vitest'
import { TOOL_TARGET_MAX, wireItem } from './chat.js'

const place = { worktree: '/Users/fxuser/repos/demo', home: '/Users/fxuser' }
const targetOf = (target: string): string => {
  const item = wireItem({ item: { id: 0, kind: 'tools', at: null, tools: [{ name: 'Bash', target, status: 'ok' }] }, place })
  if (item.kind !== 'tools') throw new Error('tools 가 아니다')
  return item.tools[0]?.target ?? ''
}

describe('R4-A1 가림 전에 잘린 긴 대상은 가림 뒤 짧아져도 생략 표시가 붙는다', () => {
  it('masked-long(경로 가림으로 짧아짐) → `…` · 끝 글 없음 · 상한 안 / unmasked-long(양성 대조) → `…`', () => {
    const masked = targetOf(`cat ${'/Users/fxuser/repos/demo/src/a.ts '.repeat(20)} SYNTHETIC_TAIL`)
    expect([masked.endsWith('…'), masked.includes('SYNTHETIC_TAIL'), masked.length <= TOOL_TARGET_MAX]).toEqual([true, false, true])
    const unmasked = targetOf(`${'a'.repeat(600)} SYNTHETIC_TAIL`)
    expect([unmasked.endsWith('…'), unmasked.length]).toEqual([true, TOOL_TARGET_MAX])
    // 짧은 대상은 그대로(표시 없음).
    expect(targetOf('cat /Users/fxuser/repos/demo/src/a.ts')).toBe('cat src/a.ts')
  })
})
