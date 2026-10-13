// LIFE-600 — 모의 LA MCP 서버를 따로 띄운다(격리 앱 실행이 `CORRAL_LA_MCP_URL` 로 붙는다). app/ 에서:
//   node --import tsx scripts/l600/fixture-server.mts <URL 파일>
// 토큰은 테스트와 같은 가짜(`life_pat_fixture…` 쓰기 · `life_pat_fixtureread…` 읽기 전용)뿐이다. SIGTERM 에 닫는다.
// 제어: 같은 폴더의 `<URL 파일>.fault` 에 JSON(`{"kind":"http","status":500,"body":"{}"}` · `{"kind":"drop"}` · `null`)을 쓰면 다음 요청부터 그대로 낸다.
import fs from 'node:fs'
import { LaMcpFixture, type FixtureFault } from '../../src/main/work/la-mcp-fixture.js'
import { FAKE_LA_READ_TOKEN, FAKE_LA_TOKEN } from '../../src/main/work/test-kit.js'

const urlFile = process.argv[2]
if (urlFile === undefined || !urlFile.startsWith('/tmp/l600')) {
  console.error('사용법: node --import tsx scripts/l600/fixture-server.mts /tmp/l600…/fixture.url')
  process.exit(2)
}
const fixture = new LaMcpFixture()
fixture.tokens.set(FAKE_LA_TOKEN, 'write')
fixture.tokens.set(FAKE_LA_READ_TOKEN, 'read')
const url = await fixture.start()
fs.writeFileSync(urlFile, url)
const faultFile = `${urlFile}.fault`
const readFault = (): FixtureFault | null => {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(faultFile, 'utf8'))
    if (typeof value !== 'object' || value === null || !('kind' in value)) return null
    if (value.kind === 'drop') return { kind: 'drop' }
    if (value.kind === 'http' && 'status' in value && typeof value.status === 'number') return { kind: 'http', status: value.status, body: 'body' in value && typeof value.body === 'string' ? value.body : '{}' }
    return null
  } catch {
    return null
  }
}
const timer = setInterval(() => { fixture.fault = readFault() }, 100)
console.log(`fixture ${url} pid=${process.pid}`)
const stop = async (): Promise<void> => {
  clearInterval(timer)
  await fixture.stop()
  fs.writeFileSync(`${urlFile}.requests.json`, JSON.stringify(fixture.requests, null, 1))
  process.exit(0)
}
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
