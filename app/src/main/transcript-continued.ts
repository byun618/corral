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
//
// 비용: 판별은 파일 끝 `CONTINUED_TAIL_BYTES` 만 읽고 파일 정체성·크기·mtime 이 그대로면 다시 읽지 않는다(stat 만). 대상은 **원본과 같은 폴더**에서만 찾는다(관측 5/5) —
// 꼬리 확인 주기마다 프로젝트 폴더 전체를 훑지 않는다.
import fs from 'node:fs'
import path from 'node:path'
import type { AgentSessionRef } from '../shared/types.js'

/** 판별이 읽는 파일 끝 — 뒤따르는 메타 줄 관측 최대 1339 B. 이 창 밖으로 밀려난 `continued-in` 은 없는 것으로 본다(옛 파일). */
export const CONTINUED_TAIL_BYTES = 64 * 1024
/** 연쇄를 따라가는 최대 횟수 — 넘으면 거기서 멈춘다. */
export const CONTINUED_CHAIN_MAX = 8
const MEMO_MAX = 512

/** 대상 id 는 경로에 들어간다 — 이 모양이 아니면 따라가지 않는다(`../` 차단). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * 파일 끝 조각에서 유효한 대상 id — 끝에서 거꾸로 본다. 메타 줄은 지나가고, `user`·`assistant` 나 읽지 못하는 줄(쓰는 중 포함)을 먼저 만나면 null.
 * 처음 만난 `continued-in` 이 곧 마지막 것이다 — 그 줄이 틀렸으면 앞의 것으로 내려가지 않는다.
 */
export function continuedTarget(input: { chunk: string; partial: boolean }): string | null {
  const lines = input.chunk.split('\n')
  if (input.partial) lines.shift()
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (line === '') continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return null
    }
    if (typeof record !== 'object' || record === null || !('type' in record)) return null
    if (record.type === 'user' || record.type === 'assistant') return null
    if (record.type !== 'continued-in') continue
    const target = 'continuedInSessionId' in record ? record.continuedInSessionId : null
    return typeof target === 'string' && SESSION_ID.test(target) ? target : null
  }
  return null
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

function readTail(input: { file: string; size: number }): { chunk: string; partial: boolean } {
  const from = Math.max(0, input.size - CONTINUED_TAIL_BYTES)
  const buffer = Buffer.alloc(input.size - from)
  const handle = fs.openSync(input.file, 'r')
  try {
    let read = 0
    while (read < buffer.length) {
      const chunk = fs.readSync(handle, buffer, read, buffer.length - read, from + read)
      if (chunk === 0) break
      read += chunk
    }
    readBytes += read
    return { chunk: buffer.subarray(0, read).toString('utf8'), partial: from > 0 }
  } finally {
    fs.closeSync(handle)
  }
}

/** 한 파일의 대상 id — 안 바뀐 파일은 stat 만. 못 읽으면 null(옛 파일에 머문다). */
function fileTarget(file: string): string | null {
  try {
    const stat = fs.statSync(file)
    const known = memo.get(file)
    if (known !== undefined && known.dev === stat.dev && known.ino === stat.ino && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.target
    const target = continuedTarget(readTail({ file, size: stat.size }))
    if (memo.size >= MEMO_MAX) memo.clear()
    memo.set(file, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, target })
    return target
  } catch {
    return null
  }
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
