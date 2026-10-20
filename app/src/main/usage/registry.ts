// 사용량 수집기 등록 (LIFE-636 E2ⓑ). 순서 = 상태바 칩 순서(E8ⓐ).
//
// **새 provider 를 넣을 때 고칠 곳 — 전부(r1 R1-6)**. 하나라도 빠지면 그 provider 는 조용히 꺼짐(`usageEnabled` 가 표에 없는 id 를 끔으로 본다)이라
// `registry.test.ts` 가 ①↔② id 일치를 검사한다.
//   ① 수집기 모듈 `main/usage/<id>.ts`(`collector.ts` 계약) + 아래 목록 한 줄
//   ② `shared/usage.ts` `USAGE_SETTING_ROWS` 한 줄 + `UsageSettingKey` 에 칸 이름
//   ③ `shared/terminal-settings.ts` — `Settings` 타입 칸 · `DEFAULT_SETTINGS`(기본 켬) · `readSettingField` 의 boolean case · `SETTING_KEYS`
//   ④ `renderer/src/ghostty-import.ts` `GHOSTTY_DIFF_LABELS` 라벨(타입이 강제한다)
//   ⑤ `renderer/src/components/StatusBarCard.tsx` `usagePatch` switch(타입이 강제한다)
//   ⑥ (선택) `renderer/src/components/StatusBarUsage.tsx` `ProviderMark` 아이콘 — 없으면 이름 첫 글자
import { claudeCollector } from './claude.js'
import { codexCollector } from './codex.js'
import { grokCollector } from './grok.js'
import type { UsageCollector } from './collector.js'

export const USAGE_COLLECTORS: readonly UsageCollector[] = [
  claudeCollector,
  codexCollector,
  grokCollector,
]
