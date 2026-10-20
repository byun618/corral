// LIFE-602 최종 관문 G4 — l600/fixture-server.mts 를 옮겼다(경로만 /tmp/l602*, 가짜 쓰기 토큰을 `<URL 파일>.token` 에 써서
// 관문 스크립트가 토큰 글자를 소스·원자료에 싣지 않고 읽게 한다). app/ 에서:
//   node --import tsx scripts/l602/la-fixture.mts <URL 파일>
// 토큰은 테스트와 같은 가짜(`life_pat_fixture…` 쓰기 · `life_pat_fixtureread…` 읽기 전용)뿐이다. SIGTERM 에 닫는다.
// 제어: 같은 폴더의 `<URL 파일>.fault` 에 JSON(`{"kind":"http","status":500,"body":"{}"}` · `{"kind":"drop"}` · `{"kind":"delay","ms":4000}` · `null`)을 쓰면 다음 요청부터 그대로 낸다.
// `<URL 파일>.corrupt` 에 깨기 이름(`issue-statusId` 등, la-mcp-fixture `FixtureCorrupt`)을 쓰면 응답 한 칸을 깬다(최종 관문 C11 의 invalid_response 줄 캡처). 빈 파일·없음 = 깨기 없음.
import fs from 'node:fs'
import { LaMcpFixture, type FixtureCorrupt, type FixtureFault } from '../../src/main/work/la-mcp-fixture.js'
import { FAKE_LA_READ_TOKEN, FAKE_LA_TOKEN } from '../../src/main/work/test-kit.js'

const urlFile = process.argv[2]
if (urlFile === undefined || !urlFile.startsWith('/tmp/l602')) {
  console.error('사용법: node --import tsx scripts/l602/la-fixture.mts /tmp/l602…/fixture.url')
  process.exit(2)
}
const fixture = new LaMcpFixture()
fixture.tokens.set(FAKE_LA_TOKEN, 'write')
fixture.tokens.set(FAKE_LA_READ_TOKEN, 'read')
const url = await fixture.start()
fs.writeFileSync(urlFile, url)
fs.writeFileSync(`${urlFile}.token`, FAKE_LA_TOKEN, { mode: 0o600 })
const faultFile = `${urlFile}.fault`
const readFault = (): FixtureFault | null => {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(faultFile, 'utf8'))
    if (typeof value !== 'object' || value === null || !('kind' in value)) return null
    if (value.kind === 'drop') return { kind: 'drop' }
    if (value.kind === 'delay' && 'ms' in value && typeof value.ms === 'number') return { kind: 'delay', ms: value.ms }
    if (value.kind === 'http' && 'status' in value && typeof value.status === 'number') return { kind: 'http', status: value.status, body: 'body' in value && typeof value.body === 'string' ? value.body : '{}' }
    return null
  } catch {
    return null
  }
}
const CORRUPTS: FixtureCorrupt[] = ['issue-statusId', 'drop-statusLabel', 'tool-error']
const readCorrupt = (): FixtureCorrupt | null => {
  try {
    const name = fs.readFileSync(`${urlFile}.corrupt`, 'utf8').trim()
    return CORRUPTS.find((entry) => entry === name) ?? null
  } catch {
    return null
  }
}
const timer = setInterval(() => {
  fixture.fault = readFault()
  fixture.corrupt = readCorrupt()
}, 100)
console.log(`fixture ${url} pid=${process.pid}`)
const stop = async (): Promise<void> => {
  clearInterval(timer)
  await fixture.stop()
  fs.writeFileSync(`${urlFile}.requests.json`, JSON.stringify(fixture.requests, null, 1))
  process.exit(0)
}
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
