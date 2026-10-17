// C2 — 모의 Jira 형 출처가 같은 계약 묶음을 통과한다. 양성 대조: `L600_BREAK=mock-transition` 이면 상태 변경을 무시하는 결함을 넣어 묶음이 실패해야 한다.
import { workContractSuite } from './contract-suite.js'
import { mockSourceEntry, seedMockState } from './mock-source.js'
import { FAKE_MOCK_TOKEN, workHarness } from './test-kit.js'

workContractSuite({
  name: '모의 Jira 형',
  setup: async () => {
    const state = seedMockState()
    const harness = workHarness({ entries: [mockSourceEntry({ state, defect: process.env.L600_BREAK === 'mock-transition' ? 'transition-ignored' : 'none' })] })
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token: FAKE_MOCK_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(`연결 실패: ${added.error.kind} ${added.error.message}`)
    return {
      service: harness.service, connectionId: added.connection.id, close: async () => {}, visibleItems: ['m-1', 'm-2', 'm-3', 'm-4', 'm-5'], retiredSpaceKeys: [], missingKey: 'CORE-999', crossSpace: { itemId: 'm-1', otherKey: 'WEB-1', otherSpaceKey: 'WEB' },
      externalBody: ({ itemId, body }) => { const item = state.items.find((entry) => entry.id === itemId); if (item !== undefined) item.body = body },
    }
  },
})
