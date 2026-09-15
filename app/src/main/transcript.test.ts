// 머리 재판독 단위 테스트 (LIFE-366 **C6′**, 수정 라운드 6).
//
// r5 는 머리를 **파일당 1회**만 읽고 못 찾은 것까지 닫았다. 갓 뜬 세션은 트랜스크립트에 메타
// 한 줄뿐이라, 통합 참조가 첫 사용자 레코드보다 **먼저** 관측되면 그 한 줄을 읽고 깃발이 서서
// 사용자가 무엇을 쳐도 제목이 안 살아났다 (codex R1 = 사용자가 원래 신고한 증상).
//
// 여기서는 **파일을 실제로 깔고** 판독층 입구(`readSessionDigest`)를 부른다 — 캐시를 비우지
// 않은 채로 파일을 키우는 것이 요점이라, 순수 함수 테스트로는 못 잡는다. HOME 은 매번 임시
// 폴더로 갈아끼운다 (관문 ④ — 사용자 HOME 을 안 만진다).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HEAD_WINDOW_BYTES, TAIL_MAX_BYTES, TAIL_WINDOW_BYTES, clearTranscriptCache, readSessionDigest } from './transcript'
import type { AgentSessionRef } from '../shared/types'

const SESSION_ID = '11111111-2222-4333-8444-555555555555'

let home = ''
let realHome: string | undefined
let file = ''

const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id: SESSION_ID }

const meta = JSON.stringify({ type: 'attachment', sessionId: SESSION_ID })

const userRecord = (text: string) =>
  JSON.stringify({
    type: 'user',
    sessionId: SESSION_ID,
    timestamp: '2026-09-15T00:00:00.000Z',
    message: { role: 'user', content: text },
  })

const assistantRecord = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SESSION_ID,
    timestamp: '2026-09-15T00:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })

/** 길이를 지정해 만드는 채움 레코드 — 창을 넘기거나 채우는 데 쓴다. */
const fillerRecord = (bytes: number) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SESSION_ID,
    timestamp: '2026-09-15T00:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(Math.max(1, bytes)) }] },
  })

function write(lines: string[]): void {
  fs.writeFileSync(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
}

function append(lines: string[]): void {
  fs.appendFileSync(file, `${lines.join('\n')}\n`)
}

beforeEach(() => {
  realHome = process.env['HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'l366-head-'))
  process.env['HOME'] = home
  const dir = path.join(home, '.claude', 'projects', 'l366')
  fs.mkdirSync(dir, { recursive: true })
  file = path.join(dir, `${SESSION_ID}.jsonl`)
  clearTranscriptCache()
})

afterEach(() => {
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  fs.rmSync(home, { recursive: true, force: true })
  clearTranscriptCache()
})

describe('머리 재판독 (C6′)', () => {
  it('C6′-① 메타 한 줄만 있을 때 읽어도, 나중에 붙은 첫 발화가 다음 주기에 제목이 된다', () => {
    write([meta])
    expect(readSessionDigest(ref).digest.firstPrompt).toBe(null)

    // **캐시를 안 비운다** — 이게 codex 재현(`head-race.mts`)이 잡은 자리다.
    append([userRecord('첫 사용자 발화가 조금 늦게 붙는 경우를 확인해라. 그리고 결과를 알려라.'), assistantRecord('확인했다')])
    expect(readSessionDigest(ref).digest.firstPrompt).toBe('첫 사용자 발화가 조금 늦게 붙는 경우를 확인해라')
  })

  it('C6′-① 메타가 여러 줄이어도(하네스 주입만 쌓여도) 사람 발화가 붙는 순간 산다', () => {
    write([meta, JSON.stringify({ type: 'user', sessionId: SESSION_ID, isMeta: true, message: { role: 'user', content: '<command-name>/clear</command-name>' } })])
    expect(readSessionDigest(ref).digest.firstPrompt).toBe(null)
    append([userRecord('두 번째 시도다. 이번에는 제목이 살아야 한다.')])
    expect(readSessionDigest(ref).digest.firstPrompt).toBe('두 번째 시도다')
  })

  it('C6′-② 안 끝난 파일의 재판독은 **추가 0바이트**다 (꼬리 조각이 이미 파일 전체다)', () => {
    write([meta])
    readSessionDigest(ref)
    append([assistantRecord('아직 사람 발화는 없다')])
    const grown = readSessionDigest(ref)
    expect(grown.bytes).toBe(fs.statSync(file).size)
    expect(grown.bytes).toBeLessThanOrEqual(TAIL_WINDOW_BYTES)
  })

  it('C6′-④ 첫 발화를 찾은 뒤에는 머리를 다시 안 읽는다 — 값도 안 바뀐다', () => {
    write([userRecord('처음 친 말이 제목이 된다'), assistantRecord('그렇다')])
    expect(readSessionDigest(ref).digest.firstPrompt).toBe('처음 친 말이 제목이 된다')
    append([userRecord('나중에 친 말은 제목이 아니다')])
    expect(readSessionDigest(ref).digest.firstPrompt).toBe('처음 친 말이 제목이 된다')
  })

  it('C6′-④ 창을 꽉 채워 읽었으면(파일이 창보다 크다) 못 찾아도 다시 안 읽는다', () => {
    // 첫 사용자 레코드가 **한 줄로 창을 넘는다** — C5′ 가 부재를 허용하는 바로 그 모양이다.
    write([JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      timestamp: '2026-09-15T00:00:00.000Z',
      message: { role: 'user', content: `창을 넘는 첫 레코드다. ${'가'.repeat(HEAD_WINDOW_BYTES)}` },
    })])
    const first = readSessionDigest(ref)
    expect(first.digest.firstPrompt).toBe(null)
    // 머리를 읽은 주기의 통과선은 **꼬리 상한 + 머리 창** 이다 (C6′-③ · 2.25MB).
    expect(first.bytes).toBeLessThanOrEqual(TAIL_MAX_BYTES + HEAD_WINDOW_BYTES)

    const before = fs.statSync(file).size
    append([assistantRecord('그 뒤로 파일이 자란다')])
    const grown = readSessionDigest(ref)
    // 머리를 다시 안 읽으므로 이번 주기 읽기는 **꼬리 창뿐**이다.
    expect(grown.bytes).toBeLessThanOrEqual(TAIL_WINDOW_BYTES)
    expect(before).toBeGreaterThan(HEAD_WINDOW_BYTES)
  })

  it('C6′-② 한 주기의 머리 읽기는 256KB 를 안 넘는다 (큰 파일 첫 판독)', () => {
    const lines = [meta]
    let size = 0
    while (size < HEAD_WINDOW_BYTES + 64 * 1024) {
      const line = fillerRecord(4096)
      lines.push(line)
      size += line.length + 1
    }
    lines.push(userRecord('창 밖에 있는 사람 발화는 못 본다'))
    write(lines)
    const read = readSessionDigest(ref)
    expect(read.digest.firstPrompt).toBe(null)
    expect(read.bytes).toBeLessThanOrEqual(TAIL_MAX_BYTES + HEAD_WINDOW_BYTES)
    // 머리 몫은 창 하나뿐 — 파일 전체를 읽은 꼬리 몫을 빼면 남는 게 256KB 를 안 넘는다.
    expect(read.bytes - fs.statSync(file).size).toBeLessThanOrEqual(HEAD_WINDOW_BYTES)
  })

  it('C6′-③ 머리를 읽은 주기에만 `headBytes` 가 선다 — 주기를 어느 통과선으로 셀지가 여기서 갈린다', () => {
    const filler = fillerRecord(100 * 1024)
    write([meta, filler, filler, filler])
    const first = readSessionDigest(ref)
    expect(first.headBytes).toBe(HEAD_WINDOW_BYTES)

    append([assistantRecord('자란다')])
    const grown = readSessionDigest(ref)
    // 창을 꽉 채워 읽었으니 머리 판독은 끝났다 — 이 주기는 **나머지 주기**(≤2MB)로 센다.
    expect(grown.headBytes).toBe(0)
  })

  it('C6′-② 창보다 작은 파일은 재판독을 해도 `headBytes` 가 0 이다 (꼬리 조각 재사용)', () => {
    write([meta])
    expect(readSessionDigest(ref).headBytes).toBe(0)
    append([assistantRecord('아직 사람 발화는 없다')])
    expect(readSessionDigest(ref).headBytes).toBe(0)
  })

  it('창 안에서 시작하고 창 안에서 끝나는 레코드는 **반드시** 뽑는다 (C5′ — 그 외 부재는 미달)', () => {
    const filler = fillerRecord(100 * 1024)
    write([meta, userRecord('창 안에 있는 첫 발화다. 이건 부재가 허용되지 않는다.'), filler, filler, filler])
    expect(fs.statSync(file).size).toBeGreaterThan(HEAD_WINDOW_BYTES)
    expect(readSessionDigest(ref).digest.firstPrompt).toBe('창 안에 있는 첫 발화다')
  })
})
