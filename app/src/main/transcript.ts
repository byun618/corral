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

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentSessionRef, SessionDigest, SessionLifecycle, SessionQuestion, TranscriptAgent, TurnOutcome } from '../shared/types.js'
import { EMPTY_SESSION_DIGEST } from '../shared/types.js'
import { log } from './log.js'
import { clearContinuedMemo, continuedReadBytes, followContinued } from './transcript-continued.js'
import type { FollowedTranscript } from './transcript-continued.js'
import { parseGrokSummary, parseGrokUpdates, parseHead, parseTail, valueLines } from './transcript-parse.js'
import type { HandedItems, Ledger, Owner } from './transcript-lifecycle.js'
import { advanceLedger, claudeLiveSessions, clearClaudeRegistry, grokSessionAlive, inheritedItems, ledgerHandoff, ledgerSettled, ledgerView } from './transcript-lifecycle.js'

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

/**
 * grok `summary.json` 상한 (LIFE-458 수정 r1·F3). JSON 한 덩어리라 꼬리만 잘라 읽을 수 없다 — 이보다 크면
 * **안 읽고** 그 칸을 null 로 둔다. 실측 143개 최대 1,627B(`raw/claude/u7-grok-summary-model.txt`).
 */
export const SUMMARY_MAX_BYTES = 256 * 1024

/**
 * 이어 나를 값의 **근거 줄** — 그 값을 낸 레코드 한 줄의 파일 위치 `[start, end)` 와 그 바이트의 sha1 (수정 r3·R3-F2).
 * 값을 잇기 전에 이 줄을 다시 읽어 지문이 같을 때만 잇는다 — 끝 닻(r2)은 앞쪽을 바꿔 쓴 파일을 못 가렸다.
 */
type Evidence = { start: number; end: number; sha1: string }
type Carried = { value: string; evidence: Evidence }
/** 이어 나르기 기준 — 지난 판독에서 온전한 줄로 끝까지 읽은 위치와, 모델·최근 발화 각각의 값·근거. */
type CarryState = { end: number; model: Carried | null; lastPrompt: Carried | null }

/** 아무것도 못 읽은 지문. */
const EMPTY: SessionDigest = EMPTY_SESSION_DIGEST

/** 형제 파일(grok `updates.jsonl`)에서 읽은 것과 그때의 stat. */
type SidecarEntry = {
  size: number
  mtimeMs: number
  turnOutcome: TurnOutcome | null
  /** 그 결과 레코드의 시각 상한 — 레코드에 시각이 없으면 이 파일 mtime (S1). */
  turnOutcomeAt: number | null
  pendingQuestions: SessionQuestion[] | null
}

/** grok `summary.json` 에서 읽은 모델과 그때의 stat (F3). */
type SummaryEntry = {
  size: number
  mtimeMs: number
  model: string | null
}

type CacheEntry = {
  /** 해소된 파일 경로. 못 찾았으면 null (다음 갱신에 다시 훑는다). */
  file: string | null
  /** 참조가 찾은 원본 — `file` 은 여기서 `continued-in` 을 따라간 파일이다(LIFE-766). 판별은 주기마다 원본부터 다시 걷는다. */
  origin: string
  size: number
  mtimeMs: number
  digest: SessionDigest
  /** 형제 파일을 합치기 **전**의 본 파일 지문 — 이어 나르기는 본 파일 값만 잇는다(형제 값이 섞이면 안 된다). */
  mainDigest: SessionDigest
  /** 본 파일 정체성 (R3-F2 ①) — 바뀌면(교체) 값을 잇지 않는다. */
  dev: number
  ino: number
  /**
   * 이어 나르기 기준 (수정 r1·F4, r3·R3-F2) — 지난 판독 끝과 값별 근거 줄. 같은 정체성·끊김 없는 판독·**근거 줄
   * 바이트 불변**일 때만 모델·최근 발화를 잇는다. 모르면 null.
   */
  carry: CarryState | null
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
  /** grok `summary.json` 판독 결과. grok 이 아니거나 그 파일이 없으면 null (F3). */
  summary: SummaryEntry | null
  /**
   * 이 지문의 `lifecycle` 을 만든 누적 판독 상태 (LIFE-462) — `ledgers` 의 그 파일 항목과 **같은 객체**일 때만 빠른 반환을 쓴다.
   * 읽을 출처가 없으면 null.
   */
  ledger: Ledger | null
  /** 그 장부의 `ledgers` 키. 교체로 키가 바뀌면 옛 장부를 아무 참조도 안 쓸 때 회수한다(R3-F2). */
  ledgerKey: string | null
  /** 이 세션의 소유 프로세스 판정(L8). claude·grok 이 아니면 null. 바뀌면 파일이 그대로여도 다시 싣는다. */
  owner: Owner | null
  /** 이 파일이 이어 받은 앞 파일의 장부(LIFE-781) — 같은 객체일 때만 빠른 반환을 쓴다. 이어 받지 않았으면 null. */
  previous: Ledger | null
  /** 이 파일이 넘긴 것의 주인(이어 받은 세션 프로세스) 판정(LIFE-781). 넘긴 게 없으면 null. 바뀌면 다시 싣는다. */
  handoffOwner: Owner | null
}

const cache = new Map<string, CacheEntry>()

/**
 * 누적 판독 상태는 **provider 별 실제 파일마다 하나**다 (LIFE-462 F2·R2-F2·R3-F1) — 키는 `<agent>:<dev>:<ino>` 다. 같은 세션을 가리키는 pane 이
 * 여럿이어도(참조 키·경로 별칭이 달라도) 한 주기에 한 번만 나아가고 모든 pane 이 같은 값을 받는다. provider 가 다르면 parser 가 달라
 * 장부를 나누지 않는다. `cycle` 은 그 판독이 일어난 주기 번호, `seen` 은 마지막으로 어느 참조가 쓴 주기 번호다(R3-F2 회수).
 */
const ledgers = new Map<string, { ledger: Ledger; cycle: number; seen: number }>()
/**
 * 이번 주기에 기록 파일(정체성 `dev:ino`)을 처음 쓴 provider (R3-F1). 다른 provider 참조가 같은 파일을 가리키면 `conflict` —
 * 그 파일은 이번 주기 한 번만 읽고(예산 공유, R2-F2) 두 참조 모두 `unreadable` 로 둔다. 어느 참조가 먼저든 결과가 같다.
 * 주기마다 비운다.
 */
const fileClaims = new Map<string, { agent: TranscriptAgent; conflict: boolean }>()

/** 테스트용 — 살아 있는 장부 수(R3-F2). */
export function lifecycleLedgerCount(): number {
  return ledgers.size
}
/** 판독 주기 번호 — `readSessionDigests`(주기 하나)·`readSessionDigest`(단독 호출 하나)마다 1 씩 는다. */
let cycle = 0

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
  /**
   * 누적 판독(LIFE-462) — **별도 계정**이다. `bytes` 에 안 들어간다. `lifecycleMaxFileBytes` 는 이번 주기에 **파일 하나**가 읽은
   * 바이트 합의 최댓값(통과선 ≤2MB, L7 — 참조가 여럿이어도 파일별로 합한다), `lifecycleCatchingUp` 은 아직 끝에 못 닿은 참조 수,
   * `lifecycleMs` 는 그 판독에 든 시간이다. 프로세스 레지스트리 판독은 기록 파일이 아니라서 `lifecycleRegistryBytes` 로 따로 센다.
   */
  lifecycleBytes: number
  lifecycleMaxFileBytes: number
  lifecycleRegistryBytes: number
  lifecycleCatchingUp: number
  lifecycleMs: number
  /** 이어 가기 판별(LIFE-766) 몫 — 별도 계정이다. 끝 판별은 바뀐 파일마다 `CONTINUED_TAIL_BYTES` 이하, 대화 찾기는 대상마다 합쳐 `CONTINUED_CONVERSATION_MAX_BYTES` 이하, 안 바뀐 파일은 0. */
  continuedBytes: number
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
  ledgers.clear()
  fileClaims.clear()
  misses.clear()
  clearClaudeRegistry()
  clearContinuedMemo()
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

/** 한 세션 id 의 후보 파일 전부 — `error` = 훑는 중 폴더·후보를 읽지 못했다(0건이 「없음」 인지 알 수 없다). LIFE-582 R1-A13. */
type Candidates = { files: string[]; error: boolean }

/**
 * 후보 하나가 있나 — `existsSync` 는 권한 오류(EACCES)도 「없음」 으로 접는다(R2-A5). 없음(ENOENT·ENOTDIR)과 못 읽음을 가른다.
 */
function probe(file: string): 'file' | 'absent' | 'error' {
  try {
    fs.statSync(file)
    return 'file'
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'error'
  }
}

/** `<HOME>/.claude/projects/<폴더>/<id>.jsonl` — 폴더 이름은 안 지어내고 훑어 찾는다. */
function claudeCandidates(id: string): Candidates {
  const projects = path.join(homeDir(), '.claude', 'projects')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true })
  } catch {
    return { files: [], error: true }
  }
  const files: string[] = []
  let error = false
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(projects, entry.name, `${id}.jsonl`)
    const found = probe(candidate)
    if (found === 'file') files.push(candidate)
    else if (found === 'error') error = true
  }
  return { files, error }
}

/** `<HOME>/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` — 날짜 3단만 내려간다. */
function codexCandidates(id: string): Candidates {
  const root = path.join(homeDir(), '.codex', 'sessions')
  const suffix = `-${id}.jsonl`
  let error = false
  const dirs = (dir: string): string[] => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name))
    } catch {
      error = true
      return []
    }
  }
  const files: string[] = []
  for (const year of dirs(root)) {
    for (const month of dirs(year)) {
      for (const day of dirs(month)) {
        let names: string[]
        try {
          names = fs.readdirSync(day)
        } catch {
          error = true
          continue
        }
        for (const file of names) if (file.endsWith(suffix)) files.push(path.join(day, file))
      }
    }
  }
  return { files, error }
}

/** `<HOME>/.grok/sessions/<urlencoded cwd>/<id>/chat_history.jsonl`. */
function grokCandidates(id: string): Candidates {
  const root = path.join(homeDir(), '.grok', 'sessions')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { files: [], error: true }
  }
  const files: string[] = []
  let error = false
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(root, entry.name, id, 'chat_history.jsonl')
    const found = probe(candidate)
    if (found === 'file') files.push(candidate)
    else if (found === 'error') error = true
  }
  return { files, error }
}

function candidatesOf(input: { agent: TranscriptAgent; id: string }): Candidates {
  switch (input.agent) {
    case 'claude':
      return claudeCandidates(input.id)
    case 'codex':
      return codexCandidates(input.id)
    case 'grok':
      return grokCandidates(input.id)
  }
}

/**
 * 쓰기(폰 지시)용 해소 — 「첫 일치」 가 아니라 **유일한 후보**만 소유 기록으로 센다(LIFE-582 R1-A13, P1 「둘 이상이면 잠금」).
 * `none` = 훑기가 성공했고 후보가 0건(새 세션이 아직 파일을 쓰지 않았을 수 있다) · `error` = 폴더를 못 읽어 0건을 믿을 수 없다 ·
 * `ambiguous` = 같은 id 의 파일이 둘 이상. 표시용 `resolveTranscriptFile`(첫 일치)과 CLI 계약은 그대로다.
 * `continuedAs` = `continued-in` 을 따라 옮겨 간 세션 id(LIFE-766) — 그 파일의 줄은 이 id 로 세야 한다. 안 옮겼으면 없다.
 */
export type TranscriptResolution = { kind: 'found'; file: string; continuedAs?: string } | { kind: 'none' } | { kind: 'error' } | { kind: 'ambiguous'; count: number }

export function resolveTranscriptUnique(ref: AgentSessionRef): TranscriptResolution {
  const agent = transcriptAgent(ref.agent)
  if (agent === null) return { kind: 'error' }
  if (ref.kind === 'path') {
    const found = probe(ref.path)
    return found === 'file' ? { kind: 'found', file: ref.path } : found === 'absent' ? { kind: 'none' } : { kind: 'error' }
  }
  const { files, error } = candidatesOf({ agent, id: ref.id })
  if (files.length > 1) return { kind: 'ambiguous', count: files.length }
  // 일부를 못 읽었으면 하나만 찾았어도 유일하다고 말할 수 없고, 0건도 「없음」 이 아니다(R2-A5).
  if (error) return { kind: 'error' }
  if (files.length === 0) return { kind: 'none' }
  // 이어 간 세션(LIFE-766) — 지시가 기록될 파일을 고르고(빈 대상 포함), 옮겨 간 id 마다 같은 유일성 계약을 건다. 대상 찾기는 표시와 같은 판별 하나다.
  const followed = followContinued({ session: ref, file: files[0]!, empty: 'follow' })
  for (const id of followed.hops) {
    const target = candidatesOf({ agent, id })
    if (target.files.length > 1) return { kind: 'ambiguous', count: target.files.length }
    if (target.error) return { kind: 'error' }
  }
  const continuedAs = followed.hops.at(-1)
  if (continuedAs === undefined) return { kind: 'found', file: followed.file }
  return { kind: 'found', file: followed.file, continuedAs }
}

/** 참조를 파일 경로로 옮긴다. 못 찾으면 null. */
export function resolveTranscriptFile(ref: AgentSessionRef): string | null {
  const agent = transcriptAgent(ref.agent)
  if (agent === null) return null
  if (ref.kind === 'path') return fs.existsSync(ref.path) ? ref.path : null
  return candidatesOf({ agent, id: ref.id }).files[0] ?? null
}

// --- 꼬리 읽기 ----------------------------------------------------------------

/**
 * `[from, size)` 구간을 읽어 문자열로 준다. `from > 0` 이면 첫 줄이 잘려 있다(`partial`).
 *
 * 조각 경계에서 멀티바이트 문자가 갈릴 수 있는데, 그 줄은 어차피 `partial` 로 버리거나
 * JSON 파싱이 실패해 건너뛴다 — 여기서 따로 다루지 않는다.
 */
function readRange(file: string, from: number, to: number): string {
  return readBytes({ file, from, to }).toString('utf8')
}

/** `readRange` 의 바이트판 — 줄 경계를 **파일 위치**로 재야 할 때(F4) 쓴다. */
function readBytes(input: { file: string; from: number; to: number }): Buffer {
  const { file, from, to } = input
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
    return buffer.subarray(0, read)
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
  /** 같은 파일일 때만 넘어오는 지난 이어 나르기 기준(`CacheEntry.carry`). 없으면 null. */
  carry: CarryState | null
  /** 같은 경로에서 전에 값을 봤는데 파일이 바뀌었다(정체성·크기) — 이번 창에 값이 없으면 같은 확장으로 새 값을 찾는다. */
  replaced: boolean
}): {
  digest: SessionDigest
  bytes: number
  headBytes: number
  titleScanned: boolean
  headDone: boolean
  firstPrompt: string | null
  /** 다음 판독에 넘길 이어 나르기 기준. */
  carry: CarryState | null
} {
  const firstFrom = Math.max(0, input.size - TAIL_WINDOW_BYTES)
  let buffer = readBytes({ file: input.file, from: firstFrom, to: input.size })
  let chunk = buffer.toString('utf8')
  let bytes = input.size - firstFrom
  let from = firstFrom
  let parsed = parseTail({ agent: input.agent, chunk, partial: from > 0, sessionId: input.sessionId })
  let titleScanned = input.titleScanned

  const needsText = parsed.activity.state !== 'text'
  const needsTitle = input.agent === 'claude' && parsed.providerTitle === null && !titleScanned
  // **이어 나르기 확인** (수정 r1·F4 → r3·R3-F2). 이번 창에 없는 값은 지난 값을 이을 수 있는데, 조건이 셋이다:
  //   ① 같은 파일(정체성·크기 비감소 — `readMain` 이 가려 `carry` 를 넘긴다)
  //   ② 끊김 없는 판독 — 이번 판독 구간이 지난 판독 끝에 닿는다. 창보다 많이 붙어 틈이 생겼으면 그 틈에 더 새 값이
  //      있을 수 있어 같은 확장(A6)으로 틈을 덮은 뒤 본다
  //   ③ **근거 줄 불변** — 그 값을 낸 줄의 바이트 지문이 그대로다. 끝 닻(r2)만으로는 앞쪽 재작성을 못 가렸다
  // 틈이 없으면 ③을 확장 **전에** 본다 — 깨졌으면(재작성) 지난 값은 이 파일의 값이 아니므로 같은 확장으로 새 값을 찾는다.
  // 파일 자체가 바뀌었으면(`replaced`) 역시 새 값을 찾는다. 이을 것도 바뀐 것도 없으면 넓히지 않는다(T7).
  const carry = input.carry
  const verified: { model: Carried | null | undefined; lastPrompt: Carried | null | undefined } = { model: undefined, lastPrompt: undefined }
  const verify = (prior: Carried | null): Carried | null => {
    if (prior === null) return null
    const check = evidenceBytes({ file: input.file, buffer, from, evidence: prior.evidence, budget: TAIL_MAX_BYTES - bytes })
    if (check === null) return null
    bytes += check.read
    return sha1(check.bytes) === prior.evidence.sha1 ? prior : null
  }
  let broken = input.replaced
  const gap = carry !== null && lineStart({ buffer, from }) > carry.end
  if (carry !== null && !gap) {
    if (parsed.model === null && carry.model !== null) verified.model = verify(carry.model)
    if (parsed.lastPrompt === null && carry.lastPrompt !== null) verified.lastPrompt = verify(carry.lastPrompt)
    if (verified.model === null || verified.lastPrompt === null) broken = true
  }
  const wantsCarry =
    carry !== null && ((parsed.model === null && carry.model !== null) || (parsed.lastPrompt === null && carry.lastPrompt !== null))
  const needsCarryCheck = (gap && wantsCarry) || (broken && (parsed.model === null || parsed.lastPrompt === null))
  // 첫 창에서 못 찾은 게 있고 아직 앞에 남은 게 있으면 **한 번만** 더 넓힌다.
  if ((needsText || needsTitle || needsCarryCheck) && from > 0) {
    // 확장 바닥은 **남은 꼬리 예산**으로 잡는다 — 근거 확인 판독까지 합쳐 실제 읽기가 `TAIL_MAX_BYTES` 를 안 넘는다 (R3-F1).
    const secondFrom = Math.max(0, from - Math.max(0, TAIL_MAX_BYTES - bytes))
    if (secondFrom < from) {
      buffer = Buffer.concat([readBytes({ file: input.file, from: secondFrom, to: from }), buffer]) // 두 구간은 붙어 있다 — 겹치지 않는다
      chunk = buffer.toString('utf8')
      bytes += from - secondFrom
      from = secondFrom
      parsed = parseTail({ agent: input.agent, chunk, partial: from > 0, sessionId: input.sessionId })
    }
    // 상한까지 봤다 — 여기서 제목이 없으면 이 파일엔 (창 안에) 없는 것이다. 다시 안 훑는다.
    titleScanned = true
  }
  // 파일을 통째로 읽었거나 제목을 찾았으면 더 훑을 이유가 없다.
  if (from === 0 || parsed.providerTitle !== null) titleScanned = true

  // --- 모델·최근 발화: 이번 창 값 또는 **근거가 그대로인** 지난 값 (R3-F2) ----------------
  //
  // 이번 창(확장 포함)에 값이 있으면 그 값과 근거 줄을 새로 쥔다. 없으면 ①②③이 다 선 지난 값만 — 확장 전에 이미
  // 확인했으면 그 결과를, 틈이었으면 여기서(남은 예산 안에서) 확인한다. 확인 못 하면 null (R3-F1·R3-F2).
  const rangeStart = lineStart({ buffer, from })
  const contiguous = carry !== null && rangeStart <= carry.end
  const lines = valueLines({
    agent: input.agent,
    chunk,
    partial: from > 0,
    sessionId: input.sessionId,
    want: { model: parsed.model !== null, lastPrompt: parsed.lastPrompt !== null },
  })
  const resolve = (field: { found: string | null; line: number | null; prior: Carried | null; checked: Carried | null | undefined }): Carried | null => {
    if (field.found !== null) {
      if (field.line === null) return null
      const range = lineRange({ buffer, index: field.line })
      const evidence = { start: from + range.start, end: from + range.end, sha1: sha1(buffer.subarray(range.start, range.end)) }
      return { value: field.found, evidence }
    }
    if (!contiguous) return null
    return field.checked !== undefined ? field.checked : verify(field.prior)
  }
  const model = resolve({ found: parsed.model, line: lines.model, prior: carry?.model ?? null, checked: verified.model })
  const lastPrompt = resolve({ found: parsed.lastPrompt, line: lines.lastPrompt, prior: carry?.lastPrompt ?? null, checked: verified.lastPrompt })
  const end = lineEnd({ buffer, from })
  const carryEnd = end !== null ? end : contiguous ? carry.end : null
  const nextCarry: CarryState | null = carryEnd === null ? null : { end: carryEnd, model, lastPrompt }

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
    carry: nextCarry,
    digest: {
      activity: parsed.activity,
      providerTitle: parsed.providerTitle,
      firstPrompt,
      tool: parsed.tool,
      // 레코드에 시각이 없는 포맷(grok)은 파일 mtime 으로 떨어진다 — **실재하는 시각**이다
      // (기준 D1: 렌더러가 처음 본 시각을 쓰면 미달).
      lastActivityAt: parsed.lastActivityAt ?? input.mtimeMs,
      turnOutcome: parsed.turnOutcome,
      // 결과를 고른 **그 레코드**의 시각 (fix-r3 T1). 없으면 null — 다른 레코드 시각(`lastActivityAt`)이나 mtime 으로
      // 메우지 않는다: 시각 없는 결과 레코드 앞의 레코드 시각을 쓰면 새 결과를 지난 결과로 버린다(review r3 T1).
      turnOutcomeAt: parsed.turnOutcomeAt,
      // 이번 창 값, 없으면 근거가 그대로인 지난 값 (F4·R3-F2). 2MB 안에서 확인 못 하면 null.
      model: model?.value ?? null,
      lastPrompt: lastPrompt?.value ?? null,
      pendingQuestions: parsed.pendingQuestions,
      // 꼬리 판독은 수명을 모른다 — `readSessionDigest` 가 누적 판독 값으로 덮는다(LIFE-462).
      lifecycle: EMPTY.lifecycle,
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
export function readSessionDigest(ref: AgentSessionRef | null): DigestRead & { continuedBytes: number } {
  cycle += 1
  fileClaims.clear()
  const before = continuedReadBytes()
  const read = readOne(ref)
  return { ...read, continuedBytes: continuedReadBytes() - before }
}

type DigestRead = {
  digest: SessionDigest
  bytes: number
  headBytes: number
  sidecarBytes: number
  statOnly: boolean
  lifecycle: LifecycleRead
}

/** 이번 주기(`cycle`) 안에서 참조 하나를 읽는다. */
function readOne(ref: AgentSessionRef | null): DigestRead {
  if (ref === null) return { digest: EMPTY, bytes: 0, headBytes: 0, sidecarBytes: 0, statOnly: false, lifecycle: NO_LIFECYCLE_READ }
  const agent = transcriptAgent(ref.agent)
  if (agent === null) return { digest: EMPTY, bytes: 0, headBytes: 0, sidecarBytes: 0, statOnly: false, lifecycle: NO_LIFECYCLE_READ }

  const key = cacheKey(ref)
  const cached = cache.get(key) ?? null
  const unresolved: { digest: SessionDigest; bytes: number; headBytes: number; sidecarBytes: number; lifecycle: LifecycleRead } = {
    digest: { ...EMPTY, activity: { state: 'unresolved' } },
    bytes: 0,
    headBytes: 0,
    sidecarBytes: 0,
    lifecycle: NO_LIFECYCLE_READ,
  }
  let origin = cached?.origin ?? null
  if (origin === null) {
    const now = Date.now()
    // 훑기를 건너뛰는 주기 — 디스크를 아예 안 만진다. `statOnly` 로 세어 A7 표에 드러낸다.
    if (!shouldResolveNow(key, now)) return { ...unresolved, statOnly: true }
    origin = resolveTranscriptFile(ref)
    if (origin === null) {
      const miss = misses.get(key) ?? null
      misses.set(key, { firstAt: miss?.firstAt ?? now, lastTryAt: now })
      return { ...unresolved, statOnly: false }
    }
    misses.delete(key)
  }
  // 이어 간 세션(LIFE-766) — 캐시가 파일을 고정하지 않게 주기마다 다시 고른다. 안 바뀐 파일은 stat 만 한다. 대상이 비어 있으면 옛 파일에 머문다.
  const followed = followContinued({ session: ref, file: origin, empty: 'stay' })
  const { file } = followed

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
      lifecycle: NO_LIFECYCLE_READ,
    }
  }

  // grok 은 **파일이 둘**이다 (LIFE-458). 턴이 중단되면 `updates.jsonl` 만 자라고 `chat_history` 는
  // 그대로일 수 있어서, 두 파일을 따로 stat 하고 **바뀐 쪽만** 읽는다 — 무변경 파일은 읽기 0바이트(T7).
  // `summary.json`(모델, F3)도 같은 식으로 따로 stat 한다.
  const sidecarFile = agent === 'grok' ? path.join(path.dirname(file), 'updates.jsonl') : null
  const sidecarStat = sidecarFile === null ? null : statOrNull(sidecarFile)
  const summaryFile = agent === 'grok' ? path.join(path.dirname(file), 'summary.json') : null
  const summaryStat = summaryFile === null ? null : statOrNull(summaryFile)
  // 파일 정체성(dev·ino)도 본다 (R4-F1) — 크기·mtime 을 보존한 교체(시간 보존 복사 뒤 rename)는 경로·크기·mtime 이
  // 같아도 다른 파일이다. 빠른 반환·`reuseMain` 둘 다 이 판정을 쓰므로 정체성이 바뀌면 `readMain` 으로 간다.
  // 무변경 파일은 stat 값만 비교하므로 여전히 읽기 0바이트다(T7).
  const mainFresh =
    cached !== null &&
    cached.file === file &&
    cached.dev === stat.dev &&
    cached.ino === stat.ino &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs
  const sidecarFresh = sameStat({ entry: cached?.sidecar ?? null, stat: sidecarStat })
  const summaryFresh = sameStat({ entry: cached?.summary ?? null, stat: summaryStat })
  // 누적 판독 출처 (LIFE-462) — claude 는 본 파일, grok 은 `updates.jsonl`, codex 는 없다(끝 표지가 기록에 없다, 00-analysis P12).
  const ledgerStat = agent === 'claude' ? stat : agent === 'grok' ? sidecarStat : null
  const ledgerFile = agent === 'claude' ? file : ledgerStat === null ? null : sidecarFile
  // 누적 상태는 파일에 붙는다 — 이번 주기에 다른 참조가 이미 나아갔으면 다시 읽지 않고 그 값을 쓴다(F2).
  // 파일 키는 경로가 아니라 **파일 정체성**(dev·ino)이다 — 같은 파일을 다른 경로(심볼릭 링크 등)로 가리켜도 장부·주기 판독·비용이 하나다(R2-F2).
  // 장부 키는 거기에 provider 를 붙인다 — 다른 provider 의 parser 상태를 이어받지 않는다(R3-F1).
  // 교체(rename)된 파일은 정체성이 달라 새 장부로 처음부터 읽는다 — `advanceLedger` 의 ①(정체성) 초기화와 같은 뜻이다.
  const fileKey = ledgerStat === null ? null : `${ledgerStat.dev}:${ledgerStat.ino}`
  const ledgerKey = fileKey === null ? null : `${agent}:${fileKey}`
  const claim = fileKey === null ? undefined : fileClaims.get(fileKey)
  if (claim !== undefined && claim.agent !== agent) claim.conflict = true
  else if (fileKey !== null && claim === undefined) fileClaims.set(fileKey, { agent, conflict: false })
  const conflict = claim !== undefined && claim.agent !== agent
  const shared = ledgerKey === null ? undefined : ledgers.get(ledgerKey)
  if (shared !== undefined) shared.seen = cycle
  const priorLedger = shared?.ledger ?? null
  const advance =
    ledgerFile !== null && ledgerStat !== null && !conflict && shared?.cycle !== cycle && !ledgerSettled({ ledger: priorLedger, stat: ledgerStat })
  // 강제 종료는 기록에 아무것도 안 남긴다 — 생존은 파일 변화와 따로 매 주기 본다(L8, `transcript-lifecycle.ts`).
  // claude 는 레지스트리를 한 번 훑고 제 세션과 넘겨받은 세션(LIFE-781)의 소유자를 함께 고른다.
  const claudeLive = agent === 'claude' ? claudeLiveSessions({ dir: path.join(homeDir(), '.claude', 'sessions') }) : null
  const liveness =
    claudeLive !== null
      ? { owner: claudeLive.owner(ref.kind === 'id' ? (followed.sessionId ?? ref.id) : path.basename(ref.path, '.jsonl')), bytes: claudeLive.bytes }
      : agent === 'grok'
        ? grokSessionAlive({
            file: path.join(homeDir(), '.grok', 'active_sessions.json'),
            sessionId: ref.kind === 'id' ? ref.id : path.basename(path.dirname(ref.path)),
          })
        : null
  const owner = liveness?.owner ?? null
  const registryBytes = liveness?.bytes ?? 0
  // 전환(LIFE-781) — 이 파일이 넘긴 것은 이어 받은 세션 프로세스가 주인이고, 앞 파일이 넘긴 것은 이 파일 소유자가 주인이다.
  const handoffOwner = (ledger: Ledger | null): Owner | null => {
    const handoff = ledger === null || claudeLive === null ? null : ledgerHandoff(ledger)
    return handoff === null || claudeLive === null ? null : claudeLive.owner(handoff.target)
  }
  const previous = agent === 'claude' ? previousLedger({ origin, followed }) : null
  const carry = (ledger: Ledger): CarryGroup[] => {
    const groups: CarryGroup[] = []
    const handoff = ledgerHandoff(ledger)
    if (handoff !== null) groups.push({ carried: handoff, owner: handoffOwner(ledger) })
    if (previous !== null && followed.sessionId !== null) groups.push({ carried: inheritedItems({ ledger, from: previous.ledger, sessionId: followed.sessionId }), owner })
    return groups
  }
  if (
    cached !== null &&
    mainFresh &&
    sidecarFresh &&
    summaryFresh &&
    !advance &&
    cached.ledger === priorLedger &&
    sameOwner({ a: cached.owner, b: owner }) &&
    cached.previous === (previous?.ledger ?? null) &&
    sameOwner({ a: cached.handoffOwner, b: handoffOwner(priorLedger) })
  ) {
    return {
      digest: cached.digest,
      bytes: 0,
      headBytes: 0,
      sidecarBytes: 0,
      statOnly: true,
      lifecycle: { ...NO_LIFECYCLE_READ, key: fileKey, registryBytes, conflict, previous: previous?.read ?? null },
    }
  }

  try {
    const main = cached !== null && mainFresh ? reuseMain(cached) : readMain({ file, stat, agent, sessionId: followed.sessionId, cached: cached?.file === file ? cached : null })
    let sidecar = cached?.sidecar ?? null
    let sidecarBytes = 0
    if (sidecarFile !== null && !sidecarFresh) {
      const read = sidecarStat === null ? null : readSidecar({ file: sidecarFile, stat: sidecarStat })
      sidecar = read?.entry ?? null
      sidecarBytes = read?.bytes ?? 0
    }
    let summary = cached?.summary ?? null
    if (summaryFile !== null && !summaryFresh) {
      const read = summaryStat === null ? null : readSummary({ file: summaryFile, stat: summaryStat })
      summary = read?.entry ?? null
      // 형제 파일 바이트에 함께 센다 — 둘 다 grok 이 더 읽는 파일이고 파일마다 ≤256KB 다(T7).
      sidecarBytes += read?.bytes ?? 0
    }
    // grok 이 아니면 턴 결과·질문은 본 파일 판독이 이미 채웠다. grok 이면 형제 파일 값으로 덮는다.
    // 모델은 **응답 기록(`chat_history` 의 `model_id`) 이 먼저**, 없을 때만 `summary.json` 이다 (F3):
    // 응답 기록은 실제로 답한 모델이고 식별자도 더 자세하다(`-build` 변형, 98 중 95). summary 는 세션에 고른
    // 모델이라 첫 응답 전에 실패한 세션(143 중 45 가 응답 모델 없음)에서도 있다 — `u7-grok-summary-model.txt`.
    const life = conflict
      ? { lifecycle: UNREADABLE, ledger: priorLedger, read: { bytes: 0, ms: 0 } }
      : readLifecycle({ file: ledgerFile, key: ledgerKey, stat: ledgerStat, agent, prior: priorLedger, advance, owner, carry })
    if (cached !== null && cached.ledgerKey !== null && cached.ledgerKey !== ledgerKey) releaseLedger({ key: cached.ledgerKey, except: key })
    const merged: SessionDigest =
      sidecarFile === null
        ? main.digest
        : {
            ...main.digest,
            turnOutcome: sidecar?.turnOutcome ?? null,
            // 결과의 시각도 형제 파일에서 — `chat_history` 의 활동 시각과 섞으면 두 시계를 견주게 된다(fix-r2 S1).
            turnOutcomeAt: sidecar?.turnOutcomeAt ?? null,
            pendingQuestions: sidecar?.pendingQuestions ?? null,
            model: main.digest.model ?? summary?.model ?? null,
          }
    const digest: SessionDigest = { ...merged, lifecycle: life.lifecycle }
    cache.set(key, {
      file,
      origin,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      digest,
      mainDigest: main.digest,
      dev: stat.dev,
      ino: stat.ino,
      carry: main.carry,
      titleScanned: main.titleScanned,
      headDone: main.headDone,
      sidecar,
      summary,
      // 충돌 주기의 지문은 빠른 반환에 다시 쓰지 않는다 — 충돌이 풀린 주기에 낡은 `unreadable` 이 남지 않게(R3-F1).
      ledger: conflict ? null : life.ledger,
      ledgerKey,
      owner,
      previous: previous?.ledger ?? null,
      handoffOwner: handoffOwner(conflict ? null : life.ledger),
    })
    return {
      digest,
      bytes: main.bytes + sidecarBytes,
      headBytes: main.headBytes,
      sidecarBytes,
      statOnly: false,
      lifecycle: { ...life.read, key: fileKey, registryBytes, conflict, previous: previous?.read ?? null },
    }
  } catch (error) {
    log('transcript.error', { where: 'read', agent, error: String(error) })
    return {
      digest: { ...EMPTY, activity: { state: 'unreadable', reason: String(error) } },
      bytes: 0,
      headBytes: 0,
      sidecarBytes: 0,
      statOnly: false,
      lifecycle: NO_LIFECYCLE_READ,
    }
  }
}

/**
 * 누적 판독 한 참조의 비용 (LIFE-462 L7) — `bytes` 는 기록 파일(정체성 `key` = dev:ino) 몫, `registryBytes` 는 프로세스 레지스트리 몫.
 * `conflict` 는 이번 주기에 다른 provider 참조가 먼저 이 파일을 썼다는 뜻이다(R3-F1).
 */
type LifecycleRead = {
  bytes: number
  ms: number
  key: string | null
  registryBytes: number
  conflict: boolean
  /** 이어 받은 앞 파일 장부를 이번에 나아가며 읽은 몫(LIFE-781) — 그 파일 정체성으로 따로 센다. 앞 파일이 없으면 null. */
  previous: { key: string; bytes: number } | null
}
const NO_LIFECYCLE_READ: LifecycleRead = { bytes: 0, ms: 0, key: null, registryBytes: 0, conflict: false, previous: null }

/** 세대 경계를 건너 싣는 묶음과 그 주인 — 주인이 살아 있을 때만 싣는다(LIFE-781). */
type CarryGroup = { carried: HandedItems; owner: Owner | null }

/**
 * 이어 받은 파일을 읽을 때 그 앞 파일의 장부 (LIFE-781) — 앞 파일이 넘긴 것(`ledgerHandoff`)을 보려고 같이 나아간다.
 * 장부는 `ledgers` 를 같이 쓴다 — 전환 전에 그 파일을 읽던 참조의 장부를 그대로 잇고, 이번 주기에 이미 나아갔으면 다시 읽지 않는다.
 * 앞 파일은 전환 뒤 거의 자라지 않는다(옛 pane 을 닫을 때 `cost-state` 한 줄 — 실측). 못 읽으면 null — 넘긴 것 없이 지금처럼 동작한다.
 */
function previousLedger(input: { origin: string; followed: FollowedTranscript }): { ledger: Ledger; read: { key: string; bytes: number } } | null {
  const { hops } = input.followed
  if (hops.length === 0) return null
  const before = hops.at(-2)
  const file = before === undefined ? input.origin : path.join(path.dirname(input.followed.file), `${before}.jsonl`)
  const stat = statOrNull(file)
  if (stat === null) return null
  const fileKey = `${stat.dev}:${stat.ino}`
  const key = `claude:${fileKey}`
  const shared = ledgers.get(key)
  if (shared !== undefined) shared.seen = cycle
  const prior = shared?.ledger ?? null
  if (shared?.cycle === cycle || ledgerSettled({ ledger: prior, stat })) return prior === null ? null : { ledger: prior, read: { key: fileKey, bytes: 0 } }
  try {
    const step = advanceLedger({ file, stat, agent: 'claude', prior })
    if (step.reset !== null) log('transcript.lifecycle.reset', { agent: 'claude', reason: step.reset })
    ledgers.set(key, { ledger: step.ledger, cycle, seen: cycle })
    return { ledger: step.ledger, read: { key: fileKey, bytes: step.bytes } }
  } catch (error) {
    log('transcript.error', { where: 'lifecycle-previous', agent: 'claude', error: String(error) })
    ledgers.delete(key)
    return null
  }
}

/** 교체로 참조가 떠난 장부를, 그 참조(`except`) 말고 아무 캐시 항목도 안 쓰면 회수한다(R3-F2). 별칭이 쓰는 장부는 남는다. */
function releaseLedger(input: { key: string; except: string }): void {
  for (const [cacheKey, entry] of cache) if (cacheKey !== input.except && entry.ledgerKey === input.key) return
  ledgers.delete(input.key)
}

function sameOwner(input: { a: Owner | null; b: Owner | null }): boolean {
  const { a, b } = input
  if (a === null || b === null) return a === b
  if (!a.alive || !b.alive) return a.alive === b.alive
  return a.since === b.since
}

/**
 * 누적 판독 한 걸음 (LIFE-462) — 출처가 없으면 `no-source`, `advance` 가 아니면(따라잡았고 그대로 · 이번 주기에 이미 나아감) 읽지 않는다.
 * **던지지 않는다** — 실패는 이 칸만 `unreadable` 로 떨어지고 지문의 나머지는 산다(L9). 누적 상태는 버린다(다음에 0 부터).
 */
function readLifecycle(input: {
  file: string | null
  /** 장부 키 — 파일 정체성(dev:ino). */
  key: string | null
  stat: fs.Stats | null
  agent: TranscriptAgent
  prior: Ledger | null
  advance: boolean
  /** 소유 프로세스 판정(L8). 죽었으면 누적은 계속하되 목록은 `not-running`, 시작 시각을 모르면 세대를 못 갈라 `unreadable`. */
  owner: Owner | null
  /** 세대 경계를 건너 싣는 묶음(LIFE-781 전환) — 장부마다 고른다. 소유자가 죽어도 주인이 산 묶음이 있으면 그것만 싣는다. */
  carry: (ledger: Ledger) => CarryGroup[]
}): { lifecycle: SessionLifecycle; ledger: Ledger | null; read: { bytes: number; ms: number } } {
  const { file, key, stat, agent, prior, owner } = input
  if (file === null || key === null || stat === null || agent === 'codex') return { lifecycle: NO_SOURCE, ledger: null, read: { bytes: 0, ms: 0 } }
  const view = (ledger: Ledger): SessionLifecycle => {
    const carried: HandedItems = { tasks: [], subagents: [] }
    for (const group of input.carry(ledger)) {
      if (group.owner === null || !group.owner.alive) continue
      carried.tasks.push(...group.carried.tasks)
      carried.subagents.push(...group.carried.subagents)
    }
    const carrying = carried.tasks.length + carried.subagents.length > 0
    if (owner === null || !owner.alive) return carrying ? ledgerView({ ledger, since: Number.POSITIVE_INFINITY, carried }) : NOT_RUNNING
    if (owner.since === null) return { state: 'unknown', reason: 'unreadable' }
    return ledgerView({ ledger, since: owner.since, carried })
  }
  if (!input.advance && prior !== null) return { lifecycle: view(prior), ledger: prior, read: { bytes: 0, ms: 0 } }
  const startedAt = Date.now()
  try {
    const step = advanceLedger({ file, stat, agent, prior })
    if (step.reset !== null) log('transcript.lifecycle.reset', { agent, reason: step.reset })
    ledgers.set(key, { ledger: step.ledger, cycle, seen: cycle })
    return { lifecycle: view(step.ledger), ledger: step.ledger, read: { bytes: step.bytes, ms: Date.now() - startedAt } }
  } catch (error) {
    log('transcript.error', { where: 'lifecycle', agent, error: String(error) })
    ledgers.delete(key)
    return {
      lifecycle: { state: 'unknown', reason: 'unreadable' },
      ledger: null,
      read: { bytes: 0, ms: Date.now() - startedAt },
    }
  }
}

const NO_SOURCE: SessionLifecycle = { state: 'unknown', reason: 'no-source' }
const UNREADABLE: SessionLifecycle = { state: 'unknown', reason: 'unreadable' }
const NOT_RUNNING: SessionLifecycle = { state: 'unknown', reason: 'not-running' }

/** stat, 없거나 못 읽으면 null — 형제 파일은 없을 수 있다(없으면 그 칸이 null 일 뿐이다). */
function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/** 캐시의 형제 파일 stat 과 지금 stat 이 같은가. 둘 다 없으면 같다. */
function sameStat(input: { entry: { size: number; mtimeMs: number } | null; stat: fs.Stats | null }): boolean {
  const { entry, stat } = input
  if (stat === null) return entry === null
  return entry !== null && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs
}

type MainRead = {
  digest: SessionDigest
  bytes: number
  headBytes: number
  titleScanned: boolean
  headDone: boolean
  carry: CarryState | null
}

/** 본 파일이 안 바뀌었다 — 읽지 않고 캐시 값을 쓴다 (형제 파일만 바뀐 주기). */
function reuseMain(cached: CacheEntry): MainRead {
  return {
    digest: cached.mainDigest,
    bytes: 0,
    headBytes: 0,
    titleScanned: cached.titleScanned,
    headDone: cached.headDone,
    carry: cached.carry,
  }
}

/** 조각에서 **온전히 읽힌 첫 줄**의 파일 위치 — `from > 0` 이면 첫 줄은 잘린 줄이라 버려지므로(`tailLines`) 첫 줄바꿈 뒤다. */
function lineStart(input: { buffer: Buffer; from: number }): number {
  if (input.from === 0) return 0
  const first = input.buffer.indexOf(0x0a)
  return first === -1 ? input.from + input.buffer.length : input.from + first + 1
}

/** 조각에서 온전히 읽힌 마지막 줄 끝(줄바꿈 뒤)의 파일 위치. 줄바꿈 없는 끝줄은 쓰다 만 것일 수 있어 안 친다. 없으면 null. */
function lineEnd(input: { buffer: Buffer; from: number }): number | null {
  const last = input.buffer.lastIndexOf(0x0a)
  if (last === -1) return null
  const end = input.from + last + 1
  return end > lineStart(input) ? end : input.from === 0 ? end : null
}

/** `chunk.split('\n')` 의 `index` 번째 줄이 조각 안에서 차지하는 바이트 구간(줄바꿈 제외). UTF-8 줄바꿈 바이트는 문자 안에 안 나온다. */
function lineRange(input: { buffer: Buffer; index: number }): { start: number; end: number } {
  let start = 0
  for (let i = 0; i < input.index; i += 1) start = input.buffer.indexOf(0x0a, start) + 1
  const next = input.buffer.indexOf(0x0a, start)
  return { start, end: next === -1 ? input.buffer.length : next }
}

function sha1(bytes: Buffer): string {
  return crypto.createHash('sha1').update(bytes).digest('hex')
}

/**
 * 근거 줄의 지금 바이트 (R3-F2). 조각 안이면 거기서, 밖이면 그 부분만 읽는다 — 읽을 양이 남은 꼬리 예산을 넘으면
 * **확인 못 함(null) = 잇지 않는다** (R3-F1). 파일이 근거 끝보다 짧으면 역시 null.
 */
function evidenceBytes(input: { file: string; buffer: Buffer; from: number; evidence: Evidence; budget: number }): {
  bytes: Buffer
  read: number
} | null {
  const { evidence, from, buffer } = input
  if (evidence.end > from + buffer.length) return null
  if (evidence.start >= from) return { bytes: buffer.subarray(evidence.start - from, evidence.end - from), read: 0 }
  const outside = Math.min(evidence.end, from) - evidence.start
  if (outside > input.budget) return null
  const head = readBytes({ file: input.file, from: evidence.start, to: evidence.start + outside })
  if (head.length !== outside) return null
  const inside = evidence.end > from ? buffer.subarray(0, evidence.end - from) : Buffer.alloc(0)
  return { bytes: Buffer.concat([head, inside]), read: outside }
}

/** grok `summary.json` 을 통째로 읽는다 — 상한보다 크면 안 읽는다 (F3, T7). */
function readSummary(input: { file: string; stat: fs.Stats }): { entry: SummaryEntry; bytes: number } {
  const entry = { size: input.stat.size, mtimeMs: input.stat.mtimeMs }
  if (input.stat.size > SUMMARY_MAX_BYTES) return { entry: { ...entry, model: null }, bytes: 0 }
  const text = readRange(input.file, 0, input.stat.size)
  return { entry: { ...entry, model: parseGrokSummary(text) }, bytes: input.stat.size }
}

/** 형제 파일 꼬리 한 창을 읽는다 — 확장 없음 (T7). */
function readSidecar(input: { file: string; stat: fs.Stats }): { entry: SidecarEntry; bytes: number } {
  const from = Math.max(0, input.stat.size - SIDECAR_WINDOW_BYTES)
  const chunk = readRange(input.file, from, input.stat.size)
  const parsed = parseGrokUpdates({ chunk, partial: from > 0 })
  const turnOutcomeAt = parsed.turnOutcome === null ? null : (parsed.turnOutcomeAt ?? input.stat.mtimeMs)
  return {
    entry: { size: input.stat.size, mtimeMs: input.stat.mtimeMs, ...parsed, turnOutcomeAt },
    bytes: input.stat.size - from,
  }
}

/** 본 파일을 읽어 지문을 만든다 — 한 번 확인한 값은 창 밖으로 밀려나도 이어 나른다. */
function readMain(input: {
  file: string
  stat: fs.Stats
  agent: TranscriptAgent
  sessionId: string | null
  /** 같은 파일의 지난 판독만 — 이어 간 새 파일에 옛 파일의 제목·머리·이어 나르기를 넘기지 않는다(LIFE-766). */
  cached: CacheEntry | null
}): MainRead {
  const { cached } = input
  // 이어 나르기 기준은 **같은 파일**일 때만 넘긴다 (R3-F2 ①) — 경로·dev·ino 가 같고 크기가 줄지 않았을 때.
  // 정체성이 바뀌면(rename 교체 등) 근거가 같아 보여도 잇지 않는다. 같은 정체성의 재작성은 근거 줄 지문이 가린다.
  const sameFile =
    cached !== null &&
    cached.file === input.file &&
    cached.dev === input.stat.dev &&
    cached.ino === input.stat.ino &&
    input.stat.size >= cached.size
  const read = readDigest({
    file: input.file,
    size: input.stat.size,
    mtimeMs: input.stat.mtimeMs,
    agent: input.agent,
    sessionId: input.sessionId,
    // **파일을 건너 이어진다.** 파일이 자라 mtime 이 바뀌어도 "이 파일은 이미 상한까지
    // 훑어봤다" 는 사실은 그대로다 — 안 이으면 갱신마다 2MB 를 다시 읽는다.
    titleScanned: cached?.titleScanned ?? false,
    // 머리는 **끝났을 때만** 이어진다 (C6′-④). 안 끝난 파일은 자랄 때마다 다시 읽는데,
    // 그런 파일은 창보다 작아서 그 재판독이 추가 0바이트다.
    headDone: cached?.headDone ?? false,
    carry: sameFile ? cached.carry : null,
    // 같은 경로에서 값을 봤는데 파일이 바뀌었다 — 이번 창에 값이 없으면 확장으로 새 파일의 값을 찾는다(r2 결과 유지).
    replaced: cached !== null && cached.file === input.file && !sameFile && cached.carry !== null && (cached.carry.model !== null || cached.carry.lastPrompt !== null),
  })
  // **한 번 확인한 provider 제목은 창 밖으로 밀려나도 유지한다** (수정 라운드 1, V2).
  // 파일이 자라면 `ai-title` 이 첫 창 밖으로 나가는데, 그때 제목이 사라지면 사용자가 보는
  // 이름이 대화 중에 폴백으로 **되돌아간다**. 같은 파일 = 같은 세션이라 소유자 확인(C2)은
  // 이미 끝난 값이다.
  const digest: SessionDigest = {
    ...read.digest,
    providerTitle: read.digest.providerTitle ?? cached?.mainDigest.providerTitle ?? null,
    // **첫 발화도 이어 나른다.** 머리 판독이 끝난 뒤로는 이번 판독에 값이 아예 안 실린다 —
    // 안 이으면 다음 갱신에서 제목이 폴백으로 되돌아간다 (V2 가 provider 제목에서 잡았던
    // 것과 같은 결함).
    firstPrompt: read.digest.firstPrompt ?? cached?.mainDigest.firstPrompt ?? null,
    // 모델·최근 발화는 `readDigest` 가 정한다 — 이번 창 값, 또는 같은 파일·끊김 없는 판독·근거 줄 불변일 때만 지난 값
    // (LIFE-458 T3·T4, 수정 r1·F4 → r3·R3-F2). 턴 결과·질문은 아예 안 잇는다 — "지금" 의 값이라 창에 없으면 null 이다.
  }
  return {
    digest,
    bytes: read.bytes,
    headBytes: read.headBytes,
    titleScanned: read.titleScanned,
    headDone: read.headDone,
    carry: read.carry,
  }
}

/**
 * 두 지문이 **화면에 보낼 만큼 다른가** — `index.ts` 의 emit 판정 (LIFE-458 T8).
 *
 * 필드를 하나씩 고르던 옛 비교는 `firstPrompt`·`tool` 을 빠뜨려(00-analysis P7) 그 둘만 바뀐 주기가
 * emit 되지 않았다. 필드가 늘 때마다 같은 구멍이 다시 열리므로 **구조 전체**를 비교한다. 지문은 이
 * 파일의 같은 코드 경로가 만들어 키 순서가 일정하다 — 순서가 달라지면 틀리는 쪽은 "같은데 다르다"
 * (emit 한 번 더)이지 "다른데 같다"(갱신 유실)가 아니다.
 */
export function digestsEqual(input: { a: SessionDigest; b: SessionDigest }): boolean {
  return JSON.stringify(input.a) === JSON.stringify(input.b)
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
  const continuedBefore = continuedReadBytes()
  cycle += 1
  fileClaims.clear()
  const digests = new Map<string, SessionDigest>()
  /** 참조 id → 파일 키 — 주기 끝에 provider 충돌 파일의 참조를 모두 `unreadable` 로 덮는다(R3-F1, 순서 무관). */
  const fileOf = new Map<string, string>()
  /** 이번 주기에 기록 파일(정체성 dev:ino)마다 읽은 누적 판독 바이트 합 (L7 — 파일 하나·주기 1회 ≤2MB 를 파일 단위로 본다). */
  const lifecycleFileBytes = new Map<string, number>()
  let lifecycleRegistryBytes = 0
  let files = 0
  let statOnly = 0
  let bytes = 0
  let headBytes = 0
  let sidecarBytes = 0
  let lifecycleBytes = 0
  let lifecycleCatchingUp = 0
  let lifecycleMs = 0
  for (const [id, ref] of refs) {
    const read = readOne(ref)
    digests.set(id, read.digest)
    if (ref === null) continue
    files += 1
    if (read.statOnly) statOnly += 1
    bytes += read.bytes
    headBytes += read.headBytes
    sidecarBytes += read.sidecarBytes
    lifecycleBytes += read.lifecycle.bytes
    lifecycleRegistryBytes += read.lifecycle.registryBytes
    const lifecycleKey = read.lifecycle.key
    if (lifecycleKey !== null) lifecycleFileBytes.set(lifecycleKey, (lifecycleFileBytes.get(lifecycleKey) ?? 0) + read.lifecycle.bytes)
    // 이어 받은 앞 파일(LIFE-781)도 같은 계정 — 그 파일 정체성으로 센다(L7 파일 하나·주기 ≤2MB).
    const previous = read.lifecycle.previous
    if (previous !== null) {
      lifecycleBytes += previous.bytes
      lifecycleFileBytes.set(previous.key, (lifecycleFileBytes.get(previous.key) ?? 0) + previous.bytes)
    }
    if (read.digest.lifecycle.state === 'unknown' && read.digest.lifecycle.reason === 'catching-up') lifecycleCatchingUp += 1
    lifecycleMs += read.lifecycle.ms
    if (lifecycleKey !== null) fileOf.set(id, lifecycleKey)
  }
  for (const [id, fileKey] of fileOf) {
    const digest = digests.get(id)
    if (fileClaims.get(fileKey)?.conflict === true && digest !== undefined) digests.set(id, { ...digest, lifecycle: UNREADABLE })
  }
  // 이번 주기에 아무 참조도 안 쓴 장부는 회수한다 — 교체돼 떠난 inode·닫힌 pane 의 장부가 쌓이지 않는다(R3-F2).
  for (const [key, entry] of ledgers) if (entry.seen !== cycle) ledgers.delete(key)
  return {
    digests,
    cost: {
      files,
      statOnly,
      bytes,
      headBytes,
      sidecarBytes,
      ms: Date.now() - startedAt,
      lifecycleBytes,
      lifecycleMaxFileBytes: Math.max(0, ...lifecycleFileBytes.values()),
      lifecycleRegistryBytes,
      lifecycleCatchingUp,
      lifecycleMs,
      continuedBytes: continuedReadBytes() - continuedBefore,
    },
  }
}
