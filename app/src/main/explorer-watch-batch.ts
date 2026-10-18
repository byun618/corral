// 탐색기 감시 — 순수 규칙 (LIFE-589 E4). 감시 프로세스(`explorer-watcher.ts`)와 단위 시험이 같이 쓴다.
//
// 감시 제외 목록 (E4ⓓ — 트리 숨김과 별개): 이 이름이 경로 어디든 끼면 그 이벤트는 감시 프로세스 **안에서** 버린다 — main·렌더러로 안 간다.
// Orca `filesystem-watcher-ignore.ts:4-15` 목록에서 `build` 를 뺐다(corral 레포의 `app/build` 처럼 추적되는 폴더 이름이라 — 제외하면 그 밑 변경이
// 안전망 주기까지 늦는다). `.turbo` 를 더했다. 제외 경로의 변경도 안전망 재조회(`shared/explorer.ts` `EXPLORER_SAFETY_NET_MS`)로는 맞아진다.
import path from 'node:path'

export const WATCH_EXCLUDED_NAMES: readonly string[] = ['.git', 'node_modules', 'dist', 'out', '.next', '.cache', '.turbo', 'target', '.venv', '__pycache__']

/** 배치 창 — 마지막 이벤트 뒤 150 ms, 첫 이벤트부터 최대 500 ms(Orca `filesystem-watch-batch-window.ts:4-5` 와 같다). */
export const BATCH_TRAILING_MS = 150
export const BATCH_MAX_MS = 500
/** 한 배치에서 바뀐 폴더가 이만큼을 넘으면 폴더 목록 대신 「전부 다시 읽기」(overflow) 하나를 보낸다 — 브랜치 전환 같은 대량 변경(E4ⓔ). */
export const BATCH_OVERFLOW_DIRS = 200

/** 감시 장애 재기동 — 60초 안에 3번까지(1초 뒤). 넘으면 멈추고 안전망만 남는다(E4ⓖ 재기동 정책). */
export const RESTART_DELAY_MS = 1_000
export const RESTART_WINDOW_MS = 60_000
export const RESTART_MAX = 3

/** `fs.watch` 가 준 상대 파일 이름(OS 구분자) → `/` 상대 경로. 제외 목록에 걸리면 null. */
export function relOfEvent(filename: string): string | null {
  const rel = filename.split(path.sep).filter((part) => part.length > 0)
  if (rel.length === 0) return ''
  if (rel.some((part) => WATCH_EXCLUDED_NAMES.includes(part))) return null
  return rel.join('/')
}

/** 바뀐 경로 하나 → 다시 읽을 후보 폴더 둘(그 경로 자체 — 폴더일 수 있다 — 와 부모). 렌더러는 받은 목록 중 **읽어 둔 폴더만** 다시 읽는다. */
export function dirsOfChange(rel: string): string[] {
  if (rel === '') return ['']
  const index = rel.lastIndexOf('/')
  return [rel, index === -1 ? '' : rel.slice(0, index)]
}

/** 배치 모으기 — 순수 상태 기계(시간은 부르는 쪽이 준다). */
export class ChangeBatch {
  private dirs = new Set<string>()
  private firstAt: number | null = null
  private lastAt = 0
  excludedCount = 0

  add(input: { filename: string | null; now: number }): void {
    if (input.filename === null) {
      // 이름 없는 이벤트(FSEvents 합침 등) — 루트부터 다시 읽게 overflow 로 본다.
      this.dirs.add('\0overflow')
    } else {
      const rel = relOfEvent(input.filename)
      if (rel === null) {
        this.excludedCount += 1
        return
      }
      for (const dir of dirsOfChange(rel)) this.dirs.add(dir)
    }
    if (this.firstAt === null) this.firstAt = input.now
    this.lastAt = input.now
  }

  isEmpty(): boolean {
    return this.firstAt === null
  }

  /** 지금 내보낼 때인가 — 쌓인 게 있고 (마지막 뒤 trailing 지남 또는 첫 것부터 max 지남). */
  due(now: number): boolean {
    if (this.firstAt === null) return false
    return now - this.lastAt >= BATCH_TRAILING_MS || now - this.firstAt >= BATCH_MAX_MS
  }

  take(): { kind: 'changed'; dirs: string[] } | { kind: 'overflow' } | null {
    if (this.firstAt === null) return null
    const dirs = [...this.dirs]
    this.dirs = new Set()
    this.firstAt = null
    if (dirs.includes('\0overflow') || dirs.length > BATCH_OVERFLOW_DIRS) return { kind: 'overflow' }
    return { kind: 'changed', dirs }
  }
}
