// 판독층 입구 테스트 (LIFE-458 T7·T3·T4) — 파일을 실제로 깔고 `readSessionDigest` 를 부른다.
//
// ① grok 형제 파일(`updates.jsonl`) — 본 파일과 **따로** stat 하고 바뀐 쪽만 읽는가, 창이 256KB 로 묶이는가
// ② 모델·최근 발화 이어 나르기 — 꼬리 창 밖으로 밀려나도 같은 파일에서 전에 본 값이 남는가,
//    읽지 않은 틈이 생기면 그 틈의 새 값을 찾거나 null 인가 (수정 r1·F4)
// ③ grok summary.json 모델 — 응답 기록에 모델이 없을 때 메우는가, 따로 stat 하는가 (수정 r1·F3)
// HOME 은 매번 임시 폴더다 (사용자 HOME 을 안 만진다).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SIDECAR_WINDOW_BYTES,
  SUMMARY_MAX_BYTES,
  TAIL_MAX_BYTES,
  TAIL_WINDOW_BYTES,
  clearTranscriptCache,
  readSessionDigest,
} from './transcript'
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

describe('grok summary.json 모델 (T3·T7, 수정 r1·F3)', () => {
  const ref: AgentSessionRef = { kind: 'id', agent: 'grok', source: 'herdr:grok', id: SESSION_ID }
  let dir = ''
  // n23 의 null 4 세션 모양 — 사람 발화만 있고 응답(assistant) 줄이 없다. summary 키는 실물 순서의 일부.
  const summary = (model: unknown) =>
    JSON.stringify({ agent_id: 'ID', created_at: 'T', current_model_id: model, num_chat_messages: 1, reasoning_effort: 'high' })
  const userOnly = jsonl([{ type: 'user', content: [{ type: 'text', text: '<user_query>해 줘</user_query>' }] }])

  beforeEach(() => {
    dir = path.join(home, '.grok', 'sessions', '%2Ftmp%2Fl458', SESSION_ID)
    fs.mkdirSync(dir, { recursive: true })
  })

  it('응답 줄이 없으면 summary 의 current_model_id 로 메운다 — 파일 크기만큼 읽는다', () => {
    fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), userOnly)
    fs.writeFileSync(path.join(dir, 'summary.json'), summary('grok-4.7'))
    const read = readSessionDigest(ref)
    expect(read.digest.model).toBe('grok-4.7')
    expect(read.sidecarBytes).toBe(fs.statSync(path.join(dir, 'summary.json')).size)
  })

  it('응답 줄의 model_id 가 먼저다', () => {
    fs.writeFileSync(
      path.join(dir, 'chat_history.jsonl'),
      userOnly + jsonl([{ type: 'assistant', content: '했다', model_id: 'grok-4.7-build' }]),
    )
    fs.writeFileSync(path.join(dir, 'summary.json'), summary('grok-4.7'))
    expect(readSessionDigest(ref).digest.model).toBe('grok-4.7-build')
  })

  it('summary 만 바뀌면 그 파일만 읽는다 — 무변경이면 stat 만', () => {
    fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), userOnly)
    fs.writeFileSync(path.join(dir, 'summary.json'), summary('grok-4.6'))
    readSessionDigest(ref)
    expect(readSessionDigest(ref).statOnly).toBe(true)
    fs.writeFileSync(path.join(dir, 'summary.json'), summary('grok-4.7 '))
    const read = readSessionDigest(ref)
    expect(read.digest.model).toBe('grok-4.7')
    expect(read.bytes).toBe(read.sidecarBytes)
  })

  it('summary 가 없거나·깨졌거나·비었거나·상한보다 크면 null — 던지지 않는다, 큰 파일은 안 읽는다', () => {
    fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), userOnly)
    expect(readSessionDigest(ref).digest.model).toBeNull()
    for (const text of ['{"current_model_id":', summary(''), summary(7), '[]']) {
      fs.writeFileSync(path.join(dir, 'summary.json'), text)
      expect(readSessionDigest(ref).digest.model).toBeNull()
    }
    fs.writeFileSync(path.join(dir, 'summary.json'), summary('grok-4.7') + ' '.repeat(SUMMARY_MAX_BYTES))
    const big = readSessionDigest(ref)
    expect(big.digest.model).toBeNull()
    expect(big.sidecarBytes).toBe(0)
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

  // 모델 없는 assistant 텍스트 한 덩어리 — 텍스트가 있으니 활동 때문에 확장이 돌지는 않는다.
  const filler = (bytes: number): unknown[] => {
    const records: unknown[] = []
    while (records.length * 10_000 < bytes) records.push(assistant('z'.repeat(10_000)))
    return records
  }

  it('이어서 읽으면 창 밖으로 밀려나도 같은 파일에서 본 값이 남는다 — 창은 넓히지 않는다', () => {
    fs.writeFileSync(file, jsonl([human('처음 부탁'), assistant('네', 'claude-opus-5-5')]))
    expect(readSessionDigest(ref).digest.model).toBe('claude-opus-5-5')

    // 폴링마다 창보다 적게 붙는다 — 판독 구간이 매번 지난 끝에서 이어진다. 합계는 창의 두 배를 넘는다.
    let read = readSessionDigest(ref)
    for (let round = 0; round < 4; round += 1) {
      fs.appendFileSync(file, jsonl(filler(TAIL_WINDOW_BYTES / 2)))
      read = readSessionDigest(ref)
    }
    expect(fs.statSync(file).size).toBeGreaterThan(TAIL_WINDOW_BYTES * 2)
    expect(read.bytes - read.headBytes).toBe(TAIL_WINDOW_BYTES)
    expect(read.digest.model).toBe('claude-opus-5-5')
    expect(read.digest.lastPrompt).toBe('처음 부탁')
  })

  it('틈 안에 새 값 — 리뷰 재현 모양(창보다 많이 한 번에 붙음): 같은 2MB 확장으로 새 값을 찾는다', () => {
    fs.writeFileSync(file, jsonl([human('old-prompt'), assistant('ready', 'old-model')]))
    readSessionDigest(ref)
    fs.appendFileSync(file, jsonl([human('new-prompt'), assistant('ok', 'new-model'), ...filler(TAIL_WINDOW_BYTES + 70_000)]))
    const read = readSessionDigest(ref)
    expect(read.bytes - read.headBytes).toBeGreaterThan(TAIL_WINDOW_BYTES)
    expect(read.bytes - read.headBytes).toBeLessThanOrEqual(TAIL_MAX_BYTES)
    expect(read.digest.model).toBe('new-model')
    expect(read.digest.lastPrompt).toBe('new-prompt')
  })

  it('틈이 2MB 밖까지 이어져 확인 못 하면 잇지 않는다 — 낡은 값 대신 null', () => {
    fs.writeFileSync(file, jsonl([human('old-prompt'), assistant('ready', 'old-model')]))
    readSessionDigest(ref)
    fs.appendFileSync(file, jsonl([human('new-prompt'), assistant('ok', 'new-model'), ...filler(TAIL_MAX_BYTES + 100_000)]))
    const read = readSessionDigest(ref)
    expect(read.bytes - read.headBytes).toBe(TAIL_MAX_BYTES)
    expect(read.digest.model).toBeNull()
    expect(read.digest.lastPrompt).toBeNull()
    // 그 뒤로 이어서 읽으면 null 이 이어진다 — 옛 값이 되살아나지 않는다.
    fs.appendFileSync(file, jsonl(filler(10_000)))
    const next = readSessionDigest(ref)
    expect(next.digest.model).toBeNull()
    expect(next.bytes - next.headBytes).toBe(TAIL_WINDOW_BYTES)
  })

  // 리뷰 r2 R2-1 모양 — 옛 값을 읽고 창보다 적게 여러 번 붙여 ~494KB 로 키운 뒤, 다음 폴링 전에 **같은 경로**가
  // 새 값(앞쪽)+filler 로 된 더 큰 파일로 바뀐다. 새 값은 마지막 256KB 창 밖·2MB 안이다.
  const grown = () => {
    fs.writeFileSync(file, jsonl([human('old-prompt'), assistant('ready', 'old-model')]))
    readSessionDigest(ref)
    for (let round = 0; round < 4; round += 1) {
      fs.appendFileSync(file, jsonl(filler(TAIL_WINDOW_BYTES / 2)))
      readSessionDigest(ref)
    }
    return fs.statSync(file)
  }
  const replacement = (bytes: number) => jsonl([human('new-prompt'), assistant('ok', 'new-model'), ...filler(bytes)])

  it('같은 경로 rename 교체(inode 바뀜) — 옛 값을 잇지 않고 새 파일의 값을 찾는다', () => {
    const before = grown()
    const next = `${file}.next`
    fs.writeFileSync(next, replacement(before.size + 30_000))
    fs.renameSync(next, file)
    const after = fs.statSync(file)
    expect(after.ino).not.toBe(before.ino)
    expect(after.size).toBeGreaterThan(before.size)
    const read = readSessionDigest(ref)
    expect(read.digest.model).toBe('new-model')
    expect(read.digest.lastPrompt).toBe('new-prompt')
    expect(read.bytes - read.headBytes).toBeLessThanOrEqual(TAIL_MAX_BYTES)
  })

  it('같은 inode truncate 뒤 재성장 — 옛 값을 잇지 않는다', () => {
    const before = grown()
    fs.writeFileSync(file, replacement(before.size + 30_000)) // 같은 경로·같은 inode 를 비우고 다시 쓴다
    const after = fs.statSync(file)
    expect(after.ino).toBe(before.ino)
    expect(after.size).toBeGreaterThan(before.size)
    const read = readSessionDigest(ref)
    expect(read.digest.model).toBe('new-model')
    expect(read.digest.lastPrompt).toBe('new-prompt')
  })

  it('교체된 파일에 값이 2MB 안에 없으면 null — 옛 값이 아니다', () => {
    const before = grown()
    fs.writeFileSync(file, jsonl(filler(before.size + 30_000)))
    const read = readSessionDigest(ref)
    expect(read.digest.model).toBeNull()
    expect(read.digest.lastPrompt).toBeNull()
  })

  it('축소가 다음 stat 에 보이면 잇지 않는다', () => {
    grown()
    fs.writeFileSync(file, jsonl([assistant('short')]))
    const read = readSessionDigest(ref)
    expect(read.digest.model).toBeNull()
    expect(read.digest.lastPrompt).toBeNull()
  })

  it('정상 append 는 닻 확인이 이미 읽은 창 안에서 끝난다 — 추가 읽기 0', () => {
    const before = grown()
    fs.appendFileSync(file, jsonl(filler(20_000)))
    const read = readSessionDigest(ref)
    expect(read.digest.model).toBe('old-model')
    expect(read.bytes - read.headBytes).toBe(TAIL_WINDOW_BYTES)
    expect(fs.statSync(file).ino).toBe(before.ino)
  })

  it('틈이 있어도 새 값이 없으면(옛 값이 여전히 최신) 확인 뒤 옛 값을 잇는다', () => {
    fs.writeFileSync(file, jsonl([human('old-prompt'), assistant('ready', 'old-model')]))
    readSessionDigest(ref)
    fs.appendFileSync(file, jsonl(filler(TAIL_WINDOW_BYTES * 2)))
    const read = readSessionDigest(ref)
    expect(read.digest.model).toBe('old-model')
    expect(read.digest.lastPrompt).toBe('old-prompt')
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
