// LIFE-636 r1 R1-6 — 등록 접점: 제품 수집기 목록과 설정 표의 id 가 정확히 같아야 한다.
// 표에 없는 수집기는 `usageEnabled` 가 끔으로 봐 조용히 영원히 `disabled` 가 된다 — 그 상태를 시험이 막는다.
import { expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/terminal-settings.js'
import { USAGE_SETTING_ROWS, usageEnabled } from '../../shared/usage.js'
import { USAGE_COLLECTORS } from './registry.js'

it('USAGE_COLLECTORS ↔ USAGE_SETTING_ROWS — id·이름·순서가 같다', () => {
  expect(USAGE_COLLECTORS.map((collector) => [collector.id, collector.name])).toEqual(USAGE_SETTING_ROWS.map((row) => [row.id, row.name]))
})

it('기본 설정이면 등록된 수집기는 전부 켜짐(표에 없어 조용히 꺼지는 수집기 0)', () => {
  expect(USAGE_COLLECTORS.filter((collector) => !usageEnabled({ settings: DEFAULT_SETTINGS, id: collector.id })).map((collector) => collector.id)).toEqual([])
})
