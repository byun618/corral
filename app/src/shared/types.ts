import type { Settings, SettingsWriteResult } from './terminal-settings.js'
import type { GhosttyImportPreview } from './ghostty-import.js'
import type { Keybindings, ShortcutMatch } from './keybindings.js'
import type { SidebarViewPrefs } from './sidebar-view.js'
import type { WindowChrome } from './window-chrome.js'
import type { MobilePairingResult, MobileStatus } from './mobile.js'
import type { ExplorerActionInput, ExplorerActionResult, ExplorerListResult, ExplorerPush } from './explorer.js'
import type { ExplorerDrop, ExplorerOpInput, ExplorerOpResult } from './explorer-ops.js'
import type { DirtyFile, FileDialogChoice, FileDialogRequest, FileReadResult, FileWatchPush, FileWriteInput, FileWriteResult, ImageReadResult } from './file-view.js'
// **경계를 건너는 타입은 전부 여기 있다** (기준 N2ⓐ).
//
// herdr 의 와이어 모양(snake_case 필드·`PaneInfo`·프로토콜 enum)은 이 파일에 한 글자도 없다.
// 어댑터가 herdr 응답을 읽어 **corral 이 정의한 이 타입으로 옮겨 담는다**. 백엔드가 바뀌면
// 고치는 곳은 어댑터 한 층이고, 이 파일과 렌더러는 그대로다 — 그게 이 경계의 존재 이유다.
//
// 규칙: 이 파일은 아무것도 import 하지 않는다. import 가 생기면 그 순간 경계가 새기 시작한다.

/**
 * corral 이 **칩으로 구분하는** 에이전트 상태. herdr 와 값이 겹치지만 corral 의 정의다.
 *
 * **`done` 이 여기 있다** (LIFE-456 — 그 전 주석의 판단을 실측으로 뒤집었다).
 * 옛 주석은 "0.9.0 은 done 을 만들지 않는다" 였고 근거는 `pane.report_agent` 가 받는
 * `PaneAgentState` 에 done 이 없다는 것이었다. 그건 **입력** 스키마다 — herdr 가 파생해
 * 내보내는 **출력**과 다른 것이었다. 실측(`raw/claude/u1/positive-control.txt`):
 * 배경 pane 에 `report-agent --state idle` 을 넣으면 herdr 가 `done` 을 내놓는다.
 * 사용자 corral 로그의 `agent_status.unmapped` 11,463 건도 전부 `wire:"done"` 이었다.
 *
 * 뜻: `done` = **idle 인데 아직 그 pane 을 안 봤다**. 보면 herdr 가 `idle` 로 내린다
 * (seen 은 herdr 가 pane 별로 들고 있고, corral 의 endpoint `pane.focus` 가 그것을 찍는다 —
 * 실측 `raw/claude/u1/u1-result-r004-polled.json`, done→idle 535ms).
 */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

/**
 * `blocked` 의 사유.
 *
 * **출처는 `agent.explain` 의 규칙 id 다**(`shared/agent-state.ts` 의 `pickBlockedRule`).
 * herdr 0.9.0 은 claude·codex·grok 의 `pane.agent_status_changed`·스냅샷 봉투에 `state_labels`
 * 를 **안 싣는다**(실측 `raw/claude/s3/s3-state-labels-findings.md`) — 그래서 봉투만 보면 늘
 * 비어 있고, corral 은 blocked 인 pane 마다 explain 을 한 번 물어 이 칸을 채운다.
 *
 * `null` 과 `'unknown'` 은 다르다: `null` = herdr 가 아무 말도 안 했다(공백),
 * `'unknown'` = 말은 했는데 그 규칙이 권한·질문을 안 가른다. 화면이 그 둘을 구분할 수 있어야
 * 「출처에 없다」와 「우리가 못 읽는다」가 같은 모양으로 안 보인다.
 */
export type BlockedReason = 'trust' | 'login' | 'permission' | 'question' | 'update' | 'unknown'

/**
 * corral 이 그 상태를 **어떻게** 알게 됐나.
 *
 * `snapshot` 은 **진입 시각이 아니다**: 부팅·30초 재동기·재연결 뒤의 첫 스냅샷은 "지금 이 값이더라"
 * 일 뿐이고 그 상태로 언제 들어갔는지는 모른다. herdr 0.9.0 스키마에 에이전트 상태 **시각** 필드가
 * 없어서(`state_change_seq` 뿐 — `raw/coordinator/c9-herdr-schema-time-fields.txt`) 진입 시각은
 * 애초에 공급할 수 없다. 화면이 경과 시간을 그릴 때 이 칸을 보고 "이건 관측 시각이지 진입 시각이
 * 아니다" 를 말할 수 있어야 한다 (표시 선택은 LIFE-448 몫).
 */
export type AgentObservedVia = 'event' | 'snapshot'

/**
 * 닫힌 pane 하나의 **마지막 기록** (S15ⓓ). `PaneRow` 와 모양이 겹치지만 **다른 것**이다 —
 * 이 pane 은 더 이상 없다. 그래서 `focused`·`cwd`·`digest` 처럼 "지금" 을 말하는 칸이 없다.
 */
export type RetainedAgentRow = {
  paneId: string
  tabId: string
  workspaceId: string
  title: string
  agent: string | null
  agentStatus: AgentStatus
  agentState: AgentState
  /**
   * 잃은 순간의 pane cwd (LIFE-467 R1). workspace 가 통째로 사라지면 `workspaceId` 로는 worktree 를 못 찾는다 —
   * 사이드바가 이 경로로 보존 행을 원래 worktree 에 붙인다. herdr 가 cwd 를 모르면 null.
   */
  cwd: string | null
  /** corral 이 그 pane 을 잃은 시각. */
  retainedAt: number
  /**
   * 잃은 순간의 provider 세션 참조 (LIFE-581 X7) — 모바일 대화 화면이 닫힌 세션의 지난 기록을 읽는 데만 쓴다(C19).
   * 데스크톱 화면은 이 칸을 읽지 않는다. 없으면(옛 행·참조를 모르던 pane) 지난 기록을 볼 수 없다.
   */
  agentSession?: AgentSessionRef | null
}

/** 지나간 상태 전이 한 칸 (S15ⓒ 이력). */
export type AgentTransition = {
  status: AgentStatus
  /** corral 이 그 상태를 **처음 관측한** 시각. */
  observedAt: number
  observedVia: AgentObservedVia
}

/**
 * pane 하나의 상태 **부가 정보** (LIFE-456 S1·S15).
 *
 * `status` 는 여기 **없다** — `PaneRow.agentStatus` 하나가 그 값의 자리다. 두 군데 두면 갈린다.
 */
export type AgentState = {
  /** S3 — `agent.explain` 이 채운다. `null` = 아무 말도 없었다, `'unknown'` = 갈래가 없다. */
  blockedReason: BlockedReason | null
  /** **지금 상태**를 corral 이 처음 관측한 시각. 같은 값이 다시 와도 갱신하지 않는다. */
  observedAt: number
  observedVia: AgentObservedVia
  /** S15ⓑ 완료 시각 — 마지막으로 `done` 에 들어간 관측 시각 (Orca `lastEnteredDoneAt` 대응). */
  enteredDoneAt: number | null
  /** S15ⓒ 지나간 전이 **최신 우선**, 지금 상태는 빼고 최대 `AGENT_HISTORY_LIMIT` 개
   *  (상수는 `shared/agent-state.ts` — 이 파일은 타입만 둔다). */
  history: readonly AgentTransition[]
}

/**
 * herdr 세션 하나 — **렌더러가 보는 만큼**.
 *
 * 소켓 경로는 여기 없다 (수정 1회차 L9). 경계의 약속이 "herdr 소켓은 main/adapter 안" 인데
 * 진단용으로 렌더러까지 실어 보내면 그 약속이 화면 상태에서 새는 꼴이다. 소켓을 들고 다니는
 * 타입은 어댑터의 `SessionHandle` 이고 그건 main 밖으로 나가지 않는다.
 */
export type SessionInfo = {
  name: string
  isDefault: boolean
  running: boolean
}

/**
 * 해소한 herdr 실행 파일 (LIFE-485 D5). 출처는 로그인 셸 조회·알려진 설치 위치·측정용 `CORRAL_HERDR_BIN`·설치본 동봉(LIFE-556)·
 * 개발 실행의 레포 guard(LIFE-561 — `npm --prefix app run herdr:guard` 가 놓은 debug 빌드).
 */
export type BackendBinary = { path: string; source: 'login-shell' | 'known-location' | 'env' | 'bundled' | 'repo-guard'; version: string | null }

/**
 * 서버를 띄우면 다시 붙을 에이전트 세션 수 (LIFE-485 D2). 개수와 종류뿐이다 — 경로·세션 id·대화 없음.
 * **모름(`known:false`)은 0 이 아니다** — 기동 결정이 확인 쪽으로 간다.
 */
export type RestoreSummary =
  | { known: true; total: number; agents: { kind: string; count: number }[] }
  | { known: false; reason: string }

/**
 * 백엔드 연결 상태 카드 (LIFE-485 D3). `ok` 면 카드가 없다.
 * - `confirm` — 서버가 꺼져 있고 사용자가 「서버 시작」 을 눌러야 띄운다. `exited` 는 연결 도중 멈춘 경우
 * - `starting` — corral 이 띄우고 준비를 기다리는 중
 * - `failed` — 띄우지 못했다(원문·로그 경로). 「다시 시도」
 * - `missing` — herdr 실행 파일을 찾지 못했다. `bundled` 면 설치본의 동봉 바이너리가 없거나 실행할 수 없다(재설치 안내 — LIFE-556)
 * - `stale` — 개발 실행의 레포 guard 가 지금 체크아웃과 맞지 않는다(LIFE-561 G3). 그 바이너리를 쓰지 않고 다른 herdr 로 내려가지도 않는다 — 재빌드 안내
 * - `bound-stopped` — 지정된 세션(프로필 바인딩·CORRAL_SESSION)이나 붙어 있던 이름 세션이 멈춰 있다. corral 은 띄우지 않는다
 * - `reconnecting` — 서버는 돌고 링크만 다시 붙는 중. 카드가 아니라 배너다 — 터미널 화면을 걷지 않는다(r1 R1-01)
 */
export type BackendStatus =
  | { kind: 'ok' }
  | { kind: 'confirm'; reason: 'stopped' | 'exited'; session: string; restore: RestoreSummary }
  | { kind: 'starting'; session: string }
  | { kind: 'failed'; session: string; error: string; logPath: string | null }
  | { kind: 'missing'; searched: string[]; bundled: boolean }
  | { kind: 'stale'; path: string; reason: string }
  /** `reason` — `bound`: 프로필 바인딩·CORRAL_SESSION 으로 지정된 세션 · `attached`: 기존 규칙으로 붙어 있던 이름 세션(r1 R1-07) */
  | { kind: 'bound-stopped'; session: string; reason: 'bound' | 'attached' }
  | { kind: 'reconnecting'; session: string; attempt: number }

/** 세션 링크가 지금 어느 걸음에 있나. */
export type LinkPhase =
  | 'idle'
  | 'connecting'
  | 'subscribing'
  | 'buffering'
  | 'snapshotting'
  | 'live'
  | 'reconnecting'
  | 'failed'

export type LinkState = {
  phase: LinkPhase
  sessionName: string | null
  attempt: number
  nextRetryInMs: number | null
  lastError: string | null
  lastPushAt: number | null
  /** 부트스트랩에서 스냅샷 전에 버퍼링한 push 수 — "구독 먼저" 가 실제로 일했다는 지문. */
  bufferedAtSnapshot: number | null
  /** 마지막 주기 재동기 시각과 그때 고친 것 (N7 의 화면 근거). */
  lastResyncAt: number | null
  lastResyncNote: string | null
  /** 지금까지 돈 재동기 횟수. */
  resyncCount: number
  /**
   * 계측용 — push 를 일부러 버리고 있나 (N7 유실 주입). 평시에는 false.
   * **어떤 이벤트를 골라 버리는지는 여기 안 싣는다** (수정 3회차 F3-L5): 그건 main 의 계측
   * 상태이고, 화면은 "주입 중" 이라는 사실만 알면 된다. 목록은 `link.drop_push` 로그에 있다.
   */
  droppingPush: boolean
}

// --- 목록 (repo → worktree → tab → pane) -------------------------------------

/**
 * 이 pane 에 붙은 에이전트가 **자기 세션을 스스로 밝힌 것** (LIFE-366).
 *
 * 출처는 herdr 가 자체 설치하는 통합 훅이다: 에이전트가 뜰 때(`SessionStart`) 훅이 herdr 소켓에
 * 자기 세션 id 를 보고하고, herdr 가 그것을 pane 에 실어 준다. corral 은 훅을 만들지도, 사용자
 * 에이전트 설정을 고치지도 않는다 (`00-analysis.md` §2.2).
 *
 * ## 왜 union 인가 — **실측은 `id` 뿐이다**
 *
 * herdr 스키마의 참조 갈래는 `id | path` 인데, 통합 3종(claude·codex·grok)을 전부 태워 보니
 * **셋 다 `id`** 로 왔다 (`raw/claude/a3-agent-session-probe.json`). claude 훅은 경로까지
 * 보내는데도 그렇다 — 경로만 보내면 herdr 는 참조 자체를 안 만든다
 * (`raw/claude/ref-semantics.json` ①). 즉 **파일을 찾는 일은 corral 몫**이다.
 * `path` 갈래는 스키마에 있어 union 으로 받아 두되, 관측된 적이 없다는 사실을 여기 적어 둔다.
 *
 * ## 한 번 박히면 안 바뀐다 (실측)
 *
 * 같은 pane 에 새 id·다른 에이전트·null 을 seq 를 올려 보고해도 herdr 는 **첫 값을 지킨다**
 * (`ref-semantics.json` ②③④). 그래서 한 pane 에서 `/clear`·`--resume` 로 세션이 갈리면
 * 참조가 낡는다 — corral 이 고칠 수 있는 자리가 아니라 herdr 상류의 일이다.
 */
export type AgentSessionRef =
  | { kind: 'id'; agent: string; source: string; id: string }
  | { kind: 'path'; agent: string; source: string; path: string }

export type PaneRow = {
  paneId: string
  tabId: string
  workspaceId: string
  title: string
  agent: string | null
  agentStatus: AgentStatus
  /** 상태의 부가 정보 — 사유·관측 시각·완료 시각·이력 (LIFE-456 S1·S15). */
  agentState: AgentState
  cwd: string | null
  focused: boolean
  /** 에이전트가 밝힌 세션 참조. 셸 탭·통합 미설치·보고 전에는 null. */
  agentSession: AgentSessionRef | null
  /** 이 pane 자신의 세션 참조에서 읽은 지문 (사이드바 세션 행). */
  digest: SessionDigest
}

/**
 * 세션 행 2차 줄에 실을 **마지막 활동 문구** (LIFE-366 ⓒ).
 *
 * `null` 하나로 뭉개지 않는다 (기준 E3): "셸 탭이라 애초에 없다" 와 "참조는 있는데 파일을
 * 못 찾았다" 와 "읽었는데 모양이 낯설다" 는 화면에서 **다르게 읽혀야 한다**. 특히 마지막 갈래는
 * 트랜스크립트 포맷이 공개 계약이 아니라는 사실(`00-analysis.md` §9.1)에 대한 대비다 —
 * 모양이 바뀌면 화면은 **모른다고 말해야지 지어내면 안 된다** (기준 A8).
 */
export type SessionActivity =
  /** 참조 자체가 없다 — 셸 탭이거나, 통합이 안 깔렸거나, 아직 보고 전이다. */
  | { state: 'none' }
  /** 참조는 있는데 그 id 의 파일을 못 찾았다 (에이전트가 다른 HOME 에서 돌거나 파일이 지워짐). */
  | { state: 'unresolved' }
  /** 파일은 찾았는데 읽지 못했다 (권한·삭제 경합 등). 사유는 진단용이라 짧게만 싣는다. */
  | { state: 'unreadable'; reason: string }
  /** 읽었는데 마지막 어시스턴트 텍스트를 못 찾았다 — 포맷이 낯설거나 꼬리 창 밖이다. */
  | { state: 'unknown-format' }
  /** 찾았다. `at` 은 그 발화의 시각(레코드 timestamp). 없으면 null. */
  | { state: 'text'; text: string; at: number | null }

/**
 * 진행 중인 도구 한 자리 (LIFE-366 B9, 수정 라운드 5).
 *
 * Orca 는 이 값을 훅에서 받지만(`agent-row-tool-preview.ts` 의 `toolName`·`toolInput`),
 * corral 은 herdr 통합이 `message` 를 안 부르므로(`00-analysis.md` §2.3) **트랜스크립트의
 * 마지막 어시스턴트 턴**에서 읽는다. `input` 은 관측된 키에서 고른 한 줄 미리보기다 —
 * 없으면 null 이고, 그때 화면은 도구 이름만 쓴다.
 */
export type SessionTool = { name: string; input: string | null }

/**
 * **마지막으로 끝난 턴의 결과** (LIFE-458 #8·#9) — provider 세션 기록의 턴 끝 표지에서 읽는다.
 *
 * `null` 은 "보고할 결과가 없다" 다: 꼬리 창에서 턴 끝 표지를 못 찾았거나, 표지 **뒤에 새 턴이
 * 시작돼** 그 결과가 풀렸다(T2). `completed` 는 정상 종료 표지를 **실제로 본** 경우에만 선다 —
 * 표지 부재를 정상 종료로 읽지 않는다.
 *
 * `interrupted` 는 "중단 표지로 끝난 턴" 이다. **사용자가 눌렀다고 단정하지 않는다** — Claude 의
 * 중단 문자열은 ESC 전용이 아니다(00-analysis §9). `reason` 은 provider 원문 값이다.
 * `failed` 의 `error` 도 원문 값이다(`rate_limit`·`server_error`·`usage_limit_exceeded` …) —
 * enum 으로 닫지 않는다. 못 읽으면 null.
 */
export type TurnOutcome =
  | { outcome: 'completed' }
  | { outcome: 'interrupted'; reason: string | null }
  | { outcome: 'failed'; error: string | null }

/** 대기 중인 질문의 선택지 하나. */
export type SessionQuestionOption = { label: string; description: string | null }

/**
 * 에이전트가 **지금 답을 기다리는** 질문 한 문항 (LIFE-458 #7). 답이 도착한 질문은 싣지 않는다.
 * `header`·`multiSelect` 는 claude 만 준다 — 다른 provider 는 null.
 */
export type SessionQuestion = {
  question: string
  header: string | null
  options: SessionQuestionOption[]
  multiSelect: boolean | null
  /** LIFE-582 — 선택지에 미리보기(`preview`)가 붙은 레이아웃(Claude). 직접 입력 행이 없다. 있을 때만 `true`. */
  preview?: true
}

/**
 * 트랜스크립트에서 읽어 낸 한 세션의 지문 — 2차 줄·제목 티어·경과 시간이 전부 여기서 나온다.
 * herdr 를 모르는 층이 만든다 (`main/transcript.ts`, `main/git-status.ts` 와 같은 결).
 */
export type SessionDigest = {
  activity: SessionActivity
  /**
   * provider 가 스스로 붙인 세션 제목 (claude 의 `ai-title` 레코드). 없으면 null.
   * **그 세션의 것임이 확인된 값만** 들어온다 (기준 C2) — 레코드의 `sessionId` 가 참조 id 와
   * 다르면 버린다.
   */
  providerTitle: string | null
  /**
   * **세션의 첫 사용자 발화**를 40자로 정제한 것 (C5, 수정 라운드 5). 없으면 null.
   *
   * 제목 티어에서 `ai-title` **아래**, 터미널 제목 **위**다 (C1′ — Orca `aiVaultTitle` 4단이
   * 라이브 제목 6단보다 위인 것과 같은 자리). 첫 발화는 세션 내내 안 바뀌므로 파일이 자라도
   * **한 번 읽어 캐시**한다 (C6).
   */
  firstPrompt: string | null
  /**
   * 마지막 어시스턴트 턴이 **도구 호출뿐일 때** 그 도구 (B9). 텍스트가 있는 턴이면 null.
   * 화면에 쓸지는 **그 pane 의 상태가 `working` 인지**가 정한다 — 판독층은 상태를 모른다.
   */
  tool: SessionTool | null
  /**
   * 마지막 활동 시각 (epoch ms). 트랜스크립트 레코드의 timestamp, 없으면 파일 mtime.
   * **렌더러가 그 행을 처음 본 시각이 아니다** — 09-gate1-fix.md E 가 지웠던 결함이 그것이었다.
   */
  lastActivityAt: number | null
  /** 마지막으로 끝난 턴의 결과 (LIFE-458 #8·#9). 없거나 새 턴이 시작돼 풀렸으면 null. */
  turnOutcome: TurnOutcome | null
  /**
   * `turnOutcome` 이 **기록된 시각** (epoch ms, LIFE-467 fix-r2 S1 · fix-r3 T1) — 결과와 **같은 출처**에서 온다:
   * claude·codex 는 그 결과를 고른 **레코드 자신의** `timestamp`(없으면 null — 다른 레코드 시각·mtime 으로 메우지 않는다),
   * grok 은 `updates.jsonl` 의 그 `turn_completed` 레코드 시각(초 단위라 그 초의 끝, 없으면 그 파일 mtime — 레코드가 쓰인
   * 뒤의 시각이라 상한이고, 결과를 남기는 쪽으로 틀린다). 결과가 없으면 null. 렌더러가 herdr working 전이와 견줘 지난 턴 결과를 거르고, null 이면 결과를 믿는다.
   */
  turnOutcomeAt: number | null
  /** 마지막으로 관측된 모델 식별자 (LIFE-458 #12). 합성·오류 레코드의 값은 쓰지 않는다. 없으면 null. */
  model: string | null
  /**
   * **사람이 친 마지막 발화** (LIFE-458 #13) — 한 줄로 접은 원문(앞 2,000자). 없으면 null.
   * 고르는 규칙은 `firstPrompt` 와 같다(하네스 주입·메타·슬래시 봉투·도구 결과 제외). 다만
   * `firstPrompt` 는 40자 **제목**으로 다듬은 값이라 같은 발화여도 문자열은 다르다.
   */
  lastPrompt: string | null
  /** 지금 답을 기다리는 질문 (LIFE-458 #7). 없으면 null — 빈 배열은 오지 않는다. */
  pendingQuestions: SessionQuestion[] | null
  /**
   * 지금 열려 있는 백그라운드 작업·서브에이전트 (LIFE-462 #10·#11). 꼬리 창이 아니라 기록 **누적 판독**에서 온다
   * (`main/transcript-lifecycle.ts`). monitoring 판단은 `shared/lifecycle.ts` 의 `isMonitoring` 한 곳이다.
   */
  lifecycle: SessionLifecycle
}

/**
 * 백그라운드 작업 하나 (LIFE-462 #10). `kind` 가 `agent` 면 비동기 서브에이전트고, 나머지는 **에이전트가 아닌 작업**이다 —
 * monitoring 은 에이전트가 아닌 작업만 센다.
 */
export type BackgroundTask = {
  /** provider 가 준 작업 id (claude `backgroundTaskId`·`taskId`·`agentId`, grok `task_id`). */
  id: string
  /** `shell` 셸 명령(claude 백그라운드 Bash · grok `bash`) · `monitor` claude Monitor · `agent` 비동기 서브에이전트. */
  kind: 'shell' | 'monitor' | 'agent'
  /** 사람이 읽을 이름 — 도구 설명, 없으면 명령 한 줄 미리보기. 둘 다 없으면 null. */
  label: string | null
  /** 시작 시각(epoch ms) — 시작 레코드의 시각. 없으면 null. */
  startedAt: number | null
}

/**
 * 아직 안 끝난 서브에이전트 하나 (LIFE-462 #11) — 부모 세션의 자식 행 재료. 자식은 자기 pane 이 없다(클릭 = 부모 pane).
 * `status` 는 기록에서 가를 수 있는 것만 싣는다 — 지금은 `running` 하나다.
 */
export type SessionSubagent = {
  /** 비동기는 `agentId`, 동기는 부르는 `tool_use` id (동기는 끝나기 전엔 agentId 가 기록에 없다). */
  id: string
  /** `Agent` 호출의 `name`. 없으면 null — 화면은 `description` 으로 떨어진다. */
  name: string | null
  description: string | null
  /** `subagent_type`. 없으면 null. */
  agentType: string | null
  /**
   * 부모가 결과를 기다리지 않는가 (`run_in_background` → `async_launched`). null = 기록으로 **증명을 못 했다** —
   * grok 은 시작 레코드에 호출 id 가 없어서, 그 자식 id 를 돌려준 `spawn_subagent` 호출 결과와 묶일 때만 확정한다.
   */
  background: boolean | null
  startedAt: number | null
  status: 'running'
}

/** 싣는 개수 상한 — 넘친 수는 `*Overflow` 로 함께 싣는다 (Orca `AGENT_STATUS_MAX_SUBAGENTS` 와 같은 32). */
export const LIFECYCLE_MAX_ITEMS = 32

/**
 * 한 세션의 백그라운드 작업·서브에이전트 목록 (LIFE-462).
 *
 * `unknown` 과 빈 목록은 다르다 — 빈 목록은 "읽었는데 열린 게 없다" 다.
 *   · `no-source`   이 provider·세션에는 읽을 출처가 없다 (codex — 기록에 끝 표지가 없다, 참조 없음)
 *   · `catching-up` 긴 파일을 앞에서부터 따라잡는 중이다 — 주기당 예산(2MB)으로 나눠 읽어 아직 끝에 못 닿았다
 *   · `unreadable`  읽다 실패했다 — 또는 읽은 것만으로는 답할 수 없다: 모양이 낯선 스냅샷(grok `tasks` 가 배열이 아님),
 *                   한도보다 긴 줄을 건너뛰어 그때 열려 있던 것의 끝을 놓쳤을 수 있음, 살아 있는 소유 프로세스의 시작 시각을 몰라
 *                   이전 프로세스의 열림과 가르지 못함
 *   · `not-running` 이 세션을 가진 살아 있는 provider 프로세스를 못 찾았다 — 프로세스가 끝나면 그 작업도 끝 통지 없이 같이
 *                   죽는다(#72171). 기록에 남은 "열림" 을 도는 중으로 싣지 않는다(L8). **끝났다는 증명은 아니다** —
 *                   레지스트리 형식이 바뀌었거나 다른 HOME 이면 살아 있어도 여기로 떨어진다(모름 쪽으로 보수적)
 *
 * `known` 의 목록은 **지금 살아 있는 소유 프로세스가 시작된 뒤** 열린 것만이다 — 그 전 프로세스(강제 종료 뒤 재개)의 열림은
 * 끝 표지가 없어도 싣지 않는다(L8, 세대 경계).
 */
export type SessionLifecycle =
  | { state: 'unknown'; reason: 'no-source' | 'catching-up' | 'unreadable' | 'not-running' }
  | {
      state: 'known'
      tasks: BackgroundTask[]
      taskOverflow: number
      subagents: SessionSubagent[]
      subagentOverflow: number
    }

/** 아무것도 못 읽은 상태의 지문. 셸 탭·통합 미설치가 여기 선다. */
export const EMPTY_SESSION_DIGEST: SessionDigest = {
  activity: { state: 'none' },
  providerTitle: null,
  firstPrompt: null,
  tool: null,
  lastActivityAt: null,
  turnOutcome: null,
  turnOutcomeAt: null,
  model: null,
  lastPrompt: null,
  pendingQuestions: null,
  lifecycle: { state: 'unknown', reason: 'no-source' },
}

export type TabRow = {
  tabId: string
  workspaceId: string
  label: string
  /** herdr 가 붙인 표찰. **순서가 아니다** — 탭을 옮겨도 안 바뀐다 (수정 1회차 M5 실측). */
  number: number
  /** 목록에서의 자리. 화면은 이 순서로 그린다. */
  order: number
  agentStatus: AgentStatus
  focused: boolean
  panes: PaneRow[]
  /** 이 탭의 세션 지문 (LIFE-366). 읽을 게 없으면 `EMPTY_SESSION_DIGEST` 와 같은 모양이다. */
  digest: SessionDigest
}

export type WorkspaceRow = {
  workspaceId: string
  label: string
  number: number
  agentStatus: AgentStatus
  focused: boolean
  tabs: TabRow[]
}

/**
 * worktree 하나의 git 상태 요약 (LIFE-357 C4). `git status --porcelain=v2 --branch` 파싱 결과다 —
 * herdr 를 모른다(경계 규칙, 이 파일 맨 위 주석). ahead·behind 는 업스트림이 없으면 null.
 */
export type GitStatusSummary = {
  branch: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  dirty: boolean
  /** git 실행 자체가 실패했을 때만 채워진다 — worktree 줄은 그래도 보인다(레포 error 필드와 같은 결). */
  error: string | null
}

/** 한 worktree(체크아웃 한 벌). 구조는 git, 열림상태는 herdr 에서 온다 (기준 N4ⓒ). */
export type WorktreeRow = {
  path: string
  /** 브랜치 이름 — 브랜치가 없으면(detached HEAD) null. 표시 문자열은 싣지 않는다(LIFE-491 — `worktree-identity.ts` 가 판정). */
  branch: string | null
  /** HEAD 의 전체 sha (`git worktree list --porcelain` 의 `HEAD` 줄). bare 레코드만 null. detached 배지가 앞 7자를 쓴다. */
  head: string | null
  /** 이 워크트리가 속한 레포의 이름(`RepoRow.name`) — detached 카드 제목 폴백(198: 브랜치 없음 → 레포 표시 이름 → 폴더 이름). */
  repoName: string
  /** 링크된 worktree 인가 (아니면 레포의 주 체크아웃). */
  isLinked: boolean
  /** herdr `worktree.list` 가 준 열린 workspace. 닫혀 있으면 null. */
  openWorkspaceId: string | null
  /** 열려 있으면 그 workspace 의 행. 닫혀 있으면 null — 그래도 worktree 줄은 보인다. */
  workspace: WorkspaceRow | null
  /** git 상태 배지 (LIFE-357 C4) — TTL 캐시로 계산한다 (main/git-status.ts). */
  gitStatus: GitStatusSummary
  /**
   * 레지스트리 메타 (LIFE-478 K1ⓐ) — `repos.json` 의 `worktrees[path]`. CLI `worktree set` 과 GUI 가 같은 칸을 쓴다.
   * 없으면 null — 제목은 브랜치로 떨어진다(`worktree-name.ts`).
   */
  displayName: string | null
  comment: string | null
  /** 부모 워크트리 경로 — 레지스트리 `parentWorktreeId`(`<repoId>::<path>`)의 경로 부분. 없으면 null. */
  parentPath: string | null
}

/** 레지스트리에 등록된 레포 하나. **목록의 루트는 이것이다** (기준 N4). */
export type RepoRow = {
  /** 레지스트리가 소유하는 유일한 영속 값 — 레포 루트 경로 (기준 N3). */
  root: string
  name: string
  /** git·herdr 조회가 실패했으면 그 사유. 레포 줄 자체는 사라지지 않는다. */
  error: string | null
  worktrees: WorktreeRow[]
}

export type RegistryState = {
  /** 레지스트리 파일이 실제로 어디 있나 — A2 의 근거이자 격리 확인용. */
  file: string
  roots: string[]
  lastError: string | null
}

// --- 라이프사이클 (R3 — LIFE-356) --------------------------------------------

/**
 * 행 생성 시 고르는 종류. **corral 의 enum 이다** — 값이 herdr `kind` 문자열과 겹치지만
 * 옮기는 것은 어댑터가 한다 (`shell` 은 agent.start 를 안 부른다는 뜻의 corral 값).
 */
export type AgentKind = 'claude' | 'codex' | 'grok' | 'shell'

/** 세션 지문을 읽을 수 있는 에이전트 — `AgentKind` 에서 `shell` 을 뺀 것. */
export type TranscriptAgent = 'claude' | 'codex' | 'grok'

/**
 * herdr 통합 훅이 그 에이전트에 깔려 있나 (LIFE-366 A1·B8).
 *
 * 이 값이 `not-installed` 이면 `agentSession` 이 영영 안 오고, 그러면 2차 줄도 못 채운다.
 * 화면이 조용히 빈 줄을 보이면 사용자는 **고장으로 읽는다** — 그래서 이 사실을 올려 보낸다.
 * 설치하는 것은 herdr 가 할 일이고 corral 은 상태만 읽는다 (`00-analysis.md` §2.2 — 뒤집힌 전제).
 */
export type IntegrationRow = {
  agent: TranscriptAgent
  state: 'not-installed' | 'current' | 'outdated'
}

/**
 * 행 생성 결과 (L1·L2). `tab.create` → (셸이 아니면) `agent.start` 재시도.
 * 성공은 "걸었다"(launch_pending)까지다 — 기동 판정은 store 의 상태 칩이 뒤이어 반영한다.
 */
export type CreateRowResult = {
  ok: boolean
  paneId: string | null
  tabId: string | null
  /** `agent_pane_busy` 를 corral 이 흡수한 재시도 횟수 (L2 의 화면 근거). */
  retries: number
  error: string | null
}

/**
 * 행 종료 결과 (L3·L4·L9a). **판별자는 herdr `pane.process_info` 다** (관문 ⑤) —
 * 포그라운드 프로세스 그룹이 셸 pid 와 같으면 잃을 게 없다(즉시 닫힘), 다르면 확인.
 * `confirmed:true` 로 다시 부르면 확인 걸음을 건너뛴다.
 *
 * discriminated union — 화면은 `outcome` 으로 갈래를 정한다:
 *   · closed        — 닫혔다
 *   · needs-confirm — 산 프로세스가 있다. 모달을 띄우고 `foreground` 를 보인다
 *   · rejected      — herdr 가 그룹 닫기를 거절했다 (L9a). **그대로 보이고 멈춘다**
 *   · error         — 그 밖의 실패
 */
export type CloseRowResult =
  | { outcome: 'closed' }
  | { outcome: 'needs-confirm'; foreground: string[] }
  | { outcome: 'rejected'; rejection: { code: string; message: string } }
  | { outcome: 'error'; error: string }

/** 닫기 게이트가 「실행 중」으로 판정한 pane 하나 (LIFE-495) — 탭 여럿을 한 모달에 모으고, 에이전트 문구를 가르는 데 쓴다. */
export type RunningPane = { tabId: string; paneId: string; foreground: string[] }

/**
 * 탭 여럿 닫기 결과 (LIFE-495 K2ⓒ·K3ⓒ). 단건 닫기도 이 길이다(탭 하나짜리 목록).
 *   · closed        — 다 닫았다(`closed` = 실제로 닫은 탭. 그 사이 사라진 탭은 빠진다)
 *   · needs-confirm — 실행 중인 pane 이 있거나(`running`) 확인을 요구했다(`alwaysConfirm` — 핀 탭). **하나도 안 닫았다**
 *   · rejected / error — 앞에서부터 닫다가 멈췄다. `closed` 는 멈추기 전까지 닫은 탭
 */
export type CloseTabsResult =
  | { outcome: 'closed'; closed: string[] }
  /** `closed` = 확인 뒤 닫다가 새 실행 중을 만나 멈췄을 때 그 전까지 닫은 탭(fix1 R1-05). 확인 전이면 빈 배열. */
  | { outcome: 'needs-confirm'; closed: string[]; running: RunningPane[] }
  | { outcome: 'rejected'; closed: string[]; rejection: { code: string; message: string } }
  | { outcome: 'error'; closed: string[]; error: string }

/**
 * 탭 이름 변경 결과 (LIFE-357 I-7). 종료 게이트가 없으니 `needs-confirm` 이 없다 —
 * 이름은 잃을 게 없는 조작이다. herdr 거절은 **그대로** 올라온다(승격 금지, `closeRow` 와 같은 기준).
 */
export type RenameRowResult =
  | { outcome: 'renamed' }
  | { outcome: 'rejected'; rejection: { code: string; message: string } }
  | { outcome: 'error'; error: string }

/**
 * worktree/workspace 열기·만들기 결과 (L6·L7·L8).
 * `rejection` 은 herdr 가 그대로 돌려준 거절(예 `workspace_group_close_required`,
 * `linked_worktree_source`) — 화면에 그대로 보인다. corral 이 승격하지 않는다 (기준 L9).
 */
/**
 * 카드 메뉴 동작 (LIFE-478) — 레지스트리 쓰기·삭제는 main 이 **CLI 와 같은 런타임 명령**(`worktree set`·`worktree rm`)을
 * 같은 디스패처로 돌린 결과다. 실패는 런타임 오류 코드(`dirty_worktree`·`worktree_busy`·`backend_unavailable`·`locked_worktree`…)와
 * 원문을 그대로 싣는다 — 화면이 오류로 보여 준다(조용히 삼키지 않는다, K1ⓓ).
 */
export type CardActionError = { ok: false; code: string; error: string }
/** 준 칸만 바꾼다. `null` = 지움(표시 이름 → 브랜치로 되돌림 · 부모 해제). */
export type WorktreeMetaUpdate = { path: string; displayName?: string | null; comment?: string | null; parentPath?: string | null }
export type WorktreeMetaResult = { ok: true } | CardActionError
/** 삭제 확인 대화가 열릴 때 읽는 사실 — 결정은 하지 않는다(결정은 `worktree rm`). */
export type WorktreeDeletePreview =
  | {
      ok: true
      path: string
      branch: string | null
      isMain: boolean
      locked: boolean
      /** `git status --porcelain --untracked-files=all` 줄 수 — 강제 삭제가 버리는 변경. */
      dirtyCount: number
      /** 살아 있는 터미널 수(`worktree rm` 의 바쁨 판정과 같은 관측). herdr 링크가 없으면 null + `backendError`. */
      liveSessions: number | null
      backendError: string | null
      /** 이 워크트리를 부모로 둔 워크트리 경로 — 삭제하면 링크가 풀린다. */
      childPaths: string[]
    }
  | CardActionError
export type WorktreeDeleteResult = { ok: true; preservedBranch: string | null; warning: string | null } | CardActionError
export type ShellActionResult = { ok: true } | CardActionError

export type WorktreeActionResult = {
  ok: boolean
  workspaceId: string | null
  rejection: { code: string; message: string } | null
  error: string | null
  /**
   * 양성 중복 — 이미 여는 중이라 이 호출이 아무것도 안 했다 (수정 2회차 F-2). 렌더러는 이걸
   * 보고 알림을 띄우지 않는다 (문자열 비교 대신 필드로 판별 — 문구가 바뀌어도 안 깨진다).
   */
  deduped?: boolean
  /**
   * linked worktree 를 열며 부모(주 체크아웃) workspace 를 **이 호출이 함께 열었다** (게이트 ① G4).
   * herdr `worktree.open` 은 부모가 열려 있어야 하는 제약(P3) 때문에 부모가 딸려 열린다 — 그 사실을
   * 화면에 한 줄 알린다 (탭을 숨기지 않는다 = 상태 왜곡 금지, 기준 N8). 이미 열려 있었으면 false.
   */
  parentOpened?: boolean
}

export type AddRepoResult = { ok: boolean; root?: string; error?: string }

/**
 * 레포 하나를 목록에서 뺀 결과 (게이트 ① 3번째 지시, 2026-09-12).
 *
 * 빼는 것은 **corral 레지스트리의 그 줄 하나**뿐이다. 디스크의 폴더도, herdr 세션도 건드리지
 * 않는다 — 그래서 여기 돌려줄 것도 "어느 루트가 빠졌나" 하나로 족하다.
 */
/** `registryGeneration` = 제거 트랜잭션 안의 목록(그 root 가 없는 목록)을 관측한 세대(성공일 때만) — 렌더러가 제거 뒤의 상태를 알아본다(LIFE-469 R2-01·R4-01). */
export type RemoveRepoResult = { ok: boolean; root?: string; error?: string; registryGeneration?: number }

/**
 * 「폴더 찾아보기」 한 번의 결과 (게이트 ① 2번째 지시, 2026-09-12).
 *
 * 고른 폴더 하나가 여러 줄이 될 수 있어서 목록으로 돌려준다 — 레포가 많은 폴더를 고르면
 * **바로 아래 1단계 자식** 중 git 레포를 전부 넣는다. 화면이 "몇 개 넣었나" 를 말하려면
 * 넣은 것·이미 있던 것·실패한 것이 갈려 있어야 한다. 그래서 셋을 따로 싣는다.
 *
 * `canceled` 는 실패가 아니다 — 사용자가 네이티브 다이얼로그를 그냥 닫은 것이고,
 * 그때 화면은 아무 말도 하지 않는다.
 */
export type BrowseReposResult = {
  ok: boolean
  canceled: boolean
  /** 사용자가 고른 폴더. 취소면 null. */
  selected: string | null
  /** 고른 폴더 자체가 레포였나(`repo`), 아니면 자식을 훑었나(`scan`). 취소면 null. */
  mode: 'repo' | 'scan' | null
  /** 이번에 새로 들어간 레포 루트. */
  added: string[]
  /** 이미 레지스트리에 있던 것 — "0개 등록" 과 구분해야 안내가 안 거짓말한다. */
  alreadyRegistered: string[]
  failed: Array<{ path: string; error: string }>
  /** 화면에 그대로 띄우는 한 줄. 취소면 null. */
  message: string | null
}

// --- 화면 UI 상태 영속 (LIFE-357 C2·C3) --------------------------------------

/**
 * 사이드바 폭·접힘 상태 (main/ui-prefs.ts 가 파일로 영속). `localStorage` 가 아니라 IPC 로
 * main 에 저장한다 — 프로덕션 빌드(file:// 렌더러)에서 LocalStorage 커밋이 디스크에 반영되지
 * 않는 현상을 실측했다(ui-prefs.ts 주석 참고). `collapsedRepos`는 레포 루트 목록,
 * `collapsedGroups`는 AgentGroupHeader 가 접힌 worktree 경로 목록 — 접힌 것만 담는다(기본은 펼침).
 */
/**
 * 폴백 번호 배정 한 칸 (LIFE-366 C13, 수정 라운드 8) — `terminal N`·`claude N` 의 N.
 *
 * Orca 는 이 값을 `tab.defaultTitle` 에 저장한다. corral 은 herdr `tab.label` 에 **쓰면 안 되므로**
 * (`userLabel` 이 사용자 이름으로 읽어 G5 가 되살아난다) 화면 영속 파일에 싣는다.
 */
export type TabOrdinal = { tabId: string; groupId: string; ordinal: number }

export type UiPrefs = {
  sidebarWidth: number | null
  sidebarCollapsed: boolean
  collapsedRepos: string[]
  collapsedGroups: string[]
  /**
   * 에이전트 묶음 알약을 **펼쳐 둔** worktree 경로 (LIFE-467). 알약은 기본 접힘(Orca compact 와 같다)이라 펼친 것만 담는다.
   * `collapsedGroups`(옛 헤더의 접힌 목록, 기본 펼침)와 뜻이 반대라 같은 칸을 재해석하지 않고 따로 둔다.
   */
  expandedAgentGroups: string[]
  /** 폴백 번호 배정표 (C13) — 재기동해도 같은 탭이 같은 번호를 쓴다. */
  tabOrdinals: TabOrdinal[]
  /**
   * worktree 별 영역 배치 (LIFE-373 F1-6 · R3-h). 모양은 렌더러 `group-tree.ts` 가 안다 —
   * 여기서는 실어 나르기만 하므로 `unknown[]` 이다(저장소가 트리 모양을 또 알면 두 진실이 된다).
   */
  groupLayouts: unknown[]
  /**
   * 사이드바 레포 수동 순서 — 레포 root, 위에서 아래 (LIFE-469). 목록에 없는 레포는 맨 아래(198 과 같다).
   * 정렬 **모드** 칸은 따로 없다 — S4(Sort by·Project order)가 이 데이터 옆에 모드를 얹는다.
   */
  manualRepoOrder: string[]
  /** 레포 root → 연결 워크트리 path 수동 순서(주 체크아웃 제외, 맨 위 고정) (LIFE-469). 없는 레포는 기본 순서. */
  manualWorktreeOrder: Record<string, string[]>
  /**
   * Group by None 의 수동 순서 — 워크트리 path, 위에서 아래 (LIFE-470). None 에서 끌어 놓을 때만 적는다. 비면 레포 순서 →
   * 레포 안 순서를 이어 붙인 순서로 읽는다(`manual-order.ts` `orderAll`).
   */
  manualFlatOrder: string[]
  /**
   * 고정한 워크트리 경로 (LIFE-478 K5 · 게이트 ⓪ Q1) — Pinned 구획에 모이는 순서는 현재 정렬을 따른다(198, 고정 시각 없음).
   * 레지스트리가 아니라 여기 두는 이유: 접힘·수동 순서와 같은 사이드바 화면 상태다. 없는 경로는 화면이 무시한다.
   */
  pinnedWorktrees: string[]
  /** 「N 하위」 를 접은 부모 워크트리 경로 (LIFE-576 D6) — 기본 펼침, 접은 것만. 경로 키인 이유는 `pinnedWorktrees` 와 같다. */
  collapsedLineage: string[]
  /**
   * 안 읽음 벨이 켜진 워크트리 경로 (LIFE-471 · 게이트 ⓪ Q1 — 198 `worktree.isUnread`). 경로 키인 이유는 `pinnedWorktrees` 와 같다.
   * pane 단위 안 읽음은 여기 두지 않는다 — paneId 는 herdr 재기동 때 다시 매겨진다(00-analysis F13).
   */
  unreadWorktrees: string[]
  /**
   * 탭 핀·색 (LIFE-495 K3·K4) — `{tabId, workspaceId, pinned, color}` 목록. 모양은 렌더러 `tab-marks.ts` 가 안다(`groupLayouts` 처럼
   * 여기서는 실어 나르기만 한다). 키가 herdr tab id 라 herdr 가 재기동하면 배치·폴백 번호와 같이 잃는다(00-analysis F13).
   */
  tabMarks: unknown[]
  /**
   * 오른쪽 패널·탐색기 (LIFE-589 E1ⓑ·E2ⓓⓔ) — 열림·폭과 표시 토글. 범위는 **전역**(worktree 별이 아니다 — VS Code `files.exclude`·
   * Orca 「Show Git Ignored Files」 처럼 보기 설정이라 worktree 를 바꿔도 같은 눈으로 본다). 기본: 닫힘 · 폭 null(토큰) · dotfile 보임 · ignored 보임(흐림).
   */
  rightPanelOpen: boolean
  rightPanelWidth: number | null
  explorerShowDotfiles: boolean
  explorerShowIgnored: boolean
} & SidebarViewPrefs

// --- 터미널 스트림 (R2 — LIFE-353) -------------------------------------------

/** 스트림 링크가 지금 어느 걸음에 있나. link 의 LinkPhase 와 별개다 — 소켓이 다르다. */
export type TerminalPhase = 'idle' | 'connecting' | 'streaming' | 'failed'

export type TerminalState = {
  /** 지금 스트리밍 중(또는 시도 중)인 pane. 없으면 null. */
  paneId: string | null
  phase: TerminalPhase
  /** 마지막 프레임의 크기 (crop 결과 = pane 내용 영역). 아직 없으면 null. */
  cols: number | null
  rows: number | null
  /** 마지막 프레임 기준 — 이 pane 의 앱이 마우스를 받겠다고 했나. */
  mouseReporting: boolean
  lastError: string | null
}

/**
 * 터미널 프레임 하나 — main → renderer 로 미는 페이로드.
 *
 * `data` 는 ANSI 바이트다 (전체 리페인트, DEC 2026 BSU/ESU 로 감쌈 — 어댑터가 만든
 * **corral 의 표현**이고 herdr 와이어 모양이 아니다). Uint8Array 로 보낸다 —
 * structured clone 이 복사 없이 나르고, base64 왕복이 없다.
 */
export type TerminalFrame = {
  paneId: string
  seq: number
  cols: number
  rows: number
  mouseReporting: boolean
  data: Uint8Array
}

/** renderer → main 스크롤 요청. 좌표는 pane 내용 영역 기준 0-기반 셀. */
export type TerminalScroll = {
  direction: 'up' | 'down'
  lines: number
  column: number | null
  row: number | null
}

/** pane 리사이즈·이웃 이동의 방향. */
export type PaneDirection = 'left' | 'right' | 'up' | 'down'

/** **분할**의 방향은 둘뿐이다 — herdr 스키마 `SplitDirection` 에 좌/상 분할이 없다. */
export type PaneSplitDirection = 'right' | 'down'

/** pane 조작 결과 — 실패는 화면에 문구로 뜬다 (herdr 응답을 그대로 흘리지 않는다). */
export type PaneActionResult = { ok: true } | { ok: false; error: string }

/** 이웃 찾기 결과 — 포커스 이동은 렌더러가 한다 (선택 pane 의 주인이 렌더러라서). */
export type PaneNeighborResult = { ok: true; paneId: string | null } | { ok: false; error: string }

/**
 * 분할 결과 — **새 pane 의 id 를 얹는다** (F2-7). `PaneNeighborResult` 와 같은 모양이다:
 * 서버 포커스는 안 옮기고(`focus: false`) 선택을 옮기는 것은 렌더러다.
 * herdr 가 id 를 안 주면 `paneId: null` — 그때는 선택이 그대로 남는다(지어내지 않는다).
 */
export type PaneSplitResult = { ok: true; paneId: string | null } | { ok: false; error: string }

/** 셀 좌표 사각형 — 탭 격자(=한 연결이 받는 서피스) 기준. */
export type TerminalCellRect = { x: number; y: number; width: number; height: number }

/**
 * 영역이 붙은 탭 안 pane 하나의 기하 (LIFE-373 ②).
 *
 * **셀 단위**다. 렌더러는 이 값에 바닥 셀 크기를 곱해 pane DOM 상자를 만든다 — 픽셀에서
 * cols 를 되짚는 반대 방향은 쓰지 않는다 (§10-R13: herdr rect → DOM 이 진실 방향).
 */
export type TerminalPaneView = {
  paneId: string
  /** 장식(테두리·스크롤바) 포함 바깥 사각형. */
  rect: TerminalCellRect
  /** 내용만 — xterm 에 실리는 범위. */
  innerRect: TerminalCellRect
  focused: boolean
  mouseReporting: boolean
}

/** 영역 하나 = endpoint 연결 하나의 상태 (main → renderer). */
export type TerminalGroupState = {
  groupId: string
  /** 이 연결이 붙어 있는 탭. 아직 안 붙었으면 null. */
  tabId: string | null
  phase: TerminalPhase
  /** 마지막으로 요청한 탭 격자. */
  grid: { cols: number; rows: number } | null
  panes: TerminalPaneView[]
  /** 줌 중인 pane (클라이언트가 그린다 — 서버 rect 는 안 바뀐다). */
  zoomedPaneId: string | null
  lastError: string | null
}

/**
 * 렌더러가 선언하는 영역 구성 (renderer → main).
 *
 * 명령이 아니라 **선언**이다 — main 이 현재 연결과 대조해 열고·닫고·탭을 옮기고·격자를 맞춘다.
 * 부팅 복원·재접속·worktree 전환이 전부 이 한 길로 들어와 attach 순서(S2-b)가 한 곳에서 지켜진다.
 */
export type TerminalGroupRequest = {
  groupId: string
  tabId: string
  /** 이 탭에서 활성인 pane — attach 의 `pane.focus` 대상. */
  activePaneId: string
  /** 영역 상자가 정한 탭 격자 (셀). */
  cols: number
  rows: number
  /** 활성 영역인가 — attach 순서에서 **마지막**에 붙는다 (S2-b). */
  active: boolean
}

export type AppState = {
  revision: number
  sessions: SessionInfo[]
  sessionsError: string | null
  selectedSession: string | null
  /** 세션을 왜 그것으로 골랐나 / 왜 못 골랐나 (수정 1회차 M6). 평시에는 null. */
  sessionNote: string | null
  link: LinkState
  /** 백엔드 연결 상태 카드 (LIFE-485). */
  backend: BackendStatus
  registry: RegistryState
  /**
   * 레지스트리 세대 — main 이 관측한 등록 목록이 **직전 관측과 다를 때** 1 오른다(LIFE-469 R2-01·R3-01·R4-01,
   * `main/registry-generation.ts`). 변경 횟수가 아니다 — 관측 사이의 여러 변경은 한 번으로 합쳐지고, 관측 사이에 원래
   * 목록으로 돌아온 변경·이미 등록된 레포의 중복 추가는 세지 않는다. 출처는 GUI·CLI·앱 밖 편집을 가리지 않는다.
   * `registry.roots` 와 같은 읽기의 값이다. 렌더러가 「제거 뒤에 다시 등록됐다」를 옛 스냅샷과 구분하는 데 쓴다.
   */
  registryGeneration: number
  repos: RepoRow[]
  terminal: TerminalState
  /**
   * 영역별 스트림 상태 (LIFE-373). `terminal` 은 그중 **포커스 pane** 하나를 추린 것이라
   * LIFE-353 의 단일 pane 계약이 그대로 산다 (§10-R5).
   */
  terminalGroups: TerminalGroupState[]
  /**
   * herdr 통합 설치 상태 3종 (LIFE-366 A1). 아직 못 읽었으면 빈 배열 —
   * 화면은 "미설치" 와 "아직 모름" 을 구분해야 하므로 빈 배열을 미설치로 읽지 않는다.
   */
  integrations: IntegrationRow[]
  /**
   * 닫힌 pane 의 **마지막 완료 기록** (LIFE-456 S15ⓓ, 최신 우선).
   *
   * 산 pane 목록과 **섞지 않는다** — 섞으면 화면이 이미 없는 pane 에 입력을 보내려 든다.
   * 메모리에만 있고 앱을 다시 켜면 비어 있다(그 사이에 끝난 턴을 확인할 길이 없어서다).
   */
  retainedAgents: readonly RetainedAgentRow[]
  /** 개발·계측 실행에서만 켜지는 진단 표시. */
  diagnostics: boolean
  /**
   * 이 프로세스의 홈 디렉터리 (LIFE-366 C9, 수정 라운드 7).
   *
   * 셸 탭 폴백이 **홈 상대 경로**(`~/…`)를 잘라 쓰는데, 렌더러에는 `HOME` 을 알 길이 없다
   * (`os` 를 못 쓴다 — 경계 규칙). 그래서 main 이 자기 값을 한 번 실어 보낸다. 계측 실행은
   * 격리 HOME 으로 앱을 띄우므로 이 값도 그 격리 HOME 이다 — 화면이 사용자 홈을 가정하면
   * 격리 실행에서 접히지 않는다.
   */
  home: string
  /**
   * orchestration 계보 — 어느 워커 pane 이 어느 pane 에서 띄워졌나 (LIFE-459). 표시는 LIFE-448.
   * 서브에이전트 계보(LIFE-462)와 섞지 않으려고 이름에 orchestration 을 박는다.
   */
  orchestrationLineage: OrchestrationLineage
  /**
   * herdr 세션의 **모든** 산 탭 id (LIFE-507) — 링크가 live 일 때만, 아니면 null(「지금은 모른다」 — 빈 배열과 구분한다). 등록 레포 밖 워크스페이스의 탭도 든다.
   * 폴백(`pickSessionName` — default 정지 → 다른 실행 세션)으로 「제 세션」(`CORRAL_SESSION` 지정 시 그것, 아니면 default)이 아닌 세션에 붙었어도 null 이다 —
   * 남의 세션 탭 목록으로 제 세션의 칸을 지우지 않는다(fix1 R1-M1).
   * 화면 영속 자료(핀·색 `tabMarks` · 폴백 번호 `tabOrdinals` · 영역 배치 `groupLayouts`)에서 **herdr 에 이제 없는 탭**의 칸을 지우는 근거다 —
   * herdr 0.9.0 은 닫힌 워크스페이스의 id 를 재기동 뒤 새 워크스페이스에 다시 쓰므로(00-analysis F2) 남겨 둔 옛 칸이 새 탭에 붙는다.
   */
  herdrTabIds: string[] | null
}

/**
 * 워커 pane 하나의 계보 (LIFE-459). `paneId`·`parentPaneId` 는 `PaneRow.paneId` 와 같은 이름공간이다 —
 * 단 `OrchestrationLineage.state === 'ready'` 일 때만. 부모는 **틀릴 바에야 없다**: 세션·세대가 하나라도
 * 어긋나면 `null` 이다. 공급 단계에서 순환 없는 숲을 보장한다.
 */
export type OrchestrationLineageEntry = {
  /** 워커(자식) pane. 그 pane 에 붙은 **최신** worker Dispatch 하나만 싣는다. */
  paneId: string
  runId: string
  taskId: string
  dispatchId: string
  dispatchStatus: 'dispatched' | 'completed' | 'failed' | 'unknown'
  /** 이 Dispatch 를 띄운 `worker-start` 호출자 pane. herdr pane 밖·세대 불일치·순환 절단이면 null. */
  parentPaneId: string | null
}

/**
 * `unavailable` 은 "계보가 없다" 가 아니라 "지금은 판단할 수 없다" 다 — 빈 배열과 구분한다.
 * 사유: 런타임에 백엔드 없음 · 화면 세션과 런타임 세션이 다름 · 저장소를 못 읽음 · pane 을 못 봄.
 */
export type OrchestrationLineage =
  | { state: 'ready'; entries: OrchestrationLineageEntry[] }
  | { state: 'unavailable'; reason: 'no_backend' | 'session_mismatch' | 'store_unreadable' | 'unobserved' }

/** preload 가 렌더러에 노출하는 표면. 여기 없는 것은 렌더러가 부를 수 없다. */
/**
 * main 이 `before-input-event` 에서 가로챈 단축키 (F2-5a · R23).
 *
 * 메뉴 액셀러레이터는 페이지 keydown 보다 먼저 처리돼서 렌더러가 볼 수 없다. main 이
 * `preventDefault()` 로 삼킨 뒤 **뜻**을 이 채널로 넘긴다 — 키 코드는 넘기지 않는다.
 */
export type CorralShortcut = ShortcutMatch

/** ⌘V 이미지 붙여넣기 — main 이 클립보드 이미지를 임시 PNG 로 쓴 결과 (LIFE-497 · D41). */
export type ClipboardImageSaveResult =
  | { status: 'saved'; path: string }
  | { status: 'empty' }
  | { status: 'failed'; error: string }

/**
 * OS 파일 드롭 — preload 가 `webUtils.getPathForFile` 로 경로를 얻어 **드롭 지점의 pane** 과 함께 넘긴다 (D43).
 * 거부(상한 초과·경로 없음)도 같은 채널로 와서 렌더러가 남긴다 — 조용히 사라지지 않게.
 */
export type TerminalFileDrop =
  | { status: 'dropped'; paneId: string; paths: string[] }
  | { status: 'rejected'; paneId: string; reason: 'too-many-paths' | 'unresolved-paths'; count: number }

export type CorralApi = {
  getState: () => Promise<AppState>
  /** 새로고침 버튼 (LIFE-445) — git 을 다시 읽어 골격을 세운 뒤의 상태. */
  refreshTree: () => Promise<AppState>
  onTerminalFocus: (listener: (request: { id: string; paneId: string; deadlineAt: number }) => void) => () => void
  terminalFocused: (id: string, paneId: string) => void
  onRevealPane: (listener: (paneId: string) => void) => () => void
  onState: (listener: (state: AppState) => void) => () => void
  addRepo: (root: string) => Promise<AddRepoResult>
  removeRepo: (root: string) => Promise<RemoveRepoResult>
  browseForRepos: () => Promise<BrowseReposResult>
  refreshSessions: () => Promise<void>
  /** 「서버 시작」·「다시 시도」 (LIFE-485). 결정은 main 이 다시 한다 — 이미 돌면 아무것도 안 띄운다. */
  startBackend: () => Promise<void>
  // --- 화면 UI 상태 영속 (C2·C3) ---
  getKeybindings: () => Promise<Keybindings>
  saveKeybindings: (overrides: Keybindings) => Promise<{ ok: true; overrides: Keybindings } | { ok: false; error: string }>
  setShortcutRecording: (active: boolean) => Promise<void>
  getUiPrefs: () => Promise<UiPrefs>
  setUiPrefs: (patch: Partial<UiPrefs>) => void
  /** 사용자 설정(LIFE-512) — 부팅 때 한 번 동기로 읽는다. 이후 변경은 `onSettings` 푸시로 받는다. */
  getSettingsSync: () => Settings
  /** 부분 갱신 — main 이 칸별로 검증해 적용하고, 바뀌었으면 `onSettings` 로 민다. 검증 뒤 전체 값을 돌려준다. */
  setSettings: (patch: Partial<Settings>) => Promise<SettingsWriteResult | null>
  onSettings: (listener: (settings: Settings) => void) => () => void
  /** Ghostty 설정 가져오기 미리보기(LIFE-513) — 인자 없음, 아무것도 쓰지 않는다. 다른 창이 부르면 null. */
  previewGhosttyImport: () => Promise<GhosttyImportPreview | null>
  // --- 라이프사이클 (R3) ---
  /** 열린 workspace 에 새 행을 만든다 (tab.create → agent.start 재시도). */
  createRow: (input: { workspaceId: string; kind: AgentKind; cwd?: string; label?: string }) => Promise<CreateRowResult>
  /** 행(탭)을 닫는다. 판별자는 herdr process_info. `confirmed` 면 확인 걸음을 건너뛴다. */
  closeRow: (input: { tabId: string; confirmed?: boolean }) => Promise<CloseRowResult>
  /**
   * 탭 여럿을 **게이트 한 번**으로 닫는다 (LIFE-495). 실행 중 판정을 다 모아 한 번에 돌려주고, `confirmed` 로 다시 부르면 전부 닫는다.
   * `alwaysConfirm` 이면 실행 중이 아니어도 `needs-confirm` 으로 멈춘다(핀 탭 닫기 확인 — 실행 중이면 같은 응답에 실린다).
   */
  closeTabs: (input: { tabIds: string[]; confirmed?: boolean; alwaysConfirm?: boolean; confirmedPaneIds?: string[] }) => Promise<CloseTabsResult>
  /**
   * 탭 이름을 사용자가 준 이름으로 바꾼다 (I-7). herdr `tab.rename` 한 번 — corral 은 이름을
   * 따로 저장하지 않는다(herdr 가 들고 있고 재기동해도 남는다).
   */
  renameRow: (input: { tabId: string; label: string }) => Promise<RenameRowResult>
  /** 열린 worktree(=workspace)를 닫는다 (L9b). 그룹 열린 primary 면 herdr 가 거절 → 그대로 보인다. */
  closeWorktree: (input: { workspaceId: string; confirmed?: boolean }) => Promise<CloseRowResult>
  /** 닫힌 worktree 행을 연다. 주 체크아웃(isLinked=false)은 workspace.create, linked 는 worktree.open. */
  openWorktree: (input: { repoRoot: string; path: string; isLinked: boolean }) => Promise<WorktreeActionResult>
  /** 새 linked worktree 를 만든다 (branch·path 지정). OS 다이얼로그 없이 텍스트 입력으로. */
  createWorktree: (input: { repoRoot: string; branch: string; path: string }) => Promise<WorktreeActionResult>
  // --- 카드 메뉴 (LIFE-478) — 경로는 main 이 등록된 레포·워크트리인지 다시 본다 ---
  setWorktreeMeta: (input: WorktreeMetaUpdate) => Promise<WorktreeMetaResult>
  previewWorktreeDelete: (input: { path: string }) => Promise<WorktreeDeletePreview>
  deleteWorktree: (input: { path: string; force: boolean }) => Promise<WorktreeDeleteResult>
  /** Finder 에서 보이고 선택(`shell.showItemInFolder`). `kind` = 워크트리 카드 / 레포 헤더. */
  revealInFinder: (input: { path: string; kind: 'worktree' | 'repo' }) => Promise<ShellActionResult>
  openInEditor: (input: { path: string }) => Promise<ShellActionResult>
  copyPath: (input: { path: string }) => Promise<ShellActionResult>
  // --- 탐색기 (LIFE-589 F1) — 읽기 전용. root = 열린 worktree 경로, rel = 루트 기준 상대 경로('' = 루트). main 이 가둔다 ---
  explorerList: (input: { root: string; rel: string }) => Promise<ExplorerListResult>
  /** 감시 구독 켜기·끄기 — 렌더러는 「패널 열림 + 활성 worktree」 하나만 켠다. 결과·변경은 `onExplorerEvent` 로 온다. */
  explorerWatch: (input: { root: string; on: boolean }) => Promise<{ ok: true } | { ok: false; code: string }>
  /** 안전망·새로고침 — git 상태를 바로 다시 읽게 한다. */
  explorerRefreshGit: (root: string) => void
  /** 우클릭 메뉴 동작(E6) — 경로 복사·상대 경로 복사·Finder·터미널에서 열기. */
  explorerAction: (input: ExplorerActionInput) => Promise<ExplorerActionResult>
  onExplorerEvent: (listener: (event: ExplorerPush) => void) => () => void
  // --- 탐색기 파일 조작 (LIFE-592 F4) — 만들기·이름 변경/이동·휴지통·되살리기·복제·가져오기. 가둠·덮어쓰기 금지·휴지통은 main(`explorer-ops.ts`) ---
  explorerOp: (input: ExplorerOpInput) => Promise<ExplorerOpResult>
  /** 탐색기 트리가 활성 요소가 됐다/떠났다 — main 이 그동안만 ⌘Z·⌘⇧Z 를 탐색기 실행 취소로 가져온다(`raw/claude/undo-routing.md`). */
  explorerFocus: (focused: boolean) => void
  /** OS 에서 탐색기에 파일을 떨어뜨렸다(preload 가 원본 경로를 main 에 직접 맡기고 표지만 넘긴다 — E7ⓓ). */
  onExplorerDrop: (listener: (drop: ExplorerDrop) => void) => () => void
  // --- 파일 탭 (LIFE-590 F2) — 읽기 전용 내용. root = 열린 worktree 경로, rel = 루트 기준 상대 경로. main 이 가두고 상한·바이너리를 판정한다 ---
  readFile: (input: { root: string; rel: string }) => Promise<FileReadResult>
  /** 이미지 바이트(LIFE-590 E4ⓔ) — 렌더러가 createImageBitmap·인라인 SVG 로 그린다(URL 없음 — CSP 무변경). */
  readImage: (input: { root: string; rel: string }) => Promise<ImageReadResult>
  /** 열린 파일 탭 감시 집합(LIFE-590 E5) — 통째로 바꾼다. */
  fileWatch: (input: { root: string; rels: string[] }) => Promise<{ ok: boolean; count: number }>
  onFileEvent: (listener: (event: FileWatchPush) => void) => () => void
  /** LIFE-591 F3 — 파일 탭 저장(쓰기 경계는 main `file-write.ts`). */
  writeFile: (input: FileWriteInput) => Promise<FileWriteResult>
  /** 확인 대화상자(OS 기본) — 문구는 main 이 만든다. 고른 답. */
  fileDialog: (request: FileDialogRequest) => Promise<FileDialogChoice>
  /** 수정 파일 목록 — 바뀔 때마다(종료 확인 관문이 동기 판정에 쓴다, E3ⓒ). */
  setDirtyFiles: (files: DirtyFile[]) => void
  /** main 이 종료·창 닫기를 막고 확인을 맡겼다. */
  /** `gen` = 요청 세대 — 응답에 그대로 돌려준다(LIFE-591 수정 r5 R5-B). */
  onQuitRequested: (listener: (gen: number) => void) => () => void
  /** 확인을 마쳤다(저장했거나 저장 안 함) — main 이 받으면 종료한다. 무효가 된 세대면 false. */
  confirmQuit: (gen: number) => Promise<boolean>
  /** 종료 확인이 취소로 끝났다 — main 이 런타임 정리를 이미 시작했었으면 runtimeClosed(LIFE-591 수정 r4 R4-A ⓒ). */
  quitCancelled: (gen: number) => Promise<{ runtimeClosed: boolean }>
  /** 종료 확인 요청을 받았다(LIFE-591 수정 r1 R1-I). */
  quitAck: (gen: number) => void
  /** 우클릭 직전 창을 앞으로 (Orca #14545 를 따라 하지 않기 — 배경 앱 우클릭에도 키보드·hover 대상이 선다). */
  activateWindow: () => void
  reportRendered: (revision: number) => void
  /**
   * pane 하나를 골라 스트림을 연다. paneId null 이면 닫는다. 결과는 state.terminal 로 돌아온다.
   * cols·rows 는 렌더러가 잰 터미널 영역 크기 — 첫 연결이 맞는 크기로 뜨게 한다 (없으면 80×24).
   */
  selectPane: (input: { paneId: string | null; cols?: number; rows?: number }) => Promise<void>
  /**
   * 영역 구성을 선언한다 (LIFE-373). main 이 현재 연결과 대조해 열고·닫고·탭을 옮기고·격자를 맞춘다.
   * 빈 배열이면 연결을 전부 닫는다.
   */
  syncTermGroups: (groups: TerminalGroupRequest[]) => void
  /**
   * xterm onData 그대로 — 키·마우스 리포트·붙여넣기 전부 이 한 길이다.
   * **어느 pane 인지 실어 보낸다**: 붙은 탭 밖 pane 이면 herdr 가 조용히 버리므로 main 이 막는다 (S1).
   */
  termInput: (input: { paneId: string; data: string }) => void
  /** ⌘V 이미지 붙여넣기 (LIFE-497) — 클립보드 이미지를 임시 PNG 로 쓰고 경로를 받는다. 쓰기는 렌더러가 termInput 으로. */
  saveClipboardImage: () => Promise<ClipboardImageSaveResult>
  /** OS 파일 드롭 (LIFE-497) — preload 의 document 드롭 처리기가 부른다. */
  onFileDrop: (listener: (drop: TerminalFileDrop) => void) => () => void
  /** 영역 상자가 정한 **탭 격자**를 1회 요청한다 (pane 단위가 아니다 — §10-R13). */
  termScroll: (input: { paneId: string } & TerminalScroll) => void
  /** 줌 — paneId null 이면 해제. 그리는 건 클라이언트, 격자만 역산해 요청한다 (F2-3). */
  termZoom: (input: { groupId: string; paneId: string | null; cols: number; rows: number }) => void
  // --- pane 분할 (② — herdr 소유) ---
  /** `pane.split`. 클라이언트가 트리를 발명하지 않는다 (F2-1). */
  /** 새 xterm 이 붙었을 때 마지막 화면을 다시 받는다 (S6). 서버에는 아무것도 안 보낸다. */
  repaintPane: (input: { paneId: string }) => Promise<void>
  splitPane: (input: { paneId: string; direction: PaneSplitDirection; ratio?: number }) => Promise<PaneSplitResult>
  /** `pane.resize` — `amount` 는 **비율 델타**다(셀이 아니다). 드래그 끝에 1회만 부른다 (F2-2). */
  resizePane: (input: { paneId: string; direction: PaneDirection; amount: number }) => Promise<PaneActionResult>
  /** `pane.close`. 마지막 pane 이면 탭이 닫힌다 (F2-5). */
  closePane: (input: { paneId: string }) => Promise<PaneActionResult>
  /** `pane.focus_direction` — 인접 pane 포커스 이동은 서버가 정한다 (F2-4). */
  focusPaneDirection: (input: { paneId: string; direction: PaneDirection }) => Promise<PaneNeighborResult>
  onTermFrame: (listener: (frame: TerminalFrame) => void) => () => void
  /** 메뉴에서 뺏어 온 단축키가 레지스트리 액션과 방향 번호가 온다 — 키는 main 이 삼키고 여기로 넘긴다. */
  onShortcut: (listener: (shortcut: CorralShortcut) => void) => () => void
  /** LIFE-527 — 창 크롬 상태(macOS 여부·전체화면·줌). 다른 창의 요청이면 null. */
  getWindowChrome: () => Promise<WindowChrome | null>
  onWindowChrome: (listener: (chrome: WindowChrome) => void) => () => void
  /** 줌이 바뀌었을지 모를 때(창 resize) — main 이 줌을 다시 읽어 신호등을 옮기고 상태를 민다. */
  syncWindowZoom: () => void
  // --- 설정 › Mobile (LIFE-577) — 켜기·끄기는 `setSettings({ mobileEnabled })`. 상태 push 에는 토큰·코드가 없다 ---
  getMobileStatus: () => Promise<MobileStatus | null>
  onMobileStatus: (listener: (status: MobileStatus) => void) => () => void
  /** 새 1회용 코드 + QR. 이전 코드는 무효가 된다. 코드는 이 응답에만 실린다. */
  createMobilePairing: () => Promise<MobilePairingResult>
  revokeMobileDevice: (input: { id: string }) => Promise<{ ok: boolean }>
  /** 「다시 확인」 — 꺼져 있으면 읽기 점검만. */
  recheckMobile: () => Promise<MobileStatus | null>
  preloadEnv: { sandboxed: boolean; contextIsolated: boolean; exposedMethods: string[] }
}
