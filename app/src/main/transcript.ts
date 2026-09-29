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
// 사용자 트랜스크립트는 중앙값 0.83MB, **최대 100.03MB** 다 (348개 실측, `raw/claude/a5-a6-cost.json`
// — 분석이 잡은 29.4MB 보다 3배 크다). herdr-studio 의 참고 구현은 전문을
// 읽는데(`session-utils.ts:readJsonl`) 그건 못 베낀다. 두 겹으로 막는다:
//   ① **mtime·size 캐시** — 파일이 안 변했으면 `stat` 한 번으로 끝난다 (읽기 0바이트)
//   ② **꼬리 창** — 바뀌었으면 마지막 256KB 만 읽는다. 거기서 어시스턴트 텍스트를 못 찾으면
//      그 앞 구간을 한 번 더 읽어 **총 2MB 까지**. 두 창은 겹치지 않으므로 같은 바이트를
//      두 번 읽지 않는다. 2MB 안에도 없으면 `unknown-format` 으로 돌아온다 — 창을 무한정
//      늘려 A6 을 깨느니 **모른다고 말하는 쪽**이다 (기준 A8 과 같은 결).
//
// 두 겹 다 실측했다. ①은 `raw/claude/a5-a6-cost.json` (두 번째 호출 0바이트), ②의 **확장 가지와
// 2MB 상한**은 `raw/claude/a6-window.json` — 사용자 파일 넷은 전부 첫 창 안에서 끝나서 확장이
// 한 번도 안 돌았기에, 격리 HOME 에 합성 파일 셋(첫 창 안 · 첫 창 밖 2MB 안 · 2MB 밖)을 깔고
// 따로 쟀다.
//
// # 읽는 방향이 **둘**이 됐다 (수정 라운드 5, C5·C6)
//
// 위의 모든 것은 꼬리다. 제목의 「첫 사용자 발화」 티어는 파일 **맨 앞**에 있어서 꼬리로는 영영
// 못 닿는다. 그래서 머리 창(256KB)을 하나 더 열되, 세 가지로 묶어 A6 을 지킨다:
//   · **끝나는 재판독** (`headDone`, 수정 라운드 6·C6′) — 찾았거나 창을 꽉 채워 읽었으면 그만
//     읽는다. r5 의 「파일당 1회」는 **못 찾은 것까지 영구히** 닫아서, 갓 뜬 세션(메타 한 줄)을
//     먼저 읽으면 사용자가 첫 말을 친 뒤에도 제목이 영영 안 살았다 (codex R1)
//   · 아직 안 끝난 파일은 **창보다 작다** — 꼬리 조각이 이미 0바이트부터라 재판독이 **0바이트**다
//   · 그래서 머리를 읽은 주기만 ≤2.25MB·≤50ms(C6′-③)이고, 나머지 주기는 기존 A6(≤2MB)이다

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentSessionRef, SessionDigest, SessionQuestion, TranscriptAgent, TurnOutcome } from '../shared/types.js'
import { EMPTY_SESSION_DIGEST } from '../shared/types.js'
import { log } from './log.js'
import { parseGrokUpdates, parseHead, parseTail } from './transcript-parse.js'

/** 첫 꼬리 창. 실측 평균 한 턴이 ~46KB 라 대략 5턴을 덮는다. */
export const TAIL_WINDOW_BYTES = 256 * 1024
/** 확장 상한 — 첫 창을 포함해 갱신 1회에 읽는 **총** 바이트. A6 통과선이 2MB 다. */
export const TAIL_MAX_BYTES = 2 * 1024 * 1024
/**
 * **머리 창** — 세션의 첫 사용자 발화를 찾는 앞쪽 조각 (C6, 수정 라운드 5).
 *
 * 꼬리 창과 같은 256KB 다. 실측이 그 크기를 고른 게 아니라 **확인**했다: 사용자 트랜스크립트
 * 367개에서 첫 발화의 바이트 오프셋이 p50 3.5KB · p95 6.6KB · 최대 202KB 로 전부 이 창 안이다
 * (`raw/claude/c5-b9-shapes-r6.json`). 다만 **레코드 한 줄의 끝**이 창을 넘는 파일이 9개 있고,
 * 그건 부재로 둔다 — 창을 키워 미리 박은 예산을 깨느니 모른다고 말하는 쪽이다. 기준 **C5′** 가
 * 그 칸을 명문화했다: 부재가 허용되는 경우는 **줄 끝이 창을 넘을 때뿐**이고 그 외 부재는 미달이다.
 */
export const HEAD_WINDOW_BYTES = 256 * 1024

/**
 * **형제 파일 창** — grok 의 턴 결과·질문은 `chat_history.jsonl` 이 아니라 같은 폴더의
 * `updates.jsonl` 에 있다(LIFE-458, 00-analysis P3). 그 파일은 p50 0.6MB · 최대 6.8MB 라
 * (`raw/claude/u1-grok-sequences.txt`) 꼬리 256KB 만 읽고 확장하지 않는다 — 기준 T7 이 박은
 * 「파일당 ≤256KB 꼬리 창 + mtime·size 캐시」다. 창 안에 턴 끝 표지가 없으면 null 이다.
 */
export const SIDECAR_WINDOW_BYTES = 256 * 1024

/** 아무것도 못 읽은 지문. */
const EMPTY: SessionDigest = EMPTY_SESSION_DIGEST

/** 형제 파일(grok `updates.jsonl`)에서 읽은 것과 그때의 stat. */
type SidecarEntry = {
  size: number
  mtimeMs: number
  turnOutcome: TurnOutcome | null
  pendingQuestions: SessionQuestion[] | null
}

type CacheEntry = {
  /** 해소된 파일 경로. 못 찾았으면 null (다음 갱신에 다시 훑는다). */
  file: string | null
  size: number
  mtimeMs: number
  digest: SessionDigest
  /**
   * 이 파일에서 **provider 제목을 상한(2MB)까지 한 번 훑어봤나** (수정 라운드 1, V2).
   * 한 번 훑었으면 다시 안 훑는다 — 이 깃발이 없으면 제목 없는 긴 파일이 갱신될 때마다
   * 2MB 를 다시 읽어 A7 주기 비용을 망가뜨린다.
   */
  titleScanned: boolean
  /**
   * 이 파일의 **머리 판독이 끝났나** (수정 라운드 6, C6′-④).
   *
   * 두 경우에만 선다. ① 첫 발화를 **찾았다** ② 머리 창을 **꽉 채워** 읽었다(파일이 창보다
   * 크다). JSONL 은 append-only 라 그 뒤로 앞쪽 256KB 는 안 바뀌므로, 두 경우 다 다시 읽어야
   * 같은 답이 나온다.
   *
   * r5 는 여기서 **못 찾은 것까지** 닫았다(`headScanned`). 그래서 갓 뜬 세션 — 트랜스크립트에
   * 메타 한 줄뿐인 순간에 통합 참조가 먼저 관측되면 — 사용자가 첫 말을 친 뒤에도 제목이 영영
   * 안 살아났다(codex R1, 사용자가 원래 신고한 「제목이 안 바뀐다」와 같은 장면).
   *
   * 안 끝난 파일은 **창보다 작다**. 그 크기면 꼬리 조각이 이미 파일 전체라 재판독이 추가
   * **0바이트**다 — 재판독을 열어도 C6′-② (주기당 ≤256KB)가 안 깨지는 이유다.
   */
  headDone: boolean
  /** grok 형제 파일 판독 결과. grok 이 아니거나 그 파일이 없으면 null (LIFE-458). */
  sidecar: SidecarEntry | null
}

const cache = new Map<string, CacheEntry>()

/**
 * **못 찾은 참조의 재탐색 간격** — 처음 30초는 매 주기 훑고, 그 뒤로는 15초에 한 번만 훑는다.
 *
 * 못 찾는 경우는 두 가지인데 비용이 정반대다. ① *방금 뜬 세션* — 파일이 곧 생기므로 빨리 다시
 * 훑어야 2차 줄이 제때 붙는다. ② *영영 안 생기는 참조* (`/clear` 뒤 낡은 id, 지워진 파일) —
 * 이건 폴링 주기(1.5초)마다 codex 날짜 3단을 영원히 훑게 된다. 두 경우를 나이로 가른다.
 */
export const RESOLVE_EAGER_MS = 30_000
export const RESOLVE_RETRY_MS = 15_000

/** 참조 키 → { 처음 못 찾은 시각, 마지막으로 훑어본 시각 }. */
const misses = new Map<string, { firstAt: number; lastTryAt: number }>()

/** 지금 다시 훑어야 하나. */
function shouldResolveNow(key: string, now: number): boolean {
  const miss = misses.get(key) ?? null
  if (miss === null) return true
  if (now - miss.firstAt < RESOLVE_EAGER_MS) return true
  return now - miss.lastTryAt >= RESOLVE_RETRY_MS
}

/**
 * 이번 갱신 주기에 실제로 읽은 바이트·파일 수 — A6·A7 계측이 이 값을 로그로 가져간다.
 * `headBytes` 는 그중 **머리 창** 몫이다 (수정 라운드 6·C6′-③): 통과선이 「머리를 읽은
 * 주기 ≤2.25MB · 나머지 주기 ≤2MB」로 갈려서, 주기를 **어느 쪽으로 세는지**가 값에 달렸다.
 * `statOnly` 는 **읽기 0바이트로 끝난 참조** 수다: 파일이 안 바뀌어 `stat` 한 번으로 끝났거나,
 * 못 찾은 참조라 이번 주기엔 훑기조차 건너뛴 경우.
 */
export type ReadCost = {
  files: number
  statOnly: number
  bytes: number
  headBytes: number
  /** 그중 grok 형제 파일(`updates.jsonl`) 몫 — 파일당 ≤256KB 인지 따로 본다 (LIFE-458 T7). */
  sidecarBytes: number
  ms: number
}

/**
 * 판독 캐시를 통째로 비운다 — **세션을 갈아탈 때** main 이 부른다 (수정 라운드 1, V10).
 *
 * 캐시 키는 `<agent>:id:<세션 id>` 라 세션이 달라도 충돌하지는 않는다. 다만 안 비우면 닫힌 탭·
 * 떠난 세션의 항목이 프로세스 수명 내내 남는다 — 지문 문자열이 p99 2.4KB 라 터질 크기는
 * 아니지만, 세션 전환이 "그 세션의 것만 본다" 는 약속(`index.ts` 의 `digests = new Map()`)과
 * 어긋난 채로 남는 것이 문제다. 테스트·실측 하네스도 같은 문을 쓴다.
 */
export function clearTranscriptCache(): void {
  cache.clear()
  misses.clear()
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

/**
 * 한 파일을 읽어 지문을 만든다. 읽은 바이트를 같이 돌려준다 (A6 계측).
 *
 * # 창을 넓히는 이유가 **둘**이다 (수정 라운드 1, V2)
 *
 * 처음엔 하나였다 — 첫 창(256KB)에 어시스턴트 텍스트가 없을 때. 리뷰(codex)가 두 번째를 찾았다:
 * **`ai-title` 이 첫 창 밖이고 어시스턴트 텍스트는 안에 있는** 파일에서는 확장이 안 돌아
 * `providerTitle` 이 조용히 null 이 되고, 제목이 provider 티어를 건너뛰어 폴백으로 떨어진다
 * (기준 C1 이 요구하는 티어가 긴 세션에서만 사라지는 모양이다).
 *
 * 그래서 **제목이 아직 없으면 한 번은 상한까지 훑는다.** 세 가지로 묶어 둔다.
 *   · `agent === 'claude'` 일 때만 — `ai-title` 은 claude 포맷의 레코드다. codex·grok 판독은
 *     provider 제목을 아예 안 주므로(`transcript-parse.ts`) 안 막으면 매번 2MB 를 다시 읽는다
 *   · **파일당 한 번** (`titleScanned`) — 없는 제목을 갱신마다 다시 찾지 않는다
 *   · 예산은 **같은 2MB** — 두 창은 여전히 안 겹치므로 갱신 1회의 총 읽기는 그대로 ≤2MB 다 (A6)
 */
function readDigest(input: {
  file: string
  size: number
  mtimeMs: number
  agent: TranscriptAgent
  sessionId: string | null
  titleScanned: boolean
  headDone: boolean
}): {
  digest: SessionDigest
  bytes: number
  headBytes: number
  titleScanned: boolean
  headDone: boolean
  firstPrompt: string | null
} {
  const firstFrom = Math.max(0, input.size - TAIL_WINDOW_BYTES)
  let chunk = readRange(input.file, firstFrom, input.size)
  let bytes = input.size - firstFrom
  let from = firstFrom
  let parsed = parseTail({ agent: input.agent, chunk, partial: from > 0, sessionId: input.sessionId })
  let titleScanned = input.titleScanned

  const needsText = parsed.activity.state !== 'text'
  const needsTitle = input.agent === 'claude' && parsed.providerTitle === null && !titleScanned
  // 첫 창에서 못 찾은 게 있고 아직 앞에 남은 게 있으면 **한 번만** 더 넓힌다.
  if ((needsText || needsTitle) && from > 0) {
    const secondFrom = Math.max(0, input.size - TAIL_MAX_BYTES)
    if (secondFrom < from) {
      chunk = readRange(input.file, secondFrom, from) + chunk // 두 구간은 붙어 있다 — 겹치지 않는다
      bytes += from - secondFrom
      from = secondFrom
      parsed = parseTail({ agent: input.agent, chunk, partial: from > 0, sessionId: input.sessionId })
    }
    // 상한까지 봤다 — 여기서 제목이 없으면 이 파일엔 (창 안에) 없는 것이다. 다시 안 훑는다.
    titleScanned = true
  }
  // 파일을 통째로 읽었거나 제목을 찾았으면 더 훑을 이유가 없다.
  if (from === 0 || parsed.providerTitle !== null) titleScanned = true

  // --- 머리 한 번 (C6) --------------------------------------------------------
  //
  // 첫 발화는 파일 **맨 앞**이라 꼬리로는 못 닿는다. 다만 이미 읽은 조각이 0바이트부터
  // 시작하면(작은 파일·확장이 끝까지 간 경우) 그 조각에 머리가 들어 있다 — 그때는
  // **한 바이트도 더 안 읽는다.** 그 외에는 앞에서 `HEAD_WINDOW_BYTES` 만큼 따로 읽는다.
  let firstPrompt: string | null = null
  let headBytes = 0
  let headDone = input.headDone
  if (!headDone) {
    // 꼬리 조각을 **그대로 쓰는 건 파일이 창 안에 다 들어올 때뿐**이다. 확장이 0바이트까지 간
    // 큰 파일에서 그 조각을 쓰면 창 **밖**의 레코드까지 읽어, 같은 파일을 두고 판독층과 C5′
    // 오라클의 답이 갈린다(줄 끝이 창을 넘는 9개가 그 자리다). 그래서 그때는 창을 따로 읽는다.
    const reuse = from === 0 && input.size <= HEAD_WINDOW_BYTES
    const headChunk = reuse ? chunk : readRange(input.file, 0, Math.min(HEAD_WINDOW_BYTES, input.size))
    if (!reuse) {
      headBytes = Math.min(HEAD_WINDOW_BYTES, input.size)
      bytes += headBytes
    }
    firstPrompt = parseHead({ agent: input.agent, chunk: headChunk, sessionId: input.sessionId })
    // **끝나는 조건은 둘뿐이다** (C6′-④): 찾았거나, 창을 꽉 채워 읽었거나. 파일이 창보다 작고
    // 아직 못 찾았으면 **안 닫는다** — 사용자가 이제 첫 말을 칠 수도 있다.
    headDone = firstPrompt !== null || input.size >= HEAD_WINDOW_BYTES
  }

  return {
    titleScanned,
    headDone,
    firstPrompt,
    headBytes,
    digest: {
      activity: parsed.activity,
      providerTitle: parsed.providerTitle,
      firstPrompt,
      tool: parsed.tool,
      // 레코드에 시각이 없는 포맷(grok)은 파일 mtime 으로 떨어진다 — **실재하는 시각**이다
      // (기준 D1: 렌더러가 처음 본 시각을 쓰면 미달).
      lastActivityAt: parsed.lastActivityAt ?? input.mtimeMs,
      turnOutcome: parsed.turnOutcome,
      model: parsed.model,
      lastPrompt: parsed.lastPrompt,
      pendingQuestions: parsed.pendingQuestions,
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
export function readSessionDigest(ref: AgentSessionRef | null): {
  digest: SessionDigest
  bytes: number
  headBytes: number
  sidecarBytes: number
  statOnly: boolean
} {
  if (ref === null) return { digest: EMPTY, bytes: 0, headBytes: 0, sidecarBytes: 0, statOnly: false }
  const agent = transcriptAgent(ref.agent)
  if (agent === null) return { digest: EMPTY, bytes: 0, headBytes: 0, sidecarBytes: 0, statOnly: false }

  const key = cacheKey(ref)
  const cached = cache.get(key) ?? null
  const unresolved: { digest: SessionDigest; bytes: number; headBytes: number; sidecarBytes: number } = {
    digest: { ...EMPTY, activity: { state: 'unresolved' } },
    bytes: 0,
    headBytes: 0,
    sidecarBytes: 0,
  }
  let file = cached?.file ?? null
  if (file === null) {
    const now = Date.now()
    // 훑기를 건너뛰는 주기 — 디스크를 아예 안 만진다. `statOnly` 로 세어 A7 표에 드러낸다.
    if (!shouldResolveNow(key, now)) return { ...unresolved, statOnly: true }
    file = resolveTranscriptFile(ref)
    if (file === null) {
      const miss = misses.get(key) ?? null
      misses.set(key, { firstAt: miss?.firstAt ?? now, lastTryAt: now })
      return { ...unresolved, statOnly: false }
    }
    misses.delete(key)
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch (error) {
    // **판독 실패를 로그로 남긴다** (수정 라운드 1, V3). 화면은 `unreadable` 로 정직하게
    // 내려앉지만, 그 사실이 아무 데도 안 남으면 하네스의 「예외 없음」 다리가 관측이 아니라
    // 무관측이 된다 — 리뷰가 그 자리를 짚었다.
    log('transcript.error', { where: 'stat', agent, error: String(error) })
    cache.delete(key)
    return {
      digest: { ...EMPTY, activity: { state: 'unreadable', reason: String(error) } },
      bytes: 0,
      headBytes: 0,
      sidecarBytes: 0,
      statOnly: false,
    }
  }

  // grok 은 **파일이 둘**이다 (LIFE-458). 턴이 중단되면 `updates.jsonl` 만 자라고 `chat_history` 는
  // 그대로일 수 있어서, 두 파일을 따로 stat 하고 **바뀐 쪽만** 읽는다 — 무변경 파일은 읽기 0바이트(T7).
  const sidecarFile = agent === 'grok' ? path.join(path.dirname(file), 'updates.jsonl') : null
  const sidecarStat = sidecarFile === null ? null : statOrNull(sidecarFile)
  const mainFresh = cached !== null && cached.file === file && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs
  const sidecarFresh = sameStat(cached?.sidecar ?? null, sidecarStat)
  if (cached !== null && mainFresh && sidecarFresh) {
    return { digest: cached.digest, bytes: 0, headBytes: 0, sidecarBytes: 0, statOnly: true }
  }

  try {
    const main = cached !== null && mainFresh ? reuseMain(cached) : readMain({ file, stat, agent, ref, cached })
    let sidecar = cached?.sidecar ?? null
    let sidecarBytes = 0
    if (sidecarFile !== null && !sidecarFresh) {
      const read = sidecarStat === null ? null : readSidecar({ file: sidecarFile, stat: sidecarStat })
      sidecar = read?.entry ?? null
      sidecarBytes = read?.bytes ?? 0
    }
    // grok 이 아니면 턴 결과·질문은 본 파일 판독이 이미 채웠다. grok 이면 형제 파일 값으로 덮는다.
    const digest: SessionDigest =
      sidecarFile === null
        ? main.digest
        : { ...main.digest, turnOutcome: sidecar?.turnOutcome ?? null, pendingQuestions: sidecar?.pendingQuestions ?? null }
    cache.set(key, {
      file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      digest,
      titleScanned: main.titleScanned,
      headDone: main.headDone,
      sidecar,
    })
    return {
      digest,
      bytes: main.bytes + sidecarBytes,
      headBytes: main.headBytes,
      sidecarBytes,
      statOnly: false,
    }
  } catch (error) {
    log('transcript.error', { where: 'read', agent, error: String(error) })
    return {
      digest: { ...EMPTY, activity: { state: 'unreadable', reason: String(error) } },
      bytes: 0,
      headBytes: 0,
      sidecarBytes: 0,
      statOnly: false,
    }
  }
}

/** stat, 없거나 못 읽으면 null — 형제 파일은 없을 수 있다(없으면 그 칸이 null 일 뿐이다). */
function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/** 캐시의 형제 파일 stat 과 지금 stat 이 같은가. 둘 다 없으면 같다. */
function sameStat(entry: SidecarEntry | null, stat: fs.Stats | null): boolean {
  if (stat === null) return entry === null
  return entry !== null && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs
}

type MainRead = { digest: SessionDigest; bytes: number; headBytes: number; titleScanned: boolean; headDone: boolean }

/** 본 파일이 안 바뀌었다 — 읽지 않고 캐시 값을 쓴다 (형제 파일만 바뀐 주기). */
function reuseMain(cached: CacheEntry): MainRead {
  return { digest: cached.digest, bytes: 0, headBytes: 0, titleScanned: cached.titleScanned, headDone: cached.headDone }
}

/** 형제 파일 꼬리 한 창을 읽는다 — 확장 없음 (T7). */
function readSidecar(input: { file: string; stat: fs.Stats }): { entry: SidecarEntry; bytes: number } {
  const from = Math.max(0, input.stat.size - SIDECAR_WINDOW_BYTES)
  const chunk = readRange(input.file, from, input.stat.size)
  const parsed = parseGrokUpdates({ chunk, partial: from > 0 })
  return {
    entry: { size: input.stat.size, mtimeMs: input.stat.mtimeMs, ...parsed },
    bytes: input.stat.size - from,
  }
}

/** 본 파일을 읽어 지문을 만든다 — 한 번 확인한 값은 창 밖으로 밀려나도 이어 나른다. */
function readMain(input: {
  file: string
  stat: fs.Stats
  agent: TranscriptAgent
  ref: AgentSessionRef
  cached: CacheEntry | null
}): MainRead {
  const { cached } = input
  const read = readDigest({
    file: input.file,
    size: input.stat.size,
    mtimeMs: input.stat.mtimeMs,
    agent: input.agent,
    sessionId: input.ref.kind === 'id' ? input.ref.id : null,
    // **파일을 건너 이어진다.** 파일이 자라 mtime 이 바뀌어도 "이 파일은 이미 상한까지
    // 훑어봤다" 는 사실은 그대로다 — 안 이으면 갱신마다 2MB 를 다시 읽는다.
    titleScanned: cached?.titleScanned ?? false,
    // 머리는 **끝났을 때만** 이어진다 (C6′-④). 안 끝난 파일은 자랄 때마다 다시 읽는데,
    // 그런 파일은 창보다 작아서 그 재판독이 추가 0바이트다.
    headDone: cached?.headDone ?? false,
  })
  // **한 번 확인한 provider 제목은 창 밖으로 밀려나도 유지한다** (수정 라운드 1, V2).
  // 파일이 자라면 `ai-title` 이 첫 창 밖으로 나가는데, 그때 제목이 사라지면 사용자가 보는
  // 이름이 대화 중에 폴백으로 **되돌아간다**. 같은 파일 = 같은 세션이라 소유자 확인(C2)은
  // 이미 끝난 값이다.
  const digest: SessionDigest = {
    ...read.digest,
    providerTitle: read.digest.providerTitle ?? cached?.digest.providerTitle ?? null,
    // **첫 발화도 이어 나른다.** 머리 판독이 끝난 뒤로는 이번 판독에 값이 아예 안 실린다 —
    // 안 이으면 다음 갱신에서 제목이 폴백으로 되돌아간다 (V2 가 provider 제목에서 잡았던
    // 것과 같은 결함).
    firstPrompt: read.digest.firstPrompt ?? cached?.digest.firstPrompt ?? null,
    // **모델·최근 발화도 이어 나른다** (LIFE-458 T3·T4). 둘 다 "가장 최근 값" 이라 더 새 값은
    // 반드시 꼬리 창 안에 있다(JSONL 은 뒤에 붙는다) — 창에 없으면 전에 본 값이 여전히 최신이다.
    // 창을 넓혀 찾지 않는다(T7). 턴 결과·질문은 **안 잇는다** — "지금" 의 값이라 창에 없으면 null 이다.
    model: read.digest.model ?? cached?.digest.model ?? null,
    lastPrompt: read.digest.lastPrompt ?? cached?.digest.lastPrompt ?? null,
  }
  return { digest, bytes: read.bytes, headBytes: read.headBytes, titleScanned: read.titleScanned, headDone: read.headDone }
}

/**
 * 두 지문이 **화면에 보낼 만큼 다른가** — `index.ts` 의 emit 판정 (LIFE-458 T8).
 *
 * 필드를 하나씩 고르던 옛 비교는 `firstPrompt`·`tool` 을 빠뜨려(00-analysis P7) 그 둘만 바뀐 주기가
 * emit 되지 않았다. 필드가 늘 때마다 같은 구멍이 다시 열리므로 **구조 전체**를 비교한다. 지문은 이
 * 파일의 같은 코드 경로가 만들어 키 순서가 일정하다 — 순서가 달라지면 틀리는 쪽은 "같은데 다르다"
 * (emit 한 번 더)이지 "다른데 같다"(갱신 유실)가 아니다.
 */
export function digestsEqual(a: SessionDigest, b: SessionDigest): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 참조 여러 개를 한 주기에 읽는다 — 화면 갱신이 부르는 입구다.
 *
 * **비용 로그는 여기서 안 찍는다** (수정 라운드 1, V1). 기준 A7′ 은 세 구간 전부에 주기 수가
 * 있어야 한다고 못 박는데, 참조가 0인 구간은 읽을 파일이 없어 `files > 0` 조건에서는 로그가
 * 아예 안 남는다 — "무관측이 통과로 읽히는" 자리다. 로그 정책은 부르는 쪽(`index.ts`)이 정한다:
 * 평시엔 읽은 게 있을 때만, 계측 실행에서는 매 주기.
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
  let headBytes = 0
  let sidecarBytes = 0
  for (const [id, ref] of refs) {
    const read = readSessionDigest(ref)
    digests.set(id, read.digest)
    if (ref === null) continue
    files += 1
    if (read.statOnly) statOnly += 1
    bytes += read.bytes
    headBytes += read.headBytes
    sidecarBytes += read.sidecarBytes
  }
  return { digests, cost: { files, statOnly, bytes, headBytes, sidecarBytes, ms: Date.now() - startedAt } }
}
