#!/usr/bin/env node
// LIFE-600 빠른 층 「핵심 진입점 1회」(C8) — 격리 개발 앱에서 설정 › 작업 연결 한 바퀴. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l600/q-entry.mjs <ROOT=/tmp/l600q-*> <OUT 파일>
//
// 흐름: 모의 LA MCP 서버 기동 → 앱 기동 → 설정 › 작업 연결 → 형식 틀린 토큰 거절(서버 요청 0) → 가짜 토큰 추가(테스트 통과 뒤 저장)
//       → 파일에 암호문만 · 끝 4자 → 스페이스 하나 끄기 → 재시작 → 유지 확인(자격은 화면이 열릴 때 풀림) → 해제 → 파일 비움 → 정리.
// 화면은 제어 소켓의 DOM 합성(click·eval)으로만 움직인다 — OS 입력 없음. 실제 LA·사용자 키체인 무접촉(계측 cipher, up.sh).
// 토큰은 테스트 가짜(`life_pat_fixture…`)뿐이다. 종료 코드: 0 판정 전부 통과 · 1 하나라도 미달 · 2 사용법.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l600q-') || OUT === undefined) {
  console.error('사용법: node scripts/l600/q-entry.mjs /tmp/l600q-<n> <OUT 파일>')
  process.exit(2)
}
const TOKEN = 'life_pat_fixture000000000000000000000000000000000000'
const log = recorder(path.resolve(OUT))
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push({ item, pass })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, detail ?? '')
}
const sh = (args) => {
  const run = spawnSync('sh', args, { cwd: APP, encoding: 'utf8' })
  log(`$ sh ${args.join(' ')} → exit ${run.status}`)
  log((run.stdout + run.stderr).trim().replaceAll(process.env.HOME ?? '~', '~'))
  if (run.status !== 0) throw new Error(`${args[0]} 실패`)
}
const js = (code) => evalJs(ROOT, code)
const click = async (selector) => {
  let last = null
  await until(async () => { last = await ctl(ROOT, { cmd: 'click', selector }); return last.ok }, { timeoutMs: 15_000, everyMs: 250, label: selector }).catch(() => null)
  if (!last?.ok) throw new Error(`클릭 실패 ${selector} ${JSON.stringify(last)}`)
}
const storeFile = path.join(ROOT, 'ud/work-connections.json')
const readStore = () => { try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')) } catch { return null } }
const fixtureRequests = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'fixture.url.requests.json'), 'utf8')) } catch { return null } }

async function openConnections() {
  const open = await js(`!!document.querySelector('[data-settings-nav-item="connections"]')`)
  if (!open) {
    await until(() => js(`!!document.querySelector('[data-settings-open]')`), { timeoutMs: 30_000, label: '렌더러 준비' })
    await click('[data-settings-open]')
    await until(() => js(`!!document.querySelector('[data-settings-nav-item="connections"]')`), { label: '설정 화면' })
  }
  await click('[data-settings-nav-item="connections"]')
  await until(() => js(`!!document.querySelector('[data-settings-section="connections"]')`), { label: '작업 연결 절' })
}

/** React 제어 입력에 값 넣기 — 네이티브 setter + input 이벤트(합성 입력, OS 입력 아님). */
const typeToken = (value) => js(`(() => {
  const input = document.querySelector('[data-connection-token]')
  if (!input) return false
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-600 q-entry ${new Date().toISOString()} ROOT=${ROOT}`)
const fixture = spawn(process.execPath, ['--import', 'tsx', 'scripts/l600/fixture-server.mts', path.join(ROOT, 'fixture.url')], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] })
fs.writeFileSync(path.join(ROOT, 'fixture.pid'), String(fixture.pid))
log(`fixture_pid=${fixture.pid}`)
let exitCode = 1
try {
  await until(() => fs.existsSync(path.join(ROOT, 'fixture.url')), { label: '모의 서버' })
  sh(['scripts/l600/up.sh', ROOT])
  await openConnections()
  const selectors = await js(`({
    nav: !!document.querySelector('[data-settings-nav="connections"]'),
    addLa: !!document.querySelector('[data-connection-add="la"]'),
    addJira: !!document.querySelector('[data-connection-add="jira"]'),
    repo: document.querySelectorAll('[data-repo-default-space]').length,
  })`)
  log('selectors', selectors)
  judge('E 진입 — data-settings-nav=connections · data-connection-add=la 있음 · jira 숨김(T6)', selectors.nav && selectors.addLa && !selectors.addJira, JSON.stringify(selectors))

  // 형식 틀린 토큰 — 보내기 전에 거절(저장 버튼 꺼짐 + 사유).
  await click('[data-connection-add="la"]')
  await until(() => js(`!!document.querySelector('[data-connection-form="la"]')`), { label: '폼' })
  await typeToken('garbage-token')
  await sleep(150)
  const rejected = await js(`({ error: document.querySelector('[data-connection-form-error="prefix"]')?.textContent ?? null, disabled: document.querySelector('[data-connection-save]')?.disabled ?? null })`)
  log('prefix', rejected)
  judge('형식 틀린 토큰 — 저장 버튼 꺼짐 + life_pat_ 사유', rejected.disabled === true && String(rejected.error).includes('life_pat_'), JSON.stringify(rejected))

  await typeToken(TOKEN)
  await sleep(150)
  await click('[data-connection-save]')
  const ok = await until(() => js(`document.querySelector('[data-connection-card] [data-connection-status]')?.getAttribute('data-connection-status') === 'ok'`), { timeoutMs: 20_000, label: '연결됨' }).then(() => true).catch(() => false)
  const card = await js(`({ text: document.querySelector('[data-connection-card]')?.textContent ?? null, spaces: [...document.querySelectorAll('[data-space-row]')].map((row) => row.getAttribute('data-space-row')) })`)
  log('card', card)
  judge('연결 테스트 통과 뒤 카드 — 상태 ok · 끝 4자 · 스페이스 3(열린 프로젝트 2 + 미분류)', ok && String(card.text).includes(`••••${TOKEN.slice(-4)}`) && card.spaces.length === 3, JSON.stringify(card))
  const stored = readStore()
  const raw = fs.readFileSync(storeFile, 'utf8')
  log('store', { connections: stored?.connections?.length, tokenTail: stored?.connections?.[0]?.tokenTail, sealedLength: stored?.connections?.[0]?.sealed?.length, plaintextInFile: raw.includes(TOKEN), mode: (fs.statSync(storeFile).mode & 0o777).toString(8) })
  judge('저장 — 연결 1 · 암호문만(평문 0) · 0600', stored?.connections?.length === 1 && !raw.includes(TOKEN) && (fs.statSync(storeFile).mode & 0o777) === 0o600)

  // 스페이스 하나 끄기 → 파일에 숨김.
  const hideKey = card.spaces[1]
  await click(`[data-space-row="${hideKey}"] [data-settings-switch]`)
  await until(() => readStore()?.connections?.[0]?.hiddenSpaceKeys?.includes(hideKey), { label: '숨김 저장' }).catch(() => null)
  judge('스페이스 끄기 저장', readStore()?.connections?.[0]?.hiddenSpaceKeys?.includes(hideKey) === true, JSON.stringify(readStore()?.connections?.[0]?.hiddenSpaceKeys))
  log('shot', await ctl(ROOT, { cmd: 'shot', name: 'q-connections-ok', selector: '[data-settings-section="connections"]' }).catch((error) => String(error)))

  // 재시작 — 기동은 금고를 건드리지 않고, 화면이 열릴 때 풀려 다시 ok.
  sh(['scripts/l600/down.sh', ROOT])
  sh(['scripts/l600/up.sh', ROOT])
  await openConnections()
  const restarted = await until(() => js(`document.querySelector('[data-connection-card] [data-connection-status]')?.getAttribute('data-connection-status') === 'ok'`), { timeoutMs: 20_000, label: '재시작 뒤 연결됨' }).then(() => true).catch(() => false)
  const hiddenAfter = await js(`document.querySelector('[data-space-row="${hideKey}"] [data-settings-switch]')?.getAttribute('aria-checked')`)
  judge('재시작 뒤 유지 — 연결 ok · 숨긴 스페이스 꺼짐', restarted && hiddenAfter === 'false', JSON.stringify({ restarted, hiddenAfter }))
  // 제어 채널은 받은 명령을 `control.cmd` 로 남긴다 — 이 드라이버가 eval 로 넣은 가짜 토큰이 거기 실린다(하네스 자신의 기록).
  // 그래서 제품 로그 판정은 `control.cmd` 줄을 빼고 센다. 네이티브 관문(C7)은 제어 채널 없이 사람이 붙여넣으므로 이 줄 자체가 없다.
  const logLines = fs.readFileSync(path.join(ROOT, 'ud/corral.ndjson'), 'utf8').split('\n')
  const harnessLines = logLines.filter((line) => line.includes('"tag":"control.cmd"'))
  const productLines = logLines.filter((line) => !line.includes('"tag":"control.cmd"'))
  log('log_lines', { product: productLines.length, harness: harnessLines.length, harnessWithToken: harnessLines.filter((line) => line.includes(TOKEN)).length, productWithToken: productLines.filter((line) => line.includes(TOKEN)).length })
  judge('기동 로그 — 계측 cipher(키체인 무접촉) · 제품 로그(control.cmd 제외) 토큰 원문 0', productLines.some((line) => line.includes('"tag":"work.test_cipher"')) && productLines.every((line) => !line.includes(TOKEN)))

  // 해제 — 확인 뒤 파일 비움.
  await click('[data-connection-remove]')
  await until(() => js(`!!document.querySelector('[data-connection-remove-ok]')`), { label: '해제 확인' })
  await click('[data-connection-remove-ok]')
  await until(() => js(`document.querySelectorAll('[data-connection-card]').length === 0`), { label: '카드 사라짐' }).catch(() => null)
  const afterRemove = readStore()
  judge('해제 — 카드 0 · 파일 연결 0', (await js(`document.querySelectorAll('[data-connection-card]').length`)) === 0 && afterRemove?.connections?.length === 0, JSON.stringify(afterRemove))
  const trace = fs.readFileSync(path.join(ROOT, 'ipc-trace.ndjson'), 'utf8')
  judge('IPC 응답 기록 — 토큰 원문 0', trace.length > 0 && !trace.includes(TOKEN), `${trace.split('\n').length - 1} 줄`)
  exitCode = verdicts.every((verdict) => verdict.pass) ? 0 : 1
} catch (error) {
  log('오류', String(error))
  exitCode = 1
} finally {
  try { sh(['scripts/l600/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  fixture.kill('SIGTERM')
  await sleep(500)
  const requests = fixtureRequests()
  if (requests !== null) {
    const nonPat = requests.filter((request) => request.bearer !== 'life_pat').length
    log('fixture_requests', { total: requests.length, nonLifePatBearer: nonPat, tools: [...new Set(requests.map((request) => request.tool).filter(Boolean))] })
    verdicts.push({ item: '서버가 받은 요청 중 형식 틀린 토큰 0', pass: nonPat === 0 })
    log(`[판정] 서버가 받은 요청 중 형식 틀린 토큰 0 ${nonPat === 0 ? '통과' : '미달'}`)
    if (nonPat !== 0) exitCode = 1
  }
  log(`# 결과 ${verdicts.filter((verdict) => verdict.pass).length}/${verdicts.length} exit=${exitCode}`)
  process.exit(exitCode)
}
