// LIFE-605 C3 — Jira Cloud 출처가 같은 계약 묶음을 통과한다(공식 명세 모양 REST fixture 상대 — `jira-rest-fixture.ts`).
// 양성 대조: `L605_BREAK=<갈래>` 면 fixture 응답 모양 하나를 깨 묶음이 실패해야 한다(issue-no-status · transition-no-to · unknown-category · rank-207 · project-no-key · search-issues-object).
import { workContractSuite } from './contract-suite.js'
import { JIRA_FIXTURE_IDS, JIRA_FIXTURE_RETIRED, JIRA_FIXTURE_VISIBLE, type JiraCorrupt } from './jira-rest-fixture.js'
import { FAKE_JIRA_TOKEN, JIRA_ACCOUNT, jiraFixtureHarness } from './test-kit.js'

const BREAKS: JiraCorrupt[] = ['issue-no-status', 'transition-no-to', 'unknown-category', 'rank-207', 'project-no-key', 'search-issues-object']

workContractSuite({
  name: 'Jira Cloud (REST fixture)',
  setup: async () => {
    const harness = await jiraFixtureHarness()
    const added = await harness.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: null })
    if (!added.ok) throw new Error(`연결 실패: ${added.error.kind} ${added.error.message}`)
    const broken = BREAKS.find((entry) => entry === process.env.L605_BREAK)
    if (broken !== undefined) harness.fixture.corrupt = broken
    return {
      service: harness.service,
      connectionId: added.connection.id,
      close: async () => {
        // 옛 경로를 한 번도 부르지 않았다(410 양성 대조 — 불렀으면 묶음 어딘가가 이미 깨졌다).
        if (harness.fixture.legacyCalls() !== 0) throw new Error(`옛 경로 호출 ${harness.fixture.legacyCalls()}건`)
        await harness.fixture.stop()
      },
      visibleItems: JIRA_FIXTURE_VISIBLE,
      retiredSpaceKeys: JIRA_FIXTURE_RETIRED,
      missingKey: 'CORE-999',
      crossSpace: { itemId: JIRA_FIXTURE_IDS.epic, otherKey: 'WEB-1', otherSpaceKey: 'WEB' },
      sourceRequests: () => harness.fixture.requests.length,
      bodyRoundTrip: 'canonical',
      querySearch: { query: 'summary ~ "영수증"', expectKey: 'CORE-4', badQuery: '랜딩 ==', textHitKey: 'WEB-1' },
      // Jira 빈 본문 두 모양 — description null · 빈 ADF. 둘 다 단건에서 '' 로 읽힌다(F9).
      externalBody: ({ itemId, body }) => {
        const issue = harness.fixture.issues.find((entry) => entry.id === itemId)
        if (issue === undefined) return
        issue.description = body === null ? null : { type: 'doc', version: 1, content: body === '' ? [] : [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] }
      },
    }
  },
})
