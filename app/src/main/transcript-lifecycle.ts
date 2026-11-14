// 백그라운드 작업·서브에이전트 수명 — **기록 누적(증분) 판독** (LIFE-462 #10·#11). herdr 를 모르는 층이다.
//
// # 왜 꼬리 창이 아닌가
//
// 458 의 판독은 "마지막 값" 이라 꼬리 창(≤2MB)으로 됐다. 여기서 싣는 것은 **열린 집합**(시작 ↔ 끝 짝)이고, 시작 레코드가
// 꼬리 창 밖에 있는 일이 흔하다 — 사용자 기록에서 끝까지 >2MB 떨어진 백그라운드 Bash 34/869 · Monitor 3/100 · 비동기 Agent
// 1/106 (00-analysis P1). 그래서 파일마다 **지난 판독 끝 위치 + 열린 집합**을 들고 가서 새 바이트만 읽어 갱신한다.
//
// # 판독 전제 — append-only (01-criteria)
//
// ① 파일 정체성(dev·ino)이 바뀌었거나 ② 파일이 지난 판독 끝보다 짧아졌거나 ③ 지난 판독 끝 바로 앞 1KiB(닻)가 달라졌으면
// 누적 상태를 버리고 0 부터 다시 쌓는다. 같은 정체성으로 제자리 재작성하되 크기·닻이 유지되는 경우는 전제 밖이다.
//
// # 비용 — 파일 하나·주기 1회 ≤2MB (L7)
//
// 첫 판독(따라잡기)도 이 한도로 나눈다. 끝에 못 닿은 동안은 목록을 **모름**(`catching-up`)으로 싣는다 — 빈 목록이 아니다.
// 한 줄이 한도보다 길면 그 줄은 건너뛴다(`skipping`). 그 줄이 끝 표지(예: 긴 동기 Agent 결과)였을 수 있으므로 **그때 열려 있던 것**은
// 불확실(`uncertain`)로 적어 두고, 그중 하나라도 아직 열려 있으면 목록 전체를 모름(`unreadable`)으로 싣는다 — 뒤에 다른 표지로
// 닫히거나 세대가 바뀌면(아래) 풀린다. 건너뛴 줄이 시작 표지였다면 그 작업은 목록에 없다(거짓 도는 중은 아니다 — 한계).
// 건너뛴 적이 있다는 것(`skipped`)도 남긴다 — 넘겨받을 id 가 건너뛸 때 아직 안 정해졌을 수 있어 넘김을 볼 때 그것으로 가른다(리뷰 r4 A).
//
// # 표지 — 전부 실측(관측)이다. 형식 계약이 아니다
//
// claude (`raw/claude/u1-u4-out.txt` · `u3-cost-state-out.txt` · `u5-shapes-out.txt`, 00-analysis §2·§5):
//   시작  · `Bash`·`Monitor`·`Agent` tool_use (이름·설명·명령·시각을 쥔다)
//         · 그 tool_result 레코드의 `toolUseResult` — `backgroundTaskId`(셸) · `taskId`+`timeoutMs`(Monitor) ·
//           `status:'async_launched'`+`agentId`(비동기 Agent). 동기 Agent 는 tool_result 가 오기 전까지가 수명이다
//   끝    · `<task-notification>` 에 `<status>` 가 있으면 그 안의 `<task-id>` 전부가 끝났다 — status 값은 가리지 않는다
//           (`completed·failed·killed·stopped` 로 닫지 않는다). `<status>` 없는 Monitor `<event>` 통지는 끝이 아니다.
//           queue-operation enqueue 와 user 레코드로 두 번 오는데, 둘 다 같은 id 를 닫으니 두 번째는 무해하다(U8)
//         · `TaskStop` 결과 `toolUseResult{task_id, task_type}`
//         · `system/agents_killed` — 열린 비동기 에이전트 전부 (실측 1건, 그때 열린 것 0 — 이름 그대로의 뜻으로 쓴다)
//         · **`cost-state` 레코드 = 그 프로세스가 이 파일을 놓았다** (L8). (대화형) 프로세스가 끝나면 백그라운드 작업도 같이 죽는데 끝 통지가
//           없다(#72171). 재개하면 하네스가 `status:stopped` 통지를 같은 파일에 쓰지만(`raw/claude/u3-resume-probe.txt`),
//           재개 전까지는 열린 채로 남는다. 사용자 기록 242 파일 · cost-state 426 중 그 뒤에 닫힌 작업 8/8 이 전부 재개 통지였다.
//           **다만 전환(`←`)과 bg 세션 프로세스 재시작(supervisor)도 이 줄을 찍는다** — 아래 「전환」·「supervisor 재시작」.
//
// # 끝 표지 없는 죽음 — 프로세스 생존 (L8)
//
// 강제 종료(SIGKILL·pane 닫기)는 `cost-state` 도 안 남긴다 — 사용자 기록에서 끝에 "열림" 이 남은 파일 21 이 전부 cost-state 가
// 없었다(`raw/claude/u3b-open-at-eof-out.txt`). 그래서 claude 는 **살아 있는 소유 프로세스**를 따로 본다: claude 는 대화형
// 프로세스마다 `~/.claude/sessions/<pid>.json`(`pid`·`sessionId`…)을 쓴다(관측). 그 세션 id 를 가진 항목의 pid 가 살아 있을
// 때만 목록을 싣고, 아니면 `not-running` 이다. 누적 상태는 계속 쌓는다.
//
// # 세대 경계 — 재개 뒤의 옛 열림 (L8)
//
// 강제 종료 뒤 재개하면 같은 파일에 잇는다(supervisor 재시작도 같은 파일에 잇지만 작업이 산다 — 아래 「supervisor 재시작」). 옛 프로세스의 열린 작업·자식은 끝 표지 없이 남는다 — claude 는 재개 때 옛 셸에
// `stopped` 통지를 쓰지만 모든 종류에 쓴다는 근거가 없고, grok 은 빈 `background_tasks` 스냅샷만 쓴다(자식은 안 닫힌다).
// 그래서 **살아 있는 소유 프로세스의 시작 시각**(claude 레지스트리 `startedAt`, grok 은 `ps` 의 시작 시각 — 초 단위)보다 먼저
// 열린 것은 싣지 않는다(제외). 캐시 없이 처음부터 다시 읽어도 같은 답이다 — 기록 순서가 아니라 시각으로 가르기 때문이다.
// 시작 시각이 없는 **열린** 항목이 하나라도 있으면 세대를 가를 수 없으므로 목록 전체를 모름(`unreadable`)으로 싣는다 —
// 빼고 `known` 을 내면 열린 자식이 없는 것처럼 보여 monitoring 이 잘못 선다(수정 r2 R2-F1). 그 항목의 끝 표지를 보면 풀린다.
//
// # 전환 — 세대 경계를 건너 넘긴 작업 (LIFE-781, 2.1.296 관측)
//
// `←` 로 백그라운드 전환하면 옛 파일 끝이 `cost-state` → (전환 때 멈춘 Monitor·서브에이전트의 `killed` 통지) → `continued-in` 이다.
// 돌던 셸은 계속 돈다 — 부모는 옛 대화형 프로세스, 끝 통지는 이어 받은 세션(새 id, 레지스트리 `kind:"bg"`)이 새 파일에 쓴다(첫 입력 전에도).
// 옛 pane 을 닫아 옛 프로세스가 죽어도 셸은 살았다(부모 1, 옛 파일에 `cost-state` 한 줄 더). 그래서:
//   · `cost-state` 는 열린 것을 닫지 않고 **보류**로 옮긴다(목록엔 없다). Monitor 는 보류하지 않고, 그때 알던 소유 프로세스 시작 시각을 적는다
//     (`parkable`). 그보다 먼저 열린 것은 볼 때 뺀다 — 단 보낸 파일이 자기 앞에서 넘겨받은 것은 빼지 않는다(연쇄 `←`, `handoffItems`). 끝 표지는 보류분도 닫는다.
//   · `continued-in` 이 오면 남은 보류분을 그 대상 세션에 **넘긴 것**으로 적는다. 넘긴 것은 뒤의 `cost-state` 에 안 지워진다.
//   · 같은 파일에 사람 줄(`assistant`·통지 아닌 `user`)이 이어지면 재개다 — 보류분·넘긴 것을 버린다(옛 세대는 위 경계가 가른다).
// 넘긴 것은 **대상 bg 세션 프로세스가 살아 있는 동안** 경계와 상관없이 싣는다(`ledgerView` 의 `carried`). 첫 입력 전엔 대상 파일의 끝 통지(`ended`)로
// 닫고(`handedOpen`), 첫 입력 뒤 대상 파일에는 옛 대화가 원래 시각으로 복사돼 경계 앞에 열려 있는데 그중 옛 파일이 넘긴 id 만 싣는다(`inheritedItems`).
// 옆 파일 장부(연쇄 앞쪽 전부·대상 파일)를 따라잡는 동안은 넘김을 몰라 목록이 모름(`catching-up`)이다 — 빈 목록을 내지 않는다. 기다려도 답이 안 바뀌면
// (넘겨받을 후보도, 세대 거르기가 앞쪽 장부에 달린 넘김도, 넘긴 것도 없으면) 묶지 않는다. 앞쪽 장부가 따라잡힌 주기에 답을 다시 고른다(`transcript.ts`). 대상 파일에서 긴 줄을 건너뛰면 넘겨받은 id 도 불확실(`unreadable`)이다 — 그 id 의 끝 표지로 풀린다.
// 보류 없이 온 `continued-in` 이나 모양이 아닌 대상 id 는 아무것도 넘기지 않는다 — 고치기 전 동작(빠짐)으로 떨어진다.
//
// # supervisor 재시작 — 같은 파일에서 세대 경계를 건너 넘어간 작업 (LIFE-794, 2.1.296 관측)
//
// supervisor 가 bg 세션 프로세스를 다시 띄우면(`claude respawn <id>` 실측) 같은 세션 id·같은 파일로 잇는다. 파일 끝은 옛 프로세스의
// `cost-state` → `last-prompt` → `cost-state` 이고 `continued-in` 은 없다. 셸·비동기 에이전트는 새 프로세스로 넘어가 계속 돌고(셸 부모 → 1),
// 끝 통지는 새 프로세스가 같은 파일에 쓴다. 넘어가지 못한 것(Monitor·handoff 끔의 셸)에는 새 프로세스가 곧바로 `killed`·`stopped` 통지를 쓴다. 그래서:
//   · bg 프로세스가 쓴 줄(`sessionKind:"bg"` — 대화형 줄에는 이 키가 없다)로 열린 셸·비동기 에이전트는 `cost-state` 때 **재시작 몫**(`restart`)으로도
//     더한다(Monitor 빼고). 대입이 아니라 더한다 — 두 번째 `cost-state` 가 첫 줄의 몫을 지우지 않게. 끝 표지로만 빠지고 사람 줄·`continued-in` 에는 안 지워진다.
//     bg 세션 프로세스는 `claude stop` 에도 셸이 산다(부모 → 1, 리뷰어 실측) — 위 L8 의 「같이 죽는다」는 대화형 프로세스 기준이다.
//   · 싣는 것은 볼 때 고른다(`restartItems`): 같은 세션 id 의 **bg 주인**(레지스트리 `kind:"bg"`)이 살아 있고 그 시작 시각보다 **먼저 열린 것**만.
//     bg 주인이 전부 `status:"idle"`(넘어간 셸이 돌면 `shell`, 서브에이전트가 돌면 `busy` — 실측)이면 싣지 않는다 — 빼는 쪽으로만 쓰는 상한이다.
//     시작 시각을 모르는 것이 있으면 목록 전체가 모름(`unreadable`)이다(R2-F1). `←` 로 복사된 옛 열림 중 앞 파일이 넘기지 않은 것은 뺀다(`notHanded`).
//     대화형 프로세스가 같은 파일을 이어 받으면(재개, L8) 싣지 않고 옛 세대를 뺀다. `cost-state` 를 쓴 bg 프로세스가 살아 있으면 그 프로세스가 연 것은
//     시작 시각 뒤라 싣지 않는다(고치기 전 동작). `←` 로 이어 받은 파일은 복사된 줄도 `sessionKind:"bg"` 로 다시 쓰여 넘겨받은 셸도 같은 길로 남는다.
// grok (`updates.jsonl`, 00-analysis P6):
//   `background_tasks` 는 **전체 스냅샷**이라 마지막 스냅샷의 `status:'running'` 이 지금 도는 작업이다. `task_completed` 는
//   스냅샷이 오기 전의 끝을 보탠다. 형제 파일 꼬리 창(256KB) 밖의 스냅샷도 누적 판독이라 잃지 않는다(P1 — 12 중 8).
//   서브에이전트(네이티브 유도 표본 — `raw/claude/l10/runs/n38-grok-subagent-shape.txt`, `runs-r2/n41`·`n42`):
//   `subagent_spawned{subagent_id, subagent_type, description…}` 가 시작, `subagent_finished{subagent_id, status}` 가 끝이다.
//   시작 시각은 줄의 `params._meta.agentTimestampMs`. 시작 레코드에는 호출 id 가 없다 — `background` 는 **그 자식 id 를 돌려준
//   호출**로만 확정한다: `tool_call{toolCallId, title:'spawn_subagent', rawInput.background}` 의 호출 id 와 같은 id 의
//   `tool_call_update` 결과 본문을 묶는다. 본문은 **맨 앞이** `Subagent started in background.\nsubagent_id: <id>\n` 인 봉투만 믿는다
//   (네이티브 표본 4/4 — `raw/claude/r2-u6-spawn-envelope.txt`). 다른 자리의 `subagent_id:`(자식 응답 인용 등)는 쓰지 않는다(U6).
//   못 묶으면 null 이다. 전경 spawn 의 결과 모양은 표본이 없어 `background:false` 는 확정하지 않는다(한계).
//   `tasks` 가 배열이 아닌 `background_tasks` 는 "작업 없음" 의 증거로 쓰지 않는다 — 다음 온전한 스냅샷까지 모름이다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { isRecord, readString } from '../shared/json.js'
import type { BackgroundTask, SessionLifecycle, SessionSubagent } from '../shared/types.js'
import { LIFECYCLE_MAX_ITEMS } from '../shared/types.js'
import { cleanActivityText, readTimestamp } from './transcript-parse.js'

/**
 * 한 파일의 세대 재료 (LIFE-781). `since` = 그 파일 소유 프로세스의 시작 시각(알면) — 그보다 먼저 열린 것은 보류분에 안 넣는다(강제 종료 뒤 재개 전의 열림).
 * `keep` = 앞 파일이 이 파일 세션에 넘긴 id — 이 파일에서 한도보다 긴 줄을 건너뛸 때 이것도 불확실로 둔다(그 줄이 넘겨받은 것의 끝 통지였을 수 있다, 리뷰 r2 B).
 */
export type Generation = { since: number | null; keep: ReadonlySet<string> }
const NO_GENERATION: Generation = { since: null, keep: new Set() }

/** 파일 하나를 한 주기에 읽는 상한 (L7) — 닻 확인 판독을 포함한다. */
export const LIFECYCLE_READ_MAX_BYTES = 2 * 1024 * 1024
/** 닻 — 지난 판독 끝 바로 앞 바이트. 판독 전제 ③(끝 앞 변경)을 알아채는 데 쓴다. */
export const LIFECYCLE_ANCHOR_BYTES = 1024

type ClaudeCall = { label: string | null; at: number | null }

/** 열린 작업·서브에이전트 묶음 — `cost-state` 뒤 보류분과 전환으로 넘긴 것(LIFE-781)이 같은 모양이다. */
type ClaudeItems = { tasks: Map<string, BackgroundTask>; subagents: Map<string, SessionSubagent> }
/** 보류분 — `since` 는 `cost-state` 를 읽을 때 알던 소유 프로세스 시작 시각(모르면 null). 세대 거르기는 볼 때 한다(`handoffItems`). */
type ParkedItems = ClaudeItems & { since: number | null }

export type LedgerState =
  | {
      agent: 'claude'
      tasks: Map<string, BackgroundTask>
      /** 결과를 아직 못 본 `Bash`·`Monitor`·`Agent` 호출 — tool_use id → 이름 재료. */
      calls: Map<string, ClaudeCall>
      /** 도는 서브에이전트 — 동기는 tool_use id, 비동기는 agentId 로 잡는다. */
      subagents: Map<string, SessionSubagent>
      /** `cost-state` 때 열려 있던 것 — 뒤에 `continued-in` 이 오면 넘긴 것이 되고, 사람 줄(같은 파일 재개)이 오면 버린다(LIFE-781). */
      parked: ParkedItems | null
      /** `continued-in` 으로 이어 받은 세션(`target`)에 넘긴 것 — 그 세션 프로세스가 살아 있는 동안 싣는다(LIFE-781). */
      handoff: (ParkedItems & { target: string; from: string | null }) | null
      /**
       * bg 프로세스가 `cost-state` 를 쓸 때 열려 있던 셸·비동기 에이전트 — supervisor 가 그 세션 프로세스를 다시 띄우면 같은 파일·같은 세션 id 로
       * 넘어간다(LIFE-794, 2.1.296 관측). 끝 표지로만 빠지고 사람 줄(`resumed`)·`continued-in` 에는 안 지워진다. 싣는 것은 볼 때 고른다(`restartItems`).
       */
      restart: ClaudeItems | null
      /** 지금 열린 것 중 bg 프로세스가 쓴 줄(`sessionKind:"bg"`)로 열린 id — `cost-state` 때 `restart` 로 옮길 후보(LIFE-794). */
      bgOpened: Set<string>
      /**
       * 이 파일에서 끝 표지를 본 id(최근 `ENDED_MAX` 개, LIFE-781) — 넘겨받은 쪽이 「이미 끝났나」를 묻는다. 이어 받은 세션은 첫 입력 전에도
       * 끝 통지를 새 파일 `queue-operation` 으로 쓴다(실제 기록 1건: 그 뒤에 복사가 온다). 그때 그 id 는 이 파일에서 아직 열린 적이 없다.
       */
      ended: Set<string>
    }
  | {
      agent: 'grok'
      tasks: Map<string, BackgroundTask>
      subagents: Map<string, SessionSubagent>
      /** 결과를 아직 못 본 `spawn_subagent` 호출 — toolCallId → `rawInput.background`(없으면 null). */
      spawnCalls: Map<string, boolean | null>
      /** 호출 결과가 `subagent_spawned` 보다 먼저 온 자식 — subagent_id → background. */
      spawnedBackground: Map<string, boolean | null>
      /** 마지막 `background_tasks` 의 `tasks` 가 배열이 아니었다 — 다음 온전한 스냅샷까지 작업 목록은 모름. */
      tasksInvalid: boolean
    }

/** 파일 하나의 누적 판독 상태. */
export type Ledger = {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  /** 온전한 줄로 소비한 끝 위치(줄바꿈 뒤). */
  offset: number
  /** `offset` 바로 앞 ≤1KiB — 다음 판독에서 같은지 본다(③). */
  anchor: Buffer
  /** 한도보다 긴 줄 한가운데다 — 다음 줄바꿈까지 버린다. */
  skipping: boolean
  /** 지난 판독이 파일 끝에 닿았나. 아니면 목록은 `catching-up` 이다. */
  caughtUp: boolean
  /** 긴 줄을 건너뛸 때 열려 있던 작업·자식 id — 그중 하나라도 아직 열려 있으면 목록은 모름이다(U3). */
  uncertain: Set<string>
  /** 이 장부에서 한도보다 긴 줄을 건너뛴 적이 있나 — 넘겨받을 id 가 그때 아직 안 정해졌어도 볼 때 불확실로 본다(리뷰 r4 A). */
  skipped: boolean
  state: LedgerState
}

export function emptyLedgerState(agent: 'claude' | 'grok'): LedgerState {
  return agent === 'claude'
    ? { agent: 'claude', tasks: new Map(), calls: new Map(), subagents: new Map(), parked: null, handoff: null, restart: null, bgOpened: new Set(), ended: new Set() }
    : { agent: 'grok', tasks: new Map(), subagents: new Map(), spawnCalls: new Map(), spawnedBackground: new Map(), tasksInvalid: false }
}

/** 이번 stat 에서 다시 읽을 게 없나 — 끝까지 따라잡았고 파일이 그대로다. */
export function ledgerSettled(input: { ledger: Ledger | null; stat: fs.Stats }): boolean {
  const { ledger, stat } = input
  return (
    ledger !== null &&
    ledger.caughtUp &&
    ledger.dev === stat.dev &&
    ledger.ino === stat.ino &&
    ledger.size === stat.size &&
    ledger.mtimeMs === stat.mtimeMs
  )
}

/**
 * 누적 판독 한 걸음 — 지난 끝에서부터 새 바이트를 ≤2MB 읽어 열린 집합을 갱신한다. 읽은 바이트를 같이 돌려준다.
 * ①②③ 이면 상태를 버리고 0 부터 다시 쌓는다(남은 예산 안에서).
 */
export function advanceLedger(input: {
  file: string
  stat: fs.Stats
  agent: 'claude' | 'grok'
  prior: Ledger | null
  /** 이 파일의 세대 재료(LIFE-781) — `cost-state` 보류분 거르기와 긴 줄 건너뛰기의 불확실 표시에 쓴다. 없으면 거르지 않는다. */
  generation?: Generation
}): {
  ledger: Ledger
  bytes: number
  reset: 'identity' | 'shrunk' | 'anchor' | null
} {
  const { file, stat, agent } = input
  const generation = input.generation ?? NO_GENERATION
  let budget = LIFECYCLE_READ_MAX_BYTES
  let bytes = 0
  let reset: 'identity' | 'shrunk' | 'anchor' | null = null
  let prior = input.prior
  if (prior !== null && (prior.dev !== stat.dev || prior.ino !== stat.ino)) reset = 'identity'
  else if (prior !== null && stat.size < prior.offset) reset = 'shrunk'
  else if (prior !== null && prior.anchor.length > 0) {
    const from = prior.offset - prior.anchor.length
    const now = readBytes({ file, from, to: prior.offset })
    bytes += now.length
    budget -= now.length
    if (!now.equals(prior.anchor)) reset = 'anchor'
  }
  if (reset !== null) prior = null

  const start = prior?.offset ?? 0
  const to = Math.min(stat.size, start + budget)
  const chunk = readBytes({ file, from: start, to })
  bytes += chunk.length
  const state = prior?.state ?? emptyLedgerState(agent)
  const uncertain = prior?.uncertain ?? new Set<string>()
  let skipping = prior?.skipping ?? false
  let skipped = prior?.skipped ?? false
  let consumed = 0
  const lastNewline = chunk.lastIndexOf(0x0a)
  if (lastNewline !== -1) {
    let begin = 0
    if (skipping) {
      begin = chunk.indexOf(0x0a) + 1
      skipping = false
    }
    consumed = lastNewline + 1
    if (begin < consumed) applyLines({ state, text: chunk.subarray(begin, consumed).toString('utf8'), generation })
  } else if (start + chunk.length < stat.size) {
    // 한도를 다 채웠는데 줄바꿈이 없다 — 한도보다 긴 줄이다. 건너뛰고 다음 줄바꿈부터 다시 읽는다.
    // 그 줄이 지금 열린 것의 끝 표지였을 수 있다 — 열린 id 를 불확실로 적는다(U3).
    consumed = chunk.length
    skipping = true
    skipped = true
    for (const id of [...openIds(state), ...generation.keep]) uncertain.add(id)
  }
  // 불확실한 것 중 그 뒤 다른 표지로 닫힌 것은 풀린다. 넘겨받은 id 는 이 파일에서 안 열려 있어도 끝 표지를 볼 때까지 남는다.
  const open = new Set(openIds(state))
  const ended = state.agent === 'claude' ? state.ended : null
  for (const id of uncertain) if (ended?.has(id) === true || (!open.has(id) && !generation.keep.has(id))) uncertain.delete(id)
  const offset = start + consumed
  const anchor = Buffer.concat([prior?.anchor ?? Buffer.alloc(0), chunk.subarray(0, consumed)])
  const ledger: Ledger = {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset,
    anchor: Buffer.from(anchor.subarray(Math.max(0, anchor.length - LIFECYCLE_ANCHOR_BYTES))),
    skipping,
    skipped,
    // 파일 끝까지 읽었으면 따라잡은 것이다 — 줄바꿈 없는 끝줄은 아직 쓰는 중이라 다음 주기에 온다.
    caughtUp: to === stat.size,
    uncertain,
    state,
  }
  return { ledger, bytes, reset }
}

function openIds(state: LedgerState): string[] {
  const ids = [...state.tasks.keys(), ...state.subagents.keys()]
  if (state.agent !== 'claude') return ids
  for (const items of [state.parked, state.handoff, state.restart]) if (items !== null) ids.push(...items.tasks.keys(), ...items.subagents.keys())
  return ids
}

/** 세대 경계와 상관없이 싣는 것 — 전환으로 넘겨받아 지금 주인(이어 받은 세션 프로세스)이 살아 있는 작업(LIFE-781). */
export type HandedItems = { tasks: BackgroundTask[]; subagents: SessionSubagent[] }

/**
 * 지금 목록 — 따라잡기 전이면 모름. `since`(살아 있는 소유 프로세스의 시작 시각, epoch ms)보다 먼저 열린 것은 이전 세대라 뺀다.
 * `carried` 는 그 경계를 건너 싣는다(같은 id 는 한 번). 소유 프로세스가 죽고 넘겨받은 것만 살면 `since` 는 무한대다.
 * 시작 시각 순, 상한 32 + 넘친 수.
 */
export function ledgerView(input: { ledger: Ledger; since: number; carried?: HandedItems }): SessionLifecycle {
  const { ledger, since } = input
  if (!ledger.caughtUp) return { state: 'unknown', reason: 'catching-up' }
  const carried = input.carried ?? { tasks: [], subagents: [] }
  const carriedIds = new Set([...carried.tasks, ...carried.subagents].map((item) => item.id))
  const open = [...ledger.state.tasks.values(), ...ledger.state.subagents.values()].filter((item) => !carriedIds.has(item.id))
  // 시작 시각을 모르는 열린 항목 — 어느 세대인지 못 가른다(R2-F1)
  if (open.some((item) => item.startedAt === null)) return { state: 'unknown', reason: 'unreadable' }
  const current = (item: { id: string; startedAt: number | null }) => !carriedIds.has(item.id) && item.startedAt !== null && item.startedAt >= since
  const tasks = [...[...ledger.state.tasks.values()].filter(current), ...carried.tasks]
  const subagents = [...[...ledger.state.subagents.values()].filter(current), ...carried.subagents]
  const shown = new Set([...tasks, ...subagents].map((item) => item.id))
  if ([...ledger.uncertain].some((id) => shown.has(id))) return { state: 'unknown', reason: 'unreadable' }
  if (ledger.state.agent === 'grok' && ledger.state.tasksInvalid) return { state: 'unknown', reason: 'unreadable' }
  return listView({ tasks, subagents })
}

/** 넘김 원본 — 대상·보낸 세션 id, 보류 때 알던 `since`, 아직 끝 표지를 못 본 항목. 세대 거르기 전이다(`handoffItems`). */
export type Handoff = HandedItems & { target: string; from: string | null; since: number | null }

/** 이 장부가 `continued-in` 으로 넘긴 것(거르기 전). 넘긴 게 없으면 null (LIFE-781). */
export function ledgerHandoff(ledger: Ledger): Handoff | null {
  const { state } = ledger
  if (state.agent !== 'claude' || state.handoff === null) return null
  const { target, from, since } = state.handoff
  return { target, from, since, tasks: [...state.handoff.tasks.values()], subagents: [...state.handoff.subagents.values()] }
}

/**
 * 넘긴 것 중 이 세대의 것 (LIFE-781) — 보류 때 소유 프로세스 시작 시각(`since`)을 알았으면 그보다 먼저 열린 것(강제 종료 뒤 재개 전의 열림)은 뺀다(리뷰 r1 B).
 * 다만 보낸 파일이 자기 앞 파일에서 넘겨받은 것(`keep`)은 원래 시각이 `since` 앞이어도 이 세대다 — 연쇄 `←` 에서 이어 넘긴다(리뷰 r2 A).
 * `keep` 은 볼 때 고른다 — 앞 파일 장부를 나중에 따라잡아도 답이 고쳐진다.
 */
export function handoffItems(input: { handoff: Handoff; keep: ReadonlySet<string> }): HandedItems {
  const { since } = input.handoff
  const current = (item: { id: string; startedAt: number | null }) => since === null || input.keep.has(item.id) || (item.startedAt !== null && item.startedAt >= since)
  return { tasks: input.handoff.tasks.filter(current), subagents: input.handoff.subagents.filter(current) }
}

/**
 * 이어 받은 파일(`ledger`)에서 앞 파일이 넘긴 것(`handed`) 중 아직 열린 것 (LIFE-781).
 * 새 파일에는 옛 대화가 원래 시각 그대로 복사돼 세대 경계 앞에 열려 있다 — 그중 **옛 파일이 넘긴 id 만** 싣는다.
 * 복사 앞에서 끝 표지를 본 id 는 다시 열려도 싣지 않는다. 값은 새 파일 쪽 항목이다(끝 표지는 새 파일에 온다).
 */
export function inheritedItems(input: { ledger: Ledger; handed: HandedItems }): HandedItems {
  const { state } = input.ledger
  const ended = state.agent === 'claude' ? state.ended : new Set<string>()
  const open = <T extends { id: string }>(item: T | undefined): T[] => (item === undefined || ended.has(item.id) ? [] : [item])
  return {
    tasks: input.handed.tasks.flatMap((item) => open(state.tasks.get(item.id))),
    subagents: input.handed.subagents.flatMap((item) => open(state.subagents.get(item.id))),
  }
}

/**
 * 첫 입력 전(옛 파일에 머무는 구간) 넘긴 것 중 아직 안 끝난 것 (LIFE-781) — 이어 받은 세션은 첫 입력 전에도 끝 통지를 새 파일에 쓴다
 * (실제 기록 1건 — 에이전트가 `←` 뒤 약 9분 30초 살다 끝, 통지는 새 파일 `queue-operation`). 새 파일을 아직 못 읽었으면(`target` null) 거르지 않는다.
 */
export function handedOpen(input: { handoff: HandedItems; target: Ledger | null }): HandedItems {
  const state = input.target?.state
  if (state === undefined || state.agent !== 'claude') return input.handoff
  const ended = state.ended
  return { tasks: input.handoff.tasks.filter((item) => !ended.has(item.id)), subagents: input.handoff.subagents.filter((item) => !ended.has(item.id)) }
}

/**
 * supervisor 재시작으로 넘어간 것 (LIFE-794) — bg 프로세스가 `cost-state` 를 쓸 때 열려 있던 것 중 **지금 bg 주인(`since` = 그 시작 시각)보다
 * 먼저 열린 것**만 싣는다. 같은 프로세스가 아직 살아 있으면(`cost-state` 를 쓰고도 안 죽었으면) 그 프로세스가 연 것은 `since` 뒤라 싣지 않는다 —
 * 고치기 전 동작이다. 시작 시각을 모르는 것도 싣지 않는다. 주인 판정(같은 세션 id 의 `kind:"bg"` 항목 생존)은 부르는 쪽이 한다.
 */
export function restartItems(input: { ledger: Ledger; since: number; drop: ReadonlySet<string> }): { carried: HandedItems; undated: boolean } {
  const { state } = input.ledger
  if (state.agent !== 'claude' || state.restart === null) return { carried: { tasks: [], subagents: [] }, undated: false }
  const kept = <T extends { id: string }>(items: Map<string, T>) => [...items.values()].filter((item) => !input.drop.has(item.id))
  const tasks = kept(state.restart.tasks)
  const subagents = kept(state.restart.subagents)
  const before = (item: { startedAt: number | null }) => item.startedAt !== null && item.startedAt < input.since
  // 시작 시각을 모르면 세대를 못 가른다 — 빼고 `known` 을 내지 않고 목록 전체를 모름으로 둔다(R2-F1 과 같다, 리뷰 r1 C).
  const undated = [...tasks, ...subagents].some((item) => item.startedAt === null)
  return { carried: { tasks: tasks.filter(before), subagents: subagents.filter(before) }, undated }
}

/**
 * `←` 앞 파일이 넘기지 않은 id (LIFE-794 리뷰 r1 D) — 이어 받은 파일에는 옛 대화가 `sessionKind:"bg"` 로 다시 쓰여 복사되므로, 그 복사로 열린 옛 열림도
 * 재시작 몫에 든다. 앞 파일이 아는 id(넘김 원본·끝 표지를 본 것) 중 781 세대 거르기(`handoffItems`)를 통과하지 못한 것은 재시작 몫에서도 뺀다.
 */
export function notHanded(input: { previous: Ledger; handed: HandedItems }): Set<string> {
  const { state } = input.previous
  if (state.agent !== 'claude') return new Set()
  const handed = new Set([...input.handed.tasks, ...input.handed.subagents].map((item) => item.id))
  const known = [...(state.handoff?.tasks.keys() ?? []), ...(state.handoff?.subagents.keys() ?? []), ...state.ended]
  return new Set(known.filter((id) => !handed.has(id)))
}

function listView(input: { tasks: BackgroundTask[]; subagents: SessionSubagent[] }): SessionLifecycle {
  const tasks = byStart(input.tasks)
  const subagents = byStart(input.subagents)
  return {
    state: 'known',
    tasks: tasks.slice(0, LIFECYCLE_MAX_ITEMS),
    taskOverflow: Math.max(0, tasks.length - LIFECYCLE_MAX_ITEMS),
    subagents: subagents.slice(0, LIFECYCLE_MAX_ITEMS),
    subagentOverflow: Math.max(0, subagents.length - LIFECYCLE_MAX_ITEMS),
  }
}

function byStart<T extends { startedAt: number | null; id: string }>(items: T[]): T[] {
  return items.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id))
}

// --- 줄 → 상태 -----------------------------------------------------------------

/**
 * claude 는 표지가 들 수 있는 줄만 파싱한다 — 대부분의 줄(훅 결과·첨부·텍스트 응답)은 문자열 검사로 건너뛴다.
 * 걸러도 틀리지 않는 이유: 아래 표지 전부가 이 문자열 중 하나를 원문 그대로 품는다.
 */
const CLAUDE_MARKERS = ['"tool_use"', '"tool_result"', '"toolUseResult"', '<task-notification>', '"agents_killed"', '"cost-state"', '"continued-in"']
/** 보류분·넘긴 것이 있는 동안은 사람 줄(재개)도 본다 — 표지 없는 `user`·`assistant` 줄이 그 갈래를 정한다(LIFE-781). */
const CLAUDE_CONVERSATION = ['"type":"user"', '"type":"assistant"']
// `subagent_id` 는 `subagent_spawned`·`subagent_finished` 와 자식 id 를 돌려준 `tool_call_update` 결과 본문(`subagent_id: …`)을 함께 잡는다.
const GROK_MARKERS = ['"background_tasks"', '"task_completed"', '"spawn_subagent"', 'subagent_id']

/**
 * 이 줄이 상태를 바꿀 수 있나. grok 은 결과를 기다리는 `spawn_subagent` 호출이 있는 동안 `tool_call_update` 도 본다 —
 * 실패 결과(`subagent_id` 없음)도 그 호출을 치워야 하기 때문이다(R2-F5). 기다리는 호출이 없으면 도구 결과 줄은 파싱하지 않는다.
 */
function mayMatter(input: { state: LedgerState; line: string }): boolean {
  const { state, line } = input
  switch (state.agent) {
    case 'claude':
      return (
        CLAUDE_MARKERS.some((marker) => line.includes(marker)) ||
        ((state.parked !== null || state.handoff !== null) && CLAUDE_CONVERSATION.some((marker) => line.includes(marker)))
      )
    case 'grok':
      return GROK_MARKERS.some((marker) => line.includes(marker)) || (state.spawnCalls.size > 0 && line.includes('"tool_call_update"'))
  }
}

export function applyLines(input: { state: LedgerState; text: string; generation?: Generation }): void {
  const { state } = input
  for (const line of input.text.split('\n')) {
    if (!mayMatter({ state, line })) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue // 잘린 줄·깨진 줄 — 던지지 않는다 (L9)
    }
    if (!isRecord(record)) continue
    applyRecord({ state: input.state, record, generation: input.generation ?? NO_GENERATION })
  }
}

export function applyRecord(input: { state: LedgerState; record: Record<string, unknown>; generation?: Generation }): void {
  const { state, record } = input
  switch (state.agent) {
    case 'claude':
      applyClaudeRecord({ state, record, generation: input.generation ?? NO_GENERATION })
      return
    case 'grok':
      applyGrokRecord({ state, record })
      return
  }
}

type ClaudeState = Extract<LedgerState, { agent: 'claude' }>
type GrokState = Extract<LedgerState, { agent: 'grok' }>

const CLAUDE_TRACKED_TOOLS = new Set(['Bash', 'Monitor', 'Agent', 'Task'])

function applyClaudeRecord(input: { state: ClaudeState; record: Record<string, unknown>; generation: Generation }): void {
  const { state, record } = input
  const at = readTimestamp(record['timestamp'])
  switch (readString(record, 'type')) {
    case 'cost-state':
      // 이 프로세스가 이 파일을 놓았다 (L8). 프로세스 끝이면 작업·서브에이전트는 끝 통지 없이 같이 죽는다 — 다만 전환(`←`)도
      // 이 줄을 먼저 찍고 `continued-in` 을 잇는다(LIFE-781 실측). 그래서 지금 열린 것은 닫지 않고 보류로 옮긴다 — 목록엔 안 싣는다.
      // 이미 넘긴 것은 그대로다 — 전환 뒤 옛 pane 을 닫으면 이 줄이 한 번 더 오지만 넘긴 셸은 이어 받은 세션 아래서 산다(실측).
      // bg 프로세스가 연 것은 재시작 몫에도 더한다 — supervisor 재시작이면 새 프로세스가 이어 받는다(LIFE-794).
      state.parked = parkable({ state, generation: input.generation })
      state.restart = restartable(state)
      state.bgOpened.clear()
      state.tasks.clear()
      state.calls.clear()
      state.subagents.clear()
      return
    case 'continued-in': {
      // 전환 — 보류분 중 그 사이 끝 통지(멈춘 Monitor·서브에이전트의 killed)를 못 본 것을 이어 받은 세션에 넘긴다(LIFE-781).
      // 보류분 없이 온 `continued-in`(관측 밖 모양)은 아무것도 넘기지 않는다 — 지금 동작(빠짐)이다.
      const target = readString(record, 'continuedInSessionId')
      if (state.parked === null || target === null || !SESSION_ID.test(target)) return
      state.handoff = { target, from: readString(record, 'sessionId'), ...state.parked }
      state.parked = null
      return
    }
    case 'system':
      if (readString(record, 'subtype') === 'agents_killed') {
        for (const items of claudeItems(state)) for (const [id, task] of items.tasks) if (task.kind === 'agent') closeClaude({ state, id })
      }
      return
    case 'queue-operation':
      if (readString(record, 'operation') === 'enqueue') applyNotification({ state, text: readString(record, 'content') })
      return
    case 'assistant':
      resumed(state)
      applyClaudeToolUses({ state, record, at })
      return
    case 'user':
      if (!notificationOnly(record)) resumed(state)
      applyClaudeUser({ state, record, at })
      return
    default:
      return
  }
}

/**
 * `cost-state` 때 보류로 옮길 것 (LIFE-781).
 * ① Monitor 는 뺀다 — 문서·실측 모두 전환 때 멈춘다(`Background this session?` 의 「they will be stopped」). 멈춤 통지(`killed`)가 없는 실제 기록도
 *    있어서(리뷰 r1 R1-3) 통지에 맡기지 않는다. 비동기 에이전트는 계속 산 실제 기록이 있어 빼지 않는다(통지로만 빠진다).
 * ② 이 파일 소유 프로세스의 시작 시각(`since`, 지금 알면)을 같이 적는다 — 이전 세대 거르기는 볼 때 한다(`handoffItems`). 판독 때 소유자가
 *    이미 죽어 `since` 를 모르면 거르지 못한다 — 한계(SURFACE).
 */
function parkable(input: { state: ClaudeState; generation: Generation }): ParkedItems {
  return {
    tasks: new Map([...input.state.tasks].filter(([, task]) => task.kind !== 'monitor')),
    subagents: new Map(input.state.subagents),
    since: input.generation.since,
  }
}

/**
 * `cost-state` 때 재시작으로 넘어갈 수 있는 것 (LIFE-794) — 지금까지 모은 것에 이번에 열린 것 중 bg 프로세스가 연 셸·비동기 에이전트를 더한다.
 * 재시작은 `cost-state` 를 두 줄 연달아 쓴다(실측) — 대입이 아니라 더해야 두 번째 줄이 첫 줄의 몫을 지우지 않는다.
 * ① Monitor 는 `bgOpened` 에 넣지 않아(Monitor 결과 분기) 여기 오지 않는다 — 재시작 때 새 프로세스가 `killed`·`stopped` 통지를 쓰고 멈췄다(실측 m0, 문서도 같이 멈춘다).
 * ② 동기 에이전트(tool_use id)는 `bgOpened` 에 없어 빠진다. ③ 대화형 프로세스가 연 것(`sessionKind` 없음)도 빠진다 — 그 `cost-state` 는
 *    재개 경계(L8)다. 넘어가지 못한 셸에는 새 프로세스가 `stopped` 통지를 쓴다(handoff 끔 실측) — 그 통지로 빠진다.
 */
function restartable(state: ClaudeState): ClaudeItems | null {
  const tasks = new Map([...(state.restart?.tasks ?? []), ...[...state.tasks].filter(([id]) => state.bgOpened.has(id))])
  const subagents = new Map([...(state.restart?.subagents ?? []), ...[...state.subagents].filter(([id]) => state.bgOpened.has(id))])
  return tasks.size + subagents.size === 0 ? null : { tasks, subagents }
}

/**
 * 같은 파일에 대화가 이어졌다(재개) — 보류분은 그 프로세스와 같이 죽었고, 넘긴 것도 이 파일의 몫이 아니다.
 * 766 판별도 `continued-in` 뒤 사람 줄이면 이어 가기를 무효로 본다. 옛 열림은 세대 경계(L8)가 가른다.
 */
function resumed(state: ClaudeState): void {
  state.parked = null
  state.handoff = null
}

/** 끝 통지만 실은 `user` 레코드 — 사람 줄이 아니다. 보류 중에도 통지는 와서 보류분을 닫는다. */
function notificationOnly(record: Record<string, unknown>): boolean {
  const content = claudeContent(record)
  return typeof content === 'string' && content.trimStart().startsWith('<task-notification>')
}

/** 열린 것·보류분·넘긴 것 — 끝 표지는 셋 모두에 듣는다. */
function claudeItems(state: ClaudeState): ClaudeItems[] {
  const all: ClaudeItems[] = [state]
  if (state.parked !== null) all.push(state.parked)
  if (state.handoff !== null) all.push(state.handoff)
  if (state.restart !== null) all.push(state.restart)
  return all
}

function claudeContent(record: Record<string, unknown>): unknown {
  const message = record['message']
  return isRecord(message) ? message['content'] : null
}

function applyClaudeToolUses(input: { state: ClaudeState; record: Record<string, unknown>; at: number | null }): void {
  const content = claudeContent(input.record)
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_use') continue
    const id = readString(block, 'id')
    const name = readString(block, 'name')
    if (id === null || name === null || !CLAUDE_TRACKED_TOOLS.has(name)) continue
    const toolInput = isRecord(block['input']) ? block['input'] : {}
    const description = oneLine(readString(toolInput, 'description'))
    input.state.calls.set(id, { label: description ?? oneLine(readString(toolInput, 'command')), at: input.at })
    if (name === 'Agent' || name === 'Task') {
      input.state.subagents.set(id, {
        id,
        name: oneLine(readString(toolInput, 'name')),
        description,
        agentType: readString(toolInput, 'subagent_type'),
        background: toolInput['run_in_background'] === true,
        startedAt: input.at,
        status: 'running',
      })
    }
  }
}

function applyClaudeUser(input: { state: ClaudeState; record: Record<string, unknown>; at: number | null }): void {
  const { state, record, at } = input
  const content = claudeContent(record)
  if (typeof content === 'string') {
    applyNotification({ state, text: content })
    return
  }
  if (!Array.isArray(content)) return
  const resultIds: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text') applyNotification({ state, text: readString(block, 'text') })
    if (block['type'] !== 'tool_result') continue
    const id = readString(block, 'tool_use_id')
    if (id !== null) resultIds.push(id)
  }
  // `toolUseResult` 는 레코드에 하나다 — 결과 블록이 하나일 때만 그 호출의 결과로 읽는다.
  const result = record['toolUseResult']
  const only = resultIds.length === 1 ? resultIds[0] : undefined
  const call = only === undefined ? undefined : state.calls.get(only)
  const syncAgent = only === undefined ? undefined : state.subagents.get(only)
  for (const id of resultIds) {
    state.calls.delete(id)
    state.subagents.delete(id) // 동기 서브에이전트는 결과가 오면 끝이다(성공·오류·중단 모두 tool_result 로 온다)
  }
  if (!isRecord(result)) return
  // bg 프로세스가 쓴 줄로 열린 것 — `cost-state` 때 재시작으로 넘어갈 후보다(LIFE-794). 대화형 줄에는 `sessionKind` 가 없다(관측).
  const byBg = readString(record, 'sessionKind') === 'bg'
  const backgroundTaskId = readString(result, 'backgroundTaskId')
  const taskId = readString(result, 'taskId')
  const agentId = readString(result, 'agentId')
  const stoppedId = readString(result, 'task_id')
  if (backgroundTaskId !== null) {
    state.tasks.set(backgroundTaskId, { id: backgroundTaskId, kind: 'shell', label: call?.label ?? null, startedAt: at ?? call?.at ?? null })
    if (byBg) state.bgOpened.add(backgroundTaskId)
  } else if (taskId !== null && 'timeoutMs' in result) {
    state.tasks.set(taskId, { id: taskId, kind: 'monitor', label: call?.label ?? null, startedAt: at ?? call?.at ?? null })
  } else if (agentId !== null && readString(result, 'status') === 'async_launched') {
    const description = syncAgent?.description ?? oneLine(readString(result, 'description'))
    const startedAt = syncAgent?.startedAt ?? at
    state.tasks.set(agentId, { id: agentId, kind: 'agent', label: description, startedAt })
    state.subagents.set(agentId, {
      id: agentId,
      name: syncAgent?.name ?? null,
      description,
      agentType: syncAgent?.agentType ?? null,
      background: true,
      startedAt,
      status: 'running',
    })
    if (byBg) state.bgOpened.add(agentId)
  } else if (stoppedId !== null && 'task_type' in result) {
    closeClaude({ state, id: stoppedId }) // TaskStop 결과
  }
}

const NOTIFICATION_ID = /<task-id>([^<]+)<\/task-id>/g

/** `<task-notification>` 에 `<status>` 가 있으면 그 안의 task-id 전부를 닫는다. 모르는 id 는 무시한다(U8). */
function applyNotification(input: { state: ClaudeState; text: string | null }): void {
  const text = input.text?.trimStart() ?? null
  if (text === null || !text.startsWith('<task-notification>')) return
  if (!/<status>[^<]*<\/status>/.test(text)) return // Monitor `<event>` 통지 — 끝이 아니다
  for (const match of text.matchAll(NOTIFICATION_ID)) {
    const id = match[1]
    if (id !== undefined) closeClaude({ state: input.state, id: id.trim() })
  }
}

function closeClaude(input: { state: ClaudeState; id: string }): void {
  for (const items of claudeItems(input.state)) {
    items.tasks.delete(input.id)
    items.subagents.delete(input.id)
  }
  input.state.bgOpened.delete(input.id)
  const { ended } = input.state
  ended.delete(input.id)
  ended.add(input.id)
  if (ended.size > ENDED_MAX) for (const id of ended) {
    ended.delete(id)
    break
  }
}

/** 끝 표지를 본 id 를 기억하는 수 — 넘겨받은 것 확인용이라 최근 것이면 된다. */
const ENDED_MAX = 1024

/** `continuedInSessionId` 모양 — 이어 가기 판별(`transcript-continued.ts`)과 같은 규칙이다. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function applyGrokRecord(input: { state: GrokState; record: Record<string, unknown> }): void {
  const params = input.record['params']
  const update = isRecord(params) && isRecord(params['update']) ? params['update'] : null
  if (update === null) return
  const meta = isRecord(params) && isRecord(params['_meta']) ? params['_meta'] : null
  const at = meta !== null && typeof meta['agentTimestampMs'] === 'number' ? meta['agentTimestampMs'] : null
  const { state } = input
  switch (readString(update, 'sessionUpdate')) {
    case 'tool_call': {
      const callId = readString(update, 'toolCallId')
      if (update['title'] !== 'spawn_subagent' || callId === null) return
      const background = isRecord(update['rawInput']) ? update['rawInput']['background'] : undefined
      state.spawnCalls.set(callId, typeof background === 'boolean' ? background : null)
      return
    }
    case 'tool_call_update': {
      const callId = readString(update, 'toolCallId')
      const status = readString(update, 'status')
      if (callId === null || !state.spawnCalls.has(callId) || (status !== 'completed' && status !== 'failed')) return
      const background = state.spawnCalls.get(callId) ?? null
      state.spawnCalls.delete(callId)
      // 이 호출이 만든 자식 — 결과 본문의 `subagent_id: <id>` 로만 묶는다. 실패·본문 없음이면 아무 자식에도 안 붙는다(F4).
      const id = status === 'completed' ? spawnedId(update) : null
      if (id === null) return
      const child = state.subagents.get(id)
      // 새 객체로 바꾼다 — 이미 내보낸 지문이 같은 객체를 쥐고 있어 제자리 수정은 변화 감지(emit)를 가린다.
      if (child !== undefined) state.subagents.set(id, { ...child, background })
      else state.spawnedBackground.set(id, background)
      return
    }
    case 'subagent_spawned': {
      const id = readString(update, 'subagent_id')
      if (id === null) return
      const background = state.spawnedBackground.get(id) ?? null
      state.spawnedBackground.delete(id)
      state.subagents.set(id, {
        id,
        name: null,
        description: oneLine(readString(update, 'description')),
        agentType: readString(update, 'subagent_type'),
        background,
        startedAt: at,
        status: 'running',
      })
      return
    }
    case 'subagent_finished': {
      const id = readString(update, 'subagent_id')
      if (id !== null) state.subagents.delete(id)
      return
    }
    case 'background_tasks': {
      // 전체 스냅샷 — 지금 도는 것만 남긴다. `kind` 는 관측된 `bash` 만 옮긴다(다른 값은 지어내지 않는다).
      // `tasks` 가 배열이 아니면 작업 없음의 증거가 아니다 — 지난 목록을 버리고 모름으로 둔다(F3).
      const tasks = update['tasks']
      state.tasks.clear()
      state.tasksInvalid = !Array.isArray(tasks)
      if (!Array.isArray(tasks)) return
      for (const task of tasks) {
        if (!isRecord(task) || task['status'] !== 'running' || task['kind'] !== 'bash') continue
        const id = readString(task, 'task_id')
        if (id === null) continue
        const label = oneLine(readString(task, 'description')) ?? oneLine(readString(task, 'command'))
        state.tasks.set(id, { id, kind: 'shell', label, startedAt: readTimestamp(task['started_at']) })
      }
      return
    }
    case 'task_completed': {
      const snapshot = update['task_snapshot']
      const id = isRecord(snapshot) ? readString(snapshot, 'task_id') : null
      if (id !== null) state.tasks.delete(id)
      return
    }
    default:
      return
  }
}

/** 백그라운드 spawn 결과 봉투 — 본문 **맨 앞** 두 줄(네이티브 표본 4/4). 다른 자리의 `subagent_id:` 는 쓰지 않는다(U6). */
const SPAWNED_ID = /^Subagent started in background\.\nsubagent_id: ([0-9A-Za-z-]+)\n/

/** `spawn_subagent` 호출 결과 본문(`rawOutput.text` 또는 `content[].content.text`)의 봉투에서 자식 id. */
function spawnedId(update: Record<string, unknown>): string | null {
  const texts: string[] = []
  const rawOutput = update['rawOutput']
  if (isRecord(rawOutput)) {
    const text = readString(rawOutput, 'text')
    if (text !== null) texts.push(text)
  }
  const content = update['content']
  if (Array.isArray(content)) {
    for (const block of content) {
      const inner = isRecord(block) ? block['content'] : null
      const text = isRecord(inner) ? readString(inner, 'text') : null
      if (text !== null) texts.push(text)
    }
  }
  for (const text of texts) {
    const match = SPAWNED_ID.exec(text)
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

/** 이름 한 줄 상한 — 명령 미리보기가 수 KB 여도 IPC 로 통째 나르지 않는다(워커 재량). */
const LABEL_MAX_CHARS = 200

function oneLine(value: string | null): string | null {
  const cleaned = value === null ? null : cleanActivityText(value)
  return cleaned === null ? null : cleaned.slice(0, LABEL_MAX_CHARS)
}

function readBytes(input: { file: string; from: number; to: number }): Buffer {
  const length = Math.max(0, input.to - input.from)
  const buffer = Buffer.alloc(length)
  if (length === 0) return buffer
  const handle = fs.openSync(input.file, 'r')
  try {
    let read = 0
    while (read < length) {
      const count = fs.readSync(handle, buffer, read, length - read, input.from + read)
      if (count === 0) break
      read += count
    }
    return buffer.subarray(0, read)
  } finally {
    fs.closeSync(handle)
  }
}

// --- claude 프로세스 레지스트리 (L8) -----------------------------------------------------

type RegistryEntry = {
  size: number
  mtimeMs: number
  pid: number | null
  sessionId: string | null
  startedAt: number | null
  /** `kind`·`jobId` — 전환으로 이어 받은 bg 세션은 `kind:"bg"`·`jobId:<대상 id 앞 8자>`(2.1.296 관측, LIFE-781 F5). */
  kind: string | null
  jobId: string | null
  /** 세션 단위 상태(`busy`·`shell`·`idle` — 2.1.296 관측). 작업 단위 생존이 아니다 — `idle` 을 「넘어간 작업 없음」으로 빼는 쪽으로만 쓴다(LIFE-794 리뷰 r1 B). */
  status: string | null
}

/**
 * 소유 프로세스 판정 — `alive` 면 `since` 는 살아 있는 소유 프로세스(여럿이면 가장 오래된 것)의 시작 시각(epoch ms)이다.
 * 시작 시각을 못 구했으면 null — 세대를 가를 수 없다.
 */
export type Owner = { alive: false } | { alive: true; since: number | null }

/** 살아 있는 소유자들의 시작 시각 중 가장 이른 것. 하나라도 모르면 null. */
function ownerOf(starts: (number | null)[]): Owner {
  if (starts.length === 0) return { alive: false }
  if (starts.some((start) => start === null)) return { alive: true, since: null }
  return { alive: true, since: Math.min(...starts.filter((start) => start !== null)) }
}
const registry = new Map<string, RegistryEntry>()

/**
 * 이 세션 id 를 가진 **살아 있는** claude 대화형 프로세스가 있나 — `<HOME>/.claude/sessions/<pid>.json` 을 본다(관측, 계약 아님).
 * 파일마다 mtime·size 캐시라 안 바뀐 파일은 `stat` 만 한다. 읽은 바이트를 같이 돌려준다(L7 누적 판독 계정).
 * 폴더가 없거나 못 읽으면 "없다" 다 — 모르는 생존을 살아 있다고 치지 않는다. pid 재사용은 가리지 못한다(한계).
 * 레지스트리를 한 번 훑어 세션 id 마다 소유자를 고르는 함수를 준다 — 한 참조가 제 세션과 넘겨받은 세션(LIFE-781)을 함께 볼 때
 * 폴더를 두 번 훑지 않는다.
 */
export function claudeLiveSessions(input: { dir: string }): {
  owner: (sessionId: string) => Owner
  bgOwner: (sessionId: string) => Owner
  bgIdle: (sessionId: string) => boolean
  bytes: number
} {
  let names: string[]
  try {
    names = fs.readdirSync(input.dir).filter((name) => name.endsWith('.json'))
  } catch {
    registry.clear()
    return { owner: () => ({ alive: false }), bgOwner: () => ({ alive: false }), bgIdle: () => false, bytes: 0 }
  }
  let bytes = 0
  const entries: RegistryEntry[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const file = `${input.dir}/${name}`
    seen.add(file)
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    let entry = registry.get(file) ?? null
    if (entry === null || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        bytes += stat.size
      } catch {
        parsed = null // 쓰는 중·깨진 파일 — 이 주기엔 없는 것으로 본다
      }
      const pid = isRecord(parsed) && typeof parsed['pid'] === 'number' ? parsed['pid'] : null
      // `startedAt` — 프로세스 시작 시각(epoch ms, `ps` 시작 시각과 1초 안 — 관측)
      const startedAt = isRecord(parsed) && typeof parsed['startedAt'] === 'number' ? parsed['startedAt'] : null
      entry = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        pid,
        sessionId: isRecord(parsed) ? readString(parsed, 'sessionId') : null,
        startedAt,
        kind: isRecord(parsed) ? readString(parsed, 'kind') : null,
        jobId: isRecord(parsed) ? readString(parsed, 'jobId') : null,
        status: isRecord(parsed) ? readString(parsed, 'status') : null,
      }
      registry.set(file, entry)
    }
    entries.push(entry)
  }
  for (const file of registry.keys()) if (!seen.has(file)) registry.delete(file)
  // 생존은 묻는 세션의 항목만 본다 — 남의 세션 pid 마다 신호를 보내지 않는다.
  const live = (match: (entry: RegistryEntry) => boolean): Owner =>
    ownerOf(entries.filter((entry) => match(entry) && entry.pid !== null && processAlive(entry.pid)).map((entry) => entry.startedAt))
  const owner = (sessionId: string): Owner => live((entry) => entry.sessionId === sessionId)
  // 넘긴 것의 주인 — 이어 받은 bg 세션 항목만(`kind:"bg"` · `jobId` 가 그 id 앞부분). 모양이 다르면 주인이 없다(빠짐 쪽, R1-5).
  // 같은 id 를 대화형으로 `--resume` 한 프로세스는 넘긴 셸을 모른다.
  const isBg = (entry: RegistryEntry, sessionId: string) =>
    entry.sessionId === sessionId && entry.kind === 'bg' && entry.jobId !== null && entry.jobId.length > 0 && sessionId.startsWith(entry.jobId)
  const bgOwner = (sessionId: string): Owner => live((entry) => isBg(entry, sessionId))
  // 살아 있는 bg 항목이 전부 `idle` 이다 — 그 프로세스가 도는 셸·서브에이전트가 없다고 스스로 적었다(실측: 셸이 돌면 `shell`, 서브에이전트가 돌면 `busy`,
  // 끝 뒤·handoff 끔 재시작 직후 `idle`). 재시작 몫을 **빼는 쪽으로만** 쓴다(LIFE-794 리뷰 r1 B). 모르는 값·없는 값은 빼지 않는다.
  const bgIdle = (sessionId: string): boolean => {
    const bg = entries.filter((entry) => isBg(entry, sessionId) && entry.pid !== null && processAlive(entry.pid))
    return bg.length > 0 && bg.every((entry) => entry.status === 'idle')
  }
  return { owner, bgOwner, bgIdle, bytes }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 있는데 남의 프로세스다 — 살아 있다.
    return isRecord(error) && error['code'] === 'EPERM'
  }
}

// --- grok 프로세스 레지스트리 (L8) -------------------------------------------------------

type GrokEntry = { sessionId: string; pid: number; startedAt: number | null | undefined }
let grokRegistry: { size: number; mtimeMs: number; entries: GrokEntry[] } | null = null

/**
 * 이 세션 id 를 가진 **살아 있는** grok 프로세스가 있나 — `<HOME>/.grok/active_sessions.json`(`[{session_id, pid, cwd}]`)을 본다
 * (네이티브 관측 `raw/claude/l10/runs-r2/n44`·`n45`, 계약 아님). grok 은 `/exit` 에 그 행을 지우고, `--resume` 에 새 pid 로 다시 쓴다.
 * 강제 종료는 행을 남기므로 `kill(pid, 0)` 으로 본다. mtime·size 캐시, 못 읽으면 "없다" — claude 레지스트리와 같은 규칙.
 * 레지스트리에 시작 시각이 없어서 세대 경계는 `ps` 의 프로세스 시작 시각으로 본다 — 행마다 한 번만 묻는다(파일이 바뀌면 다시).
 */
export function grokSessionAlive(input: { file: string; sessionId: string }): { owner: Owner; bytes: number } {
  let stat: fs.Stats
  try {
    stat = fs.statSync(input.file)
  } catch {
    grokRegistry = null
    return { owner: { alive: false }, bytes: 0 }
  }
  let bytes = 0
  if (grokRegistry === null || grokRegistry.size !== stat.size || grokRegistry.mtimeMs !== stat.mtimeMs) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(fs.readFileSync(input.file, 'utf8'))
      bytes = stat.size
    } catch {
      parsed = null // 쓰는 중·깨진 파일 — 이 주기엔 없는 것으로 본다
    }
    const entries: GrokEntry[] = []
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        const sessionId = isRecord(row) ? readString(row, 'session_id') : null
        const pid = isRecord(row) && typeof row['pid'] === 'number' ? row['pid'] : null
        if (sessionId !== null && pid !== null) entries.push({ sessionId, pid, startedAt: undefined })
      }
    }
    grokRegistry = { size: stat.size, mtimeMs: stat.mtimeMs, entries }
  }
  const starts: (number | null)[] = []
  for (const entry of grokRegistry.entries) {
    if (entry.sessionId !== input.sessionId || !processAlive(entry.pid)) continue
    if (entry.startedAt === undefined) entry.startedAt = processStartMs(entry.pid)
    starts.push(entry.startedAt)
  }
  return { owner: ownerOf(starts), bytes }
}

/**
 * 프로세스 시작 시각(epoch ms, 초 단위 내림) — `ps -o lstart=`. 못 구하면 null.
 * 초 단위라 새 프로세스의 항목은 늘 이 값 이상이다. 옛 항목이 새 프로세스와 같은 초에 열렸으면 못 가른다(한계).
 */
function processStartMs(pid: number): number | null {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { LC_ALL: 'C' } })
    const at = Date.parse(out.trim())
    return Number.isNaN(at) ? null : at
  } catch {
    return null
  }
}

/** 레지스트리 캐시를 비운다 — `clearTranscriptCache` 가 같이 부른다. */
export function clearClaudeRegistry(): void {
  registry.clear()
  grokRegistry = null
}
