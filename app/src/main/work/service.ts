// 작업 출처 레지스트리 + 연결 관리 (LIFE-600 킥오프 2·5·6·7) — IPC 가 부르는 main 쪽 한 곳.
//
// - 연결마다 출처 클라이언트 인스턴스 하나. **자격은 그 연결이 처음 쓰일 때 푼다**(연결 테스트·작업 요청) — 앱 기동은 금고를 건드리지 않는다.
//   풀 때는 연결 상태를 `testing` + `pending: keychain` 으로 먼저 밀어, 화면이 「macOS 가 허용을 물을 수 있다」 를 보이게 한다.
// - 연결 추가: 형식 검사(보내기 전 거절) → **연결 테스트 통과 뒤에만** 싸고(키체인) → 파일에 쓴다. 어느 단계든 실패면 저장 0.
// - 요청: 손검증(unknown → 계약) → 연결 확인 → **능력 문**(꺼진 능력은 출처에 닿기 전에 `unsupported` + 이유) → 출처 → 결과 연산 대조.
// - 오류 5종 중 인증·권한·네트워크·키체인은 연결 상태(pill)를 바꾼다. **인증 실패만 「토큰 다시 붙여넣기」** — 권한 부족·네트워크는 연결 유지.
// - 밖으로 나가는 모양(`WorkSettingsState`·`WorkResponse`)에 토큰은 없다. 끝 4자만.
// - **세대(generation)** — 해제·토큰 교체마다 연결의 세대를 올리고 그 연결의 클라이언트를 닫는다(R1-C). 진행 중인 요청은 await 마다 세대를
//   확인해, 바뀌었으면 결과를 버리고 상태·클라이언트를 되살리지 않는다. 닫힌 클라이언트는 이후 아무것도 보내지 않는다.
//   **이미 보낸 쓰기는 되돌리지 못한다** — 막는 것은 해제·교체 「뒤에」 새로 나가는 요청이다.
// - 인증 실패 상태에서는 일반 요청을 다시 보내지 않는다(R1-K) — 다시 보내는 길은 사용자가 누른 「연결 테스트」 와 토큰 교체뿐이다.

import { randomUUID } from 'node:crypto'
import { isRecord } from '../../shared/json.js'
import {
  capabilitiesOf,
  connectionStatusOf,
  readWorkRequest,
  type WorkActionResult,
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
import { workError } from './errors.js'
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
  now?: () => number
  newId?: () => string
}

type Runtime = {
  status: WorkConnectionStatus
  pending: WorkConnectionPending
  error: WorkError | null
  checkedAt: number | null
  spaces: WorkSpace[] | null
  capabilities: WorkCapabilities | null
  client: WorkSourceClient | null
}

const MAX_TOKEN_LENGTH = 512
const LAST_SPACE_REASON = '마지막 스페이스는 끌 수 없습니다 — 연결을 해제하세요'

function freshRuntime(): Runtime {
  return { status: 'unchecked', pending: null, error: null, checkedAt: null, spaces: null, capabilities: null, client: null }
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
  private readonly now: () => number
  private readonly newId: () => string

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

    // 교체가 실패하면 카드 상태를 교체 전 그대로 되돌린다(R1-D) — `testing` 에 멈추거나 `auth` 가 `ok` 로 바뀌지 않게.
    const generation = existing === null ? null : this.generation(existing.id)
    const before = existing === null ? null : this.runtime.get(existing.id) ?? freshRuntime()
    const fail = ({ error, client }: { error: WorkError; client: WorkSourceClient | null }): WorkConnectionAddResult => {
      client?.close()
      if (existing !== null && before !== null && generation === this.generation(existing.id)) {
        this.patchRuntime(existing.id, { status: before.status, pending: before.pending, error: before.error })
      }
      log('work.connection_add', { source: entry.descriptor.id, replace: existing !== null, ok: false, errorKind: error.kind, status: error.status })
      return { ok: false, error }
    }
    // 교체하는 동안 그 연결이 해제·다시 교체됐으면 이 교체는 버린다.
    const superseded = (): boolean => existing !== null && generation !== this.generation(existing.id)
    const supersededError = workError({ kind: 'not_connected', message: '토큰을 바꾸는 동안 연결이 해제됐거나 다시 바뀌었습니다. 저장하지 않았습니다.' })

    if (existing !== null) this.patchRuntime(existing.id, { status: 'testing', pending: 'network', error: null })
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
    const data = this.deps.store.get()
    const id = existing?.id ?? this.newId()
    const stored: StoredConnection = {
      id,
      sourceId: entry.descriptor.id,
      addedAt: existing?.addedAt ?? this.now(),
      tokenTail: token.slice(-4),
      sealed: sealed.sealed,
      hiddenSpaceKeys: existing?.hiddenSpaceKeys ?? [],
    }
    const next: WorkStoreData = { ...data, connections: existing === null ? [...data.connections, stored] : data.connections.map((row) => (row.id === id ? stored : row)) }
    const written = this.deps.store.write(next)
    if (!written.ok) return fail({ error: workError({ kind: 'local_write', message: `연결을 저장하지 못했습니다 (${written.error.slice(0, 120)}).` }), client })
    // 옛 토큰으로 진행 중인 요청은 세대가 바뀌어 결과를 버리고, 옛 클라이언트는 더 보내지 않는다.
    this.bump(id)
    this.runtime.get(id)?.client?.close()
    this.deps.vault.forget(id)
    this.deps.vault.remember({ connectionId: id, token })
    this.runtime.set(id, { status: 'ok', pending: null, error: null, checkedAt: this.now(), spaces: tested.result.spaces, capabilities: tested.result.capabilities, client })
    log('work.connection_add', { source: entry.descriptor.id, replace: existing !== null, ok: true, spaces: tested.result.spaces.length })
    this.emit()
    const summary = this.summaryOf(stored)
    return summary === null ? { ok: false, error: invalid('연결 출처가 사라졌습니다.') } : { ok: true, connection: summary }
  }

  async testConnection(input: unknown): Promise<WorkActionResult> {
    const id = isRecord(input) && nonEmpty(input.connectionId) ? input.connectionId : null
    if (id === null) return { ok: false, error: invalid('연결 id 가 잘못됐습니다.') }
    const outcome = await this.run({ connectionId: id, call: { op: 'listSpaces' }, announce: true })
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error }
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
    return outcome.ok ? { requestId, connectionId, ok: true, result: outcome.result } : { requestId, connectionId, ok: false, error: outcome.error }
  }

  private async run({ connectionId, call, announce }: { connectionId: string; call: Parameters<WorkSourceClient['call']>[0]; announce: boolean }): Promise<WorkOutcome> {
    const stored = this.deps.store.get().connections.find((row) => row.id === connectionId)
    if (stored === undefined) return { ok: false, error: workError({ kind: 'not_connected', message: '없는 연결입니다.' }) }
    const entry = this.deps.sources.get(stored.sourceId)
    if (entry === null) return { ok: false, error: workError({ kind: 'not_connected', message: '이 연결의 작업 출처를 이 판의 corral 이 모릅니다.' }) }
    // 능력 문 — 꺼진 능력은 출처에 닿지 않는다(이유를 그대로 돌려준다).
    const capabilities = this.runtime.get(connectionId)?.capabilities ?? this.runtime.get(connectionId)?.client?.capabilities() ?? null
    const gate = capabilities === null ? null : closedCapability({ capabilities, call })
    if (gate !== null) return { ok: false, error: gate }
    // 인증 실패 상태 — 일반 요청은 같은 자격을 다시 보내지 않는다. 사용자가 누른 연결 테스트(announce)만 다시 보낸다(R1-K).
    const known = this.runtime.get(connectionId)
    if (!announce && known?.status === 'auth') return { ok: false, error: known.error ?? workError({ kind: 'auth', message: '토큰이 거부된 연결입니다 — 토큰을 다시 붙여넣으세요.' }) }

    const generation = this.generation(connectionId)
    const startedAt = this.now()
    let client = known?.client ?? null
    if (client === null) {
      const unlocking = !this.deps.vault.isOpen(connectionId)
      this.patchRuntime(connectionId, { status: 'testing', pending: unlocking ? 'keychain' : 'network', error: null })
      const opened = await this.deps.vault.unseal({ connectionId, sealed: stored.sealed })
      // 푸는 동안 해제·교체됐으면 옛 자격으로 클라이언트를 만들지 않고, 상태도 건드리지 않는다(R1-C).
      if (generation !== this.generation(connectionId)) return { ok: false, error: this.staleError(connectionId) }
      if (!opened.ok) {
        this.settle({ connectionId, outcome: { ok: false, error: opened.error } })
        return { ok: false, error: opened.error }
      }
      client = entry.create(opened.token)
      this.patchRuntime(connectionId, { client, capabilities: client.capabilities() })
      const lateGate = closedCapability({ capabilities: client.capabilities(), call })
      if (lateGate !== null) {
        this.patchRuntime(connectionId, { pending: null, status: this.runtime.get(connectionId)?.checkedAt === null ? 'unchecked' : 'ok' })
        return { ok: false, error: lateGate }
      }
      if (!announce) this.patchRuntime(connectionId, { pending: 'network' })
    }
    if (announce) this.patchRuntime(connectionId, { status: 'testing', pending: 'network', error: null })
    const outcome = await client.call(call)
    if (generation !== this.generation(connectionId)) {
      log('work.request', { op: call.op, ok: false, errorKind: 'not_connected', status: null, ms: this.now() - startedAt, discarded: true })
      return { ok: false, error: this.staleError(connectionId) }
    }
    const checked: WorkOutcome = outcome.ok && !resultMatches({ call: call.op, result: outcome.result.op })
      ? { ok: false, error: workError({ kind: 'invalid_response', message: `출처가 ${call.op} 에 ${outcome.result.op} 로 답했습니다.` }) }
      : outcome
    log('work.request', { op: call.op, ok: checked.ok, errorKind: checked.ok ? null : checked.error.kind, status: checked.ok ? null : checked.error.status, ms: this.now() - startedAt })
    this.settle({ connectionId, outcome: checked })
    return checked
  }

  /** 결과로 연결 상태를 정한다 — 성공 = ok, 연결 계열 오류 = 그 상태, 연산 하나의 실패는 상태를 바꾸지 않는다. */
  private settle({ connectionId, outcome }: { connectionId: string; outcome: WorkOutcome }): void {
    const current = this.runtime.get(connectionId) ?? freshRuntime()
    if (outcome.ok) {
      const spaces = outcome.result.op === 'listSpaces' ? outcome.result.spaces : current.spaces
      const capabilities = outcome.result.op === 'listSpaces' ? outcome.result.capabilities : current.capabilities
      this.runtime.set(connectionId, { ...current, status: 'ok', pending: null, error: null, checkedAt: this.now(), spaces, capabilities })
    } else {
      const status = connectionStatusOf(outcome.error.kind)
      if (status === null) this.runtime.set(connectionId, { ...current, pending: null, status: current.status === 'testing' ? (current.checkedAt === null ? 'unchecked' : 'ok') : current.status })
      else {
        // 인증 실패면 그 토큰으로 만든 클라이언트는 닫고 버린다. 그 뒤 일반 요청은 `run` 이 보내기 전에 막는다(R1-K) —
        // 같은 자격을 다시 보내는 길은 사용자가 누른 연결 테스트(금고의 토큰으로 새 클라이언트)와 토큰 교체뿐이다.
        // 키체인 실패는 클라이언트가 없고, 암호문은 그대로 둔다(다음 요청이 다시 푼다).
        if (outcome.error.kind === 'auth') current.client?.close()
        const client = outcome.error.kind === 'auth' ? null : current.client
        this.runtime.set(connectionId, { ...current, status, pending: null, error: outcome.error, checkedAt: this.now(), client })
      }
    }
    this.emit()
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
    const error = runtime.error === null || connectionStatusOf(runtime.error.kind) === null
      ? null
      : { message: runtime.error.message, action: actionOf(runtime.error) }
    return {
      id: stored.id,
      sourceId: stored.sourceId,
      name: entry.descriptor.name,
      mono: entry.descriptor.mono,
      tokenTail: stored.tokenTail,
      addedAt: stored.addedAt,
      status: runtime.status,
      pending: runtime.pending,
      error: runtime.status === 'ok' || runtime.status === 'testing' || runtime.status === 'unchecked' ? null : error,
      checkedAt: runtime.checkedAt,
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
