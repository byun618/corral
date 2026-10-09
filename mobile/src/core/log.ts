// 폰 쪽 연결 기록 (P8) — 시도·인증·프로브·끊김 사유·재연결을 시각과 함께 남긴다. 사후 회수는 앱 「연결 기록」 화면의 복사와
// 기록 파일(런타임이 붙인다)·logcat(`[corral-conn]`) 셋.
//
// 비밀 없음: 기록은 아래 `ConnEvent` 의 고정 칸만 받는다 — 토큰·코드 칸이 없다. 그래도 칸 값에 비밀이 섞이는 실수를 막으려고
// 연결 관리자가 아는 비밀(토큰·코드)을 `forget` 전까지 등록해 두고 적기 전에 `<redacted>` 로 바꾼다.

export type LogValue = string | number | boolean | null

export type LogEntry = { at: number; event: string; detail: Record<string, LogValue> }

export type LogSink = (entry: LogEntry, line: string) => void

export const LOG_CAPACITY = 500

export class ConnectionLog {
  private entries: LogEntry[] = []
  private readonly secrets = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly sinks: LogSink[] = []
  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  /** 앱 재시작 전의 기록(파일)을 앞에 붙인다. */
  restore(previous: LogEntry[]): void {
    this.entries = [...previous, ...this.entries].slice(-LOG_CAPACITY)
    this.emit()
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink)
  }

  rememberSecret(value: string): void {
    if (value.length > 0) this.secrets.add(value)
  }

  forgetSecrets(): void {
    this.secrets.clear()
  }

  add(event: string, detail: Record<string, LogValue> = {}): void {
    const clean: Record<string, LogValue> = {}
    // `at`·`event` 는 기록 줄의 봉투 칸이다 — detail 이 같은 이름을 쓰면 덮지 않게 `atDetail`·`eventDetail` 로 옮긴다(R2-A3:
    // 덮인 줄은 재시작 복원 때 파서가 버려 파일에서도 사라졌다).
    for (const [key, value] of Object.entries(detail)) clean[key === 'at' || key === 'event' ? `${key}Detail` : key] = typeof value === 'string' ? this.redact(value) : value
    const entry: LogEntry = { at: this.now(), event, detail: clean }
    // 새 배열 — 구독자(useSyncExternalStore)가 바뀜을 참조로 안다.
    this.entries = [...this.entries, entry].slice(-LOG_CAPACITY)
    const line = formatLine(entry)
    for (const sink of this.sinks) sink(entry, line)
    this.emit()
  }

  list(): readonly LogEntry[] {
    return this.entries
  }

  text(): string {
    return this.entries.map(formatLine).join('\n')
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private redact(value: string): string {
    let out = value
    for (const secret of this.secrets) out = out.split(secret).join('<redacted>')
    return out
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

/** 기록 한 줄 — 봉투(`at` ISO 시각 · `event`)가 늘 이긴다. 이 줄은 `parseLine` 으로 그대로 되읽힌다(저장 → 재시작 복원 → 재복사). */
export function formatLine(entry: LogEntry): string {
  const line: Record<string, LogValue> = { at: new Date(entry.at).toISOString(), event: entry.event }
  for (const [key, value] of Object.entries(entry.detail)) if (key !== 'at' && key !== 'event') line[key] = value
  return JSON.stringify(line)
}

/** 기록 파일 한 줄을 다시 읽는다 — 모양이 틀린 줄은 버린다. */
export function parseLine(line: string): LogEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { at, event, ...rest }: Record<string, unknown> = { ...parsed }
  if (typeof at !== 'string' || typeof event !== 'string') return null
  const time = Date.parse(at)
  if (Number.isNaN(time)) return null
  const detail: Record<string, LogValue> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') detail[key] = value
  }
  return { at: time, event, detail }
}
