// LIFE-834 — 도우미 출력 줄 해석·OS 판정·사용자 문구.
import { describe, expect, it } from 'vitest'
import { dictationErrorMessage, dictationOsSupported, parseHelperLine } from './dictation.js'

describe('parseHelperLine — 도우미 규약', () => {
  it.each([
    ['{"type":"ready"}', { type: 'ready' }],
    ['{"type":"done"}', { type: 'done' }],
    ['{"type":"partial","text":"워크"}', { type: 'partial', text: '워크' }],
    ['{"text":"워크트리 목록","type":"final"}', { type: 'final', text: '워크트리 목록' }],
    ['{"type":"level","rms":0}', { type: 'level', rms: 0 }],
    ['{"type":"error","code":"mic-denied","message":"거부"}', { type: 'error', code: 'mic-denied', message: '거부' }],
    ['{"type":"error","code":"x"}', { type: 'error', code: 'x', message: '' }],
  ])('%s', (line, expected) => {
    expect(parseHelperLine(line)).toEqual(expected)
  })
  it.each(['', 'not json', 'null', '"final"', '{"type":"final"}', '{"type":"final","text":3}', '{"type":"level","rms":"0"}', '{"type":"error"}', '{"type":"check"}', '{"type":"unknown"}'])(
    '모양이 다르면 null: %s',
    (line) => {
      expect(parseHelperLine(line)).toBeNull()
    },
  )
})

describe('dictationOsSupported — macOS 26(Darwin 25) 이상', () => {
  it.each([
    [{ platform: 'darwin', release: '25.4.0' }, true],
    [{ platform: 'darwin', release: '26.0.0' }, true],
    [{ platform: 'darwin', release: '24.6.0' }, false],
    [{ platform: 'darwin', release: '' }, false],
    [{ platform: 'linux', release: '25.0.0' }, false],
  ])('%o → %s', (input, expected) => {
    expect(dictationOsSupported(input)).toBe(expected)
  })
})

describe('dictationErrorMessage — 원인을 말한다', () => {
  it('모르는 코드도 코드·사유를 그대로 보인다', () => {
    expect(dictationErrorMessage({ code: 'weird', message: '이유' })).toBe('받아쓰기 오류 (weird): 이유')
  })
  it('권한 거부는 설정 위치를 말한다', () => {
    expect(dictationErrorMessage({ code: 'mic-denied', message: '' })).toContain('개인정보 보호 및 보안 › 마이크')
  })
})
