// 작업 출처 레지스트리 + 연결 관리 (LIFE-600 킥오프 2·5·6·7) — IPC 가 부르는 main 쪽 한 곳.
//
// - 연결마다 출처 클라이언트 인스턴스 하나. **자격은 그 연결이 처음 쓰일 때 푼다**(연결 테스트·작업 요청) — 앱 기동은 금고를 건드리지 않는다.
//   풀 때는 연결 상태를 `testing` + `pending: keychain` 으로 먼저 밀어, 화면이 「macOS 가 허용을 물을 수 있다」 를 보이게 한다.
// - 연결 추가: 형식 검사(보내기 전 거절) → **연결 테스트 통과 뒤에만** 싸고(키체인) → 파일에 쓴다. 어느 단계든 실패면 저장 0.
// - 요청: 손검증(unknown → 계약) → 연결 확인 → **능력 문**(꺼진 능력은 출처에 닿기 전에 `unsupported` + 이유) → 출처 → 결과 연산 대조.
// - 오류 5종 중 인증·권한·네트워크·키체인은 연결 상태(pill)를 바꾼다. **인증 실패만 「토큰 다시 붙여넣기」** — 권한 부족·네트워크는 연결 유지.
// - 밖으로 나가는 모양(`WorkSettingsState`·`WorkResponse`)에 토큰은 없다. 끝 4자만.
// - **연결 단위 상태 모델**(R2-A·B·H · R3-A·B·C, notes §11 전이 표):
//   ① 세대(generation) — 자격 교체·해제 때만 오른다. 오르면 그 세대의 클라이언트를 닫는다. 닫힌 클라이언트는 새 전송을 하지 않는다
//      (여러 단계 연산의 다음 단계 포함). **이미 보낸 쓰기는 되돌리지 못한다.**
//   ② 클라이언트 획득은 세대마다 promise 하나(`acquire` — 풀기 + 만들기 + 설치). 동시 첫 요청이 그것을 나눠 쓴다 → 세대마다 클라이언트 하나.
//   ③ **진행 표시와 확정 상태를 나눈다** — 진행 표시(`progress`: 획득·누른 테스트·교체가 저마다 하나씩 넣고 끝나면 자기 것만 뺀다)가 하나라도
//      있으면 화면은 `testing`. 확정 상태(`settled`: unchecked·ok·auth·forbidden·offline·keychain)는 결과만 바꾼다. 실패는 자기 진행 표시만
//      거둔다 — 확정 상태를 되돌리거나 `checkedAt` 으로 추정하지 않는다.
//   ④ 요청 순번(ticket) — 결과가 확정 상태를 바꾸려면 같은 세대이고 순번 > `settledTicket`(확정 상태를 마지막으로 정한 순번).
//      auth 는 `settledTicket` 을 **그때까지 발급한 마지막 순번**으로 올린다 → auth 시점에 진행 중이던 모든 요청(마지막 순번 포함)은 auth 를 풀지 못한다.
//      auth 상태에서는 일반 요청을 보내지 않으므로, auth 를 푸는 것은 auth 이후에 시작한 「연결 테스트」 와 토큰 교체(새 세대)뿐이다.
//      **자격 무효(`rejected`)는 확정 상태와 다른 축**(R4-A) — auth 가 세우고, 소유한 **성공**(누른 테스트 성공)이나 새 세대(교체 성공)만 거둔다.
//      재시험이 network·5xx·forbidden·invalid_response 로 실패하면 화면은 그 장애를 보이지만 일반 요청 차단은 그대로다.
//      **데이터 순번은 상태 순번과 따로**(R4-C) — 스페이스 목록은 `spacesTicket` 보다 늦게 시작했고 마지막 auth(`authFloor`) 뒤에 시작한
//      목록 성공이면 받는다. 목록이 없는 후행 성공(예: listStatuses)이 먼저 시작한 목록 성공을 버리게 하지 않는다.
//   ⑤ 설정 저장은 저장 직전 최신 행을 읽어 자기 칸만 바꾼다 — 토큰 교체는 자격 칸만, 숨김·레포 기본은 그대로(R2-H).
// - 밖으로 나가는 오류 문구는 마지막 경계(이 파일의 IPC 응답·push)에서 금고가 아는 토큰을 한 번 더 지운다(R2-F).
// - **활동 기록(LIFE-602 D9)** — 쓰기 연산은 보낼 때마다 쓰기 id 를 새로 만들어 출처에 메타로 싣고(`WorkCallMeta`), **성공한 쓰기만**
//   그 id 로 활동 저장소에 남긴다. 상세·보드·백로그 어디서 바꿨든 이 한 곳을 지난다. 세대가 바뀌어 버린 결과는 남기지 않는다.
//   상태 라벨·뗀 연결의 상대는 이 서비스를 지난 응답(상태 목록·단건)에서 기억한 값으로 채운다 — 모르면 null(화면이 「다른 상태」 등으로).

import { randomUUID } from 'node:crypto'
import { isRecord } from '../../shared/json.js'
import {
  capabilitiesOf,
  connectionStatusOf,
  readWorkActivityQuery,
  readWorkRequest,
  type WorkActionResult,
  type WorkActivityChange,
  type WorkActivityResult,
  type WorkCall,
  type WorkItem,
  type WorkResult,
  type WorkCapabilities,
  type WorkConnectionAddResult,
  type WorkConnectionPending,
  type WorkConnectionStatus,
  type WorkConnectionSummary,
  type WorkError,
  type WorkResponse,
  type WorkSettingsState,
  type WorkSpace,
} from '../../shared/work.js'
import { log } from '../log.js'
import { redactSecret, workError } from './errors.js'
import type { ActivityPort } from './activity-store.js'
import type { WorkOutcome, WorkSourceClient, WorkSourceRegistry } from './source.js'
import type { StoredConnection, WorkStoreData, WorkStoreWrite } from './store.js'
import type { CredentialVault } from './vault.js'

export type WorkStorePort = { get(): WorkStoreData; write(next: WorkStoreData): WorkStoreWrite }
export type WorkRepoRef = { id: string; root: string }

export type WorkServiceDeps = {
  store: WorkStorePort
  vault: CredentialVault
  sources: WorkSourceRegistry
  /** 등록된 레포 — 기본 스페이스의 키(`RepoRecord.id`) ↔ 화면의 `root`. */
  repos: () => WorkRepoRef[]
  onChange: (state: WorkSettingsState) => void
  /** 활동 저장소(LIFE-602) — 없으면 기록하지 않는다. */
  activity?: ActivityPort
  now?: () => number
  newId?: () => string
}

type SettledStatus = Exclude<WorkConnectionStatus, 'testing'>
/** 마지막 확정 상태 — 결과만 바꾼다. */
type Settled = { status: SettledStatus; error: WorkError | null; checkedAt: number | null }

type Runtime = {
  settled: Settled
  /** 진행 표시 — id → 기다리는 것. 비어 있지 않으면 화면은 testing, pending 은 마지막에 넣은 것. */
  progress: Map<number, WorkConnectionPending>
  spaces: WorkSpace[] | null
  capabilities: WorkCapabilities | null
  client: WorkSourceClient | null
  /** 이 세대의 클라이언트 획득(풀기 + 만들기 + 설치) — 진행 중이면 동시 요청이 나눠 쓴다. */
  acquiring: Promise<Acquired> | null
  /** 확정 상태를 마지막으로 정한 순번(auth 면 그때 발급한 마지막 순번) — 이 순번 이하로 시작한 요청의 결과는 확정 상태를 바꾸지 못한다. */
  settledTicket: number
  /** 자격 무효 — 서버가 이 자격을 거부했다(auth). 소유한 성공 또는 새 세대만 거둔다. 있으면 일반 요청을 보내지 않는다(R4-A). */
  rejected: WorkError | null
  /** 마지막 auth 때 발급돼 있던 마지막 순번 — 이 순번 이하로 시작한 요청의 데이터(스페이스 목록)는 받지 않는다. */
  authFloor: number
  /** 스페이스 목록을 마지막으로 정한 순번(R4-C). */
  spacesTicket: number
}

type Acquired = { ok: true; client: WorkSourceClient; fresh: boolean } | { ok: false; stale: true } | { ok: false; stale: false; error: WorkError }
type Claim = { connectionId: string; generation: number; ticket: number }

const MAX_TOKEN_LENGTH = 512
const LAST_SPACE_REASON = '마지막 스페이스는 끌 수 없습니다 — 연결을 해제하세요'

function freshRuntime(): Runtime {
  return { settled: { status: 'unchecked', error: null, checkedAt: null }, progress: new Map(), spaces: null, capabilities: null, client: null, acquiring: null, settledTicket: 0, rejected: null, authFloor: 0, spacesTicket: 0 }
}

function invalid(message: string): WorkError {
  return workError({ kind: 'invalid_request', message })
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

export class WorkService {
  private readonly deps: WorkServiceDeps
  private readonly runtime = new Map<string, Runtime>()
  private readonly generations = new Map<string, number>()
  private generationSeq = 0
  private ticketSeq = 0
  private progressSeq = 0
  private readonly now: () => number
  private readonly newId: () => string
  /** 연결 → 상태 키 → 라벨 (상태 목록 응답에서) — 활동 기록의 상태 라벨. */
  private readonly statusLabels = new Map<string, Map<string, string>>()
  /** 연결 → 작업 id → 마지막으로 본 단건(연결 포함) — 뗀 연결의 상대를 활동에 적는 데. */
  private readonly seenItems = new Map<string, Map<string, WorkItem>>()

  constructor(deps: WorkServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
  }

  settings(): WorkSettingsState {
    const data = this.deps.store.get()
    const repos = this.deps.repos()
    const connections = data.connections.flatMap((stored) => {
      const summary = this.summaryOf(stored)
      return summary === null ? [] : [summary]
    })
    const repoDefaults = Object.entries(data.repoDefaults).flatMap(([repoId, entry]) => {
      const repo = repos.find((row) => row.id === repoId)
      return repo === undefined ? [] : [{ repoRoot: repo.root, connectionId: entry.connectionId, spaceKey: entry.spaceKey }]
    })
    return { sources: this.deps.sources.descriptors(), connections, repoDefaults }
  }

  async addConnection(input: unknown): Promise<WorkConnectionAddResult> {
    if (!isRecord(input) || !nonEmpty(input.sourceId) || typeof input.token !== 'string') return { ok: false, error: invalid('연결 입력이 잘못됐습니다.') }
    const replaceId = input.replaceId ?? null
    if (replaceId !== null && !nonEmpty(replaceId)) return { ok: false, error: invalid('바꿀 연결 id 가 잘못됐습니다.') }
    const entry = this.deps.sources.get(input.sourceId)
    if (entry === null) return { ok: false, error: invalid('모르는 작업 출처입니다.') }
    const existing = replaceId === null ? null : this.deps.store.get().connections.find((row) => row.id === replaceId) ?? null
    if (replaceId !== null && (existing === null || existing.sourceId !== entry.descriptor.id)) return { ok: false, error: invalid('바꿀 연결이 없습니다.') }
    // 보내기 전에 거절한다 — LA 는 형식 다른 토큰에 500 을 주므로, 그 경로를 아예 열지 않는다(C5).
    const token = input.token.trim()
    if (token.length === 0) return { ok: false, error: invalid('토큰을 붙여넣으세요.') }
    if (token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) return { ok: false, error: invalid('토큰 모양이 아닙니다 — 공백 없이 한 줄이어야 합니다.') }
    const prefix = entry.descriptor.tokenPrefix
    if (prefix !== null && !token.startsWith(prefix)) return { ok: false, error: invalid(`${entry.descriptor.tokenLabel}은 ${prefix} 로 시작합니다. 보내지 않았습니다.`) }

    // 교체가 실패하면 자기 진행 표시만 거둔다(R1-D·R3-B) — 확정 상태는 건드리지 않으므로, 그사이 다른 요청이 정한 더 새 상태를 되돌리지 않는다.
    const generation = existing === null ? null : this.generation(existing.id)
    const progress = existing === null ? null : this.beginProgress({ connectionId: existing.id, pending: 'network' })
    const fail = ({ error, client }: { error: WorkError; client: WorkSourceClient | null }): WorkConnectionAddResult => {
      client?.close()
      if (existing !== null && progress !== null) this.endProgress({ connectionId: existing.id, progress })
      log('work.connection_add', { source: entry.descriptor.id, replace: existing !== null, ok: false, errorKind: error.kind, status: error.status })
      // 붙여넣은 토큰은 아직 금고에 없다 — 그것까지 지운다.
      return { ok: false, error: this.scrub({ error, secret: token }) }
    }
    // 교체하는 동안 그 연결이 해제·다시 교체됐으면 이 교체는 버린다.
    const superseded = (): boolean => existing !== null && generation !== this.generation(existing.id)
    const supersededError = workError({ kind: 'not_connected', message: '토큰을 바꾸는 동안 연결이 해제됐거나 다시 바뀌었습니다. 저장하지 않았습니다.' })

    const client = entry.create(token)
    const tested = await client.call({ op: 'listSpaces' })
    if (superseded()) return fail({ error: supersededError, client })
    if (!tested.ok || tested.result.op !== 'listSpaces') {
      const error = tested.ok ? workError({ kind: 'invalid_response', message: '연결 테스트 응답이 스페이스 목록이 아닙니다.' }) : tested.error
      return fail({ error, client })
    }
    const sealed = await this.deps.vault.seal(token)
    if (superseded()) return fail({ error: supersededError, client })
    if (!sealed.ok) return fail({ error: sealed.error, client })
    // 저장 직전 최신 행 — 교체를 기다리는 동안 바뀐 비자격 설정(숨김 스페이스)을 보존하고 자격 칸만 바꾼다(R2-H).
    const data = this.deps.store.get()
    const id = existing?.id ?? this.newId()
    const latest = existing === null ? null : data.connections.find((row) => row.id === id) ?? null
    if (existing !== null && latest === null) return fail({ error: supersededError, client })
    const stored: StoredConnection = {
      id,
      sourceId: entry.descriptor.id,
      addedAt: latest?.addedAt ?? this.now(),
      tokenTail: token.slice(-4),
      sealed: sealed.sealed,
      hiddenSpaceKeys: latest === null ? [] : [...latest.hiddenSpaceKeys],
    }
    const next: WorkStoreData = { ...data, connections: existing === null ? [...data.connections, stored] : data.connections.map((row) => (row.id === id ? stored : row)) }
    const written = this.deps.store.write(next)
    if (!written.ok) return fail({ error: workError({ kind: 'local_write', message: `연결을 저장하지 못했습니다 (${written.error.slice(0, 120)}).` }), client })
    // 옛 토큰으로 진행 중인 요청은 세대가 바뀌어 결과를 버리고, 옛 클라이언트는 더 보내지 않는다.
    this.bump(id)
    this.runtime.get(id)?.client?.close()
    this.deps.vault.forget(id)
    this.deps.vault.remember({ connectionId: id, token })
    // 새 세대 — 확정 상태는 ok 하나로 시작한다(옛 세대의 진행 표시·오류는 함께 버린다).
    this.runtime.set(id, { ...freshRuntime(), settled: { status: 'ok', error: null, checkedAt: this.now() }, settledTicket: this.ticketSeq, authFloor: this.ticketSeq, spacesTicket: this.ticketSeq, spaces: tested.result.spaces, capabilities: tested.result.capabilities, client })
    log('work.connection_add', { source: entry.descriptor.id, replace: existing !== null, ok: true, spaces: tested.result.spaces.length })
    this.emit()
    const summary = this.summaryOf(stored)
    return summary === null ? { ok: false, error: invalid('연결 출처가 사라졌습니다.') } : { ok: true, connection: summary }
  }

  async testConnection(input: unknown): Promise<WorkActionResult> {
    const id = isRecord(input) && nonEmpty(input.connectionId) ? input.connectionId : null
    if (id === null) return { ok: false, error: invalid('연결 id 가 잘못됐습니다.') }
    const outcome = await this.run({ connectionId: id, call: { op: 'listSpaces' }, announce: true })
    return outcome.ok ? { ok: true } : { ok: false, error: this.scrub({ error: outcome.error }) }
  }

  removeConnection(input: unknown): WorkActionResult {
    const id = isRecord(input) && nonEmpty(input.connectionId) ? input.connectionId : null
    if (id === null) return { ok: false, error: invalid('연결 id 가 잘못됐습니다.') }
    const data = this.deps.store.get()
    if (!data.connections.some((row) => row.id === id)) return { ok: false, error: workError({ kind: 'not_connected', message: '없는 연결입니다.' }) }
    const repoDefaults = Object.fromEntries(Object.entries(data.repoDefaults).filter(([, entry]) => entry.connectionId !== id))
    const written = this.deps.store.write({ connections: data.connections.filter((row) => row.id !== id), repoDefaults })
    if (!written.ok) return { ok: false, error: workError({ kind: 'local_write', message: `연결을 해제하지 못했습니다 (${written.error.slice(0, 120)}).` }) }
    this.bump(id)
    this.runtime.get(id)?.client?.close()
    this.deps.vault.forget(id)
    this.runtime.delete(id)
    this.statusLabels.delete(id)
    this.seenItems.delete(id)
    this.deps.activity?.purgeConnection(id)
    log('work.connection_remove', { ok: true })
    this.emit()
    return { ok: true }
  }

  setSpaceHidden(input: unknown): WorkActionResult {
    if (!isRecord(input) || !nonEmpty(input.connectionId) || !nonEmpty(input.spaceKey) || typeof input.hidden !== 'boolean') return { ok: false, error: invalid('스페이스 입력이 잘못됐습니다.') }
    const { connectionId, spaceKey, hidden } = input
    const data = this.deps.store.get()
    const stored = data.connections.find((row) => row.id === connectionId)
    if (stored === undefined) return { ok: false, error: workError({ kind: 'not_connected', message: '없는 연결입니다.' }) }
    const spaces = this.runtime.get(connectionId)?.spaces ?? null
    if (hidden) {
      if (spaces === null) return { ok: false, error: invalid('스페이스 목록을 아직 받지 못했습니다 — 연결 테스트를 먼저 하세요.') }
      const visible = spaces.filter((space) => space.key !== spaceKey && !stored.hiddenSpaceKeys.includes(space.key))
      if (visible.length === 0) return { ok: false, error: invalid(LAST_SPACE_REASON) }
    }
    const hiddenSpaceKeys = hidden ? [...new Set([...stored.hiddenSpaceKeys, spaceKey])] : stored.hiddenSpaceKeys.filter((key) => key !== spaceKey)
    const written = this.deps.store.write({ ...data, connections: data.connections.map((row) => (row.id === connectionId ? { ...row, hiddenSpaceKeys } : row)) })
    if (!written.ok) return { ok: false, error: workError({ kind: 'local_write', message: `저장하지 못했습니다 (${written.error.slice(0, 120)}).` }) }
    this.emit()
    return { ok: true }
  }

  setRepoDefault(input: unknown): WorkActionResult {
    if (!isRecord(input) || typeof input.repoRoot !== 'string') return { ok: false, error: invalid('레포 입력이 잘못됐습니다.') }
    const raw = input.target ?? null
    const target = isRecord(raw) && nonEmpty(raw.connectionId) && nonEmpty(raw.spaceKey) ? { connectionId: raw.connectionId, spaceKey: raw.spaceKey } : null
    if (raw !== null && target === null) return { ok: false, error: invalid('스페이스 입력이 잘못됐습니다.') }
    const repos = this.deps.repos()
    const repo = repos.find((row) => row.root === input.repoRoot)
    if (repo === undefined) return { ok: false, error: invalid('등록된 레포가 아닙니다.') }
    const data = this.deps.store.get()
    if (target !== null && !data.connections.some((row) => row.id === target.connectionId)) return { ok: false, error: workError({ kind: 'not_connected', message: '없는 연결입니다.' }) }
    // 지워진 레포의 항목은 이 쓰기 때 떨어진다(store.ts 머리 주석).
    const known = new Set(repos.map((row) => row.id))
    const repoDefaults = Object.fromEntries(Object.entries(data.repoDefaults).filter(([repoId]) => known.has(repoId) && repoId !== repo.id))
    if (target !== null) repoDefaults[repo.id] = target
    const written = this.deps.store.write({ ...data, repoDefaults })
    if (!written.ok) return { ok: false, error: workError({ kind: 'local_write', message: `저장하지 못했습니다 (${written.error.slice(0, 120)}).` }) }
    this.emit()
    return { ok: true }
  }

  async request(input: unknown): Promise<WorkResponse> {
    const request = readWorkRequest(input)
    if (request === null) {
      const requestId = isRecord(input) && typeof input.requestId === 'string' ? input.requestId.slice(0, 128) : ''
      const connectionId = isRecord(input) && typeof input.connectionId === 'string' ? input.connectionId.slice(0, 128) : ''
      return { requestId, connectionId, ok: false, error: invalid('작업 요청 모양이 잘못됐습니다.') }
    }
    const { requestId, connectionId, call } = request
    const outcome = await this.run({ connectionId, call, announce: false })
    return outcome.ok ? { requestId, connectionId, ok: true, result: outcome.result } : { requestId, connectionId, ok: false, error: this.scrub({ error: outcome.error }) }
  }

  /** 작업 하나의 corral 활동 기록(LIFE-602) — 오래된 것부터. 없는 연결이면 not_connected. */
  activity(input: unknown): WorkActivityResult {
    const query = readWorkActivityQuery(input)
    if (query === null) return { ok: false, error: invalid('활동 요청 모양이 잘못됐습니다.') }
    if (!this.deps.store.get().connections.some((row) => row.id === query.connectionId)) return { ok: false, error: workError({ kind: 'not_connected', message: '없는 연결입니다.' }) }
    return { ok: true, records: this.deps.activity?.list(query) ?? [] }
  }

  private async run({ connectionId, call, announce }: { connectionId: string; call: Parameters<WorkSourceClient['call']>[0]; announce: boolean }): Promise<WorkOutcome> {
    const stored = this.deps.store.get().connections.find((row) => row.id === connectionId)
    if (stored === undefined) return { ok: false, error: workError({ kind: 'not_connected', message: '없는 연결입니다.' }) }
    const entry = this.deps.sources.get(stored.sourceId)
    if (entry === null) return { ok: false, error: workError({ kind: 'not_connected', message: '이 연결의 작업 출처를 이 판의 corral 이 모릅니다.' }) }
    // 능력 문 — 꺼진 능력은 출처에 닿지 않는다(이유를 그대로 돌려준다).
    const known = this.runtime.get(connectionId)
    const capabilities = known?.capabilities ?? known?.client?.capabilities() ?? null
    const gate = capabilities === null ? null : closedCapability({ capabilities, call })
    if (gate !== null) return { ok: false, error: gate }
    // 인증 실패(확정) — 일반 요청은 같은 자격을 다시 보내지 않는다. 사용자가 누른 연결 테스트(announce)만 다시 보낸다(R1-K).
    // 확정 상태가 아니라 자격 무효 축을 본다 — 재시험이 network 등으로 실패해 상태가 offline 이어도 차단은 그대로(R4-A).
    if (!announce && known?.rejected) return { ok: false, error: known.rejected }

    this.ticketSeq += 1
    const claim: Claim = { connectionId, generation: this.generation(connectionId), ticket: this.ticketSeq }
    const startedAt = this.now()
    // 누른 테스트는 시작부터 진행 표시. 일반 요청은 이 요청이 클라이언트를 처음 만든 경우에만(첫 사용).
    let progress = announce ? this.beginProgress({ connectionId, pending: 'network' }) : null
    try {
      const acquired = await this.acquire({ claim, sealed: stored.sealed, create: entry.create })
      if (!acquired.ok) {
        // 획득 중 해제·교체 — 옛 자격으로 클라이언트를 만들지 않았고, 상태도 건드리지 않는다(R1-C).
        if (acquired.stale) return { ok: false, error: this.staleError(connectionId) }
        this.settle({ claim, outcome: { ok: false, error: acquired.error } })
        return { ok: false, error: acquired.error }
      }
      const client = acquired.client
      const lateGate = closedCapability({ capabilities: client.capabilities(), call })
      if (lateGate !== null) return { ok: false, error: lateGate }
      if (progress === null && acquired.fresh) progress = this.beginProgress({ connectionId, pending: 'network' })
      const writeId = isWrite(call) ? this.newId() : null
      const outcome = await client.call(call, { writeId })
      if (claim.generation !== this.generation(connectionId)) {
        log('work.request', { op: call.op, ok: false, errorKind: 'not_connected', status: null, ms: this.now() - startedAt, discarded: true })
        return { ok: false, error: this.staleError(connectionId) }
      }
      const checked: WorkOutcome = outcome.ok && !resultMatches({ call: call.op, result: outcome.result.op })
        ? { ok: false, error: workError({ kind: 'invalid_response', message: `출처가 ${call.op} 에 ${outcome.result.op} 로 답했습니다.` }) }
        : outcome
      log('work.request', { op: call.op, ok: checked.ok, errorKind: checked.ok ? null : checked.error.kind, status: checked.ok ? null : checked.error.status, ms: this.now() - startedAt })
      if (checked.ok) {
        if (writeId !== null) this.record({ connectionId, call, result: checked.result, writeId })
        this.remember({ connectionId, result: checked.result })
      }
      this.settle({ claim, outcome: checked })
      return checked
    } finally {
      if (progress !== null) this.endProgress({ connectionId, progress })
    }
  }

  /** 이 서비스를 지난 응답에서 상태 라벨·단건을 기억한다(활동 기록용). */
  private remember({ connectionId, result }: { connectionId: string; result: WorkResult }): void {
    if (result.op === 'listStatuses') {
      const labels = this.statusLabels.get(connectionId) ?? new Map<string, string>()
      for (const status of result.statuses) labels.set(status.key, status.label)
      this.statusLabels.set(connectionId, labels)
      return
    }
    const item = 'item' in result ? result.item : null
    if (item === null || item.relations === null) return
    const items = this.seenItems.get(connectionId) ?? new Map<string, WorkItem>()
    items.set(item.id, item)
    this.seenItems.set(connectionId, items)
  }

  /** 성공한 쓰기 → 활동 기록(칸마다 한 줄, 같은 쓰기 id). 순서만 바꾼 것은 남기지 않는다. */
  private record({ connectionId, call, result, writeId }: { connectionId: string; call: WorkCall; result: WorkResult; writeId: string }): void {
    const activity = this.deps.activity
    if (activity === undefined) return
    const changes = changesOf({ call, result, statusLabel: (key) => this.statusLabels.get(connectionId)?.get(key) ?? null, seen: (itemId) => this.seenItems.get(connectionId)?.get(itemId) ?? null })
    const at = this.now()
    for (const { itemId, change } of changes) activity.append({ id: this.newId(), connectionId, itemId, at, writeId, change })
  }

  /**
   * 이 세대의 클라이언트 — 있으면 그것, 획득 중이면 그 promise, 없으면 새로 시작한다(R2-A). 획득 = 풀기 + 만들기 + 설치를 한 번에.
   * 획득은 자기 진행 표시(키체인 대기 또는 네트워크)를 하나 넣고 끝나면 뺀다. 푸는 동안 세대가 바뀌었으면 만들지 않는다(stale).
   * 실패한 획득은 지워 다음 요청이 다시 푼다(암호문은 그대로 — C6).
   */
  private acquire({ claim, sealed, create }: { claim: Claim; sealed: string; create: (token: string) => WorkSourceClient }): Promise<Acquired> {
    const { connectionId, generation } = claim
    const current = this.runtime.get(connectionId)
    if (current?.client) return Promise.resolve({ ok: true, client: current.client, fresh: false })
    if (current?.acquiring) return current.acquiring
    const progress = this.beginProgress({ connectionId, pending: this.deps.vault.isOpen(connectionId) ? 'network' : 'keychain' })
    const acquiring: Promise<Acquired> = this.deps.vault.unseal({ connectionId, sealed }).then((opened): Acquired => {
      if (generation !== this.generation(connectionId)) return { ok: false, stale: true }
      this.endProgress({ connectionId, progress })
      if (!opened.ok) {
        if (this.runtime.get(connectionId)?.acquiring === acquiring) this.patchRuntime(connectionId, { acquiring: null })
        return { ok: false, stale: false, error: opened.error }
      }
      const client = create(opened.token)
      this.patchRuntime(connectionId, { client, capabilities: client.capabilities(), acquiring: null })
      return { ok: true, client, fresh: true }
    })
    this.patchRuntime(connectionId, { acquiring })
    return acquiring
  }

  /** 확정 상태를 바꿔도 되는 결과인가 — 같은 세대이고, 확정 상태를 마지막으로 정한 순번보다 **뒤에** 시작한 요청. */
  private owns(claim: Claim): boolean {
    if (claim.generation !== this.generation(claim.connectionId)) return false
    return claim.ticket > (this.runtime.get(claim.connectionId)?.settledTicket ?? 0)
  }

  private beginProgress({ connectionId, pending }: { connectionId: string; pending: WorkConnectionPending }): number {
    this.progressSeq += 1
    const id = this.progressSeq
    const current = this.runtime.get(connectionId) ?? freshRuntime()
    const progress = new Map(current.progress).set(id, pending)
    this.runtime.set(connectionId, { ...current, progress })
    this.emit()
    return id
  }

  /** 자기 진행 표시만 뺀다 — 세대가 바뀌어 새 runtime 이면 없는 id 라 아무것도 안 한다. 해제된 연결의 runtime 을 되살리지 않는다. */
  private endProgress({ connectionId, progress }: { connectionId: string; progress: number }): void {
    const current = this.runtime.get(connectionId)
    if (current === undefined || !current.progress.has(progress)) return
    const next = new Map(current.progress)
    next.delete(progress)
    this.runtime.set(connectionId, { ...current, progress: next })
    this.emit()
  }

  /**
   * 결과로 확정 상태를 정한다 — 성공 = ok, 연결 계열 오류 = 그 상태, 연산 하나의 실패(거절·어긋남 등)는 확정 상태를 바꾸지 않는다.
   * 바꿀 자격이 없는 결과(`owns` 거짓 — 해제·교체 뒤, 또는 확정 상태를 정한 요청보다 먼저 시작한 요청)는 아무것도 바꾸지 않는다(R2-B·R3-A).
   */
  private settle({ claim, outcome }: { claim: Claim; outcome: WorkOutcome }): void {
    if (claim.generation !== this.generation(claim.connectionId)) return
    const { connectionId, ticket } = claim
    const before = this.runtime.get(connectionId) ?? freshRuntime()
    // 데이터 — 스페이스 목록은 상태 순번과 따로 센다(R4-C). auth 이전에 시작한 요청의 목록은 받지 않는다.
    const current = outcome.ok && outcome.result.op === 'listSpaces' && ticket > before.spacesTicket && ticket > before.authFloor
      ? { ...before, spaces: outcome.result.spaces, capabilities: outcome.result.capabilities, spacesTicket: ticket }
      : before
    if (!this.owns(claim)) {
      if (current !== before) {
        this.runtime.set(connectionId, current)
        this.emit()
      }
      return
    }
    if (outcome.ok) {
      // 소유한 성공 — 확정 ok, 자격 무효도 거둔다(auth 이후에 시작한 요청만 소유할 수 있다).
      this.runtime.set(connectionId, { ...current, settled: { status: 'ok', error: null, checkedAt: this.now() }, settledTicket: ticket, rejected: null })
    } else {
      const status = connectionStatusOf(outcome.error.kind)
      if (status === null) return
      const settled: Settled = { status, error: outcome.error, checkedAt: this.now() }
      if (outcome.error.kind === 'auth') {
        // 인증 실패 — 그 자격의 클라이언트를 닫고 버린다(진행 중인 여러 단계 연산의 다음 단계도 나가지 않는다).
        // 확정 순번을 지금까지 발급한 마지막 순번으로 → 이미 진행 중인 요청은 (마지막 순번이어도) auth 를 풀지 못한다(R3-A).
        current.client?.close()
        this.runtime.set(connectionId, { ...current, settled, client: null, settledTicket: this.ticketSeq, authFloor: this.ticketSeq, rejected: outcome.error })
      } else {
        // 키체인 실패는 클라이언트가 없고, 암호문은 그대로 둔다(다음 요청이 다시 푼다).
        // 자격 무효(`rejected`)는 건드리지 않는다 — 장애는 자격이 유효하다는 근거가 아니다(R4-A).
        this.runtime.set(connectionId, { ...current, settled, settledTicket: ticket })
      }
    }
    this.emit()
  }

  /** 밖으로 나가는 오류의 마지막 경계 — 금고가 아는 토큰(과 아직 금고에 없는 붙여넣은 토큰)을 지운다(R2-F). */
  private scrub({ error, secret = '' }: { error: WorkError; secret?: string }): WorkError {
    return { ...error, message: redactSecret({ text: this.deps.vault.redact(error.message), secret }) }
  }

  private generation(connectionId: string): number {
    return this.generations.get(connectionId) ?? 0
  }

  private bump(connectionId: string): void {
    this.generationSeq += 1
    this.generations.set(connectionId, this.generationSeq)
  }

  private staleError(connectionId: string): WorkError {
    const exists = this.deps.store.get().connections.some((row) => row.id === connectionId)
    return workError({ kind: 'not_connected', message: exists ? '토큰이 바뀌어 이전 토큰으로 한 요청의 결과를 버렸습니다 — 다시 시도하세요.' : '연결이 해제돼 요청 결과를 버렸습니다.' })
  }

  private patchRuntime(connectionId: string, patch: Partial<Runtime>): void {
    this.runtime.set(connectionId, { ...(this.runtime.get(connectionId) ?? freshRuntime()), ...patch })
    this.emit()
  }

  private summaryOf(stored: StoredConnection): WorkConnectionSummary | null {
    const entry = this.deps.sources.get(stored.sourceId)
    if (entry === null) return null
    const runtime = this.runtime.get(stored.id) ?? freshRuntime()
    const settledError = runtime.settled.error
    const error = settledError === null || connectionStatusOf(settledError.kind) === null
      ? null
      : { message: this.deps.vault.redact(settledError.message), action: actionOf(settledError) }
    const testing = runtime.progress.size > 0
    const status: WorkConnectionStatus = testing ? 'testing' : runtime.settled.status
    return {
      id: stored.id,
      sourceId: stored.sourceId,
      name: entry.descriptor.name,
      mono: entry.descriptor.mono,
      tokenTail: stored.tokenTail,
      addedAt: stored.addedAt,
      generation: this.generation(stored.id),
      status,
      pending: testing ? [...runtime.progress.values()].at(-1) ?? null : null,
      error: status === 'ok' || status === 'testing' || status === 'unchecked' ? null : error,
      checkedAt: runtime.settled.checkedAt,
      spaces: runtime.spaces === null
        ? null
        : runtime.spaces.map((space) => ({ key: space.key, name: space.name, color: space.color, openCount: space.openCount, hidden: stored.hiddenSpaceKeys.includes(space.key) })),
      hiddenSpaceKeys: [...stored.hiddenSpaceKeys],
      capabilities: runtime.capabilities,
    }
  }

  private emit(): void {
    this.deps.onChange(this.settings())
  }
}

function actionOf(error: WorkError): 'replace_token' | 'retry' | null {
  switch (error.kind) {
    case 'auth':
    case 'keychain':
      return 'replace_token'
    case 'network':
      return 'retry'
    default:
      return null
  }
}

/** 출처 상태를 바꾸는 연산 — 쓰기 id 를 싣고, 성공하면 활동에 남긴다. */
function isWrite(call: WorkCall): boolean {
  switch (call.op) {
    case 'changeStatus':
    case 'setPlacement':
    case 'setParent':
    case 'reorder':
    case 'addRelation':
    case 'removeRelation':
    case 'addComment':
    case 'updateItem':
    case 'createItem':
      return true
    case 'listSpaces':
    case 'listStatuses':
    case 'listItems':
    case 'getItem':
    case 'findByKey':
    case 'listTransitions':
    case 'listComments':
    case 'listChildren':
    case 'listHistory':
      return false
  }
}

/** 줄 수 — 본문 변경은 전문을 남기지 않고 줄 수만. */
function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length
}

/** 성공한 쓰기 하나가 남길 활동 — (작업 id, 바뀐 것) 목록. 코멘트는 출처가 가지므로 남기지 않는다. 순서 바꾸기도 남기지 않는다. */
export function changesOf({ call, result, statusLabel, seen }: {
  call: WorkCall
  result: WorkResult
  statusLabel: (statusKey: string) => string | null
  seen: (itemId: string) => WorkItem | null
}): { itemId: string; change: WorkActivityChange }[] {
  switch (call.op) {
    case 'changeStatus': {
      if (result.op !== 'changeStatus') return []
      const { item } = result
      return [{ itemId: call.itemId, change: { field: 'status', statusKey: item.statusKey, statusLabel: statusLabel(item.statusKey), resolution: item.resolution } }]
    }
    case 'updateItem': {
      const { fields } = call
      const changes: { itemId: string; change: WorkActivityChange }[] = []
      if (fields.title !== undefined) changes.push({ itemId: call.itemId, change: { field: 'title', to: fields.title } })
      if (fields.body !== undefined) changes.push({ itemId: call.itemId, change: { field: 'body', lines: lineCount(fields.body) } })
      if (fields.priority !== undefined) changes.push({ itemId: call.itemId, change: { field: 'priority', to: fields.priority } })
      if (fields.dueAt !== undefined) changes.push({ itemId: call.itemId, change: { field: 'dueAt', to: fields.dueAt } })
      return changes
    }
    case 'setPlacement':
      return [{ itemId: call.itemId, change: { field: 'placement', to: call.placement } }]
    case 'setParent':
      return [{ itemId: call.itemId, change: { field: 'parent', parentId: call.parentId } }]
    case 'addRelation':
      return result.op === 'addRelation' ? [{ itemId: call.itemId, change: { field: 'relation', action: 'add', kind: result.relation.kind, otherKey: result.relation.other.key } }] : []
    case 'removeRelation': {
      const known = seen(call.itemId)?.relations?.find((relation) => relation.id === call.relationId) ?? null
      return [{ itemId: call.itemId, change: { field: 'relation', action: 'remove', kind: known?.kind ?? null, otherKey: known?.other.key ?? null } }]
    }
    case 'createItem':
      return result.op === 'createItem' && call.parentId !== null ? [{ itemId: call.parentId, change: { field: 'child', childKey: result.item.key, childTitle: result.item.title } }] : []
    case 'reorder':
    case 'addComment':
    case 'listSpaces':
    case 'listStatuses':
    case 'listItems':
    case 'getItem':
    case 'findByKey':
    case 'listTransitions':
    case 'listComments':
    case 'listChildren':
    case 'listHistory':
      return []
  }
}

function resultMatches({ call, result }: { call: string; result: string }): boolean {
  return call === result
}

function closedCapability({ capabilities, call }: { capabilities: WorkCapabilities; call: Parameters<WorkSourceClient['call']>[0] }): WorkError | null {
  for (const name of capabilitiesOf(call)) {
    const capability = capabilities[name]
    switch (capability.state) {
      case 'on': break
      case 'hidden': return workError({ kind: 'unsupported', message: `이 출처에는 ${name} 능력이 없습니다.` })
      case 'disabled': return workError({ kind: 'unsupported', message: capability.reason })
    }
  }
  return null
}
