#!/usr/bin/env node
// LIFE-605 C12 — 빌드한 main 번들의 Jira fixture 게이트가 **동작으로** 닫혀 있는가(R1-V: 전에는 로그 표지 글의 존재만 봤다).
//   node scripts/l605/check-main-registry.mjs [--bundle <파일>]   (app/ 에서, `npm run build` 뒤 — 기본 out/main/index.js)
// 1) 번들에서 `function jiraFixtureBaseFromEnv(env) { … }` 를 꺼내 그대로 돌린다 — 제어 소켓 없음·https·다른 호스트는 null, 소켓 + 127.0.0.1 만 주소.
// 2) 레지스트리에 Jira 출처가 그 게이트 값으로만 실린다 — `jiraSourceEntry(` 호출이 정확히 하나이고 `jiraFixture === null ? {} : { baseUrlOf: () => jiraFixture }` 모양.
// 하나라도 어긋나면 exit 1, 함수를 못 찾으면 exit 2. 양성 대조: 게이트를 일부러 연 사본(--bundle)이면 exit 1.
import fs from 'node:fs'
import path from 'node:path'

const app = path.resolve(import.meta.dirname, '../..')
const bundleAt = process.argv.indexOf('--bundle')
const bundle = bundleAt === -1 ? path.join(app, 'out/main/index.js') : path.resolve(process.argv[bundleAt + 1] ?? '')
const body = fs.readFileSync(bundle, 'utf8')

const start = body.indexOf('function jiraFixtureBaseFromEnv(env) {')
const end = start === -1 ? -1 : body.indexOf('\n}', start)
if (start === -1 || end === -1) {
  console.log(JSON.stringify({ bundle: path.relative(app, bundle), found: false, exit: 2 }))
  process.exit(2)
}
const source = body.slice(start, end + 2)
const gate = new Function(`${source}\nreturn jiraFixtureBaseFromEnv`)()
const SOCKET = '/tmp/l605t/never.sock'
const cases = [
  { env: {}, want: null },
  { env: { CORRAL_JIRA_FIXTURE_URL: 'http://127.0.0.1:4100' }, want: null },
  { env: { CORRAL_CONTROL_SOCKET: SOCKET, CORRAL_JIRA_FIXTURE_URL: 'https://127.0.0.1:4100' }, want: null },
  { env: { CORRAL_CONTROL_SOCKET: SOCKET, CORRAL_JIRA_FIXTURE_URL: 'http://evil.example:4100' }, want: null },
  { env: { CORRAL_CONTROL_SOCKET: SOCKET, CORRAL_JIRA_FIXTURE_URL: 'http://127.0.0.1:4100/x' }, want: null },
  { env: { CORRAL_CONTROL_SOCKET: SOCKET, CORRAL_JIRA_FIXTURE_URL: 'http://127.0.0.1:4100' }, want: 'http://127.0.0.1:4100' },
]
const results = cases.map(({ env, want }) => {
  const got = gate(env)
  return { env: Object.keys(env).map((key) => `${key}=${key === 'CORRAL_CONTROL_SOCKET' ? '<sock>' : env[key]}`).join(' ') || '(없음)', want, got, ok: got === want }
})
const calls = body.split('jiraSourceEntry(').length - 1 - (body.includes('function jiraSourceEntry(') ? 1 : 0)
const wired = /jiraSourceEntry\(\s*jiraFixture === null \? \{\} : \{ baseUrlOf: \(\) => jiraFixture \}\s*\)/.test(body)
const gated = /const jiraFixture = jiraFixtureBaseFromEnv\(process\.env\)/.test(body)
const ok = results.every((result) => result.ok) && calls === 1 && wired && gated
console.log(JSON.stringify({ bundle: path.relative(app, bundle), found: true, results, registry: { calls, wired, gated }, exit: ok ? 0 : 1 }, null, 1))
process.exit(ok ? 0 : 1)
