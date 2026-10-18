// Codex 사용량 수집기 (LIFE-636 E4) — `<$CODEX_HOME 또는 ~/.codex>/auth.json` 을 **읽기만** 해 `wham/usage` 를 부른다.
//
// HTTP 하나로 간다(00-analysis D4) — codex app-server RPC 는 자식 프로세스를 띄우고 config 를 고칠 수 있어 넣지 않는다(codex 자식 프로세스 0).
// 토큰 갱신은 하지 않는다 — 401 이면 「codex 실행 시 갱신」. User-Agent 는 corral 자기 이름(D10).
//
// 창 길이는 플랜마다 다르다(A2 — free 30일 하나 · prolite 주간 하나 · plus 5h+주간). `limit_window_seconds` 로 라벨을 만든다.
// 응답의 email·account_id·user_id·plan_type 은 읽지 않는다 — 렌더러로 가는 값은 창뿐이다(E6ⓒ).
import path from 'node:path'
import { isRecord, readRecord } from '../../shared/json.js'
import { windowLabel, type UsageWindow } from '../../shared/usage.js'
import { PARSE_ERROR, failure, getJson, percentOf, readJsonFile, stringField, timeOf, type CollectorDeps, type FetchOutcome, type UsageCollector } from './collector.js'

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

function windowOf({ value, now }: { value: unknown; now: number }): UsageWindow | null {
  if (!isRecord(value)) return null
  const usedPercent = percentOf(value.used_percent)
  if (usedPercent === null) return null
  const seconds = value.limit_window_seconds
  const minutes = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : null
  const after = value.reset_after_seconds
  const resetsAt = timeOf(value.reset_at) ?? (typeof after === 'number' && Number.isFinite(after) && after >= 0 ? now + after * 1000 : null)
  return { label: minutes === null ? 'limit' : windowLabel(minutes), windowMinutes: minutes, usedPercent, resetsAt }
}

/** 응답 → 창 목록(primary·secondary 중 있는 것). 하나도 없으면 null(= `error(parse)`). */
export function parseCodexUsage({ value, now }: { value: unknown; now: number }): UsageWindow[] | null {
  if (!isRecord(value)) return null
  const limit = readRecord(value, 'rate_limit')
  if (limit === null) return null
  const windows = [windowOf({ value: limit.primary_window, now }), windowOf({ value: limit.secondary_window, now })].filter((window) => window !== null)
  return windows.length > 0 ? windows : null
}

async function fetchCodex(deps: CollectorDeps): Promise<FetchOutcome> {
  const home = deps.env.CODEX_HOME
  const file = path.join(home !== undefined && home !== '' ? home : path.join(deps.homedir, '.codex'), 'auth.json')
  const auth = await readJsonFile({ deps, file })
  switch (auth.kind) {
    case 'missing':
      return { kind: 'unavailable', reason: 'Codex 로그인 정보 없음' }
    case 'error':
      return failure({ error: { kind: 'credential', message: 'Codex auth.json 을 읽지 못함' } })
    case 'found':
      break
  }
  const tokens = isRecord(auth.value) ? readRecord(auth.value, 'tokens') : null
  const token = stringField({ record: tokens, key: 'access_token' })
  // API 키 로그인(ChatGPT 계정 아님)에는 사용량 창이 없다.
  if (token === null) return { kind: 'unavailable', reason: 'Codex ChatGPT 로그인 정보 없음' }
  const accountId = stringField({ record: tokens, key: 'account_id' })
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (accountId !== null) headers['ChatGPT-Account-Id'] = accountId
  const response = await getJson({ deps, url: CODEX_USAGE_URL, cli: 'codex', headers })
  if (response.kind === 'error') return response
  const windows = parseCodexUsage({ value: response.value, now: deps.now() })
  return windows === null ? failure({ error: PARSE_ERROR }) : { kind: 'ok', windows }
}

export const codexCollector: UsageCollector = { id: 'codex', name: 'Codex', fetch: fetchCodex }
