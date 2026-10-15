// 미확정 시작 기록 (LIFE-603 R1-C) — `<userData>/work-start-pending.json`(격리 오버라이드 `CORRAL_WORK_START_PENDING`).
//
// 런타임 `worktree create` 를 부르기 **전에** 시도(작업 · 레포 · 이름 · 예정 경로)를 적고, 링크를 저장하면 지운다.
// 응답 전에 앱이 끝나거나(크래시 · 종료) 결과가 미확정(`outcome_unknown`)이면 기록이 남고, 다음 상태 내보내기(`StartService.recover`)가
// 그 경로의 worktree 를 트리에서 찾으면 그때 링크 · 「작업 시작」 활동을 적는다(활동은 같은 `run:start:<attemptId>` 열쇠라 한 번).
// 형식 `{ version: 1, entries: PendingStart[] }`. 손상이면 빈 목록으로 시작하고 로그(앱은 산다). 본문(프롬프트)은 적지 않는다.
import fs from 'node:fs'
import path from 'node:path'
import { isRecord, safeParse } from '../../shared/json.js'
import type { AgentKind } from '../../shared/types.js'
import { log } from '../log.js'

export type PendingStart = {
  attemptId: string
  connectionId: string
  sourceId: string
  itemId: string
  itemKey: string
  repoRoot: string
  name: string
  /** 런타임이 만들 자리(`startWorktreePath`). */
  path: string
  agent: AgentKind
  model: string
  startedAt: number
}

export type PendingPort = {
  list(): PendingStart[]
  add(entry: PendingStart): void
  remove(attemptId: string): void
}

/** 하루가 지나도 worktree 가 안 나타난 기록은 버린다(런타임 영수증 수명과 같은 24시간). */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000

const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const AGENTS: readonly AgentKind[] = ['claude', 'codex', 'grok', 'shell']

export function readPendingStart(value: unknown): PendingStart | null {
  if (!isRecord(value)) return null
  const { attemptId, connectionId, sourceId, itemId, itemKey, repoRoot, name, path: target, agent, model, startedAt } = value
  const kind = AGENTS.find((entry) => entry === agent)
  if (!str(attemptId) || !str(connectionId) || !str(sourceId) || !str(itemId) || !str(itemKey) || !str(repoRoot) || !str(name) || !str(target)) return null
  if (kind === undefined || typeof model !== 'string' || typeof startedAt !== 'number') return null
  return { attemptId, connectionId, sourceId, itemId, itemKey, repoRoot, name, path: target, agent: kind, model, startedAt }
}

export class PendingStartStore implements PendingPort {
  readonly file: string
  private entries: PendingStart[] = []

  constructor(userDataDir: string) {
    const fromEnv = process.env.CORRAL_WORK_START_PENDING
    this.file = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : path.join(userDataDir, 'work-start-pending.json')
    this.load()
  }

  private load(): void {
    let text: string
    try {
      if (!fs.existsSync(this.file)) return
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      log('work.start_pending_load_failed', { file: this.file, error: String(error) })
      return
    }
    const parsed = safeParse(text)
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      log('work.start_pending_corrupt', { file: this.file, bytes: text.length })
      return
    }
    this.entries = parsed.entries.flatMap((row) => { const entry = readPendingStart(row); return entry === null ? [] : [entry] })
  }

  list(): PendingStart[] { return [...this.entries] }

  add(entry: PendingStart): void {
    this.entries = [...this.entries.filter((row) => row.attemptId !== entry.attemptId), entry]
    this.save()
  }

  remove(attemptId: string): void {
    const next = this.entries.filter((row) => row.attemptId !== attemptId)
    if (next.length === this.entries.length) return
    this.entries = next
    this.save()
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* 지울 것이 없으면 그만 */ }
      log('work.start_pending_save_failed', { file: this.file, error: String(error) })
    }
  }
}

/** 메모리 판 — 시험용. */
export class MemoryPending implements PendingPort {
  entries: PendingStart[] = []
  list(): PendingStart[] { return [...this.entries] }
  add(entry: PendingStart): void { this.entries = [...this.entries.filter((row) => row.attemptId !== entry.attemptId), entry] }
  remove(attemptId: string): void { this.entries = this.entries.filter((row) => row.attemptId !== attemptId) }
}
