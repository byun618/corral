// @vitest-environment happy-dom
/* global window, document */
// LIFE-636 E2ⓑ — 「끼울 수 있는 구조」: 시험 전용 가짜 provider 를 수집기 계약대로 만들어 main 서비스에 등록하면,
// 서비스 푸시 → IPC 직렬화(JSON 왕복) → 렌더러 저장소 → 상태바 칩까지 그대로 흐른다. 제품 등록(`registry.ts`)에는 싣지 않는다.
// E2ⓒ: 모르는 형태를 내는 provider 는 `error(parse)` 로 보이고 렌더러에 숫자가 없다.
// main·렌더러를 함께 띄우므로 App.settings.test.mjs 처럼 .mjs 다(두 tsconfig 어느 쪽에도 상대를 끌어들이지 않는다).
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { resetUsageStoreForTest } from './usage-store.js'
import { StatusBar } from './components/StatusBar.js'
import { PARSE_ERROR } from '../../main/usage/collector.js'
import { USAGE_COLLECTORS } from '../../main/usage/registry.js'
import { UsageService } from '../../main/usage/service.js'
import { fakeDeps } from '../../main/usage/fake-deps.test-helper.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const gemini = { id: 'gemini', name: 'Gemini', fetch: async () => ({ kind: 'ok', windows: [{ label: '1d', windowMinutes: 1440, usedPercent: 37, resetsAt: null }] }) }
const broken = { id: 'mystery', name: 'Mystery', fetch: async () => ({ kind: 'error', error: PARSE_ERROR, retryAfterMs: null }) }

afterEach(() => {
  Reflect.deleteProperty(window, 'corral')
  resetUsageStoreForTest()
  document.body.replaceChildren()
})

it('가짜 provider 둘 — 서비스 → 직렬화 → 렌더러 칩(37%) · 모르는 형태는 ⚠ 알 수 없음, 숫자 0', async () => {
  expect(USAGE_COLLECTORS.map((collector) => collector.id)).toEqual(['claude', 'codex', 'grok'])
  let listener = null
  let latest = { providers: [] }
  const svc = new UsageService({
    collectors: [gemini, broken],
    isEnabled: () => true,
    isActive: () => true,
    deps: (signal) => fakeDeps({ signal }).deps,
    // main 의 `webContents.send` 자리 — 구조화 복제처럼 JSON 왕복으로 넘긴다.
    onChange: (snapshot) => { latest = JSON.parse(JSON.stringify(snapshot)); listener?.(latest) },
    log: () => {},
  })
  Reflect.set(window, 'corral', { getUsage: async () => latest, onUsage: (next) => { listener = next; return () => { listener = null } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(StatusBar, { inert: false, memoryLabel: null })) })
  await act(async () => { svc.start(); await Promise.resolve() })
  await act(async () => { await svc.refresh(null) })
  const chips = [...host.querySelectorAll('[data-statusbar-usage-chip]')].map((el) => [el.dataset.statusbarUsageChip, el.dataset.statusbarUsageStatus, el.textContent])
  expect(chips).toEqual([['gemini', 'ok', 'G37%'], ['mystery', 'error', 'M⚠알 수 없음']])
  expect(host.querySelector('[data-statusbar-usage-chip="mystery"]').textContent).not.toMatch(/\d/)
  svc.dispose()
  act(() => root.unmount())
})
