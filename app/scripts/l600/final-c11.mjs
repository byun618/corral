#!/usr/bin/env node
// LIFE-600 최종 관문 C11 — 설정 › 작업 연결의 오류 상태 6종 + R2-E 실패 줄 2종 캡처와 E 선택자 DOM 확인. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l600/final-c11.mjs <ROOT=/tmp/l600q-*> <OUT 로그> <캡처 폴더>
//
// 격리 개발 앱(userData·제어 소켓 = ROOT) + 모의 LA MCP 서버 + 계측 cipher — **네이티브가 아니다.** 실제 LA·사용자 키체인·설치본 무접촉.
// 상태를 만드는 법(제품 코드 무변경 — 서버 쪽 제어만):
//   ok = 가짜 토큰 연결 · testing = 서버 응답 4초 지연 중 연결 테스트 · auth = 401 · forbidden = 403 · offline = 500
//   · keychain = 앱을 내리고 저장 파일의 암호문을 0바이트(`=`)로 → 재기동 뒤 풀기가 빈 값(키체인 오류 갈래)
//   · 실패 줄 ① 누른 테스트 invalid_response = 서버 응답의 statusId 를 숫자로 · ② 레포 기본 저장 실패 = userData 폴더를 잠깐 쓰기 금지(0500)
// 화면은 제어 소켓의 DOM 합성(click·eval)으로만 움직인다. 토큰은 테스트 가짜뿐. 종료 코드: 0 전부 통과 · 1 하나라도 미달 · 2 사용법.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT, SHOTS] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l600q-') || OUT === undefined || SHOTS === undefined) {
  console.error('사용법: node scripts/l600/final-c11.mjs /tmp/l600q-<n> <OUT 로그> <캡처 폴더>')
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
const urlFile = path.join(ROOT, 'fixture.url')
const setFault = (fault) => fs.writeFileSync(`${urlFile}.fault`, JSON.stringify(fault))
const setCorrupt = (name) => fs.writeFileSync(`${urlFile}.corrupt`, name ?? '')
const storeFile = path.join(ROOT, 'ud/work-connections.json')
const pill = () => js(`document.querySelector('[data-connection-card] [data-connection-status]')?.getAttribute('data-connection-status') ?? null`)
const waitPill = (value, label) => until(async () => (await pill()) === value, { timeoutMs: 20_000, label })
fs.mkdirSync(SHOTS, { recursive: true })
const shot = async (name) => {
  const reply = await ctl(ROOT, { cmd: 'shot', name: `f-c11-${name}`, selector: '[data-settings-section="connections"]' })
  if (!reply.ok || typeof reply.file !== 'string') throw new Error(`캡처 실패 ${name} ${JSON.stringify(reply)}`)
  const target = path.join(SHOTS, `f-c11-${name}.png`)
  fs.copyFileSync(reply.file, target)
  log('shot', { name, bytes: fs.statSync(target).size })
  return target
}

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
const typeToken = (value) => js(`(() => {
  const input = document.querySelector('[data-connection-token]')
  if (!input) return false
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
/** 누른 연결 테스트로 상태를 만든다 — 서버 쪽 고장을 걸고 누른 뒤 그 상태를 기다린다. */
async function stateByTest({ fault, status }) {
  setFault(fault)
  await sleep(300)
  await click('[data-connection-test]')
  await waitPill(status, status)
}
/** 고장을 거두고 누른 테스트로 ok 로 되돌린다(R4-A — 성공한 재검증만 자격 무효를 거둔다). */
async function recover() {
  setFault(null)
  setCorrupt(null)
  await sleep(300)
  await click('[data-connection-test]')
  await waitPill('ok', '복구')
}
const seen = new Set()
const selectorsNow = () => js(`({
  nav: !!document.querySelector('[data-settings-nav="connections"]'),
  addLa: !!document.querySelector('[data-connection-add="la"]'),
  addJira: !!document.querySelector('[data-connection-add="jira"]'),
  form: !!document.querySelector('[data-connection-form]'),
  card: !!document.querySelector('[data-connection-card]'),
  status: document.querySelector('[data-connection-status]')?.getAttribute('data-connection-status') ?? null,
  error: !!document.querySelector('[data-connection-error]'),
  spaceRows: document.querySelectorAll('[data-space-row]').length,
  repoDefault: document.querySelectorAll('[data-repo-default-space]').length,
})`)

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
const repoDir = path.join(ROOT, 'repo')
fs.mkdirSync(repoDir, { recursive: true })
spawnSync('git', ['init', '-q', repoDir])
log(`# LIFE-600 final-c11 ${new Date().toISOString()} ROOT=${ROOT} — 격리 개발 앱, 네이티브 아님`)
const fixture = spawn(process.execPath, ['--import', 'tsx', 'scripts/l600/fixture-server.mts', urlFile], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] })
fs.writeFileSync(path.join(ROOT, 'fixture.pid'), String(fixture.pid))
log(`fixture_pid=${fixture.pid}`)
let exitCode = 1
const dom = {}
try {
  await until(() => fs.existsSync(urlFile), { label: '모의 서버' })
  sh(['scripts/l600/up.sh', ROOT])
  log('add-repo', await ctl(ROOT, { cmd: 'add-repo', root: repoDir }))
  await openConnections()
  dom.empty = await selectorsNow()

  // 폼 → 가짜 토큰 → ok
  await click('[data-connection-add="la"]')
  await until(() => js(`!!document.querySelector('[data-connection-form="la"]')`), { label: '폼' })
  dom.form = await selectorsNow()
  await typeToken(TOKEN)
  await sleep(150)
  await click('[data-connection-save]')
  await waitPill('ok', '연결됨')
  dom.ok = await selectorsNow()
  seen.add('ok')
  await shot('ok')

  // testing — 응답 4초 지연 중
  setFault({ kind: 'delay', ms: 4000 })
  await sleep(300)
  await click('[data-connection-test]')
  await waitPill('testing', 'testing')
  seen.add('testing')
  await shot('testing')
  await waitPill('ok', '지연 뒤 ok')
  setFault(null)

  for (const [status, fault] of [
    ['auth', { kind: 'http', status: 401, body: '{"code":"UNAUTHORIZED"}' }],
    ['forbidden', { kind: 'http', status: 403, body: '{"code":"FORBIDDEN"}' }],
    ['offline', { kind: 'http', status: 500, body: '{"code":"INTERNAL_ERROR"}' }],
  ]) {
    await stateByTest({ fault, status })
    dom[status] = await selectorsNow()
    seen.add(status)
    await shot(status)
    await recover()
  }

  // 실패 줄 ① — 누른 테스트 invalid_response(연결 상태는 ok 그대로, 카드에 로컬 오류 줄)
  setCorrupt('issue-statusId')
  await sleep(300)
  await click('[data-connection-test]')
  await until(() => js(`!!document.querySelector('[data-connection-test-error="invalid_response"]')`), { label: 'invalid 줄' })
  dom.testInvalid = { pill: await pill(), line: await js(`document.querySelector('[data-connection-test-error]')?.textContent ?? null`) }
  await shot('test-invalid-response')
  await recover()

  // 실패 줄 ② — 레포 기본 저장 실패(userData 쓰기 금지)
  await until(() => js(`!!document.querySelector('[data-repo-default-space] .repo-default-button')`), { label: '레포 기본 줄' })
  fs.chmodSync(path.join(ROOT, 'ud'), 0o500)
  try {
    await click('[data-repo-default-space] .repo-default-button')
    await until(() => js(`document.querySelectorAll('.repo-default-option').length > 1`), { label: '레포 기본 메뉴' })
    await js(`document.querySelectorAll('.repo-default-option')[1].click(), true`)
    await until(() => js(`!!document.querySelector('[data-repo-default-error]')`), { label: '레포 기본 실패 줄' })
  } finally {
    fs.chmodSync(path.join(ROOT, 'ud'), 0o700)
  }
  dom.repoDefaultFail = await js(`document.querySelector('[data-repo-default-error]')?.textContent ?? null`)
  await shot('repo-default-write-failure')

  // keychain — 내리고 암호문을 0바이트로, 재기동 뒤 화면이 열릴 때 자동 풀기
  sh(['scripts/l600/down.sh', ROOT])
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  store.connections[0].sealed = '='
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), { mode: 0o600 })
  sh(['scripts/l600/up.sh', ROOT])
  await openConnections()
  await waitPill('keychain', 'keychain')
  dom.keychain = await selectorsNow()
  seen.add('keychain')
  await shot('keychain')

  log('dom', dom)
  judge('E 선택자 — nav·add=la·form·card·error·space-row·repo-default 존재, add=jira 숨김(T6)',
    dom.empty.nav && dom.empty.addLa && !dom.empty.addJira && dom.form.form && dom.ok.card && dom.auth.error && dom.ok.spaceRows > 0 && dom.ok.repoDefault > 0,
    JSON.stringify({ nav: dom.empty.nav, addLa: dom.empty.addLa, addJira: dom.empty.addJira, form: dom.form.form, card: dom.ok.card, error: dom.auth.error, spaceRows: dom.ok.spaceRows, repoDefault: dom.ok.repoDefault }))
  judge('data-connection-status 6종 관측 — ok·testing·auth·forbidden·offline·keychain', ['ok', 'testing', 'auth', 'forbidden', 'offline', 'keychain'].every((value) => seen.has(value)), [...seen].join(','))
  judge('실패 줄 ① 누른 테스트 invalid_response — pill ok + 로컬 오류 줄', dom.testInvalid.pill === 'ok' && typeof dom.testInvalid.line === 'string', JSON.stringify(dom.testInvalid))
  judge('실패 줄 ② 레포 기본 저장 실패 문구', typeof dom.repoDefaultFail === 'string' && dom.repoDefaultFail.includes('저장하지 못했습니다'), dom.repoDefaultFail)
  const shots = fs.readdirSync(SHOTS).filter((name) => name.startsWith('f-c11-'))
  judge('캡처 8장(6 상태 + 실패 줄 2)', shots.length === 8, shots.join(','))
  exitCode = verdicts.every((verdict) => verdict.pass) ? 0 : 1
} catch (error) {
  log('오류', String(error))
  exitCode = 1
} finally {
  try { fs.chmodSync(path.join(ROOT, 'ud'), 0o700) } catch { /* 없으면 그만 */ }
  try { sh(['scripts/l600/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)); exitCode = 1 }
  fixture.kill('SIGTERM')
  await sleep(500)
  log(`# 결과 ${verdicts.filter((verdict) => verdict.pass).length}/${verdicts.length} exit=${exitCode}`)
  process.exit(exitCode)
}
