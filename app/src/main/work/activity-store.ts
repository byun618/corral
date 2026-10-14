// corral 활동 저장소 (LIFE-602 C9 · 묶음 D9) — `<userData>/work-activity.json`(경로 오버라이드 `CORRAL_WORK_ACTIVITY`, 격리 실행용).
//
// 담는 것: corral 에서 **성공한** 작업 쓰기 하나 = 한 줄(연결 id · 작업 id · 시각 · 쓰기 id · 무엇이 바뀌었나). 기록 지점은 `WorkService` 하나다 —
//   상세·보드·백로그 어디서 바꿨든 같은 길이라 화면마다 따로 기록하지 않는다. 실패한 쓰기는 남지 않는다.
// 담지 않는 것: 토큰 · 본문 전문(본문 변경은 줄 수만) · 코멘트(출처가 가진다).
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

export type ActivityPort = {
  append(record: WorkActivityRecord): void
  list(query: { connectionId: string; itemId: string }): WorkActivityRecord[]
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
  return change === null ? null : { id, connectionId, itemId, at, writeId, change }
}

/** 상한을 지킨다 — 작업마다 최근 `perItem` 줄, 전체 최근 `total` 줄. 순서(오래된 것부터)는 그대로. */
export function capRecords({ records, perItem = ACTIVITY_PER_ITEM, total = ACTIVITY_TOTAL }: { records: WorkActivityRecord[]; perItem?: number; total?: number }): WorkActivityRecord[] {
  const counts = new Map<string, number>()
  const kept: WorkActivityRecord[] = []
  for (let index = records.length - 1; index >= 0 && kept.length < total; index -= 1) {
    const record = records[index]
    if (record === undefined) continue
    const key = `${record.connectionId}\n${record.itemId}`
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
    if (!isRecord(parsed) || !Array.isArray(parsed.records)) {
      // 손상 — 빈 기록으로 시작하고 원본은 옆으로(다음 쓰기가 지우지 않게).
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
    log('work.activity_load', { file: this.file, records: this.records.length, dropped })
  }

  append(record: WorkActivityRecord): void {
    this.records = capRecords({ records: [...this.records, record] })
    this.save()
  }

  list({ connectionId, itemId }: { connectionId: string; itemId: string }): WorkActivityRecord[] {
    return this.records.filter((record) => record.connectionId === connectionId && record.itemId === itemId).map((record) => ({ ...record, change: { ...record.change } }))
  }

  purgeConnection(connectionId: string): void {
    const next = this.records.filter((record) => record.connectionId !== connectionId)
    if (next.length === this.records.length) return
    this.records = next
    this.save()
  }

  private save(): void {
    const payload = JSON.stringify({ version: WORK_ACTIVITY_VERSION, records: this.records }) + '\n'
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

  append(record: WorkActivityRecord): void {
    this.records = capRecords({ records: [...this.records, record] })
  }

  list({ connectionId, itemId }: { connectionId: string; itemId: string }): WorkActivityRecord[] {
    return this.records.filter((record) => record.connectionId === connectionId && record.itemId === itemId)
  }

  purgeConnection(connectionId: string): void {
    this.records = this.records.filter((record) => record.connectionId !== connectionId)
  }
}
