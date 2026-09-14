// 세션 트랜스크립트 판독 (LIFE-366) — **herdr 를 모르는 층이다.**
//
// `git-status.ts` 와 같은 자리다: 어댑터가 corral 타입(`AgentSessionRef`)까지 옮겨 놓으면,
// 이 파일은 그 corral 타입만 받아 디스크를 읽고 corral 타입(`SessionDigest`)을 돌려준다.
// herdr 소켓도, 와이어 필드도, 어댑터도 import 하지 않는다 (기준 E1).
//
// # 왜 corral 이 파일을 직접 찾나 — herdr 가 주는 건 **id 뿐**이다
//
// 분석(§2.1)은 herdr 가 "세션 id 또는 트랜스크립트 경로" 를 준다고 봤다. 실측은 달랐다:
// 통합 3종을 다 태워 보니 **전부 `kind:'id'`** 였고, 경로만 보고하면 참조가 아예 안 생긴다
// (`raw/claude/a3-agent-session-probe.json` · `raw/claude/ref-semantics.json`).
// 그래서 id → 파일 해소가 이 층의 일이 된다. 규칙은 셋 다 실측으로 확정했다
// (`raw/claude/a10-foreign-shapes.json` · `raw/claude/a3b-real-agent.json`):
//
//   claude : <HOME>/.claude/projects/<프로젝트 폴더>/<session-id>.jsonl
//   codex  : <HOME>/.codex/sessions/YYYY/MM/DD/rollout-<시각>-<session-id>.jsonl
//   grok   : <HOME>/.grok/sessions/<urlencoded cwd>/<session-id>/chat_history.jsonl
//
// 셋 다 "폴더 이름을 cwd 에서 유도" 하는 길이 있지만 **그 길을 쓰지 않는다.** 슬러그 규칙은
// 문서화된 계약이 아니고(claude 는 `/`→`-`, grok 은 퍼센트 인코딩으로 서로 다르다), corral 의
// cwd 와 에이전트의 cwd 가 같다는 보장도 없다. 대신 **id 로 훑어 찾고 그 결과를 캐시**한다 —
// 한 번 찾으면 그 세션이 끝날 때까지 다시 안 훑는다.
//
// # 비용 — 파일 크기에 비례하지 않는다 (기준 A6)
//
// 사용자 트랜스크립트는 중앙값 1.2MB, 최대 29.4MB 다. herdr-studio 의 참고 구현은 전문을
// 읽는데(`session-utils.ts:readJsonl`) 그건 못 베낀다. 두 겹으로 막는다:
//   ① **mtime·size 캐시** — 파일이 안 변했으면 `stat` 한 번으로 끝난다 (읽기 0바이트)
//   ② **꼬리 창** — 바뀌었으면 마지막 256KB 만 읽는다. 거기서 어시스턴트 텍스트를 못 찾으면
//      그 앞 구간을 한 번 더 읽어 **총 2MB 까지**. 두 창은 겹치지 않으므로 같은 바이트를
//      두 번 읽지 않는다. 2MB 안에도 없으면 `unknown-format` 으로 돌아온다 — 창을 무한정
//      늘려 A6 을 깨느니 **모른다고 말하는 쪽**이다 (기준 A8 과 같은 결).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentSessionRef, SessionDigest, TranscriptAgent } from '../shared/types.js'
import { log } from './log.js'
import { parseTail } from './transcript-parse.js'

/** 첫 꼬리 창. 실측 평균 한 턴이 ~46KB 라 대략 5턴을 덮는다. */
export const TAIL_WINDOW_BYTES = 256 * 1024
/** 확장 상한 — 첫 창을 포함해 갱신 1회에 읽는 **총** 바이트. A6 통과선이 2MB 다. */
export const TAIL_MAX_BYTES = 2 * 1024 * 1024

/** 아무것도 못 읽은 지문. */
const EMPTY: SessionDigest = { activity: { state: 'none' }, providerTitle: null, lastActivityAt: null }

type CacheEntry = {
  /** 해소된 파일 경로. 못 찾았으면 null (다음 갱신에 다시 훑는다). */
  file: string | null
  size: number
  mtimeMs: number
  digest: SessionDigest
}

const cache = new Map<string, CacheEntry>()

/** 이번 갱신 주기에 실제로 읽은 바이트·파일 수 — A6·A7 계측이 이 값을 로그로 가져간다. */
export type ReadCost = { files: number; statOnly: number; bytes: number; ms: number }

export function clearTranscriptCacheForTest(): void {
  cache.clear()
}

/** 참조 하나의 캐시 키. pane 이 달라도 같은 세션이면 같은 파일이라 id 로 잡는다. */
function cacheKey(ref: AgentSessionRef): string {
  return ref.kind === 'id' ? `${ref.agent}:id:${ref.id}` : `${ref.agent}:path:${ref.path}`
}

/** corral 이 읽을 줄 아는 에이전트인가. 모르는 이름은 읽지 않는다 (지어내지 않는다). */
function transcriptAgent(name: string): TranscriptAgent | null {
  if (name === 'claude' || name === 'codex' || name === 'grok') return name
  return null
}

// --- id → 파일 찾기 -----------------------------------------------------------

function homeDir(): string {
  return os.homedir()
}

/** `<HOME>/.claude/projects/<폴더>/<id>.jsonl` — 폴더 이름은 안 지어내고 훑어 찾는다. */
function findClaudeFile(id: string): string | null {
  const projects = path.join(homeDir(), '.claude', 'projects')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(projects, entry.name, `${id}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** `<HOME>/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` — 날짜 3단만 내려간다. */
function findCodexFile(id: string): string | null {
  const root = path.join(homeDir(), '.codex', 'sessions')
  const suffix = `-${id}.jsonl`
  const dirs = (dir: string): string[] => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name))
    } catch {
      return []
    }
  }
  for (const year of dirs(root)) {
    for (const month of dirs(year)) {
      for (const day of dirs(month)) {
        let files: string[]
        try {
          files = fs.readdirSync(day)
        } catch {
          continue
        }
        for (const file of files) if (file.endsWith(suffix)) return path.join(day, file)
      }
    }
  }
  return null
}

/** `<HOME>/.grok/sessions/<urlencoded cwd>/<id>/chat_history.jsonl`. */
function findGrokFile(id: string): string | null {
  const root = path.join(homeDir(), '.grok', 'sessions')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(root, entry.name, id, 'chat_history.jsonl')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** 참조를 파일 경로로 옮긴다. 못 찾으면 null. */
export function resolveTranscriptFile(ref: AgentSessionRef): string | null {
  const agent = transcriptAgent(ref.agent)
  if (agent === null) return null
  if (ref.kind === 'path') return fs.existsSync(ref.path) ? ref.path : null
  switch (agent) {
    case 'claude':
      return findClaudeFile(ref.id)
    case 'codex':
      return findCodexFile(ref.id)
    case 'grok':
      return findGrokFile(ref.id)
  }
}

// --- 꼬리 읽기 ----------------------------------------------------------------

/**
 * `[from, size)` 구간을 읽어 문자열로 준다. `from > 0` 이면 첫 줄이 잘려 있다(`partial`).
 *
 * 조각 경계에서 멀티바이트 문자가 갈릴 수 있는데, 그 줄은 어차피 `partial` 로 버리거나
 * JSON 파싱이 실패해 건너뛴다 — 여기서 따로 다루지 않는다.
 */
function readRange(file: string, from: number, to: number): string {
  const handle = fs.openSync(file, 'r')
  try {
    const length = Math.max(0, to - from)
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const chunk = fs.readSync(handle, buffer, read, length - read, from + read)
      if (chunk === 0) break
      read += chunk
    }
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    fs.closeSync(handle)
  }
}

/** 한 파일을 읽어 지문을 만든다. 읽은 바이트를 같이 돌려준다 (A6 계측). */
function readDigest(input: {
  file: string
  size: number
  mtimeMs: number
  agent: TranscriptAgent
  sessionId: string | null
}): { digest: SessionDigest; bytes: number } {
  const firstFrom = Math.max(0, input.size - TAIL_WINDOW_BYTES)
  let chunk = readRange(input.file, firstFrom, input.size)
  let bytes = input.size - firstFrom
  let from = firstFrom
  let parsed = parseTail({ agent: input.agent, chunk, partial: from > 0, sessionId: input.sessionId })

  // 첫 창에서 어시스턴트 텍스트를 못 찾았고 아직 앞에 남은 게 있으면 **한 번만** 더 넓힌다.
  if (parsed.activity.state !== 'text' && from > 0) {
    const secondFrom = Math.max(0, input.size - TAIL_MAX_BYTES)
    if (secondFrom < from) {
      chunk = readRange(input.file, secondFrom, from) + chunk // 두 구간은 붙어 있다 — 겹치지 않는다
      bytes += from - secondFrom
      from = secondFrom
      parsed = parseTail({ agent: input.agent, chunk, partial: from > 0, sessionId: input.sessionId })
    }
  }

  return {
    digest: {
      activity: parsed.activity,
      providerTitle: parsed.providerTitle,
      // 레코드에 시각이 없는 포맷(grok)은 파일 mtime 으로 떨어진다 — **실재하는 시각**이다
      // (기준 D1: 렌더러가 처음 본 시각을 쓰면 미달).
      lastActivityAt: parsed.lastActivityAt ?? input.mtimeMs,
    },
    bytes,
  }
}

/**
 * 참조 하나의 지문. 파일이 안 변했으면 `stat` 한 번으로 캐시를 돌려준다.
 *
 * **던지지 않는다.** 한 세션의 판독 실패가 목록 전체를 무너뜨리면 안 되므로 모든 실패는
 * `activity` 의 갈래로 내려앉는다 (기준 A8).
 */
export function readSessionDigest(ref: AgentSessionRef | null): { digest: SessionDigest; bytes: number; statOnly: boolean } {
  if (ref === null) return { digest: EMPTY, bytes: 0, statOnly: false }
  const agent = transcriptAgent(ref.agent)
  if (agent === null) return { digest: EMPTY, bytes: 0, statOnly: false }

  const key = cacheKey(ref)
  const cached = cache.get(key) ?? null
  const file = cached?.file ?? resolveTranscriptFile(ref)
  if (file === null) {
    // 못 찾았다는 사실은 캐시하지 않는다 — 세션이 방금 떠서 파일이 아직 없을 수 있다.
    return { digest: { ...EMPTY, activity: { state: 'unresolved' } }, bytes: 0, statOnly: false }
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch (error) {
    cache.delete(key)
    return {
      digest: { ...EMPTY, activity: { state: 'unreadable', reason: String(error) } },
      bytes: 0,
      statOnly: false,
    }
  }

  if (cached !== null && cached.file === file && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return { digest: cached.digest, bytes: 0, statOnly: true }
  }

  try {
    const read = readDigest({
      file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      agent,
      sessionId: ref.kind === 'id' ? ref.id : null,
    })
    cache.set(key, { file, size: stat.size, mtimeMs: stat.mtimeMs, digest: read.digest })
    return { digest: read.digest, bytes: read.bytes, statOnly: false }
  } catch (error) {
    return {
      digest: { ...EMPTY, activity: { state: 'unreadable', reason: String(error) } },
      bytes: 0,
      statOnly: false,
    }
  }
}

/**
 * 참조 여러 개를 한 주기에 읽는다 — 화면 갱신이 부르는 입구다.
 * 비용을 한 줄 로그로 남긴다 (A7 이 그 로그를 근거로 삼는다).
 */
export function readSessionDigests(refs: ReadonlyMap<string, AgentSessionRef | null>): {
  digests: Map<string, SessionDigest>
  cost: ReadCost
} {
  const startedAt = Date.now()
  const digests = new Map<string, SessionDigest>()
  let files = 0
  let statOnly = 0
  let bytes = 0
  for (const [id, ref] of refs) {
    const read = readSessionDigest(ref)
    digests.set(id, read.digest)
    if (ref === null) continue
    files += 1
    if (read.statOnly) statOnly += 1
    bytes += read.bytes
  }
  const cost = { files, statOnly, bytes, ms: Date.now() - startedAt }
  if (files > 0) log('transcript.read', cost)
  return { digests, cost }
}
