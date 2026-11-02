// 세션 이어 가기 판별 (LIFE-766 C1·C3·C6 찾기·C7·C8). `fixtures/continued-in/` 은 이 기계 실제 기록의 끝 모양을 가린 것이다 — 줄 순서·키·종류만 남기고 값은 지어냈다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRef } from '../shared/types.js'
import { ChatBuilder } from './chat-parse.js'
import { clearTranscriptCache, readSessionDigest, readSessionDigests, resolveTranscriptFile, resolveTranscriptUnique, TAIL_MAX_BYTES } from './transcript.js'
import { CONTINUED_CHAIN_MAX, CONTINUED_CONVERSATION_MAX_BYTES, CONTINUED_PROBE_BYTES, CONTINUED_TAIL_BYTES, clearContinuedMemo, continuedReadBytes, continuedVerdict, followContinued } from './transcript-continued.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'continued-in')
const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const LOST = '00000000-0000-4000-8000-0000000000ff'
const META_TYPES = ['last-prompt', 'cost-state', 'artifact-comment-monitor', 'file-history-snapshot', 'queue-operation']

const row = (value: unknown): string => `${JSON.stringify(value)}\n`
const fork = (to: string, from = A): string => row({ type: 'continued-in', timestamp: '2026-01-01T00:00:00.000Z', sessionId: from, continuedInSessionId: to })
const human = (text: string, sessionId: string): string => row({ type: 'user', sessionId, uuid: `u-${text}`, parentUuid: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: text } })
const reply = (text: string, sessionId: string): string => row({ type: 'assistant', sessionId, uuid: `a-${text}`, parentUuid: null, timestamp: '2026-01-01T00:00:02.000Z', message: { id: `m-${text}`, role: 'assistant', model: 'x', content: [{ type: 'text', text }] } })
const ask = (sessionId: string): string => row({ type: 'assistant', sessionId, uuid: 'q', parentUuid: null, timestamp: '2026-01-01T00:00:03.000Z', message: { id: 'm-q', role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: 'call-1', name: 'AskUserQuestion', input: { questions: [{ question: '어느 쪽?', header: '선택', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] } }] } })

const refOf = (id: string): AgentSessionRef => ({ kind: 'id', agent: 'claude', source: 'herdr:claude', id })

let home = ''
let realHome: string | undefined
let dir = ''
const fileOf = (id: string): string => path.join(dir, `${id}.jsonl`)
const follow = (id = A) => followContinued({ session: refOf(id), file: fileOf(id), empty: 'stay' })
const followEmpty = (id = A) => followContinued({ session: refOf(id), file: fileOf(id), empty: 'follow' })

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'l766-'))
  realHome = process.env['HOME']
  process.env['HOME'] = home
  dir = path.join(home, '.claude', 'projects', 'proj')
  fs.mkdirSync(dir, { recursive: true })
  clearTranscriptCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  fs.rmSync(home, { recursive: true, force: true })
  clearTranscriptCache()
})

describe('C1 판별 규칙', () => {
  it('ⓐ 끝 줄 → 대상 파일과 대상 세션 id 를 함께 고른다', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), human('새', B))
    expect(follow()).toEqual({ file: fileOf(B), sessionId: B, hops: [B] })
  })

  it.each(META_TYPES)('ⓑ 뒤에 메타 줄(%s)이 있어도 따라간다', (type) => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B) + row({ type, sessionId: A }))
    fs.writeFileSync(fileOf(B), human('새', B))
    expect(follow().file).toBe(fileOf(B))
  })

  it('ⓒ 연쇄 A→B→C 는 끝까지 간다', () => {
    fs.writeFileSync(fileOf(A), fork(B))
    fs.writeFileSync(fileOf(B), fork(C, B))
    fs.writeFileSync(fileOf(C), human('끝', C))
    expect(followEmpty()).toEqual({ file: fileOf(C), sessionId: C, hops: [B, C] })
  })

  it('ⓒ 연쇄가 상한을 넘으면 상한에서 멈춘다', () => {
    const ids = Array.from({ length: CONTINUED_CHAIN_MAX + 3 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    ids.forEach((id, index) => fs.writeFileSync(fileOf(id), fork(ids[index + 1] ?? LOST, id)))
    const followed = followEmpty(ids[0])
    expect(followed.hops).toHaveLength(CONTINUED_CHAIN_MAX)
    expect(followed.file).toBe(fileOf(ids[CONTINUED_CHAIN_MAX]!))
  })

  it('ⓓ 순환 A→B→A 는 예외 없이 멈춘다 · 자기 자신도', () => {
    fs.writeFileSync(fileOf(A), fork(B))
    fs.writeFileSync(fileOf(B), fork(A, B))
    expect(followEmpty()).toEqual({ file: fileOf(B), sessionId: B, hops: [B] })
    fs.writeFileSync(fileOf(C), fork(C, C))
    expect(followEmpty(C)).toEqual({ file: fileOf(C), sessionId: C, hops: [] })
  })

  it('ⓔ 대상 파일이 없으면 옛 파일, 생기면 옮겨 간다', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
    fs.writeFileSync(fileOf(B), human('새', B))
    expect(follow()).toEqual({ file: fileOf(B), sessionId: B, hops: [B] })
  })

  it.each(['user', 'assistant'])('ⓕ continued-in 뒤 %s 줄 → 옛 파일(세션이 되살아났다)', (type) => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    expect(follow().file).toBe(fileOf(B))
    fs.appendFileSync(fileOf(A), type === 'user' ? human('되살림', A) : reply('되살림', A))
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
  })

  it.each([
    ['깨진 줄이 뒤에', () => fork(B) + '{"type":"cost-'],
    ['JSON 이지만 객체 아님', () => fork(B) + '42\n'],
    ['type 없는 객체', () => fork(B) + row({ sessionId: A })],
    ['continuedInSessionId 없음', () => row({ type: 'continued-in', sessionId: A })],
    ['숫자 id', () => row({ type: 'continued-in', continuedInSessionId: 7 })],
    ['틀린 마지막 줄이 맞는 앞 줄을 가린다', () => fork(B) + row({ type: 'continued-in', continuedInSessionId: '../x' })],
  ])('ⓖ %s → 옛 파일', (_name, tail) => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + tail())
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
  })

  // 값이 가리키는 파일을 실제로 만든다 — 모양 검사만이 막는다(검사를 지우면 이 칸이 실패한다).
  it.each([
    ['경로 조작 ../', `../other/${B}`],
    ['경로 구분자', `sub/${B}`],
    ['대문자 UUID', B.toUpperCase()],
    ['긴 모양', `${B}0`],
  ])('ⓖ 모양 위반(%s) — 그 대상 파일이 있어도 옛 파일', (_name, target) => {
    const pointed = path.join(dir, `${target}.jsonl`)
    fs.mkdirSync(path.dirname(pointed), { recursive: true })
    fs.writeFileSync(pointed, human('밖', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + row({ type: 'continued-in', continuedInSessionId: target }))
    expect(fs.existsSync(pointed)).toBe(true)
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
  })

  it('ⓖ 여러 continued-in 은 마지막 것을 쓴다', () => {
    fs.writeFileSync(fileOf(B), human('b', B))
    fs.writeFileSync(fileOf(C), human('c', C))
    fs.writeFileSync(fileOf(A), fork(B) + fork(C))
    expect(follow().file).toBe(fileOf(C))
  })

  it('ⓖ 앞에 깨진 줄이 있어도 뒤의 유효한 줄은 읽는다 · 사람 글 속 문자열은 표지가 아니다', () => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), `{"broken\n${fork(B)}`)
    expect(follow().file).toBe(fileOf(B))
    fs.writeFileSync(fileOf(C), human(`{"type":"continued-in","continuedInSessionId":"${B}"}`, C))
    expect(follow(C).file).toBe(fileOf(C))
  })

  it('ⓗ continued-in 이 없는 파일 → 그대로', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + reply('답', A) + row({ type: 'cost-state', sessionId: A }))
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
    fs.writeFileSync(fileOf(C), '')
    expect(follow(C)).toEqual({ file: fileOf(C), sessionId: C, hops: [] })
  })

  it.each(['codex', 'grok'])('ⓘ %s 참조는 파일을 읽지 않고 그대로', (agent) => {
    const open = vi.spyOn(fs, 'openSync')
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), fork(B))
    expect(followContinued({ session: { kind: 'id', agent, source: `herdr:${agent}`, id: A }, file: fileOf(A), empty: 'stay' })).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
    expect(open).not.toHaveBeenCalled()
  })

  it('ⓙ kind: path 참조는 그 파일이 곧 세션이다 — 읽지 않고 그대로, 세션 id 는 null', () => {
    const open = vi.spyOn(fs, 'openSync')
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), fork(B))
    const session: AgentSessionRef = { kind: 'path', agent: 'claude', source: 'herdr:claude', path: fileOf(A) }
    expect(followContinued({ session, file: fileOf(A), empty: 'stay' })).toEqual({ file: fileOf(A), sessionId: null, hops: [] })
    expect(open).not.toHaveBeenCalled()
    expect(resolveTranscriptUnique(session)).toEqual({ kind: 'found', file: fileOf(A) })
  })

  it('판독 창 밖으로 밀려난 continued-in → 옛 파일(안전한 실패)', () => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), fork(B) + row({ type: 'cost-state', pad: 'x'.repeat(CONTINUED_TAIL_BYTES) }))
    expect(follow().file).toBe(fileOf(A))
    expect(continuedVerdict({ chunk: fork(B), partial: true })).toEqual({ kind: 'window' })
  })

  it('못 읽는 파일 → 예외 없이 그대로', () => {
    expect(follow(LOST)).toEqual({ file: fileOf(LOST), sessionId: LOST, hops: [] })
  })
})

describe('모름은 없음이 아니다 — 직전 판별을 유지한다', () => {
  it.each([
    ['쓰는 중 줄', '{"type":"cost-'],
    ['읽지 못하는 완성 줄', '{broken}\n'],
    ['type 없는 줄', row({ sessionId: A })],
  ])('이동 뒤 %s 가 붙어도 대상에 머문다', (_name, tail) => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    expect(follow().file).toBe(fileOf(B))
    fs.appendFileSync(fileOf(A), tail)
    expect(follow().file).toBe(fileOf(B))
  })

  it('쓰는 중이던 줄이 메타로 완성되면 그대로 대상에 머문다', () => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    expect(follow().file).toBe(fileOf(B))
    fs.appendFileSync(fileOf(A), '{"type":"cost-')
    expect(follow().file).toBe(fileOf(B))
    fs.appendFileSync(fileOf(A), 'state"}\n')
    expect(follow().file).toBe(fileOf(B))
  })

  it('8~64 KiB 완성 사람 줄 → 옛 파일 / 같은 자리 완성 메타 → 새 파일에 머문다', () => {
    const size = CONTINUED_PROBE_BYTES * 3
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    expect(follow().file).toBe(fileOf(B))
    fs.appendFileSync(fileOf(A), row({ type: 'cost-state', pad: 'x'.repeat(size) }))
    expect(follow().file).toBe(fileOf(B))
    fs.appendFileSync(fileOf(A), human('y'.repeat(size), A))
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
  })

  it('쓰는 중이던 사람 줄이 완성되면 곧바로 옛 파일로 돌아온다(되살아남)', () => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    expect(follow().file).toBe(fileOf(B))
    const line = human('되살림', A)
    fs.appendFileSync(fileOf(A), line.slice(0, 20))
    expect(follow().file).toBe(fileOf(B))
    fs.appendFileSync(fileOf(A), line.slice(20))
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
  })

  it('읽기 오류 한 번도 대상에 머물고, 풀리면 다시 판별한다', () => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    expect(follow().file).toBe(fileOf(B))
    fs.appendFileSync(fileOf(A), row({ type: 'cost-state' }))
    const open = vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
      throw new Error('EMFILE')
    })
    expect(follow().file).toBe(fileOf(B))
    expect(open).toHaveBeenCalledTimes(1)
    fs.appendFileSync(fileOf(A), human('되살림', A))
    expect(follow().file).toBe(fileOf(A))
  })

  it('원본 stat 이 실패해도 예외 없이 직전 판별 · 메모가 비었으면 옛 경로 그대로', () => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    expect(follow().file).toBe(fileOf(B))
    fs.rmSync(fileOf(A))
    expect(follow().file).toBe(fileOf(B))
    clearContinuedMemo()
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
  })

  it.each([
    ['교체(정체성이 다름)', () => {
      fs.rmSync(fileOf(A))
      fs.writeFileSync(fileOf(A), '{"type":"cost-')
    }],
    ['줄어듦', () => fs.writeFileSync(fileOf(A), '{"t')],
  ])('%s 된 파일의 모름에는 직전 판별을 잇지 않는다', (_name, change) => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    expect(follow().file).toBe(fileOf(B))
    change()
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
  })

  describe('스캐너 — 읽지 못하는 줄 앞을 더 본다(리뷰 r2 재현)', () => {
    const parked = (): void => {
      fs.writeFileSync(fileOf(B), human('새', B))
      fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
      expect(follow().file).toBe(fileOf(B))
    }
    const back = { file: '', sessionId: A, hops: [] }

    it('같은 관측의 완성 사람 줄 + 쓰는 중 assistant → 옛 파일', () => {
      parked()
      fs.appendFileSync(fileOf(A), `${human('되살림', A)}{"type":"assistant","sessionId":"`)
      expect(follow()).toEqual({ ...back, file: fileOf(A) })
    })

    it('완성 사람 줄 + 깨진 완성 줄 → 옛 파일', () => {
      parked()
      fs.appendFileSync(fileOf(A), `${human('되살림', A)}{broken}\n`)
      expect(follow()).toEqual({ ...back, file: fileOf(A) })
    })

    it('64 KiB 를 넘는 완성 사람 줄 → 옛 파일 · 그 뒤 짧은 메타도 옛 파일', () => {
      parked()
      fs.appendFileSync(fileOf(A), human('x'.repeat(CONTINUED_TAIL_BYTES + 100), A))
      expect(follow()).toEqual({ ...back, file: fileOf(A) })
      fs.appendFileSync(fileOf(A), row({ type: 'cost-state', sessionId: A }))
      expect(follow()).toEqual({ ...back, file: fileOf(A) })
    })

    it('처음부터 64 KiB 를 넘는 완성 줄 + 짧은 메타를 한 번에 봐도 옛 파일', () => {
      parked()
      fs.appendFileSync(fileOf(A), human('x'.repeat(CONTINUED_TAIL_BYTES + 100), A) + row({ type: 'cost-state', sessionId: A }))
      expect(follow()).toEqual({ ...back, file: fileOf(A) })
    })

    it('메타 줄이 64 KiB 를 넘어 continued-in 이 창 밖이면 옛 파일로 돌아간다 — 합의된 안전한 실패', () => {
      parked()
      fs.appendFileSync(fileOf(A), row({ type: 'cost-state', pad: 'x'.repeat(CONTINUED_TAIL_BYTES + 100) }))
      expect(follow()).toEqual({ ...back, file: fileOf(A) })
      fs.appendFileSync(fileOf(A), row({ type: 'cost-state', sessionId: A }))
      expect(follow()).toEqual({ ...back, file: fileOf(A) })
    })

    it('continued-in 뒤 메타 + 읽지 못하는 줄 → 모름(직전 유지), 8 KiB 를 넘어도 같다', () => {
      parked()
      fs.appendFileSync(fileOf(A), row({ type: 'cost-state', pad: 'x'.repeat(CONTINUED_PROBE_BYTES) }))
      expect(follow().file).toBe(fileOf(B))
      fs.appendFileSync(fileOf(A), '{"type":"cost-')
      expect(follow().file).toBe(fileOf(B))
    })

    it('읽지 못하는 줄 앞의 모양 위반 continued-in → 없음', () => {
      expect(continuedVerdict({ chunk: `${row({ type: 'continued-in', continuedInSessionId: '../x' })}{"t`, partial: false })).toEqual({ kind: 'none' })
    })

    it('잘린 창에서 읽지 못하는 줄뿐이면 window · 파일 전체면 모름', () => {
      expect(continuedVerdict({ chunk: 'x\n{broken}\n', partial: true })).toEqual({ kind: 'window' })
      expect(continuedVerdict({ chunk: '{broken}\n', partial: false })).toEqual({ kind: 'unknown' })
    })
  })

  it('더 큰 파일로 교체(다른 inode, 끝이 쓰는 중 줄)되면 직전 판별을 잇지 않는다', () => {
    fs.writeFileSync(fileOf(B), human('새', B))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    expect(follow().file).toBe(fileOf(B))
    // 옛 파일이 있는 채로 rename — 같은 inode 가 다시 쓰일 수 없다.
    const replacement = path.join(dir, 'replacement.tmp')
    fs.writeFileSync(replacement, `${human('x'.repeat(4096), A)}${fork(B)}{"type":"cost-`)
    const before = fs.statSync(fileOf(A))
    fs.renameSync(replacement, fileOf(A))
    const after = fs.statSync(fileOf(A))
    expect(after.ino).not.toBe(before.ino)
    expect(after.size).toBeGreaterThan(before.size)
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
  })

  it('처음 보는 파일의 모름은 옛 파일 · 없음과 있음은 그대로', () => {
    expect(continuedVerdict({ chunk: `${fork(B)}{"type":"cost-`, partial: false })).toEqual({ kind: 'unknown' })
    expect(continuedVerdict({ chunk: human('옛', A), partial: false })).toEqual({ kind: 'none' })
    expect(continuedVerdict({ chunk: row({ type: 'cost-state' }), partial: false })).toEqual({ kind: 'none' })
    expect(continuedVerdict({ chunk: fork(B), partial: false })).toEqual({ kind: 'target', id: B })
    expect(continuedVerdict({ chunk: row({ type: 'continued-in', continuedInSessionId: 'x' }), partial: false })).toEqual({ kind: 'none' })
  })
})

describe('C2ⓒ 실제 기록 끝 모양(가린 fixture)', () => {
  const tails = ['tail-1.jsonl', 'tail-2.jsonl', 'tail-3.jsonl', 'tail-4.jsonl', 'tail-5.jsonl']
  const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

  it.each(tails)('%s 가 그 대상으로 풀린다', (name) => {
    const text = read(name)
    const verdict = continuedVerdict({ chunk: text, partial: false })
    if (verdict.kind !== 'target') throw new Error('대상 없음')
    const target = verdict.id
    fs.writeFileSync(fileOf(A), text)
    expect(follow().file).toBe(fileOf(A)) // 대상이 아직 없다
    fs.writeFileSync(fileOf(target), human('새', target))
    expect(follow()).toEqual({ file: fileOf(target), sessionId: target, hops: [target] })
  })

  it('끝 모양 두 갈래(끝 줄 2건 · 메타 줄 뒤따름 3건)를 다 담는다 — 시험 재료가 빠지면 여기서 잡는다', () => {
    const last = tails.map((name) => JSON.parse(read(name).trim().split('\n').at(-1) ?? 'null').type)
    expect(last.filter((type) => type === 'continued-in')).toHaveLength(2)
    expect(last.filter((type) => type !== 'continued-in')).toHaveLength(3)
  })
})

/** 파일 전체를 그 세션 id 로 읽은 말풍선 수. */
function promptCount(input: { text: string; sessionId: string | null }): number {
  const builder = new ChatBuilder({ agent: 'claude', sessionId: input.sessionId })
  let offset = 0
  for (const line of input.text.split('\n')) {
    if (line !== '') builder.feed({ offset, line })
    offset += Buffer.byteLength(line) + 1
  }
  return builder.items.filter((item) => item.kind === 'prompt').length
}

describe('C3 대화 내용이 맞다 (fixture 쌍)', () => {
  it('옛 참조로 고른 id 로 읽은 사람 말풍선 수 = 대상 id 로 직접 연 수 · 대조: 옛 id 로 읽으면 0', () => {
    const tail = fs.readFileSync(path.join(FIXTURES, 'tail-5.jsonl'), 'utf8')
    const verdict = continuedVerdict({ chunk: tail, partial: false })
    if (verdict.kind !== 'target') throw new Error('대상 없음')
    const target = verdict.id
    const text = fs.readFileSync(path.join(FIXTURES, 'target.jsonl'), 'utf8')
    fs.writeFileSync(fileOf(A), tail)
    fs.writeFileSync(fileOf(target), text)
    const followed = follow()
    const direct = promptCount({ text, sessionId: target })
    expect(direct).toBeGreaterThan(0)
    expect(promptCount({ text, sessionId: followed.sessionId })).toBe(direct)
    // 대조 — 유효 id 를 옛 id 로 되돌린 모양(분석 측정 0/10)
    expect(promptCount({ text, sessionId: A })).toBe(0)
  })
})

describe('C6 쓰기용 찾기(resolveTranscriptUnique)', () => {
  it('대상 파일과 옮겨 간 id 를 준다 · 표시용 첫 일치는 원본 그대로', () => {
    fs.writeFileSync(fileOf(A), fork(B))
    fs.writeFileSync(fileOf(B), human('새', B))
    expect(resolveTranscriptUnique(refOf(A))).toEqual({ kind: 'found', file: fileOf(B), continuedAs: B })
    expect(resolveTranscriptFile(refOf(A))).toBe(fileOf(A))
  })

  it('이어 가기가 없으면 예전 모양 그대로', () => {
    fs.writeFileSync(fileOf(A), human('옛', A))
    expect(resolveTranscriptUnique(refOf(A))).toEqual({ kind: 'found', file: fileOf(A) })
  })

  it('대상 후보 둘 이상 → ambiguous', () => {
    fs.writeFileSync(fileOf(A), fork(B))
    fs.writeFileSync(fileOf(B), human('새', B))
    const other = path.join(home, '.claude', 'projects', 'other')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, `${B}.jsonl`), human('사본', B))
    expect(resolveTranscriptUnique(refOf(A))).toEqual({ kind: 'ambiguous', count: 2 })
  })

  it('폴더를 못 읽으면 error(기다림) — 기존 계약', () => {
    fs.writeFileSync(fileOf(A), fork(B))
    fs.writeFileSync(fileOf(B), human('새', B))
    const locked = path.join(home, '.claude', 'projects', 'locked')
    fs.mkdirSync(locked)
    fs.chmodSync(locked, 0o000)
    try {
      expect(resolveTranscriptUnique(refOf(A))).toEqual({ kind: 'error' })
    } finally {
      fs.chmodSync(locked, 0o755)
    }
  })

  it('옮겨 간 id 의 후보 폴더만 오류면 error(기다림) — 원본 찾기는 성공해도', () => {
    fs.writeFileSync(fileOf(A), fork(B))
    fs.writeFileSync(fileOf(B), human('새', B))
    const other = path.join(home, '.claude', 'projects', 'other')
    fs.mkdirSync(other)
    // 자기 자신을 가리키는 링크 — 이 후보만 ELOOP 다.
    fs.symlinkSync(path.join(other, `${B}.jsonl`), path.join(other, `${B}.jsonl`))
    expect(resolveTranscriptFile(refOf(A))).toBe(fileOf(A))
    expect(resolveTranscriptUnique(refOf(A))).toEqual({ kind: 'error' })
  })

  it('대상이 다른 폴더에만 있으면 표시와 같이 옛 파일에 머문다', () => {
    fs.writeFileSync(fileOf(A), fork(B))
    const other = path.join(home, '.claude', 'projects', 'other')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, `${B}.jsonl`), human('밖', B))
    expect(resolveTranscriptUnique(refOf(A))).toEqual({ kind: 'found', file: fileOf(A) })
  })
})

describe('C7 지문', () => {
  it('캐시된 참조가 전환 뒤 새 파일로 옮겨 가 최근 지시·턴 결과·대기 질문이 새 파일 값이다', () => {
    fs.writeFileSync(fileOf(A), human('옛 지시', A) + reply('옛 답', A))
    expect(readSessionDigest(refOf(A)).digest.lastPrompt).toBe('옛 지시')
    fs.writeFileSync(fileOf(B), human('옛 지시', B) + reply('옛 답', B) + human('새 지시', B) + ask(B))
    fs.appendFileSync(fileOf(A), fork(B))
    const { digest } = readSessionDigest(refOf(A))
    expect(digest.lastPrompt).toBe('새 지시')
    expect(digest.pendingQuestions?.[0]?.question).toBe('어느 쪽?')
    fs.appendFileSync(fileOf(B), reply('새 답', B) + row({ type: 'system', subtype: 'turn_duration', sessionId: B, timestamp: '2026-01-01T00:00:09.000Z' }))
    const after = readSessionDigest(refOf(A)).digest
    expect(after.activity).toMatchObject({ state: 'text', text: '새 답' })
    expect(after.turnOutcome).not.toBeNull()
  })

  it('재시작(캐시 비움) 뒤에도 같다 — 새 파일 + 새 id', () => {
    fs.writeFileSync(fileOf(A), human('옛 지시', A) + fork(B))
    fs.writeFileSync(fileOf(B), human('새 지시', B))
    const before = readSessionDigest(refOf(A)).digest
    clearTranscriptCache()
    const after = readSessionDigest(refOf(A)).digest
    expect(after.lastPrompt).toBe('새 지시')
    expect(after).toEqual(before)
  })

  it('대상이 늦게 생겨도 다음 주기에 옮겨 간다', () => {
    fs.writeFileSync(fileOf(A), human('옛 지시', A) + fork(B))
    expect(readSessionDigest(refOf(A)).digest.lastPrompt).toBe('옛 지시')
    fs.writeFileSync(fileOf(B), human('새 지시', B))
    expect(readSessionDigest(refOf(A)).digest.lastPrompt).toBe('새 지시')
  })

  it('옛 파일의 제목·첫 발화를 새 파일로 나르지 않는다 · 옛 세션이 되살아나면 돌아온다', () => {
    fs.writeFileSync(fileOf(A), row({ type: 'ai-title', aiTitle: '옛 제목', sessionId: A }) + human('옛 첫 지시', A) + fork(B))
    fs.writeFileSync(fileOf(B), human('새 첫 지시', B))
    clearTranscriptCache()
    fs.writeFileSync(fileOf(A), row({ type: 'ai-title', aiTitle: '옛 제목', sessionId: A }) + human('옛 첫 지시', A))
    expect(readSessionDigest(refOf(A)).digest.providerTitle).toBe('옛 제목')
    fs.appendFileSync(fileOf(A), fork(B))
    const moved = readSessionDigest(refOf(A)).digest
    expect(moved.providerTitle).toBeNull()
    expect(moved.firstPrompt).toBe('새 첫 지시')
    fs.appendFileSync(fileOf(A), human('되살림', A))
    expect(readSessionDigest(refOf(A)).digest.lastPrompt).toBe('되살림')
  })

  it('수명 판독이 예외 없이 돌고 소유자는 새 id 로 본다', () => {
    const sessions = path.join(home, '.claude', 'sessions')
    fs.mkdirSync(sessions)
    // 전환 뒤 실물 모양 — 옛 id 의 프로세스는 interact 로 남고, 새 id 를 쥔 쪽이 대화를 잇는다.
    fs.writeFileSync(path.join(sessions, '1.json'), JSON.stringify({ pid: process.pid, sessionId: B, startedAt: Date.now() }))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), human('새', B))
    expect(readSessionDigest(refOf(A)).digest.lifecycle.state).not.toBe('unknown')
    fs.writeFileSync(path.join(sessions, '1.json'), JSON.stringify({ pid: process.pid, sessionId: A, startedAt: Date.now() }))
    clearTranscriptCache()
    expect(readSessionDigest(refOf(A)).digest.lifecycle).toMatchObject({ state: 'unknown', reason: 'not-running' })
  })

  it('수명 세대 경계(F6) — 포크 전에 열린 작업은 이전 세대로 빠지고 포크 뒤에 열린 작업만 실린다', () => {
    const at = (seconds: number): string => new Date(Date.parse('2026-06-01T00:00:00.000Z') + seconds * 1000).toISOString()
    const job = (input: { tool: string; task: string; seconds: number }): string =>
      row({ type: 'assistant', sessionId: B, uuid: `u-${input.tool}`, parentUuid: 'p', timestamp: at(input.seconds), message: { id: `m-${input.tool}`, role: 'assistant', model: 'x', content: [{ type: 'tool_use', id: input.tool, name: 'Bash', input: { command: 'sleep 600', run_in_background: true } }] } }) +
      row({ type: 'user', sessionId: B, uuid: `r-${input.tool}`, parentUuid: `u-${input.tool}`, timestamp: at(input.seconds), message: { role: 'user', content: [{ tool_use_id: input.tool, type: 'tool_result', content: 'ok' }] }, toolUseResult: { backgroundTaskId: input.task } })
    const sessions = path.join(home, '.claude', 'sessions')
    fs.mkdirSync(sessions)
    // 포크 프로세스는 포크 시각(100초)에 시작한다 — 새 파일에는 포크 전 줄이 복사돼 있다.
    fs.writeFileSync(path.join(sessions, '1.json'), JSON.stringify({ pid: process.pid, sessionId: B, startedAt: Date.parse(at(100)) }))
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), human('새', B) + job({ tool: 't-before', task: 'before', seconds: 10 }))
    expect(readSessionDigest(refOf(A)).digest.lifecycle).toMatchObject({ state: 'known', tasks: [] })
    fs.appendFileSync(fileOf(B), job({ tool: 't-after', task: 'after', seconds: 110 }))
    const after = readSessionDigest(refOf(A)).digest.lifecycle
    if (after.state !== 'known') throw new Error('known 이어야 한다')
    expect(after.tasks.map((task) => task.id)).toEqual(['after'])
  })

  it('옛 참조와 새 참조가 함께 있어도 같은 파일 값이다(압축 뒤 다른 pane 등)', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), human('새', B))
    const { digests } = readSessionDigests(new Map([['a', refOf(A)], ['b', refOf(B)]]))
    expect(digests.get('a')?.lastPrompt).toBe('새')
    expect(digests.get('b')?.lastPrompt).toBe('새')
  })
})

describe('C8 비용', () => {
  it('ⓐ 변경 없는 파일의 지문 재확인 읽기 0 바이트 — 옮겨 간 뒤에도', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), human('새', B))
    expect(readSessionDigest(refOf(A)).bytes).toBeGreaterThan(0)
    const before = continuedReadBytes()
    const read = fs.readSync
    const reads = vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof read>) => read(...args))
    const again = readSessionDigest(refOf(A))
    expect(again).toMatchObject({ bytes: 0, statOnly: true })
    expect(continuedReadBytes()).toBe(before)
    expect(reads).not.toHaveBeenCalled()
  })

  it('ⓑ 판별 한 번의 읽기는 상수 이하 · 변경 없는 파일은 추가 0 · 주기 비용에 따로 드러난다', () => {
    fs.writeFileSync(fileOf(A), `${human('큰', A)}${row({ type: 'cost-state', pad: 'x'.repeat(CONTINUED_TAIL_BYTES * 3) })}`)
    const start = continuedReadBytes()
    follow()
    expect(continuedReadBytes() - start).toBe(CONTINUED_TAIL_BYTES)
    const after = continuedReadBytes()
    for (let index = 0; index < 5; index += 1) follow()
    expect(continuedReadBytes()).toBe(after)
    fs.appendFileSync(fileOf(A), reply('자람', A))
    const { cost } = readSessionDigests(new Map([['a', refOf(A)]]))
    expect(cost.continuedBytes).toBeGreaterThan(0)
    expect(cost.continuedBytes).toBeLessThanOrEqual(CONTINUED_TAIL_BYTES)
    expect(cost.bytes).toBeLessThanOrEqual(TAIL_MAX_BYTES + 256 * 1024)
    expect(readSessionDigests(new Map([['a', refOf(A)]])).cost.continuedBytes).toBe(0)
  })

  it('ⓑ 끝이 assistant 인 자라는 파일의 판별은 작은 창 이하만 읽는다', () => {
    expect(CONTINUED_PROBE_BYTES).toBe(8 * 1024)
    fs.writeFileSync(fileOf(A), human('큰', A) + reply('x'.repeat(CONTINUED_TAIL_BYTES * 2), A))
    for (let index = 0; index < 5; index += 1) {
      fs.appendFileSync(fileOf(A), reply(`자람 ${index}`, A))
      const before = continuedReadBytes()
      follow()
      expect(continuedReadBytes() - before).toBeLessThanOrEqual(CONTINUED_PROBE_BYTES)
    }
  })

  it('ⓑ 메타 줄이 작은 창을 넘는 continued-in 도 넓혀서 풀린다 · 총 읽기는 상한 이하, 겹쳐 읽지 않는다', () => {
    fs.writeFileSync(fileOf(B), human('새', B))
    const metas = Array.from({ length: 4 }, () => row({ type: 'cost-state', pad: 'x'.repeat(CONTINUED_PROBE_BYTES) })).join('')
    fs.writeFileSync(fileOf(A), reply('y'.repeat(CONTINUED_TAIL_BYTES * 2), A) + fork(B) + metas)
    const before = continuedReadBytes()
    expect(follow().file).toBe(fileOf(B))
    // 옛 파일 창 전체 + 대상 파일(작아서 통째로) 한 hop + 대상의 대화 찾기(첫 줄에서 끝난다)
    expect(continuedReadBytes() - before).toBe(CONTINUED_TAIL_BYTES + fs.statSync(fileOf(B)).size * 2)
  })

  it('ⓒ 대상 찾기·지문 재확인은 프로젝트 폴더를 훑지 않는다 — 훑기 횟수를 센다', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    const projects = path.join(home, '.claude', 'projects')
    const readdir = vi.spyOn(fs, 'readdirSync')
    const scans = (): number => readdir.mock.calls.filter(([target]) => target === projects).length
    expect(readSessionDigest(refOf(A)).digest.lastPrompt).toBe('옛')
    expect(scans()).toBe(1) // 처음 참조를 찾을 때 한 번
    for (let index = 0; index < 5; index += 1) readSessionDigest(refOf(A))
    fs.writeFileSync(fileOf(B), human('새', B))
    for (let index = 0; index < 5; index += 1) readSessionDigest(refOf(A))
    expect(readSessionDigest(refOf(A)).digest.lastPrompt).toBe('새')
    for (let index = 0; index < 20; index += 1) follow()
    expect(scans()).toBe(1)
  })
})

describe('C13 빈 대상', () => {
  const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, 'fixtures', 'continued-in', name), 'utf8')

  it.each(['empty-2.jsonl', 'empty-5.jsonl'])('ⓐ 메타 줄만 있는 대상(%s) → 보여 주는 쪽은 옛 파일 · 입력 쪽은 대상과 그 id', (name) => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), fixture(name))
    expect(follow()).toEqual({ file: fileOf(A), sessionId: A, hops: [] })
    expect(followEmpty()).toEqual({ file: fileOf(B), sessionId: B, hops: [B] })
    expect(resolveTranscriptUnique(refOf(A))).toEqual({ kind: 'found', file: fileOf(B), continuedAs: B, shown: fileOf(A) })
  })

  it('ⓐ 지문도 대상이 비면 옛 파일 값이고, 대화가 복사되면 다음 주기에 새 파일 값이다', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), fixture('empty-5.jsonl'))
    expect(readSessionDigest(refOf(A)).digest.lastPrompt).toBe('옛')
    fs.appendFileSync(fileOf(B), human('옛', B) + human('새', B))
    expect(readSessionDigest(refOf(A)).digest.lastPrompt).toBe('새')
  })

  it('ⓑ 대화가 복사되면 옮겨 간다 · shown 이 사라진다 — 큰 attachment 가 끝 창을 채워도 앞에서 찾는다', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), fixture('empty-5.jsonl'))
    expect(follow().file).toBe(fileOf(A))
    fs.appendFileSync(fileOf(B), human('옛', B) + row({ type: 'attachment', pad: 'x'.repeat(CONTINUED_TAIL_BYTES * 2) }))
    expect(follow()).toEqual({ file: fileOf(B), sessionId: B, hops: [B] })
    expect(resolveTranscriptUnique(refOf(A))).toEqual({ kind: 'found', file: fileOf(B), continuedAs: B })
  })

  it('ⓑ 쓰는 중인 대화 줄(개행 없음)은 세지 않고, 크기가 그대로면 재읽기 0, 줄이 닫히면 옮겨 간다', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    const line = human('새', B)
    fs.writeFileSync(fileOf(B), fixture('empty-2.jsonl') + line.slice(0, -1))
    expect(follow().file).toBe(fileOf(A))
    // 쓰는 중 줄이 그대로면 다시 읽지 않는다.
    const before = continuedReadBytes()
    follow()
    expect(continuedReadBytes()).toBe(before)
    fs.appendFileSync(fileOf(B), '\n')
    expect(follow().file).toBe(fileOf(B))
  })

  it('ⓑ assistant 만 있어도 대화다', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), fixture('empty-2.jsonl') + reply('답', B))
    expect(follow().file).toBe(fileOf(B))
  })

  it('ⓓ 연쇄 중간이 비었으면 그 앞에 머문다 — 입력 쪽은 끝까지 간다', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), fixture('empty-2.jsonl') + fork(C, B))
    fs.writeFileSync(fileOf(C), human('끝', C))
    expect(follow().file).toBe(fileOf(A))
    expect(followEmpty()).toEqual({ file: fileOf(C), sessionId: C, hops: [B, C] })
    fs.writeFileSync(fileOf(B), human('중간', B) + fork(C, B))
    fs.writeFileSync(fileOf(C), fixture('empty-2.jsonl'))
    expect(follow().file).toBe(fileOf(B))
  })

  it('ⓔ 변경 없는 빈 대상의 재확인은 0 바이트 · 자라면 본 데까지 건너뛴다 · 찾은 뒤에는 자라도 0 바이트', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), fixture('empty-5.jsonl'))
    follow()
    const before = continuedReadBytes()
    for (let index = 0; index < 5; index += 1) follow()
    expect(continuedReadBytes()).toBe(before)
    const meta = row({ type: 'mode', mode: 'normal', sessionId: B })
    fs.appendFileSync(fileOf(B), meta)
    follow()
    expect(continuedReadBytes() - before).toBe(Buffer.byteLength(meta))
    const copied = human('새', B)
    fs.appendFileSync(fileOf(B), copied)
    expect(follow().file).toBe(fileOf(B))
    fs.appendFileSync(fileOf(B), row({ type: 'attachment', pad: 'x'.repeat(CONTINUED_TAIL_BYTES) }))
    const found = continuedReadBytes()
    follow()
    // 대상 끝 판별만 — 대화 찾기는 더 읽지 않는다.
    expect(continuedReadBytes() - found).toBeLessThanOrEqual(CONTINUED_TAIL_BYTES)
    fs.writeFileSync(fileOf(C), '')
    const settled = continuedReadBytes()
    follow()
    expect(continuedReadBytes()).toBe(settled)
  })

  it('ⓔ 찾기 상한을 다 읽어도 없으면 앞 파일에 머물고, 자라도 더 읽지 않는다', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), row({ type: 'attachment', pad: 'x'.repeat(CONTINUED_CONVERSATION_MAX_BYTES + 1024) }))
    const before = continuedReadBytes()
    expect(follow().file).toBe(fileOf(A))
    expect(continuedReadBytes() - before).toBeLessThanOrEqual(CONTINUED_TAIL_BYTES + CONTINUED_CONVERSATION_MAX_BYTES)
    const capped = continuedReadBytes()
    fs.appendFileSync(fileOf(B), human('새', B))
    expect(follow().file).toBe(fileOf(A))
    expect(continuedReadBytes()).toBe(capped)
  })

  it('ⓔ 파일이 바뀌면(줄어듦) 처음부터 다시 찾는다', () => {
    fs.writeFileSync(fileOf(A), human('옛', A) + fork(B))
    fs.writeFileSync(fileOf(B), human('새', B) + reply('답', B))
    expect(follow().file).toBe(fileOf(B))
    fs.writeFileSync(fileOf(B), fixture('empty-2.jsonl').slice(0, 10) + '\n')
    expect(follow().file).toBe(fileOf(A))
  })
})
