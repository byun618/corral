// C2 — LA 출처가 계약 묶음을 통과한다(모의 LA MCP HTTP 서버 상대). 양성 대조: `L600_BREAK=la-field` 면 서버 응답 한 칸을 깨 묶음이 실패해야 한다.
import { workContractSuite } from './contract-suite.js'
import { FIXTURE_RETIRED_SPACE_KEYS, FIXTURE_VISIBLE_ITEMS } from './la-mcp-fixture.js'
import { FAKE_LA_TOKEN, laFixtureHarness } from './test-kit.js'

workContractSuite({
  name: 'LA (모의 MCP 서버)',
  setup: async () => {
    const harness = await laFixtureHarness()
    const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(`연결 실패: ${added.error.kind} ${added.error.message}`)
    if (process.env.L600_BREAK === 'la-field') harness.fixture.corrupt = 'drop-statusLabel'
    // LIFE-601 — 새 칸(E1 막은 쪽 키 · E2 issue_by_seq id) 어긋남 양성 대조.
    if (process.env.L601_BREAK === 'blocker-key') harness.fixture.corrupt = 'blocker-no-displayId'
    if (process.env.L601_BREAK === 'byseq-id') harness.fixture.corrupt = 'byseq-bad-id'
    if (process.env.L601_BREAK === 'byseq-kind') harness.fixture.corrupt = 'byseq-unknown-kind'
    if (process.env.L601_BREAK === 'byseq-null') harness.fixture.corrupt = 'byseq-null-kind-data'
    return { service: harness.service, connectionId: added.connection.id, close: () => harness.fixture.stop(), visibleItems: FIXTURE_VISIBLE_ITEMS, retiredSpaceKeys: FIXTURE_RETIRED_SPACE_KEYS, missingKey: 'LIFE-99999' }
  },
})
