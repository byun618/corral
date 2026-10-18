// C2 — LA 출처가 계약 묶음을 통과한다(모의 LA MCP HTTP 서버 상대). 양성 대조: `L600_BREAK=la-field` 면 서버 응답 한 칸을 깨 묶음이 실패해야 한다.
import { workContractSuite } from './contract-suite.js'
import { FIXTURE_IDS, FIXTURE_RETIRED_SPACE_KEYS, FIXTURE_VISIBLE_ITEMS } from './la-mcp-fixture.js'
import { FAKE_LA_TOKEN, laFixtureHarness } from './test-kit.js'

workContractSuite({
  name: 'LA (모의 MCP 서버)',
  setup: async () => {
    // LIFE-638 — 쪽 크기 3: 커서 시험의 첫 쪽이 스페이스 전체보다 작다(여러 쪽을 이어 붙이는 길을 묶음 전체가 탄다).
    const harness = await laFixtureHarness({ pageSize: 3 })
    const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(`연결 실패: ${added.error.kind} ${added.error.message}`)
    if (process.env.L600_BREAK === 'la-field') harness.fixture.corrupt = 'drop-statusLabel'
    // LIFE-601 — 새 칸(E1 막은 쪽 키 · E2 issue_by_seq id) 어긋남 양성 대조.
    if (process.env.L601_BREAK === 'blocker-key') harness.fixture.corrupt = 'blocker-no-displayId'
    if (process.env.L601_BREAK === 'byseq-id') harness.fixture.corrupt = 'byseq-bad-id'
    if (process.env.L601_BREAK === 'byseq-kind') harness.fixture.corrupt = 'byseq-unknown-kind'
    if (process.env.L601_BREAK === 'byseq-null') harness.fixture.corrupt = 'byseq-null-kind-data'
    // LIFE-602 — 새 칸(E5 resolution) 어긋남 양성 대조.
    if (process.env.L602_BREAK === 'resolution') harness.fixture.corrupt = 'resolution-unknown'
    // LIFE-602 수정 1 — 쓰기 응답 하나(E4 issue_update)만 어긋남: 읽기 단계는 통과하고 updateItem 을 쓰는 시험만 실패해야 한다.
    if (process.env.L602_BREAK === 'update-title') harness.fixture.corrupt = 'update-bad-title'
    // LIFE-604 C4 — 만들기 칸을 무시하는 모의(T3 까지의 모양) 양성 대조: 만들기 칸 시험이 실패해야 한다.
    if (process.env.L604_BREAK === 'create-fields') harness.fixture.corrupt = 'create-ignore-fields'
    // LIFE-635 C1 — 작업 링크 행 어긋남 양성 대조: 링크를 읽는 단건 시험이 실패해야 한다.
    if (process.env.L635_BREAK === 'worklink-kind') harness.fixture.corrupt = 'worklink-unknown-kind'
    return { service: harness.service, connectionId: added.connection.id, close: () => harness.fixture.stop(), visibleItems: FIXTURE_VISIBLE_ITEMS, retiredSpaceKeys: FIXTURE_RETIRED_SPACE_KEYS, missingKey: 'LIFE-99999', crossSpace: { itemId: FIXTURE_IDS.task600, otherKey: 'LIFE-20', otherSpaceKey: FIXTURE_IDS.lifeAssistant }, sourceRequests: () => harness.fixture.requests.length,
      externalBody: ({ itemId, body }) => {
        const issue = harness.fixture.issues.find((entry) => entry.id === itemId)
        if (issue === undefined) throw new Error(`픽스처에 없음: ${itemId}`)
        const before = issue.description
        issue.description = body
        return () => { issue.description = before }
      },
      // LIFE-635 — LA 웹·폰·다른 Mac 이 남긴 링크(같은 판별 규칙으로 fixture 에 직접).
      workLinkStore: 'on',
      declared: { cursorPaging: 'on', comments: 'on', history: 'on' },
      plantWorkLink: ({ itemId, link, machine, repo }) => harness.fixture.plantWorkLink({ issueId: itemId, link, machine, repo }),
    }
  },
})
