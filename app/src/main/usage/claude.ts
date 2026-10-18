// Claude 사용량 수집기 (LIFE-636 E3) — Claude Code 의 OAuth 로그인을 **읽기만** 해 `/api/oauth/usage` 를 부른다(00-analysis D10 ⓐ).
//
// 자격 증명(E3ⓐ, Orca `claude-oauth-credentials.ts` 규칙): macOS 키체인 service `Claude Code-credentials`
// (`CLAUDE_CONFIG_DIR` 이면 `-<sha256(NFC(dir)) 앞 8 hex>` 접미사), account `$USER` → 없으면 `<configDir 또는 ~/.claude>/.credentials.json`.
// 토큰은 갱신하지 않는다 — 만료면 401 로 「claude 실행 시 갱신」 이 보인다(D3). `expiresAt` 은 보지 않는다(서버가 판단, Orca 와 같음).
// User-Agent 는 corral 자기 이름이다(D10 — claude-code 로 위장하지 않는다).
//
// 응답(E3ⓒ, 실측 `raw/coord/c10`): 새 `limits[]`(kind·percent·resets_at·scope.model.display_name)가 있으면 그것을 쓰고,
// 없으면 평면 `five_hour`·`seven_day`(utilization·resets_at). 둘 다 못 읽으면 `error(parse)` — 숫자를 지어내지 않는다.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { isRecord, readArray, readRecord, safeParse } from '../../shared/json.js'
import { windowLabel, type UsageWindow } from '../../shared/usage.js'
import { PARSE_ERROR, failure, getJson, percentOf, readJsonFile, stringField, timeOf, type CollectorDeps, type FetchOutcome, type UsageCollector } from './collector.js'

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const SESSION_MINUTES = 5 * 60
const WEEK_MINUTES = 7 * 24 * 60

/** 키체인 service — `CLAUDE_CONFIG_DIR` 가 있으면 경로 해시 접미사(Orca `claude-accounts/keychain.ts:39-47`). */
export function claudeKeychainService(configDir: string | null): string {
  if (configDir === null) return KEYCHAIN_SERVICE
  const digest = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)
  return `${KEYCHAIN_SERVICE}-${digest}`
}

/** 키체인 account — `$USER`. 허용 문자 밖이면 Claude Code 기본값(Orca `:24-37`). */
export function claudeKeychainAccount(user: string | undefined): string {
  return user !== undefined && /^[A-Za-z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}

function tokenOf(value: unknown): string | null {
  return stringField({ record: isRecord(value) ? value.claudeAiOauth : null, key: 'accessToken' })
}

type TokenRead = { kind: 'token'; token: string } | { kind: 'none' } | { kind: 'error' }

async function readClaudeToken(deps: CollectorDeps): Promise<TokenRead> {
  const fromEnv = deps.env.CLAUDE_CONFIG_DIR
  const configDir = fromEnv !== undefined && fromEnv !== '' ? fromEnv : null
  if (deps.platform === 'darwin') {
    const read = await deps.readKeychain({ service: claudeKeychainService(configDir), account: claudeKeychainAccount(deps.env.USER) })
    switch (read.kind) {
      case 'error':
        return { kind: 'error' }
      case 'found': {
        const token = tokenOf(safeParse(read.secret))
        if (token !== null) return { kind: 'token', token }
        break // 형태가 다르면 파일로 넘어간다
      }
      case 'missing':
        break
    }
  }
  const file = await readJsonFile({ deps, file: path.join(configDir ?? path.join(deps.homedir, '.claude'), '.credentials.json') })
  switch (file.kind) {
    case 'missing':
      return { kind: 'none' }
    case 'error':
      return { kind: 'error' }
    case 'found': {
      const token = tokenOf(file.value)
      return token === null ? { kind: 'none' } : { kind: 'token', token }
    }
  }
}

function limitMinutes({ kind, group }: { kind: string | null; group: string | null }): number | null {
  if (kind === 'session' || group === 'session') return SESSION_MINUTES
  if (kind === 'weekly_all' || kind === 'weekly_scoped' || group === 'weekly') return WEEK_MINUTES
  return null
}

function windowFromLimit(item: unknown): UsageWindow | null {
  if (!isRecord(item)) return null
  const usedPercent = percentOf(item.percent ?? item.utilization)
  if (usedPercent === null) return null
  const kind = stringField({ record: item, key: 'kind' })
  const minutes = limitMinutes({ kind, group: stringField({ record: item, key: 'group' }) })
  const base = minutes === null ? (kind ?? '?') : windowLabel(minutes)
  const scope = readRecord(item, 'scope')
  const model = stringField({ record: scope === null ? null : readRecord(scope, 'model'), key: 'display_name' })
  return { label: model === null ? base : `${model} ${base}`, windowMinutes: minutes, usedPercent, resetsAt: timeOf(item.resets_at) }
}

function windowFromFlat({ value, minutes }: { value: unknown; minutes: number }): UsageWindow | null {
  if (!isRecord(value)) return null
  const usedPercent = percentOf(value.utilization ?? value.used_percentage)
  if (usedPercent === null) return null
  return { label: windowLabel(minutes), windowMinutes: minutes, usedPercent, resetsAt: timeOf(value.resets_at) }
}

/** 응답 → 창 목록. 읽을 창이 하나도 없으면 null(= `error(parse)`). */
export function parseClaudeUsage(value: unknown): UsageWindow[] | null {
  if (!isRecord(value)) return null
  const fromLimits = readArray(value, 'limits').map(windowFromLimit).filter((window) => window !== null)
  if (fromLimits.length > 0) return fromLimits
  const flat = [windowFromFlat({ value: value.five_hour, minutes: SESSION_MINUTES }), windowFromFlat({ value: value.seven_day, minutes: WEEK_MINUTES })].filter((window) => window !== null)
  return flat.length > 0 ? flat : null
}

async function fetchClaude(deps: CollectorDeps): Promise<FetchOutcome> {
  const token = await readClaudeToken(deps)
  switch (token.kind) {
    case 'none':
      return { kind: 'unavailable', reason: 'Claude 로그인 정보 없음' }
    case 'error':
      return failure({ error: { kind: 'credential', message: 'Claude 자격 증명을 읽지 못함 (키체인·파일)' } })
    case 'token':
      break
  }
  const response = await getJson({ deps, url: CLAUDE_USAGE_URL, cli: 'claude', headers: { Authorization: `Bearer ${token.token}`, 'anthropic-beta': 'oauth-2025-04-20' } })
  if (response.kind === 'error') return response
  const windows = parseClaudeUsage(response.value)
  return windows === null ? failure({ error: PARSE_ERROR }) : { kind: 'ok', windows }
}

export const claudeCollector: UsageCollector = { id: 'claude', name: 'Claude', fetch: fetchClaude }
