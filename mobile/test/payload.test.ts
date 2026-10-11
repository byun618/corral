// QR 페이로드 검사 (P3ⓔ) — 네트워크 전에 거절한다. 실제 서버 QR 모양은 app/src/main/mobile/protocol.ts `pairingPayload`.
import { describe, expect, it } from 'vitest'
import { hostOf, originOf, parsePairingPayload } from '../src/core/payload'

const good = { kind: 'corral-pair', v: 1, url: 'wss://my-mac.tail1234.ts.net:8577/ws', code: 'ABCD2345' }

describe('parsePairingPayload', () => {
  it('정상 — 코드는 대문자·공백 정리', () => {
    expect(parsePairingPayload(JSON.stringify(good))).toEqual({ ok: true, target: { url: good.url, host: 'my-mac.tail1234.ts.net', code: 'ABCD2345' } })
    expect(parsePairingPayload(`  ${JSON.stringify({ ...good, code: ' abcd2345 ' })}\n`)).toMatchObject({ ok: true, target: { code: 'ABCD2345' } })
  })

  it.each([
    ['빈 문자열', ''],
    ['JSON 아님', 'hello'],
    ['URL QR', 'https://example.com'],
    ['배열', '[1,2]'],
    ['kind 다름', JSON.stringify({ ...good, kind: 'other' })],
    ['너무 김', JSON.stringify({ ...good, pad: 'x'.repeat(2000) })],
  ])('%s → not_corral', (_name, text) => {
    expect(parsePairingPayload(text)).toEqual({ ok: false, problem: 'not_corral' })
  })

  it('v 다름 → unknown_version', () => {
    expect(parsePairingPayload(JSON.stringify({ ...good, v: 2 }))).toEqual({ ok: false, problem: 'unknown_version' })
  })

  it.each([
    ['ws 평문', 'ws://my-mac.ts.net:8577/ws'],
    ['https', 'https://my-mac.ts.net:8577/ws'],
    ['경로 다름', 'wss://my-mac.ts.net:8577/other'],
    ['쿼리', 'wss://my-mac.ts.net:8577/ws?x=1'],
    ['사용자 정보', 'wss://u:p@my-mac.ts.net:8577/ws'],
    ['포트 범위 밖', 'wss://my-mac.ts.net:70000/ws'],
    ['문자열 아님', 42],
  ])('%s → bad_url', (_name, url) => {
    expect(parsePairingPayload(JSON.stringify({ ...good, url }))).toEqual({ ok: false, problem: 'bad_url' })
  })

  it.each([['짧음', 'ABC'], ['혼동 문자 O', 'ABCDO234'], ['숫자 1', 'ABCD1234'], ['문자열 아님', 12345678]])('%s → bad_code', (_name, code) => {
    expect(parsePairingPayload(JSON.stringify({ ...good, code }))).toEqual({ ok: false, problem: 'bad_code' })
  })
})

describe('hostOf · originOf', () => {
  it('RN 기본 Origin 과 같은 모양', () => {
    expect(hostOf(good.url)).toBe('my-mac.tail1234.ts.net:8577')
    expect(originOf(good.url)).toBe('https://my-mac.tail1234.ts.net:8577')
    expect(originOf('wss://h.ts.net/ws')).toBe('https://h.ts.net')
    expect(originOf('ws://h/ws')).toBeNull()
  })
})
