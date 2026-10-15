// corral 활동 저장소 (LIFE-602 C9 · 묶음 D9) — `<userData>/work-activity.json`(경로 오버라이드 `CORRAL_WORK_ACTIVITY`, 격리 실행용).
//
// 담는 것: corral 에서 **성공한** 작업 쓰기 하나 = 한 줄(연결 id · 작업 id · 시각 · 쓰기 id · 무엇이 바뀌었나). 기록 지점은 `WorkService` 하나다 —
//   상세·보드·백로그 어디서 바꿨든 같은 길이라 화면마다 따로 기록하지 않는다. 실패한 쓰기는 남지 않는다.
// 담지 않는 것: 토큰 · 본문 전문(본문 변경은 줄 수만) · 코멘트(출처가 가진다).
// LIFE-603: 같은 v1 에 실행 갈래(시작 · 자동 연결 · 떼기)와 에이전트 갈래(질문 · 턴 결과)를 더한다 — main 이 링크된 worktree 를 보고 남긴다(`links.ts`).
//   그 기록은 `eventKey` 로 한 번만 남는다. 모르는 칸 모양은 v1 의 규칙대로 그 줄만 버린다(옛 판은 새 갈래 줄을 버리고 나머지를 읽는다).
//
// 형식 v1 = `{ version: 1, records: WorkActivityRecord[] }`, 오래된 것부터. 줄마다 칸을 검증해 읽고(망가진 줄만 버림),
// tmp → rename 원자 쓰기 · 파일 권한 0600 · 바꾸기 전에는 파일을 만들지 않는다(`store.ts` 와 같은 결).
// **손상 파일**(JSON 이 아님 · 최상위 모양 다름): 앱은 죽지 않고 로그를 남긴 뒤 빈 기록으로 시작한다. 원본은 `.corrupt` 로 옮겨 둔다
//   (다음 쓰기가 덮어 지우지 않게 — 하나만 보존, 이전 `.corrupt` 는 덮는다).
// **보존 상한**: 작업 하나당 최근 200줄 · 전체 5,000줄(넘으면 오래된 것부터 버린다). 파일 크기 상한은 대략 5,000 × 수백 바이트.
// **연결 해제**: 그 연결의 줄을 지운다(`purgeConnection`) — 해제한 계정의 흔적을 남기지 않는다.
// 쓰기 실패는 기록만 잃는다 — 작업 쓰기 결과는 바꾸지 않는다(메모리에는 남아 이번 실행 동안은 보인다).

import fs from 'node:fs'
import path from 'node:path'
import { isRecord, safeParse } from '../../shared/json.js'
import {
  readWorkPriority,
  readWorkRelationKind,
  type WorkActivityChange,
  type WorkActivityRecord,
  type WorkResolution,
} from '../../shared/work.js'
import { log } from '../log.js'

export const WORK_ACTIVITY_VERSION = 1
export const ACTIVITY_PER_ITEM = 200
export const ACTIVITY_TOTAL = 5_000
/**
 * 남긴 사건 열쇠의 기억 상한(R1-K) — 줄이 보존 상한으로 밀려나도 열쇠는 따로 남아 같은 사건이 되살아나지 않는다.
 * 열쇠 하나 ~100바이트라 파일이 수 MB 를 넘지 않는다. 넘으면 오래된 열쇠부터 잊는다(그때는 아주 오래된 사건이 다시 남을 수 있다).
 */
export const ACTIVITY_SEEN_KEYS = 20_000

/**
 * 열쇠 기억 — 열쇠 → 그 사건의 연결 id. 넣은 순서를 지키고 상한을 넘으면 오래된 것부터 버린다.
 * 연결 id 를 같이 두는 이유(R2-J ⓒ): 연결 해제 때 **줄이 밀려난 열쇠까지** 그 연결의 것을 지운다(`run:start:<attemptId>` 처럼 열쇠에 연결 id 가 없는 것도).
 * 파일 형식: `seen: [[열쇠, 연결 id], …]`. fix1 판의 문자열 배열은 연결 id 를 모르는 열쇠로 읽고(null), 해제 때 열쇠 안의 `:<연결 id>:` 로 가린다.
 */
export class SeenKeys {
  private readonly keys = new Map<string, string | null>()
  private readonly limit: number
  constructor(limit: number = ACTIVITY_SEEN_KEYS) { this.limit = limit }
  has(key: string): boolean { return this.keys.has(key) }
  add({ key, connectionId }: { key: string; connectionId: string | null }): void {
    this.keys.delete(key)
    this.keys.set(key, connectionId)
    for (const oldest of this.keys.keys()) {
      if (this.keys.size <= this.limit) break
      this.keys.delete(oldest)
    }
  }
  entries(): [string, string | null][] { return [...this.keys.entries()] }
  list(): string[] { return [...this.keys.keys()] }
  /** 그 연결의 열쇠를 전부 잊는다 — 연결 id 를 아는 것은 그 값으로, 모르는 옛 열쇠는 열쇠 안의 `:<연결 id>:` 로. */
  dropConnection(connectionId: string): void {
    for (const [key, owner] of [...this.keys.entries()]) {
      if (owner === connectionId || (owner === null && key.includes(`:${connectionId}:`))) this.keys.delete(key)
    }
  }
  /** 파일의 `seen` 칸 읽기 — `[열쇠, 연결 id]` 쌍 또는 옛 문자열. */
  load(value: unknown): void {
    if (!Array.isArray(value)) return
    for (const row of value) {
      if (typeof row === 'string' && row.length > 0) this.add({ key: row, connectionId: null })
      else if (Array.isArray(row) && typeof row[0] === 'string' && row[0].length > 0) this.add({ key: row[0], connectionId: typeof row[1] === 'string' ? row[1] : null })
    }
  }
}

function sameChange({ a, b }: { a: WorkActivityChange; b: WorkActivityChange }): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export type ActivityPort = {
  /** `eventKey` 가 이미 있으면 남기지 않는다(LIFE-603 — 같은 사건은 한 번). 남겼으면 true. */
  append(record: WorkActivityRecord): boolean
  /** 이미 남긴 사건의 내용을 바꾼다(R1-M). 그 열쇠의 줄이 없거나(밀려났거나) 같으면 false. */
  refresh(input: { eventKey: string; change: WorkActivityChange }): boolean
  list(query: { connectionId: string; itemId: string; itemKey?: string }): WorkActivityRecord[]
  purgeConnection(connectionId: string): void
}

const str = (value: unknown): value is string => typeof value === 'string'
const nullableStr = (value: unknown): value is string | null => value === null || typeof value === 'string'

function readResolution(value: unknown): WorkResolution | null | undefined {
  if (value === null) return null
  return value === 'completed' || value === 'cancelled' || value === 'other' ? value : undefined
}

function readChange(value: unknown): WorkActivityChange | null {
  if (!isRecord(value)) return null
  switch (value.field) {
    case 'status': {
      const resolution = readResolution(value.resolution)
      return str(value.statusKey) && nullableStr(value.statusLabel) && resolution !== undefined ? { field: 'status', statusKey: value.statusKey, statusLabel: value.statusLabel, resolution } : null
    }
    case 'title':
      return str(value.to) ? { field: 'title', to: value.to } : null
    case 'body':
      return typeof value.lines === 'number' && Number.isInteger(value.lines) && value.lines >= 0 ? { field: 'body', lines: value.lines } : null
    case 'priority': {
      const to = value.to === null ? null : readWorkPriority(value.to)
      return value.to === null || to !== null ? { field: 'priority', to } : null
    }
    case 'dueAt':
      return nullableStr(value.to) ? { field: 'dueAt', to: value.to } : null
    case 'placement':
      return value.to === 'board' || value.to === 'backlog' ? { field: 'placement', to: value.to } : null
    case 'parent':
      return nullableStr(value.parentId) ? { field: 'parent', parentId: value.parentId } : null
    case 'relation': {
      const kind = value.kind === null ? null : readWorkRelationKind(value.kind)
      if (value.kind !== null && kind === null) return null
      return (value.action === 'add' || value.action === 'remove') && nullableStr(value.otherKey) ? { field: 'relation', action: value.action, kind, otherKey: value.otherKey } : null
    }
    case 'child':
      return str(value.childKey) && str(value.childTitle) ? { field: 'child', childKey: value.childKey, childTitle: value.childTitle } : null
    case 'created':
      return str(value.kindLabel) ? { field: 'created', kindLabel: value.kindLabel } : null
    case 'run': {
      if (!str(value.worktree)) return null
      if (value.event === 'source_link_failed') return nullableStr(value.message) ? { field: 'run', event: 'source_link_failed', worktree: value.worktree, message: value.message } : null
      if (value.event === 'start') return str(value.branch) && str(value.agent) && nullableStr(value.model) ? { field: 'run', event: 'start', worktree: value.worktree, branch: value.branch, agent: value.agent, model: value.model } : null
      return (value.event === 'auto_link' || value.event === 'detach') && nullableStr(value.branch) ? { field: 'run', event: value.event, worktree: value.worktree, branch: value.branch } : null
    }
    case 'agent': {
      if (!str(value.worktree) || !nullableStr(value.agent)) return null
      if (value.event === 'question') return nullableStr(value.question) && nullableStr(value.noBody) ? { field: 'agent', event: 'question', agent: value.agent, worktree: value.worktree, question: value.question, noBody: value.noBody } : null
      if (value.event !== 'result') return null
      const outcome = value.outcome === 'completed' || value.outcome === 'interrupted' || value.outcome === 'failed' ? value.outcome : null
      const files = value.filesChanged === null || (typeof value.filesChanged === 'number' && Number.isInteger(value.filesChanged) && value.filesChanged >= 0)
      return outcome !== null && nullableStr(value.detail) && files ? { field: 'agent', event: 'result', agent: value.agent, worktree: value.worktree, outcome, detail: value.detail, filesChanged: typeof value.filesChanged === 'number' ? value.filesChanged : null } : null
    }
    default:
      return null
  }
}

export function readActivityRecord(value: unknown): WorkActivityRecord | null {
  if (!isRecord(value)) return null
  const { id, connectionId, itemId, at, writeId } = value
  if (!str(id) || !str(connectionId) || !str(itemId) || !str(writeId)) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  const change = readChange(value.change)
  if (change === null) return null
  if (value.itemKey !== undefined && !str(value.itemKey)) return null
  if (value.eventKey !== undefined && !str(value.eventKey)) return null
  return { id, connectionId, itemId, at, writeId, change, ...(str(value.itemKey) ? { itemKey: value.itemKey } : {}), ...(str(value.eventKey) ? { eventKey: value.eventKey } : {}) }
}

/** 상한·찾기의 묶음 — 작업 id, 모르면 키(LIFE-603 자동 연결 사건). */
function groupOf(record: WorkActivityRecord): string {
  return `${record.connectionId}\n${record.itemId === '' ? `key:${record.itemKey ?? ''}` : record.itemId}`
}

/** 그 작업의 기록인가 — 작업 id 가 같거나, 키로 남긴 기록의 키가 같다. */
export function recordMatches({ record, query }: { record: WorkActivityRecord; query: { connectionId: string; itemId: string; itemKey?: string } }): boolean {
  if (record.connectionId !== query.connectionId) return false
  if (record.itemId !== '' && record.itemId === query.itemId) return true
  return query.itemKey !== undefined && record.itemKey !== undefined && record.itemKey === query.itemKey
}

/** 상한을 지킨다 — 작업마다 최근 `perItem` 줄, 전체 최근 `total` 줄. 순서(오래된 것부터)는 그대로. */
export function capRecords({ records, perItem = ACTIVITY_PER_ITEM, total = ACTIVITY_TOTAL }: { records: WorkActivityRecord[]; perItem?: number; total?: number }): WorkActivityRecord[] {
  const counts = new Map<string, number>()
  const kept: WorkActivityRecord[] = []
  for (let index = records.length - 1; index >= 0 && kept.length < total; index -= 1) {
    const record = records[index]
    if (record === undefined) continue
    const key = groupOf(record)
    const count = counts.get(key) ?? 0
    if (count >= perItem) continue
    counts.set(key, count + 1)
    kept.push(record)
  }
  return kept.reverse()
}

export class WorkActivityStore implements ActivityPort {
  readonly file: string
  private records: WorkActivityRecord[] = []
  private readonly seen = new SeenKeys()

  constructor(userDataDir: string) {
    const fromEnv = process.env.CORRAL_WORK_ACTIVITY
    this.file = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : path.join(userDataDir, 'work-activity.json')
  }

  load(): void {
    let text: string
    try {
      if (!fs.existsSync(this.file)) return
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      log('work.activity_load_failed', { file: this.file, error: String(error) })
      return
    }
    const parsed = safeParse(text)
    if (!isRecord(parsed) || parsed.version !== WORK_ACTIVITY_VERSION || !Array.isArray(parsed.records)) {
      // 손상(모르는 버전 포함) — 빈 기록으로 시작하고 원본은 옆으로(다음 쓰기가 지우지 않게).
      this.records = []
      let preserved: string | null = `${this.file}.corrupt`
      try {
        fs.renameSync(this.file, preserved)
      } catch (error) {
        preserved = null
        log('work.activity_corrupt_preserve_failed', { file: this.file, error: String(error) })
      }
      log('work.activity_corrupt', { file: this.file, bytes: text.length, preserved })
      return
    }
    let dropped = 0
    const records: WorkActivityRecord[] = []
    for (const row of parsed.records) {
      const record = readActivityRecord(row)
      if (record === null) dropped += 1
      else records.push(record)
    }
    this.records = capRecords({ records })
    // 열쇠 기억(R1-K) — 옛 파일엔 `seen` 이 없다. 그때는 남은 줄의 열쇠로 시작한다.
    this.seen.load(parsed.seen)
    for (const record of this.records) if (record.eventKey !== undefined && !this.seen.has(record.eventKey)) this.seen.add({ key: record.eventKey, connectionId: record.connectionId })
    log('work.activity_load', { file: this.file, records: this.records.length, dropped })
  }

  append(record: WorkActivityRecord): boolean {
    if (record.eventKey !== undefined) {
      if (this.seen.has(record.eventKey)) return false
      this.seen.add({ key: record.eventKey, connectionId: record.connectionId })
    }
    this.records = capRecords({ records: [...this.records, record] })
    this.save()
    return true
  }

  refresh({ eventKey, change }: { eventKey: string; change: WorkActivityChange }): boolean {
    const index = this.records.findIndex((row) => row.eventKey === eventKey)
    const current = this.records[index]
    if (current === undefined || sameChange({ a: current.change, b: change })) return false
    this.records = this.records.map((row, at) => (at === index ? { ...row, change } : row))
    this.save()
    return true
  }

  list(query: { connectionId: string; itemId: string; itemKey?: string }): WorkActivityRecord[] {
    return this.records.filter((record) => recordMatches({ record, query })).map((record) => ({ ...record, change: { ...record.change } }))
  }

  purgeConnection(connectionId: string): void {
    const next = this.records.filter((record) => record.connectionId !== connectionId)
    const before = this.seen.list().length
    // 그 연결의 열쇠는 줄이 남았든 밀려났든 잊는다(R2-J ⓒ) — 해제한 계정의 흔적을 남기지 않는다.
    this.seen.dropConnection(connectionId)
    if (next.length === this.records.length && this.seen.list().length === before) return
    this.records = next
    this.save()
  }

  private save(): void {
    const payload = JSON.stringify({ version: WORK_ACTIVITY_VERSION, records: this.records, seen: this.seen.entries() }) + '\n'
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, payload, { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch (cleanupError) {
        log('work.activity_tmp_cleanup_failed', { file: tmp, error: String(cleanupError) })
      }
      log('work.activity_save_failed', { file: this.file, error: String(error) })
    }
  }
}

/** 메모리 판 — 테스트용(파일 없음). */
export class MemoryActivity implements ActivityPort {
  records: WorkActivityRecord[] = []
  private readonly seen: SeenKeys

  constructor(limit?: number) { this.seen = new SeenKeys(limit) }

  append(record: WorkActivityRecord): boolean {
    if (record.eventKey !== undefined) {
      if (this.seen.has(record.eventKey)) return false
      this.seen.add({ key: record.eventKey, connectionId: record.connectionId })
    }
    this.records = capRecords({ records: [...this.records, record] })
    return true
  }

  refresh({ eventKey, change }: { eventKey: string; change: WorkActivityChange }): boolean {
    const index = this.records.findIndex((row) => row.eventKey === eventKey)
    const current = this.records[index]
    if (current === undefined || sameChange({ a: current.change, b: change })) return false
    this.records = this.records.map((row, at) => (at === index ? { ...row, change } : row))
    return true
  }

  list(query: { connectionId: string; itemId: string; itemKey?: string }): WorkActivityRecord[] {
    return this.records.filter((record) => recordMatches({ record, query }))
  }

  purgeConnection(connectionId: string): void {
    this.records = this.records.filter((record) => record.connectionId !== connectionId)
    this.seen.dropConnection(connectionId)
  }

  /** 시험용 — 기억하는 열쇠. */
  seenKeys(): string[] { return this.seen.list() }
}
