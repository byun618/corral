// 작업 연결 저장소 (LIFE-600 C8) — `<userData>/work-connections.json`(경로 오버라이드 `CORRAL_WORK_CONNECTIONS`, 격리 실행용).
//
// 담는 것: 연결(출처 id · 추가 시각 · 토큰 끝 4자 · **암호문**(base64, `safeStorage`) · 숨긴 스페이스 키) + 레포 ↔ 기본 스페이스.
// 담지 않는 것: 토큰 평문. 암호문은 OS 키체인의 키 없이는 풀리지 않는다.
//
// 레포 키는 main `RepoRecord.id`(registry 의 uuid)다 — 렌더러는 경로(`root`)만 알지만, 경로는 레포를 옮기면 바뀐다.
//   - 레포 경로가 바뀌어도(같은 id) 기본 스페이스는 유지된다.
//   - 레포를 목록에서 지우면 그 id 의 항목은 읽을 때 무시되고, 다음 쓰기 때 떨어진다(`service.ts`).
//   - 스페이스가 사라지면(프로젝트 완료·보관) 항목은 남고, 화면이 「없는 스페이스」 로 보인다.
//
// settings.ts 와 같은 결: 칸별 검증으로 읽고(망가진 행만 버림), tmp → rename 원자 쓰기, **바꾸기 전에는 파일을 만들지 않는다**.
// 파일 권한은 0600 — 암호문뿐이지만 남이 읽을 이유가 없다.

import fs from 'node:fs'
import path from 'node:path'
import { isRecord, safeParse } from '../../shared/json.js'
import { log } from '../log.js'

export const WORK_STORE_VERSION = 1

export type StoredConnection = {
  id: string
  sourceId: string
  addedAt: number
  tokenTail: string
  sealed: string
  hiddenSpaceKeys: string[]
  /**
   * 비밀 아닌 연결 칸(LIFE-605 — Jira 사이트 호스트·이메일) — **카드 표시용**. 클라이언트를 만드는 값은 암호문 안에 같이 싼 것을 쓴다
   * (이 칸을 모르는 이전 판 앱이 파일을 다시 쓰면 이 칸만 떨어진다 — 그래도 연결은 돈다, design-notes §1). 없는 행은 빈 객체.
   */
  account: Record<string, string>
}

export type StoredRepoDefault = { connectionId: string; spaceKey: string }

export type WorkStoreData = {
  connections: StoredConnection[]
  /** 키 = `RepoRecord.id`. */
  repoDefaults: Record<string, StoredRepoDefault>
}

export type WorkStoreWrite = { ok: true } | { ok: false; error: string }

function readConnection(value: unknown): StoredConnection | null {
  if (!isRecord(value)) return null
  const { id, sourceId, addedAt, tokenTail, sealed, hiddenSpaceKeys } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof sourceId !== 'string' || sourceId.length === 0) return null
  if (typeof addedAt !== 'number' || !Number.isFinite(addedAt)) return null
  if (typeof tokenTail !== 'string' || tokenTail.length > 4) return null
  if (typeof sealed !== 'string' || sealed.length === 0) return null
  const hidden = Array.isArray(hiddenSpaceKeys) ? hiddenSpaceKeys.filter((key): key is string => typeof key === 'string') : []
  const account = isRecord(value.account) ? Object.fromEntries(Object.entries(value.account).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
  return { id, sourceId, addedAt, tokenTail, sealed, hiddenSpaceKeys: hidden, account }
}

function readRepoDefaults(value: unknown): Record<string, StoredRepoDefault> {
  const result: Record<string, StoredRepoDefault> = {}
  if (!isRecord(value)) return result
  for (const [repoId, entry] of Object.entries(value)) {
    if (isRecord(entry) && typeof entry.connectionId === 'string' && typeof entry.spaceKey === 'string') {
      result[repoId] = { connectionId: entry.connectionId, spaceKey: entry.spaceKey }
    }
  }
  return result
}

export function readWorkStore(value: unknown): WorkStoreData {
  if (!isRecord(value)) return { connections: [], repoDefaults: {} }
  const rows = Array.isArray(value.connections) ? value.connections : []
  const connections: StoredConnection[] = []
  for (const row of rows) {
    const connection = readConnection(row)
    if (connection === null) {
      log('work.store_row_dropped', { reason: 'invalid' })
      continue
    }
    if (!connections.some((existing) => existing.id === connection.id)) connections.push(connection)
  }
  return { connections, repoDefaults: readRepoDefaults(value.repoDefaults) }
}

function copy(data: WorkStoreData): WorkStoreData {
  return {
    connections: data.connections.map((connection) => ({ ...connection, hiddenSpaceKeys: [...connection.hiddenSpaceKeys], account: { ...connection.account } })),
    repoDefaults: Object.fromEntries(Object.entries(data.repoDefaults).map(([key, entry]) => [key, { ...entry }])),
  }
}

export class WorkConnectionStore {
  readonly file: string
  private data: WorkStoreData = { connections: [], repoDefaults: {} }

  constructor(userDataDir: string) {
    const fromEnv = process.env.CORRAL_WORK_CONNECTIONS
    this.file = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : path.join(userDataDir, 'work-connections.json')
  }

  load(): void {
    try {
      if (!fs.existsSync(this.file)) return
      this.data = readWorkStore(safeParse(fs.readFileSync(this.file, 'utf8')))
      log('work.store_load', { file: this.file, connections: this.data.connections.length })
    } catch (error) {
      this.data = { connections: [], repoDefaults: {} }
      log('work.store_load_failed', { file: this.file, error: String(error) })
    }
  }

  get(): WorkStoreData {
    return copy(this.data)
  }

  /** 바꾼 사본을 통째로 쓴다. **쓰기가 성공한 뒤에만** 메모리 값을 바꾼다 — 실패하면 아무것도 저장되지 않은 상태 그대로. */
  write(next: WorkStoreData): WorkStoreWrite {
    const payload = JSON.stringify({ version: WORK_STORE_VERSION, ...next }, null, 2) + '\n'
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, payload, { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch (cleanupError) {
        log('work.store_tmp_cleanup_failed', { file: tmp, error: String(cleanupError) })
      }
      log('work.store_save_failed', { file: this.file, error: String(error) })
      return { ok: false, error: String(error) }
    }
    this.data = copy(next)
    return { ok: true }
  }
}
