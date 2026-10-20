// LIFE-600 최종 관문 C3 양성 대조 — LA 응답이 main 에서 형태 검증을 못 넘으면 분류된 오류가 된다. app/ 에서:
//   node --import tsx scripts/l600/final-c3.mts
// 모의 LA MCP 서버(실제 LA 무접촉) + 실제 LA source + WorkService. 세 가지를 각각 깨고 같은 요청(getItem)을 보낸다:
//   필드 누락(statusLabel 칸 삭제) · 타입 어긋남(statusId 를 숫자로) · 도구 결과 isError.
// 각 줄에 분류값을 낸다. 종료 코드: 0 = 세 건 모두 기대 분류 · 1 = 하나라도 성공 값이거나 다른 분류.
import { FIXTURE_IDS, type FixtureCorrupt } from '../../src/main/work/la-mcp-fixture.js'
import { FAKE_LA_TOKEN, laFixtureHarness } from '../../src/main/work/test-kit.js'

const cases: { name: string; corrupt: FixtureCorrupt; expect: string }[] = [
  { name: '필드 누락 (statusLabel 칸 삭제)', corrupt: 'drop-statusLabel', expect: 'invalid_response' },
  { name: '타입 어긋남 (statusId = 12345)', corrupt: 'issue-statusId', expect: 'invalid_response' },
  { name: '도구 결과 isError (code INTERNAL)', corrupt: 'tool-error', expect: 'rejected' },
]
const h = await laFixtureHarness()
let failed = 0
try {
  const added = await h.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(`연결 실패 ${added.error.kind}`)
  const clean = await h.service.request({ requestId: 'clean', connectionId: added.connection.id, call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } })
  console.log(JSON.stringify({ case: '깨기 없음(대조)', ok: clean.ok }))
  if (!clean.ok) failed += 1
  for (const entry of cases) {
    h.fixture.corrupt = entry.corrupt
    const response = await h.service.request({ requestId: entry.corrupt, connectionId: added.connection.id, call: { op: 'getItem', itemId: FIXTURE_IDS.task600 } })
    const kind = response.ok ? null : response.error.kind
    const pass = kind === entry.expect
    if (!pass) failed += 1
    console.log(JSON.stringify({ case: entry.name, corrupt: entry.corrupt, ok: response.ok, kind, message: response.ok ? null : response.error.message, expect: entry.expect, pass }))
  }
} finally {
  await h.fixture.stop()
}
console.log(`# C3 결과 ${cases.length + 1 - failed}/${cases.length + 1}`)
process.exit(failed === 0 ? 0 : 1)
