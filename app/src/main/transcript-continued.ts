// 세션 이어 가기 판별 (LIFE-766) — 기록 파일의 `continued-in` 을 따라 **지금 자라는 파일과 그 세션 id** 를 고른다. 대화·폰 쓰기·지문이 이 한 곳을 쓴다.
//
// Claude Code 는 세션을 백그라운드로 옮길 때(`--fork-session --resume`) 새 id 의 새 파일로 이어 쓰고 옛 파일에 `continued-in` 한 줄을 남긴다.
// 그 시점에 `SessionStart` 가 돌지 않아 herdr 참조는 옛 id 에 머문다(2.1.296 관측). **참조(`pane.agentSession`)는 고쳐 쓰지 않는다** —
// 채널 키·`sessionMoved`·작업 링크가 그 값에 묶여 있어서, 따라가기는 읽는 쪽에서만 한다.
//
// **파일과 세션 id 는 항상 함께 옮긴다.** 새 파일의 줄은 `sessionId` 가 전부 새 id 라, 옛 id 로 읽으면 사람 발화가 전부 사라진다(`claudeHumanText`).
//
// 유효한 `continued-in`: 파일의 마지막 것이고 → `continuedInSessionId` 가 세션 id 모양이고 → 그 뒤에 `user`·`assistant` 줄이 없고(`--resume <옛 id>` 는 같은
// 파일에 이어 쓴다) → 대상 파일이 있다(약 0.9초 늦게 생긴다). 하나라도 아니면 **옛 파일에 머문다** — `continued-in` 은 공식 형식이 아니라, 못 읽으면 지금처럼 동작하는 쪽이 안전하다.
// 다만 **모름**(`continued-in` 뒤의 읽지 못하는 줄·쓰는 중 줄, 읽기 오류)은 없음과 다르다 — 같은 파일의 직전 판별을 유지한다. 판별을 처음 하는 파일이면 옛 파일에 머문다.
// 읽지 못하는 줄 앞에 완성된 `user`·`assistant` 가 있으면 모름이 아니라 없음이다. 가장 큰 창을 다 읽어도 `continued-in` 이 안 보이면 없음이다.
//
// 비용: 판별은 파일 끝 작은 창(`CONTINUED_PROBE_BYTES`)을 읽고, 결론이 안 나면 `CONTINUED_TAIL_BYTES` 까지만 넓힌다. 파일 정체성·크기·mtime 이 그대로면 다시 읽지 않는다(stat 만). 대상은 **원본과 같은 폴더**에서만 찾는다(관측 5/5) —
// 꼬리 확인 주기마다 프로젝트 폴더 전체를 훑지 않는다.
import fs from 'node:fs'
import path from 'node:path'
import type { AgentSessionRef } from '../shared/types.js'

/** 판별이 읽는 파일 끝 — 뒤따르는 메타 줄 관측 최대 1339 B. 이 창 밖으로 밀려난 `continued-in` 은 없는 것으로 본다(옛 파일). */
export const CONTINUED_TAIL_BYTES = 64 * 1024
/** 먼저 읽는 작은 창 — 끝의 `user`·`assistant` 줄이 이 창 안에 온전히 들어오면 여기서 끝난다. 끝 줄이 창보다 크면 결론이 안 나 `CONTINUED_TAIL_BYTES` 까지 넓힌다. */
export const CONTINUED_PROBE_BYTES = 8 * 1024
/** 연쇄를 따라가는 최대 횟수 — 넘으면 거기서 멈춘다. */
export const CONTINUED_CHAIN_MAX = 8
const MEMO_MAX = 512

/** 대상 id 는 경로에 들어간다 — 이 모양이 아니면 따라가지 않는다(`../` 차단). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 판별 결과 — `target` 대상 있음 · `none` 확실히 없음 · `unknown` 모름(`continued-in` 뒤의 읽지 못하는 줄 등) · `window` 잘린 창의 줄을 다 봐도 결론이 없다. */
export type ContinuedVerdict = { kind: 'target'; id: string } | { kind: 'none' } | { kind: 'unknown' } | { kind: 'window' }

/**
 * 파일 끝 조각의 판별 — 끝에서 거꾸로 본다. 메타 줄과 읽지 못하는 줄(쓰는 중·깨진 완성 줄·`type` 없음)은 지나가되 읽지 못한 줄은 표시만 남긴다.
 * 완성된 `user`·`assistant` 를 먼저 만나면 없음 — 뒤에 읽지 못하는 줄이 있어도 같다. `continued-in` 을 만나면 그 줄이 곧 마지막 것이다:
 * 모양 위반이면 없음, 뒤에 읽지 못한 줄이 있으면 모름(그 줄이 사람 줄일 수 있다), 아니면 대상. 창에 걸린 첫 줄은 없는 것으로 본다.
 * 줄을 다 봐도 결론이 없으면 잘린 창은 `window`, 파일 전체는 읽지 못한 줄이 있었으면 모름·아니면 없음.
 */
export function continuedVerdict(input: { chunk: string; partial: boolean }): ContinuedVerdict {
  const lines = input.chunk.split('\n')
  if (input.partial) lines.shift()
  let unreadable = false
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (line === '') continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      unreadable = true
      continue
    }
    if (typeof record !== 'object' || record === null || !('type' in record)) {
      unreadable = true
      continue
    }
    if (record.type === 'user' || record.type === 'assistant') return { kind: 'none' }
    if (record.type !== 'continued-in') continue
    const target = 'continuedInSessionId' in record ? record.continuedInSessionId : null
    if (typeof target !== 'string' || !SESSION_ID.test(target)) return { kind: 'none' }
    return unreadable ? { kind: 'unknown' } : { kind: 'target', id: target }
  }
  if (input.partial) return { kind: 'window' }
  return unreadable ? { kind: 'unknown' } : { kind: 'none' }
}

type Memo = { dev: number; ino: number; size: number; mtimeMs: number; target: string | null }
const memo = new Map<string, Memo>()
let readBytes = 0

/** 지금까지 판별이 읽은 바이트 — 비용 계정·시험. */
export function continuedReadBytes(): number {
  return readBytes
}

export function clearContinuedMemo(): void {
  memo.clear()
}

function readRange(input: { file: string; from: number; to: number }): Buffer {
  const buffer = Buffer.alloc(input.to - input.from)
  const handle = fs.openSync(input.file, 'r')
  try {
    let read = 0
    while (read < buffer.length) {
      const chunk = fs.readSync(handle, buffer, read, buffer.length - read, input.from + read)
      if (chunk === 0) break
      read += chunk
    }
    readBytes += read
    return buffer.subarray(0, read)
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * 작은 창을 먼저 읽고, 줄을 다 봐도 결론이 없을 때만 앞을 더 읽어 `CONTINUED_TAIL_BYTES` 까지 넓힌다.
 * 가장 큰 창에도 `continued-in` 이 안 보이면 없음이다 — 창 밖의 것은 없는 것으로 본다(옛 파일, 합의된 안전한 실패).
 */
function judgeTail(input: { file: string; size: number }): ContinuedVerdict {
  const near = Math.max(0, input.size - CONTINUED_PROBE_BYTES)
  const tail = readRange({ file: input.file, from: near, to: input.size })
  const verdict = continuedVerdict({ chunk: tail.toString('utf8'), partial: near > 0 })
  if (verdict.kind !== 'window') return verdict
  const far = Math.max(0, input.size - CONTINUED_TAIL_BYTES)
  const wider = Buffer.concat([readRange({ file: input.file, from: far, to: near }), tail])
  const widest = continuedVerdict({ chunk: wider.toString('utf8'), partial: far > 0 })
  return widest.kind === 'window' ? { kind: 'none' } : widest
}

/**
 * 한 파일의 대상 id — 안 바뀐 파일은 stat 만. **모름이면 같은 파일의 직전 판별을 유지한다** — 쓰는 중 줄·읽기 오류 한 번에 옛 파일로 되돌아가 왕복하지 않게.
 * 직전 판별이 없거나 파일이 바뀌었으면(정체성·줄어듦) null(옛 파일에 머문다).
 */
function fileTarget(file: string): string | null {
  const known = memo.get(file)
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return known?.target ?? null
  }
  if (known !== undefined && known.dev === stat.dev && known.ino === stat.ino && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.target
  const prior = known !== undefined && known.dev === stat.dev && known.ino === stat.ino && stat.size >= known.size ? known.target : null
  let verdict: ContinuedVerdict
  try {
    verdict = judgeTail({ file, size: stat.size })
  } catch {
    return prior
  }
  const target = verdict.kind === 'target' ? verdict.id : verdict.kind === 'unknown' ? prior : null
  if (memo.size >= MEMO_MAX) memo.clear()
  memo.set(file, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, target })
  return target
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** 따라간 결과 — `hops` = 옮겨 간 세션 id 들(순서대로, 안 옮겼으면 빈 배열). `sessionId` = 그 파일을 읽을 id(경로 참조는 null — 파일이 곧 세션이다). */
export type FollowedTranscript = { file: string; sessionId: string | null; hops: readonly string[] }

/**
 * 참조가 찾은 파일 → 지금 읽을 파일과 세션 id. 이어 가기는 Claude 의 id 참조에만 있다 — codex·grok·경로 참조는 읽지 않고 그대로 돌려준다.
 * 항상 참조가 찾은 **원본**에서 다시 걷는다 — 옛 세션이 되살아나면(`continued-in` 뒤 새 줄) 원본으로 돌아온다. 순환이면 이미 본 파일 앞에서 멈춘다.
 */
export function followContinued(input: { session: AgentSessionRef; file: string }): FollowedTranscript {
  const { session } = input
  if (session.kind !== 'id') return { file: input.file, sessionId: null, hops: [] }
  if (session.agent !== 'claude') return { file: input.file, sessionId: session.id, hops: [] }
  const seen = new Set([input.file])
  const hops: string[] = []
  let file = input.file
  let sessionId = session.id
  while (hops.length < CONTINUED_CHAIN_MAX) {
    const target = fileTarget(file)
    if (target === null) break
    const next = path.join(path.dirname(file), `${target}.jsonl`)
    if (seen.has(next) || !isFile(next)) break
    seen.add(next)
    hops.push(target)
    file = next
    sessionId = target
  }
  return { file, sessionId, hops }
}
