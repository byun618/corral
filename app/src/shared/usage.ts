// provider 사용량 — main(수집기·서비스)과 렌더러(상태바 칩·팝오버·설정 카드)가 같이 보는 결과 모양 (LIFE-636 E2).
//
// **남은 한도만**(00-analysis D1): provider 서버가 돌려주는 한도 창마다 사용률·초기화 시각. 토큰·비용 집계는 없다.
// 이 파일의 값은 렌더러로 간다 — **토큰·email·account_id·user_id 칸을 두지 않는다**(E6ⓒ). 표시에 필요한 칸만.
// 형태 검사는 main 수집기 경계에서 끝난다(E2ⓒ). 여기 오는 숫자는 응답에서 읽은 값이다 — 모르면 숫자 대신 `error(parse)`.
import { isRecord } from './json.js'
import type { Settings } from './terminal-settings.js'

/** 한도 창 하나. 라벨은 창 길이에서 만든다(D5) — provider 이름이 붙는 창(예: `Fable 7d`)은 `scope` 로 앞에 붙인다. */
export type UsageWindow = {
  /** 표시 라벨 — `windowLabel` 로 만든 길이 라벨(`5h`·`7d`·`30d`)에 scope 가 있으면 `Fable 7d`. */
  label: string
  /** 창 길이(분). 응답에 길이 근거가 없으면 null. */
  windowMinutes: number | null
  /** 사용률 0–100. */
  usedPercent: number
  /** 초기화 시각(epoch ms). 모르면 null. */
  resetsAt: number | null
}

/** 실패 사유 — 렌더러는 kind 로 모양을 고르고 message 를 그대로 보인다. message 는 수집기가 만든 고정 문구다(응답 본문·토큰을 싣지 않는다). */
export type UsageErrorKind =
  | 'expired' // 401·만료된 자격 — 「<CLI> 실행 시 갱신」
  | 'forbidden' // 403
  | 'rate_limited' // 429
  | 'server' // 5xx
  | 'network'
  | 'timeout'
  | 'parse' // 모르는 응답 형태
  | 'credential' // 자격 증명을 읽다 실패(키체인 오류·손상된 파일)
  | 'http' // 그 밖의 HTTP 상태

export type UsageError = { kind: UsageErrorKind; message: string }

/**
 * provider 하나의 상태 — 렌더러가 switch 로 모양을 고른다(E8ⓑ).
 * `loading` = 첫 조회 전·중(값 없음) · `ok` · `stale` = 직전 값 + 이번 실패 · `error` = 값 없음 + 실패 · `unavailable` = 자격 없음 · `disabled` = 설정에서 끔.
 */
export type ProviderUsage =
  | { status: 'loading' }
  | { status: 'ok'; windows: UsageWindow[]; updatedAt: number }
  | { status: 'stale'; windows: UsageWindow[]; updatedAt: number; error: UsageError }
  | { status: 'error'; error: UsageError; checkedAt: number }
  | { status: 'unavailable'; reason: string }
  | { status: 'disabled' }

export type ProviderUsageEntry = {
  /** 수집기 id — 제품은 `claude`·`codex`·`grok`. 시험용 가짜 provider 도 같은 길로 흐른다(E2ⓑ). */
  id: string
  /** 표시 이름(`Claude`). */
  name: string
  usage: ProviderUsage
  /** 지금 조회 중인가 — 값이 있을 때 새로고침 표시용. */
  refreshing: boolean
}

/** main → 렌더러 스냅숏. 순서 = 등록 순서(Claude·Codex·Grok — E8ⓐ). */
export type UsageSnapshot = { providers: ProviderUsageEntry[] }

export const EMPTY_USAGE_SNAPSHOT: UsageSnapshot = { providers: [] }

/** 실패 뒤 직전 값을 보여 주는 최대 나이(E7ⓕ) — 넘으면 값을 버리고 `error`. */
export const USAGE_STALE_MAX_MS = 30 * 60 * 1000

/** 30분 넘은 직전 값은 버린다 — `stale` → `error`. main 스냅숏과 렌더러 표시가 같은 규칙을 쓴다(창이 쉬어 푸시가 없어도 화면이 낡은 값을 들지 않게). */
export function expireStale({ usage, now }: { usage: ProviderUsage; now: number }): ProviderUsage {
  if (usage.status !== 'stale' || now - usage.updatedAt <= USAGE_STALE_MAX_MS) return usage
  return { status: 'error', error: usage.error, checkedAt: now }
}

/** 칩 숫자 — 가장 빡빡한 창(사용률 최대, D5). 창이 없으면 null. */
export function tightestWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  let best: UsageWindow | null = null
  for (const window of windows) if (best === null || window.usedPercent > best.usedPercent) best = window
  return best
}

/** 사용률 단계(E8ⓒ) — 60% 미만 기본 · 60% 이상 주의 · 80% 이상 경고. */
export type UsageTone = 'normal' | 'caution' | 'warning'
export function usageTone(usedPercent: number): UsageTone {
  if (usedPercent >= 80) return 'warning'
  if (usedPercent >= 60) return 'caution'
  return 'normal'
}

/**
 * 창 길이(분) → 라벨(D5). 300 = `5h` · 10080 = `7d` · 43200 = `30d`. 일 단위로 떨어지면 `Nd`, 시간 단위면 `Nh`, 그 밖은 `Nm`.
 * 서버가 299·10079 처럼 1분 모자라게 줄 수 있어(Orca `codex-rate-limit-window-classification.ts`) 1분 차이는 시간 단위로 맞춘다.
 */
export function windowLabel(minutes: number): string {
  const rounded = Math.round(minutes)
  const hours = Math.round(rounded / 60)
  if (hours > 0 && Math.abs(rounded - hours * 60) <= 1) {
    return hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`
  }
  return `${rounded}m`
}

/** 초기화까지 남은 시간 — `2d 3h` · `4h 12m` · `9m` · `곧`. */
export function formatResetIn({ resetsAt, now }: { resetsAt: number; now: number }): string {
  const totalMinutes = Math.floor((resetsAt - now) / 60_000)
  if (totalMinutes <= 0) return '곧'
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}

/** provider ↔ 설정 칸 표(E9) — 설정 › 외관 「상태바」 카드의 스위치 순서이기도 하다. 수집기를 더하면 여기 한 줄 + `Settings` 칸 하나. */
export type UsageSettingKey = 'statusBarUsageClaude' | 'statusBarUsageCodex' | 'statusBarUsageGrok'
export const USAGE_SETTING_ROWS: readonly { id: string; name: string; key: UsageSettingKey }[] = [
  { id: 'claude', name: 'Claude', key: 'statusBarUsageClaude' },
  { id: 'codex', name: 'Codex', key: 'statusBarUsageCodex' },
  { id: 'grok', name: 'Grok', key: 'statusBarUsageGrok' },
]

/** 설정에서 이 provider 가 켜져 있나. 표에 없는 id 는 꺼진 것으로 본다(조회하지 않는다). */
export function usageEnabled({ settings, id }: { settings: Pick<Settings, UsageSettingKey>; id: string }): boolean {
  const row = USAGE_SETTING_ROWS.find((entry) => entry.id === id)
  return row === undefined ? false : settings[row.key]
}

// --- IPC 로 받은 값 읽기 (렌더러) — main 이 만든 값이지만 모양이 다르면 버린다(설정 저장소 `readSettings` 와 같은 결) ---

const ERROR_KINDS: readonly UsageErrorKind[] = ['expired', 'forbidden', 'rate_limited', 'server', 'network', 'timeout', 'parse', 'credential', 'http']

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value) || typeof value.label !== 'string' || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return null
  const windowMinutes = readNullableNumber(value.windowMinutes)
  const resetsAt = readNullableNumber(value.resetsAt)
  if (windowMinutes === undefined || resetsAt === undefined) return null
  return { label: value.label, windowMinutes, usedPercent: value.usedPercent, resetsAt }
}

function readWindows(value: unknown): UsageWindow[] | null {
  if (!Array.isArray(value)) return null
  const windows = value.map(readWindow)
  return windows.every((window) => window !== null) ? windows.filter((window) => window !== null) : null
}

function readError(value: unknown): UsageError | null {
  if (!isRecord(value) || typeof value.message !== 'string') return null
  const kind = ERROR_KINDS.find((candidate) => candidate === value.kind)
  return kind === undefined ? null : { kind, message: value.message }
}

function readUsage(value: unknown): ProviderUsage | null {
  if (!isRecord(value)) return null
  switch (value.status) {
    case 'loading':
      return { status: 'loading' }
    case 'disabled':
      return { status: 'disabled' }
    case 'unavailable':
      return typeof value.reason === 'string' ? { status: 'unavailable', reason: value.reason } : null
    case 'ok': {
      const windows = readWindows(value.windows)
      return windows !== null && typeof value.updatedAt === 'number' ? { status: 'ok', windows, updatedAt: value.updatedAt } : null
    }
    case 'stale': {
      const windows = readWindows(value.windows)
      const error = readError(value.error)
      return windows !== null && error !== null && typeof value.updatedAt === 'number' ? { status: 'stale', windows, updatedAt: value.updatedAt, error } : null
    }
    case 'error': {
      const error = readError(value.error)
      return error !== null && typeof value.checkedAt === 'number' ? { status: 'error', error, checkedAt: value.checkedAt } : null
    }
    default:
      return null
  }
}

/** 스냅숏 읽기 — 모양이 다른 provider 항목은 그 항목만 버린다. 스냅숏 자체가 아니면 null. */
export function readUsageSnapshot(value: unknown): UsageSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.providers)) return null
  const providers: ProviderUsageEntry[] = []
  for (const entry of value.providers) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string') continue
    const usage = readUsage(entry.usage)
    if (usage !== null) providers.push({ id: entry.id, name: entry.name, usage, refreshing: entry.refreshing === true })
  }
  return { providers }
}
