// 사용량 수집기 등록 (LIFE-636 E2ⓑ) — provider 를 더하려면 `collector.ts` 계약을 따르는 모듈 하나를 만들고 여기 한 줄을 더한다.
// 순서 = 상태바 칩 순서(E8ⓐ). on/off 설정 칸은 `shared/usage.ts` `USAGE_SETTING_ROWS` 에 한 줄.
import { claudeCollector } from './claude.js'
import { codexCollector } from './codex.js'
import { grokCollector } from './grok.js'
import type { UsageCollector } from './collector.js'

export const USAGE_COLLECTORS: readonly UsageCollector[] = [
  claudeCollector,
  codexCollector,
  grokCollector,
]
