// C2 — LA 출처가 계약 묶음을 통과한다(모의 LA MCP HTTP 서버 상대). 양성 대조: `L600_BREAK=la-field` 면 서버 응답 한 칸을 깨 묶음이 실패해야 한다.
import { workContractSuite } from './contract-suite.js'
import { FIXTURE_VISIBLE_ITEMS } from './la-mcp-fixture.js'
import { FAKE_LA_TOKEN, laFixtureHarness } from './test-kit.js'

workContractSuite({
  name: 'LA (모의 MCP 서버)',
  setup: async () => {
    const harness = await laFixtureHarness()
    const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(`연결 실패: ${added.error.kind} ${added.error.message}`)
    if (process.env.L600_BREAK === 'la-field') harness.fixture.corrupt = 'drop-statusLabel'
    return { service: harness.service, connectionId: added.connection.id, close: () => harness.fixture.stop(), visibleItems: FIXTURE_VISIBLE_ITEMS }
  },
})
