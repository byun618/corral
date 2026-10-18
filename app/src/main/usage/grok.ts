// Grok 사용량 수집기 (LIFE-636 E5) — `<$GROK_HOME 또는 ~/.grok>/auth.json` 을 **읽기만** 해 주간 크레딧 사용률을 부른다.
//
// auth.json = issuer 키 → 항목(`key` 액세스 토큰·`user_id`·`expires_at` …). issuer `https://auth.x.ai`(`::<client>` 포함)를 우선한다(Orca `grok-auth.ts`).
// 액세스 토큰 수명이 약 2시간이라(R6) 만료는 흔하다 — `expires_at` 이 지났으면 **요청하지 않고** 만료 상태다. 갱신(`grok login`)은 하지 않는다(D3).
// 응답(실측 `raw/coord/c12`): `config.creditUsagePercent` = 주간 사용률, 창 = `currentPeriod` start~end, 초기화 = end.
// percent 가 없으면 `error(parse)` 다 — Orca 는 0% 로 떨어지지만 그건 지어낸 숫자다(useMemoryLabel 원칙 — E5ⓒ 선택 사유).
import path from 'node:path'
import { isRecord, readRecord } from '../../shared/json.js'
import { windowLabel, type UsageWindow } from '../../shared/usage.js'
import { PARSE_ERROR, failure, getJson, percentOf, readJsonFile, stringField, timeOf, type CollectorDeps, type FetchOutcome, type UsageCollector } from './collector.js'

export const GROK_USAGE_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const XAI_ISSUER = 'https://auth.x.ai'

type GrokEntry = { token: string; userId: string | null; expiresAt: number | null; preferred: boolean }

/** auth.json → 쓸 항목 하나. 우선 issuer → 만료 안 된 것 먼저. 항목이 없으면 null. */
export function pickGrokEntry({ value, now }: { value: unknown; now: number }): GrokEntry | null {
  if (!isRecord(value)) return null
  const entries: GrokEntry[] = []
  for (const [issuer, entry] of Object.entries(value)) {
    const token = stringField({ record: entry, key: 'key' })
    if (token === null) continue
    entries.push({
      token,
      userId: stringField({ record: entry, key: 'user_id' }),
      expiresAt: isRecord(entry) ? timeOf(entry.expires_at) : null,
      preferred: issuer === XAI_ISSUER || issuer.startsWith(`${XAI_ISSUER}::`),
    })
  }
  const fresh = (entry: GrokEntry): boolean => entry.expiresAt === null || entry.expiresAt > now
  const rank = (entry: GrokEntry): number => (entry.preferred ? 2 : 0) + (fresh(entry) ? 1 : 0)
  let best: GrokEntry | null = null
  for (const entry of entries) if (best === null || rank(entry) > rank(best)) best = entry
  return best
}

/** 응답 → 창 하나. percent 가 없으면 null(= `error(parse)`). */
export function parseGrokUsage(value: unknown): UsageWindow[] | null {
  if (!isRecord(value)) return null
  const config = readRecord(value, 'config') ?? value
  const usedPercent = percentOf(config.creditUsagePercent)
  if (usedPercent === null) return null
  const period = readRecord(config, 'currentPeriod')
  const start = period === null ? null : timeOf(period.start)
  const end = period === null ? null : timeOf(period.end)
  const minutes = start !== null && end !== null && end > start ? Math.round((end - start) / 60_000) : null
  return [{ label: minutes === null ? 'credits' : windowLabel(minutes), windowMinutes: minutes, usedPercent, resetsAt: end }]
}

async function fetchGrok(deps: CollectorDeps): Promise<FetchOutcome> {
  const home = deps.env.GROK_HOME
  const file = path.join(home !== undefined && home !== '' ? home : path.join(deps.homedir, '.grok'), 'auth.json')
  const auth = await readJsonFile({ deps, file })
  switch (auth.kind) {
    case 'missing':
      return { kind: 'unavailable', reason: 'Grok 로그인 정보 없음' }
    case 'error':
      return failure({ error: { kind: 'credential', message: 'Grok auth.json 을 읽지 못함' } })
    case 'found':
      break
  }
  const entry = pickGrokEntry({ value: auth.value, now: deps.now() })
  if (entry === null) return { kind: 'unavailable', reason: 'Grok 로그인 정보 없음' }
  if (entry.expiresAt !== null && entry.expiresAt <= deps.now()) {
    return failure({ error: { kind: 'expired', message: '로그인 만료 — grok 실행 시 갱신' } })
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${entry.token}`, 'X-XAI-Token-Auth': 'xai-grok-cli' }
  if (entry.userId !== null) headers['x-userid'] = entry.userId
  const response = await getJson({ deps, url: GROK_USAGE_URL, cli: 'grok', headers })
  if (response.kind === 'error') return response
  const windows = parseGrokUsage(response.value)
  return windows === null ? failure({ error: PARSE_ERROR }) : { kind: 'ok', windows }
}

export const grokCollector: UsageCollector = { id: 'grok', name: 'Grok', fetch: fetchGrok }
