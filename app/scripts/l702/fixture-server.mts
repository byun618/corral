// LIFE-702 최종 관문 — 오래된 완료 씨앗을 심은 모의 LA MCP 서버(l600/fixture-server.mts 를 줄여 옮김). app/ 에서:
//   node --import tsx scripts/l702/fixture-server.mts /tmp/l702g-<n>/fixture.url
// 제품 코드는 바꾸지 않는다 — `LaMcpFixture` 의 공개 칸(`issues` · `doneClock`)에 씨앗만 더한다(리뷰 r3 R3-4: 모의 씨앗은 전부 doneAt null 이라 심는 수단이 필요).
// 씨앗(스페이스 corral = FIXTURE_IDS.corral, 시각은 서버 기동 시점 기준):
//   LIFE-901 「L702 오래된 완료 스무날」 done · doneAt 20일 전 · position 51
//   LIFE-902 「L702 최근 완료 열사흘」   done · doneAt 13일 전 · position 50
//   LIFE-903 「L702 완료 시각 없음」     done · doneAt null   · position 52
//   LIFE-904 「L702 열린 백로그」        todo · onBoard false · position 53
//   LIFE-905 「L702 끌어 완료로」        todo · onBoard true  · position 54 (ⓕ 완료로 끌기 대상)
// 기존 씨앗 열린 일감(LIFE-600 개발 중 · LIFE-601 등)은 그대로. done 진입 시각 = `doneClock` 기본(실제 지금, fix r1 F2).
// 상태 기록: 300ms 마다 `<URL 파일>.state.json` 에 { at, issues(id·seq·title·statusId·doneAt·position·onBoard), writeArgs, toolNames } 를 쓴다. SIGTERM 에 닫는다.
import fs from 'node:fs'
import { FIXTURE_IDS, FIXTURE_STATUS, LaMcpFixture } from '../../src/main/work/la-mcp-fixture.js'
import { FAKE_LA_READ_TOKEN, FAKE_LA_TOKEN } from '../../src/main/work/test-kit.js'

const urlFile = process.argv[2]
if (urlFile === undefined || !urlFile.startsWith('/tmp/l702g-')) {
  console.error('사용법: node --import tsx scripts/l702/fixture-server.mts /tmp/l702g-<n>/fixture.url')
  process.exit(2)
}
const DAY = 86_400_000
const now = Date.now()
const fixture = new LaMcpFixture()
fixture.tokens.set(FAKE_LA_TOKEN, 'write')
fixture.tokens.set(FAKE_LA_READ_TOKEN, 'read')
const seedId = (n: number): string => `00000000-0000-4000-8000-${String(70000 + n).padStart(12, '0')}`
const seed = ({ n, title, statusId, doneAt, position, onBoard }: { n: number; title: string; statusId: string; doneAt: string | null; position: string; onBoard: boolean }): void => {
  fixture.issues.push({
    id: seedId(n), sequentialId: 900 + n, kind: 'task', parentId: FIXTURE_IDS.corral, title, description: null, priority: 'medium', statusId,
    resolution: statusId === FIXTURE_STATUS.done ? 'completed' : null, color: null, position, onBoard, dueAt: null, archivedAt: null, doneAt,
    updatedAt: '2026-10-13T00:00:00.000Z', version: 1,
  })
}
seed({ n: 1, title: 'L702 오래된 완료 스무날', statusId: FIXTURE_STATUS.done, doneAt: new Date(now - 20 * DAY).toISOString(), position: '51', onBoard: true })
seed({ n: 2, title: 'L702 최근 완료 열사흘', statusId: FIXTURE_STATUS.done, doneAt: new Date(now - 13 * DAY).toISOString(), position: '50', onBoard: true })
seed({ n: 3, title: 'L702 완료 시각 없음', statusId: FIXTURE_STATUS.done, doneAt: null, position: '52', onBoard: true })
seed({ n: 4, title: 'L702 열린 백로그', statusId: FIXTURE_STATUS.todo, doneAt: null, position: '53', onBoard: false })
seed({ n: 5, title: 'L702 끌어 완료로', statusId: FIXTURE_STATUS.todo, doneAt: null, position: '54', onBoard: true })

const url = await fixture.start()
fs.writeFileSync(urlFile, url)
const dump = (): void => {
  const state = {
    at: new Date().toISOString(),
    issues: fixture.issues.map((issue) => ({ id: issue.id, seq: issue.sequentialId, title: issue.title, statusId: issue.statusId, doneAt: issue.doneAt, position: issue.position, onBoard: issue.onBoard, archivedAt: issue.archivedAt })),
    writeArgs: fixture.writeArgs,
    toolNames: fixture.toolCalls.map((call) => call.tool),
  }
  fs.writeFileSync(`${urlFile}.state.json`, JSON.stringify(state, null, 1))
}
dump()
const timer = setInterval(dump, 300)
console.log(`fixture ${url} pid=${process.pid}`)
const stop = async (): Promise<void> => {
  clearInterval(timer)
  dump()
  await fixture.stop()
  process.exit(0)
}
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
