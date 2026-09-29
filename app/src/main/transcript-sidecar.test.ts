// 판독층 입구 테스트 (LIFE-458 T7·T3·T4) — 파일을 실제로 깔고 `readSessionDigest` 를 부른다.
//
// ① grok 형제 파일(`updates.jsonl`) — 본 파일과 **따로** stat 하고 바뀐 쪽만 읽는가, 창이 256KB 로 묶이는가
// ② 모델·최근 발화 이어 나르기 — 꼬리 창 밖으로 밀려나도 같은 파일에서 전에 본 값이 남는가
// HOME 은 매번 임시 폴더다 (사용자 HOME 을 안 만진다).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIDECAR_WINDOW_BYTES, TAIL_WINDOW_BYTES, clearTranscriptCache, readSessionDigest } from './transcript'
import type { AgentSessionRef } from '../shared/types'

const SESSION_ID = '11111111-2222-4333-8444-666666666666'

let home = ''
let realHome: string | undefined

beforeEach(() => {
  realHome = process.env['HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'l458-side-'))
  process.env['HOME'] = home
  clearTranscriptCache()
})

afterEach(() => {
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  fs.rmSync(home, { recursive: true, force: true })
  clearTranscriptCache()
})

const jsonl = (records: unknown[]): string => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`

describe('grok 형제 파일 updates.jsonl (T7)', () => {
  const ref: AgentSessionRef = { kind: 'id', agent: 'grok', source: 'herdr:grok', id: SESSION_ID }
  let dir = ''
  const update = (value: Record<string, unknown>) => ({ timestamp: 0, method: 'session/update', params: { sessionId: 'ID', update: value } })
  const turn = (stop: string) => update({ sessionUpdate: 'turn_completed', prompt_id: 'ID', stop_reason: stop })
  const userChunk = update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' } })

  beforeEach(() => {
    dir = path.join(home, '.grok', 'sessions', '%2Ftmp%2Fl458', SESSION_ID)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'chat_history.jsonl'),
      jsonl([
        { type: 'user', content: [{ type: 'text', text: '<user_query>해 줘</user_query>' }] },
        { type: 'assistant', content: '했다', model_id: 'grok-4.7-build' },
      ]),
    )
  })

  it('updates 만 자라면 본 파일은 안 읽고 형제 파일만 읽는다 — 결과가 바뀐다', () => {
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), jsonl([userChunk, turn('end_turn')]))
    const first = readSessionDigest(ref)
    expect(first.digest.turnOutcome).toEqual({ outcome: 'completed' })
    expect(first.digest.model).toBe('grok-4.7-build')
    expect(first.digest.lastPrompt).toBe('해 줘')

    fs.appendFileSync(path.join(dir, 'updates.jsonl'), jsonl([userChunk, turn('cancelled')]))
    const second = readSessionDigest(ref)
    expect(second.digest.turnOutcome).toEqual({ outcome: 'interrupted', reason: 'cancelled' })
    expect(second.statOnly).toBe(false)
    // 읽은 바이트 = 형제 파일뿐. 본 파일(chat_history)은 0바이트.
    expect(second.bytes).toBe(second.sidecarBytes)
    expect(second.sidecarBytes).toBe(fs.statSync(path.join(dir, 'updates.jsonl')).size)
    expect(second.digest.model).toBe('grok-4.7-build') // 본 파일 값은 캐시에서 그대로
  })

  it('둘 다 안 바뀌면 stat 만 — 읽기 0바이트', () => {
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), jsonl([turn('end_turn')]))
    readSessionDigest(ref)
    const again = readSessionDigest(ref)
    expect(again.statOnly).toBe(true)
    expect(again.bytes).toBe(0)
  })

  it('형제 파일이 창보다 크면 꼬리 256KB 만 읽는다', () => {
    const filler = update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'y'.repeat(4000) } })
    const records: unknown[] = []
    while (records.length * 4100 < SIDECAR_WINDOW_BYTES * 3) records.push(filler)
    records.push(turn('rate_limit'))
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), jsonl(records))
    const read = readSessionDigest(ref)
    expect(read.sidecarBytes).toBe(SIDECAR_WINDOW_BYTES)
    expect(read.digest.turnOutcome).toEqual({ outcome: 'failed', error: 'rate_limit' })
  })

  it('형제 파일이 없으면 턴 결과·질문이 null — 던지지 않는다', () => {
    const read = readSessionDigest(ref)
    expect(read.digest.turnOutcome).toBeNull()
    expect(read.digest.pendingQuestions).toBeNull()
    expect(read.digest.model).toBe('grok-4.7-build')
  })
})

describe('모델·최근 발화 이어 나르기 (T3·T4)', () => {
  const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id: SESSION_ID }
  let file = ''
  const human = (text: string) => ({ type: 'user', sessionId: SESSION_ID, message: { role: 'user', content: text } })
  const assistant = (text: string, model?: string) => ({
    type: 'assistant',
    sessionId: SESSION_ID,
    timestamp: '2026-09-30T00:00:00.000Z',
    message: model === undefined ? { role: 'assistant', content: [{ type: 'text', text }] } : { model, role: 'assistant', content: [{ type: 'text', text }] },
  })

  beforeEach(() => {
    const dir = path.join(home, '.claude', 'projects', 'l458')
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, `${SESSION_ID}.jsonl`)
  })

  it('창 밖으로 밀려나도 같은 파일에서 본 값이 남는다 — 창은 넓히지 않는다', () => {
    fs.writeFileSync(file, jsonl([human('처음 부탁'), assistant('네', 'claude-opus-5-5')]))
    expect(readSessionDigest(ref).digest.model).toBe('claude-opus-5-5')

    // 모델 없는 assistant 텍스트로 첫 창을 넘치게 채운다 — 텍스트가 있으니 확장도 안 돈다.
    const filler: unknown[] = []
    while (filler.length * 10_000 < TAIL_WINDOW_BYTES * 2) filler.push(assistant('z'.repeat(10_000)))
    fs.appendFileSync(file, jsonl(filler))
    const read = readSessionDigest(ref)
    expect(read.bytes - read.headBytes).toBe(TAIL_WINDOW_BYTES)
    expect(read.digest.model).toBe('claude-opus-5-5')
    expect(read.digest.lastPrompt).toBe('처음 부탁')
  })

  it('더 새 값이 오면 그 값으로 바뀐다', () => {
    fs.writeFileSync(file, jsonl([human('처음'), assistant('네', 'claude-opus-5-5')]))
    readSessionDigest(ref)
    fs.appendFileSync(file, jsonl([human('다음'), assistant('네', 'claude-fable-5-1')]))
    const read = readSessionDigest(ref)
    expect(read.digest.model).toBe('claude-fable-5-1')
    expect(read.digest.lastPrompt).toBe('다음')
  })
})
