// herdr 통합 훅 설치 상태 (LIFE-366 A1) — **읽기 전용**.
//
// 통합 훅이 하는 일은 하나다: 에이전트가 뜰 때 자기 세션 id 를 herdr 소켓에 보고한다.
// 그게 없으면 pane 에 `agent_session` 이 영영 안 붙고, 그러면 세션 행 2차 줄도 못 채운다
// (`00-analysis.md` §2.2). 그래서 corral 은 이 상태를 읽어 화면에 올린다 — **설치는 하지
// 않는다.** `integration.install` 은 사용자 HOME 의 에이전트 설정 파일을 고치는 조작이라
// corral 이 말없이 부를 일이 아니고, 화이트리스트(`request.ts`)에도 넣지 않았다.

import { isRecord, readString } from '../../../shared/json.js'
import type { IntegrationRow, TranscriptAgent } from '../../../shared/types.js'
import { log } from '../../log.js'
import { request } from './request.js'

/** corral 이 세션 지문을 읽을 줄 아는 에이전트 셋. herdr 는 17종을 알지만 우리 관심은 이 셋이다. */
const WANTED: readonly TranscriptAgent[] = ['claude', 'codex', 'grok']

export type IntegrationScan = { rows: IntegrationRow[]; error: string | null }

/**
 * herdr 와이어 `IntegrationState` 를 corral 값으로 옮긴다.
 * 모르는 값은 **버린다** — 지어낸 상태를 화면에 올리지 않는다.
 */
function readState(value: string | null): IntegrationRow['state'] | null {
  if (value === 'not_installed') return 'not-installed'
  if (value === 'current') return 'current'
  if (value === 'outdated') return 'outdated'
  return null
}

/**
 * 통합 3종의 상태를 읽는다. 실패하면 빈 목록 + 사유 — 화면은 "미설치" 와 "아직 모름" 을
 * 구분해야 하므로 실패를 미설치로 바꾸지 않는다.
 */
export async function readIntegrations(socketPath: string): Promise<IntegrationScan> {
  try {
    const frame = await request(socketPath, 'integration.list', {}, { reason: 'integrations' })
    if (frame.error) {
      return { rows: [], error: `${frame.error.code}: ${frame.error.message}` }
    }
    const result = frame.result
    const list = isRecord(result) ? result['integrations'] : null
    if (!Array.isArray(list)) return { rows: [], error: 'integration.list 응답 모양이 예상과 다르다' }
    const byAgent = new Map<TranscriptAgent, IntegrationRow['state']>()
    for (const item of list) {
      if (!isRecord(item)) continue
      const target = readString(item, 'target')
      const state = readState(readString(item, 'state'))
      if (state === null) continue
      const wanted = WANTED.find((agent) => agent === target)
      if (wanted === undefined) continue
      byAgent.set(wanted, state)
    }
    const rows: IntegrationRow[] = []
    for (const agent of WANTED) {
      const state = byAgent.get(agent)
      if (state === undefined) continue
      rows.push({ agent, state })
    }
    log('integrations.read', { rows })
    return { rows, error: null }
  } catch (error) {
    return { rows: [], error: String(error) }
  }
}
