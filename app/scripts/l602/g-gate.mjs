#!/usr/bin/env node
// LIFE-602 최종 관문(G1–G5) — 격리 개발 앱(l602/up.sh, 모의 출처 · 계측 cipher)에서 돈다. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l602/g-gate.mjs <모드> <ROOT=/tmp/l602q-*> <OUT 파일> [추가]
//
// g1      (C9) 우선순위 저장 → 활동 파일 → 앱 종료 → 같은 userData 로 재기동 → 같은 작업 활동 재표시. 이어서 G2(손상 파일 재기동 · 대조 = 정상 파일 복원 재기동).
// g3      (C4) 메인 창 이동 양성 대조 — 추가 인자 `guarded`(빌드 그대로) | `bare`(ROOT/app 에 가드 둘을 뺀 사본: main will-navigate preventDefault ·
//         렌더러 md-link onClick preventDefault). 같은 조작(location.assign · 본문 링크 클릭 — 대상은 ROOT 안의 로컬 파일)의 location 전후 · 로그 window.navigate.denied.
// g4      (C8) 충돌 검사 켜진 모의 — 제목·우선순위·본문·체크 칸 각각: 외부 변경 → 상세 저장 → 배너·칸 → 새로 불러오기 또는 덮기 → 서버 값.
// g4drift (C8) 모의 drift 토큰 — 단건 두 번째 읽기 뒤 모의 웹이 우선순위를 바꾼다 → 제목 저장 = 배너(우선순위 칸).
// g4la    (C8) LA 모의 MCP(scripts/l602/la-fixture.mts, 루프백) — 같은 외부 변경 뒤 저장: 배너 0 · 나중 저장이 이김.
// g5      (C13) 화면 캡처(패널·전체·편집기·충돌·활동) · T3 data-* 19개 DOM 검사(상태별) · T5 몫 0 · 토큰 두 파일 대조.
// dmg     패키징 산출물(app/dist/mac-arm64/corral.app — 설치하지 않음)을 같은 격리 환경으로 1회 기동 → 창·작업 페이지·상세(모의 출처) 캡처 → 종료.
//
// 실제 LA·사용자 키체인·설치본 무접촉. 원자료의 토큰 꼴 글자(`mock_…`·`life_pat_…`)는 끝에 가린다. 종료 코드: 0 전부 통과 · 1 미달 · 2 사용법.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const MODES = ['g1', 'g3', 'g4', 'g4drift', 'g4la', 'g5', 'dmg']
const [MODE, ROOT, OUT, EXTRA] = process.argv.slice(2)
if (!MODES.includes(MODE) || !ROOT?.startsWith('/tmp/l602q-') || OUT === undefined || (MODE === 'g3' && EXTRA !== 'guarded' && EXTRA !== 'bare')) {
  console.error(`사용법: node scripts/l602/g-gate.mjs <${MODES.join('|')}> /tmp/l602q-<n> <OUT 파일> [g3: guarded|bare]`)
  process.exit(2)
}
const OUT_FILE = path.resolve(OUT)
const RAW_DIR = path.dirname(OUT_FILE)
const log = recorder(OUT_FILE)
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push({ item, pass })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, detail ?? '')
}
const sh = (args, env = {}) => {
  const run = spawnSync('sh', args, { cwd: APP, encoding: 'utf8', env: { ...process.env, ...env } })
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
const pageOpen = () => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`)
const readText = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
const logLines = () => (readText(path.join(ROOT, 'ud/corral.ndjson')) ?? '').split('\n').filter((line) => line.length > 0)
const tagCount = (tag) => logLines().filter((line) => { try { return JSON.parse(line).tag === tag } catch { return false } }).length
const idle = () => until(() => js(`!document.querySelector('[data-issue-busy]')`), { everyMs: 20, timeoutMs: 10_000, label: '확인 끝' })
const set = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); return e.value })()`)
const shot = async (name) => {
  const taken = await ctl(ROOT, { cmd: 'shot', name })
  if (taken.file && (MODE === 'g5' || MODE === 'dmg')) {
    const target = path.join(RAW_DIR, `${MODE === 'g5' ? 'g5' : 'g-dmg'}-${name}.png`)
    fs.copyFileSync(taken.file, target)
    log('shot', { name, bytes: fs.statSync(target).size, copied: path.basename(target) })
  } else log('shot', { name, file: taken.file?.replaceAll(ROOT, '<ROOT>') })
}

let connectionId = null
const request = (call) => js(`window.corral.workRequest({ requestId: 'g-' + Date.now() + '-' + Math.random(), connectionId: ${JSON.stringify(connectionId)}, call: ${JSON.stringify(call)} })`)
async function connect({ sourceId, token }) {
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  const added = await js(`window.corral.addWorkConnection({ sourceId: ${JSON.stringify(sourceId)}, token: ${JSON.stringify(token)}, replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
  log('연결', { sourceId, ok: added?.ok })
  connectionId = added?.id ?? null
  if (!added?.ok) throw new Error('연결 실패')
}
async function openPage() {
  if (!(await pageOpen())) await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(pageOpen, { timeoutMs: 10_000, label: '⌘I 로 열림' })
}
/** 그 작업 상세를 연다 — 이미 열려 있으면(ui-prefs 복원) 누르지 않는다(다시 누르면 닫힌다). */
async function openDetail(key) {
  await openPage()
  await until(() => js(`!!document.querySelector('[data-issue-card="${key}"]')`), { timeoutMs: 15_000, label: `카드 ${key}` })
  if (!(await js(`!!document.querySelector('[data-issue-detail="${key}"]')`))) await click(`[data-issue-card="${key}"]`)
  await until(() => js(`(() => { const d = document.querySelector('[data-issue-detail="${key}"]'); return !!d && !!d.querySelector('[data-md-rendered], .md-empty') && !d.querySelector('[data-issue-body-edit]')?.disabled })()`), { timeoutMs: 15_000, label: `상세 ${key}` })
}
const corralRows = (key) => js(`[...document.querySelectorAll('[data-issue-detail="${key}"] [data-activity-row="change"][data-activity-origin="corral"]')].filter((e) => e.textContent.includes('우선순위')).length`)
const banner = () => js(`(() => { const b = document.querySelector('[data-issue-conflict]'); return b ? { fields: [...b.querySelectorAll('[data-conflict-field]')].map((e) => e.getAttribute('data-conflict-field')), text: b.textContent.slice(0, 120) } : null })()`)
const serverItem = async (itemId) => { const got = await request({ op: 'getItem', itemId }); return got.ok ? got.result.item : { error: got.error } }
const pick = (item) => ({ title: item.title, priority: item.priority, body: item.body, version: item.version })

/** 원자료의 토큰 꼴 글자를 가린다 — 가짜 토큰도(관문 규칙). 길이·sha256 은 남기지 않는다(가짜라 뜻이 없다). */
function maskRaw(file) {
  const text = readText(file)
  if (text === null) return
  fs.writeFileSync(file, text.replace(/life_pat_[A-Za-z0-9_]+/g, '<fixture-token>').replace(/mock_[A-Za-z0-9_]+/g, '<fixture-token>'))
}

let fixture = null
log(`# LIFE-602 g-gate ${MODE}${EXTRA ? ` ${EXTRA}` : ''} ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
  switch (MODE) {
    case 'g1': {
      sh(['scripts/l602/up.sh', ROOT])
      await connect({ sourceId: 'mock-jira', token: 'mock_l602_g1' })
      await openDetail('CORE-1')
      await click('[data-issue-detail="CORE-1"] [data-field="priority"]'); await click('[data-priority-row="high"]')
      await until(async () => (await corralRows('CORE-1')) > 0, { timeoutMs: 10_000, label: '활동 줄' })
      await sleep(300)
      const file = path.join(ROOT, 'ud/work-activity.json')
      const before = JSON.parse(readText(file) ?? 'null')
      log('활동 파일', { version: before?.version, records: before?.records?.length })
      // G1 — 종료 → 같은 userData 로 재기동
      sh(['scripts/l602/down.sh', ROOT]); sh(['scripts/l602/up.sh', ROOT])
      await openDetail('CORE-1')
      const shown = await until(() => corralRows('CORE-1'), { timeoutMs: 10_000, label: '재기동 활동' }).then((hit) => hit.value).catch(() => 0)
      const after = JSON.parse(readText(file) ?? 'null')
      await shot('g1-restart')
      judge('G1 (C9) 재기동 뒤 같은 작업 활동에 「나 · corral」 우선순위 줄 · 파일 줄 수 그대로', shown >= 1 && after?.records?.length === before?.records?.length, JSON.stringify({ shown, before: before?.records?.length, after: after?.records?.length }))
      // G2 — 손상 파일로 재기동
      sh(['scripts/l602/down.sh', ROOT])
      const valid = readText(file)
      fs.writeFileSync(path.join(ROOT, 'activity.valid.json'), valid ?? '')
      const garbage = '{"version":1,"records":[{"broken'
      fs.writeFileSync(file, garbage)
      const corruptBefore = tagCount('work.activity_corrupt')
      sh(['scripts/l602/up.sh', ROOT])
      await openDetail('CORE-1')
      await sleep(1500)
      const alive = await js('document.readyState')
      const rowsCorrupt = await corralRows('CORE-1')
      const preserved = readText(`${file}.corrupt`)
      const corruptAfter = tagCount('work.activity_corrupt')
      const corruptLine = logLines().filter((line) => line.includes('"work.activity_corrupt"')).at(-1)?.replaceAll(ROOT, '<ROOT>') ?? null
      log('손상 재기동', { alive, rowsCorrupt, preserved: preserved === garbage, corruptBefore, corruptAfter, corruptLine })
      await shot('g2-corrupt')
      judge('G2 (C9) 손상 파일 — 앱 생존 · work.activity_corrupt 로그 1줄 더 · .corrupt 에 원본 그대로 · 빈 활동', alive === 'complete' && corruptAfter === corruptBefore + 1 && preserved === garbage && rowsCorrupt === 0, JSON.stringify({ alive, corruptBefore, corruptAfter, preserved: preserved === garbage, rowsCorrupt }))
      // 대조 — 정상 파일을 되돌리면 읽힌다
      sh(['scripts/l602/down.sh', ROOT])
      fs.writeFileSync(file, valid ?? '')
      sh(['scripts/l602/up.sh', ROOT])
      await openDetail('CORE-1')
      const rowsValid = await until(() => corralRows('CORE-1'), { timeoutMs: 10_000, label: '정상 파일 활동' }).then((hit) => hit.value).catch(() => 0)
      judge('G2 대조 — 정상 파일로 재기동하면 같은 줄이 읽힌다', rowsValid >= 1, JSON.stringify({ rowsValid }))
      break
    }
    case 'g3': {
      const target = path.join(ROOT, 'target.html')
      fs.writeFileSync(target, '<!doctype html><title>L602 G3 TARGET</title><p>moved</p>')
      const targetUrl = `file://${target}`
      let env = {}
      if (EXTRA === 'bare') {
        // 가드 둘을 뺀 사본 — 빌드 산출물(out/)을 복사해 고친다. 원본 app/out 은 건드리지 않는다.
        const copy = path.join(ROOT, 'app')
        fs.mkdirSync(copy, { recursive: true })
        fs.copyFileSync(path.join(APP, 'package.json'), path.join(copy, 'package.json'))
        fs.cpSync(path.join(APP, 'out'), path.join(copy, 'out'), { recursive: true })
        if (!fs.existsSync(path.join(copy, 'node_modules'))) fs.symlinkSync(path.join(APP, 'node_modules'), path.join(copy, 'node_modules'))
        const mainFile = path.join(copy, 'out/main/index.js')
        const mainText = readText(mainFile)
        const mainGuard = 'window.webContents.on("will-navigate", (event, url) => {\n    event.preventDefault();'
        const rendererDir = path.join(copy, 'out/renderer/assets')
        const rendererFile = path.join(rendererDir, fs.readdirSync(rendererDir).find((name) => /^index-.*\.js$/.test(name)))
        const rendererText = readText(rendererFile)
        const linkGuard = '"data-md-link": action.kind,\n          onClick: (event) => {\n            event.preventDefault();'
        const found = { main: mainText.split(mainGuard).length - 1, link: rendererText.split(linkGuard).length - 1 }
        log('사본 가드 위치', found)
        if (found.main !== 1 || found.link !== 1) throw new Error('가드 위치를 하나로 찾지 못함')
        fs.writeFileSync(mainFile, mainText.replace(mainGuard, 'window.webContents.on("will-navigate", (event, url) => {\n    /* L602 G3 bare: guard removed */'))
        fs.writeFileSync(rendererFile, rendererText.replace(linkGuard, '"data-md-link": action.kind,\n          onClick: (event) => {\n            /* L602 G3 bare: guard removed */'))
        env = { L602_APP_DIR: copy }
      }
      sh(['scripts/l602/up.sh', ROOT], env)
      await connect({ sourceId: 'mock-jira', token: 'mock_l602_g3' })
      const href0 = await js('location.href')
      const denied0 = tagCount('window.navigate.denied')
      // ① location.assign — main 가드만 막는다
      await js(`setTimeout(() => location.assign(${JSON.stringify(targetUrl)}), 0); true`)
      await sleep(1500)
      const afterAssign = await js('({ href: location.href, title: document.title })')
      const deniedAssign = tagCount('window.navigate.denied') - denied0
      log('① location.assign', { moved: afterAssign.href !== href0, title: afterAssign.title, deniedAssign })
      if (afterAssign.href !== href0) {
        // 가드 없는 사본은 옮겨 갔다 — 앱 화면으로 되돌린다(같은 가드 없음 덕에 돌아갈 수 있다).
        await js(`setTimeout(() => location.assign(${JSON.stringify(href0)}), 0); true`)
        await sleep(1500)
      }
      // ② 본문 링크 클릭 — 상세 CORE-1 본문의 막힌 링크(file:, data-md-link≠external) 하나의 href 를 로컬 대상으로 바꿔 누른다(렌더러 가드 + main 가드).
      //    external 링크는 누르지 않는다 — window.open 이 사용자 브라우저를 연다(첫 회차 g3-*-r1 에서 example.com 을 열었다).
      await openDetail('CORE-1')
      const denied1 = tagCount('window.navigate.denied')
      const clicked = await js(`(() => { const a = document.querySelector('[data-issue-body] a.md-link:not([data-md-link="external"])'); if (!a) return null; a.setAttribute('href', ${JSON.stringify(targetUrl)}); setTimeout(() => a.click(), 0); return a.getAttribute('data-md-link') })()`)
      await sleep(1500)
      const afterLink = await js('({ href: location.href, title: document.title })')
      const deniedLink = tagCount('window.navigate.denied') - denied1
      log('② 본문 링크', { clicked, moved: afterLink.href !== href0, title: afterLink.title, deniedLink })
      if (EXTRA === 'bare') {
        // 사본은 preventDefault 만 뺐다 — 로그 줄은 그대로 남으므로 판정에 쓰지 않는다(이동 여부만).
        judge('G3 가드 없는 사본 — location.assign 이 메인 창을 옮김(대상 문서 제목)', afterAssign.href !== href0 && afterAssign.title === 'L602 G3 TARGET', JSON.stringify({ afterAssign, deniedAssign }))
        judge('G3 가드 없는 사본 — 본문 링크 클릭이 메인 창을 옮김', clicked !== null && afterLink.href !== href0 && afterLink.title === 'L602 G3 TARGET', JSON.stringify({ clicked, afterLink }))
      } else {
        judge('G3 가드 있는 빌드 — location.assign 이동 0 · window.navigate.denied 1줄', afterAssign.href === href0 && deniedAssign === 1, JSON.stringify({ same: afterAssign.href === href0, deniedAssign }))
        judge('G3 가드 있는 빌드 — 본문 링크 클릭 이동 0(렌더러가 막아 main 까지 가지 않음)', clicked !== null && afterLink.href === href0, JSON.stringify({ clicked, same: afterLink.href === href0, deniedLink }))
      }
      break
    }
    case 'g4': {
      sh(['scripts/l602/up.sh', ROOT])
      await connect({ sourceId: 'mock-jira', token: 'mock_l602_g4' })
      const seed = await request({ op: 'updateItem', itemId: 'm-2', fields: { body: 'SEED BODY\n- [ ] A\n- [ ] B\n' }, ifVersion: null })
      log('씨앗', { ok: seed.ok })
      await openDetail('CORE-2')
      const scenario = async ({ name, field, external, save, resolve, expect }) => {
        await until(async () => (await banner()) === null, { timeoutMs: 5_000, label: '배너 없음' }).catch(() => null)
        const ext = await request({ op: 'updateItem', itemId: 'm-2', fields: external, ifVersion: null })
        await save()
        const shown = await until(() => banner(), { timeoutMs: 10_000, label: `${name} 배너` }).then((hit) => hit.value).catch(() => null)
        const mid = pick(await serverItem('m-2'))
        await click(resolve === 'reload' ? '[data-conflict-reload]' : '[data-conflict-override]')
        await sleep(500); await idle()
        const last = pick(await serverItem('m-2'))
        const screen = await js(`({ title: document.querySelector('[data-issue-title]').value, priority: document.querySelector('[data-field="priority"]').textContent, body: document.querySelector('[data-issue-body]').textContent.slice(0, 80), banner: !!document.querySelector('[data-issue-conflict]') })`)
        log(name, { extOk: ext.ok, shown, mid, last, screen })
        judge(`G4 ${name} — 저장 안 됨 · 배너 칸 ${field} · ${resolve === 'reload' ? '새로 불러오기 = 서버(외부) 값' : '덮기 = 서버가 내 값'}`, shown !== null && shown.fields.includes(field) && expect.mid(mid) && expect.last(last, screen), JSON.stringify({ shown, mid, last, screen }))
      }
      await scenario({
        name: '제목', field: 'title', external: { title: 'EXT TITLE' }, resolve: 'reload',
        save: async () => { await set('[data-issue-title]', 'MY TITLE'); await js(`document.querySelector('[data-issue-title]').blur()`); await sleep(400) },
        expect: { mid: (item) => item.title === 'EXT TITLE', last: (item, screen) => item.title === 'EXT TITLE' && screen.title === 'EXT TITLE' && !screen.banner },
      })
      await scenario({
        name: '우선순위', field: 'priority', external: { priority: 'lowest' }, resolve: 'override',
        save: async () => { await click('[data-field="priority"]'); await click('[data-priority-row="high"]'); await sleep(400) },
        expect: { mid: (item) => item.priority === 'lowest', last: (item, screen) => item.priority === 'high' && !screen.banner },
      })
      await scenario({
        name: '본문', field: 'body', external: { body: 'EXT BODY\n- [ ] A\n- [ ] B\n' }, resolve: 'reload',
        save: async () => {
          await click('[data-issue-body-edit]')
          await until(() => js(`!!document.querySelector('[data-md-editor] textarea')`), { timeoutMs: 5_000, label: '편집기' })
          await set('[data-md-editor] textarea', 'MY BODY'); await click('[data-md-save]'); await sleep(400)
        },
        expect: { mid: (item) => item.body === 'EXT BODY\n- [ ] A\n- [ ] B\n', last: (item, screen) => item.body === 'EXT BODY\n- [ ] A\n- [ ] B\n' && screen.body.includes('EXT BODY') && !screen.banner },
      })
      await scenario({
        name: '체크 칸', field: 'body', external: { body: 'EXT BODY\n- [ ] A\n- [ ] B CHANGED\n' }, resolve: 'override',
        save: async () => { await click('[data-issue-body] [data-md-check="2"]'); await sleep(400) },
        expect: { mid: (item) => item.body === 'EXT BODY\n- [ ] A\n- [ ] B CHANGED\n', last: (item) => item.body === 'EXT BODY\n- [x] A\n- [ ] B\n' },
      })
      break
    }
    case 'g4drift': {
      sh(['scripts/l602/up.sh', ROOT])
      await connect({ sourceId: 'mock-jira', token: 'mock_l602_g4_drift' })
      await openDetail('CORE-2')
      // 코멘트 → 단건 재조회(두 번째 읽기) → 모의 웹이 우선순위를 바꿈 → 제목 저장 = 충돌
      await set('[data-comment-composer] textarea', 'G4 DRIFT')
      await ctl(ROOT, { cmd: 'key', keyCode: 'Enter', modifiers: ['meta'] })
      await sleep(800); await idle()
      const drifted = pick(await serverItem('m-2'))
      await set('[data-issue-title]', 'DRIFT TITLE'); await js(`document.querySelector('[data-issue-title]').blur()`)
      const shown = await until(() => banner(), { timeoutMs: 10_000, label: 'drift 배너' }).then((hit) => hit.value).catch(() => null)
      const last = pick(await serverItem('m-2'))
      log('drift', { drifted, shown, last })
      judge('G4 drift — 다른 곳의 우선순위 변경 뒤 제목 저장 = 저장 안 됨 · 배너 칸 priority', shown !== null && shown.fields.includes('priority') && last.title !== 'DRIFT TITLE', JSON.stringify({ shown, last }))
      break
    }
    case 'g4la': {
      const urlFile = path.join(ROOT, 'fixture.url')
      fixture = spawn(process.execPath, ['--import', 'tsx', 'scripts/l602/la-fixture.mts', urlFile], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] })
      fixture.stdout.on('data', (chunk) => log('fixture', String(chunk).trim()))
      await until(() => fs.existsSync(`${urlFile}.token`), { timeoutMs: 20_000, label: 'LA 모의 서버' })
      const url = readText(urlFile)
      log('LA 모의 서버', { url, pid: fixture.pid })
      sh(['scripts/l602/up.sh', ROOT, `CORRAL_LA_MCP_URL=${url}`])
      await connect({ sourceId: 'la', token: readText(`${urlFile}.token`) })
      await openPage()
      const cards = await until(() => js(`[...document.querySelectorAll('[data-issue-card]')].map((e) => e.getAttribute('data-issue-card'))`), { timeoutMs: 15_000, label: 'LA 카드' }).then((hit) => hit.value)
      log('LA 카드', cards)
      const key = cards.find((entry) => entry.endsWith('-600'))
      if (key === undefined) throw new Error('LA 카드 600 없음')
      await openDetail(key)
      const listed = await request({ op: 'findByKey', key })
      const id = listed.ok && listed.result.item !== null ? listed.result.item.id : null
      log('대상', { key, found: id !== null })
      const steps = [
        { name: '제목', external: { title: 'EXT LA TITLE' }, save: async () => { await set('[data-issue-title]', 'MY LA TITLE'); await js(`document.querySelector('[data-issue-title]').blur()`) }, mine: (item) => item.title === 'MY LA TITLE' },
        { name: '우선순위', external: { priority: 'low' }, save: async () => { await click('[data-field="priority"]'); await click('[data-priority-row="highest"]') }, mine: (item) => item.priority === 'highest' },
        { name: '본문', external: { body: 'EXT LA BODY' }, save: async () => { await click('[data-issue-body-edit]'); await until(() => js(`!!document.querySelector('[data-md-editor] textarea')`), { timeoutMs: 5_000, label: '편집기' }); await set('[data-md-editor] textarea', 'MY LA BODY'); await click('[data-md-save]') }, mine: (item) => item.body === 'MY LA BODY' },
      ]
      for (const step of steps) {
        const ext = await request({ op: 'updateItem', itemId: id, fields: step.external, ifVersion: null })
        await step.save()
        await sleep(1200); await idle()
        const shown = await banner()
        const got = await request({ op: 'getItem', itemId: id })
        const last = got.ok ? pick(got.result.item) : { error: got.error }
        log(`LA ${step.name}`, { extOk: ext.ok, shown, last })
        judge(`G4 LA 모의 MCP ${step.name} — 외부 변경 뒤 저장: 배너 0 · 나중 저장(내 값)이 이김`, shown === null && step.mine(last), JSON.stringify({ shown, last }))
      }
      break
    }
    case 'dmg': {
      const exe = path.join(APP, 'dist/mac-arm64/corral.app/Contents/MacOS/corral')
      if (!fs.existsSync(exe)) throw new Error('패키징 산출물 없음 — npm run package:mac 먼저')
      sh(['scripts/l602/up.sh', ROOT], { L602_EXE: exe })
      const pid = readText(path.join(ROOT, 'app.pid'))?.trim()
      const command = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).stdout.trim()
      const fromDist = command.startsWith(exe)
      log('기동한 실행 파일', { pid, fromDist, installed: command.startsWith('/Applications/') })
      await connect({ sourceId: 'mock-jira', token: 'mock_l602_dmg' })
      const windowShown = await js(`({ visible: document.visibilityState, w: innerWidth, h: innerHeight })`)
      await openDetail('CORE-1')
      const head = await js(`({ key: document.querySelector('[data-issue-detail]')?.getAttribute('data-issue-detail'), title: document.querySelector('[data-issue-title]')?.value, rendered: !!document.querySelector('[data-md-rendered]') })`)
      const version = await js(`window.corral.appVersion?.() ?? null`).catch(() => null)
      await shot('detail')
      log('패키징 앱', { windowShown, head, version })
      judge('dmg 산출 .app(설치 안 함) 격리 기동 — 창 · 작업 페이지 · 상세 CORE-1 본문', fromDist && windowShown.w > 0 && head.key === 'CORE-1' && head.rendered, JSON.stringify({ fromDist, windowShown, head }))
      break
    }
    case 'g5': {
      sh(['scripts/l602/up.sh', ROOT])
      await connect({ sourceId: 'mock-jira', token: 'mock_l602_g5' })
      const T3 = ['data-issue-detail', 'data-issue-conflict', 'data-issue-title', 'data-issue-status', 'data-issue-fields', 'data-issue-links', 'data-issue-children', 'data-issue-body', 'data-issue-body-edit', 'data-md-editor', 'data-md-tool', 'data-md-save', 'data-md-rendered', 'data-md-check', 'data-issue-activity', 'data-activity-filter', 'data-comment-composer', 'data-toast', 'data-toast-undo']
      const T5 = ['data-issue-open', 'data-issue-start', 'data-issue-work']
      const seen = new Map()
      const census = async (state) => {
        const counts = await js(`(${JSON.stringify([...T3, ...T5])}).map((name) => [name, document.querySelectorAll('[' + name + ']').length])`)
        for (const [name, count] of counts) if (count > 0 && !seen.has(name)) seen.set(name, state)
        log(`census ${state}`, Object.fromEntries(counts.filter(([, count]) => count > 0)))
        return Object.fromEntries(counts)
      }
      await openDetail('CORE-1')
      await census('상세 CORE-1')
      await shot('panel')
      await click('[data-issue-detail="CORE-1"] [data-field="priority"]'); await click('[data-priority-row="high"]')
      await until(() => js(`!!document.querySelector('[data-toast-undo]')`), { timeoutMs: 5_000, label: '토스트' })
      await census('우선순위 저장 뒤 토스트')
      await js(`document.querySelector('[data-issue-activity]').scrollIntoView()`)
      await sleep(300); await shot('activity')
      await js(`document.querySelector('[data-issue-detail]').querySelector('.issue-detail-scroll').scrollTop = 0`)
      await click('[data-issue-full]')
      await until(() => js(`document.querySelector('[data-issue-full]')?.getAttribute('data-issue-full') === 'full'`), { timeoutMs: 5_000, label: '전체' })
      await sleep(300); await shot('full')
      await click('[data-issue-full]')
      await click('[data-issue-body-edit]')
      await until(() => js(`!!document.querySelector('[data-md-editor]')`), { timeoutMs: 5_000, label: '편집기' })
      await census('본문 편집기')
      await shot('editor')
      await ctl(ROOT, { cmd: 'key', keyCode: 'Escape' }); await sleep(300)
      if (await js(`!!document.querySelector('[data-md-editor]')`)) await js(`document.querySelector('[data-md-editor] textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      // 충돌 상태 — CORE-2 를 열고 외부에서 우선순위를 바꾼 뒤 우선순위 저장
      await openDetail('CORE-2')
      await request({ op: 'updateItem', itemId: 'm-2', fields: { priority: 'lowest', title: 'EXTERNAL TITLE' }, ifVersion: null })
      await click('[data-issue-detail="CORE-2"] [data-field="priority"]'); await click('[data-priority-row="high"]')
      await until(() => banner(), { timeoutMs: 10_000, label: '충돌 배너' })
      await census('충돌 배너')
      await shot('conflict')
      const missing = T3.filter((name) => !seen.has(name))
      const t5 = T5.filter((name) => seen.has(name))
      log('T3 data-* 처음 보인 상태', Object.fromEntries(seen))
      judge(`G5 T3 data-* ${T3.length}개 전부 DOM 에 있음(상태별)`, missing.length === 0, JSON.stringify({ missing }))
      judge('G5 T5 몫(data-issue-open·start·work) DOM 에 0', t5.length === 0, JSON.stringify({ t5 }))
      // 토큰 — 상세 css 가 쓰는 var(--…) 가 앱 토큰 파일과 specs 역반영 파일에 같은 값으로 있는가
      const appTokens = readText(path.join(APP, 'src/renderer/src/design-tokens.css'))
      const specTokens = readText(path.join(APP, '../specs/design-tokens.css'))
      const used = new Set()
      for (const css of ['src/renderer/src/components/task-detail.css']) for (const match of (readText(path.join(APP, css)) ?? '').matchAll(/var\((--[a-z0-9-]+)/g)) used.add(match[1])
      const valueOf = (text, name) => [...text.matchAll(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'gm'))].map((match) => match[1].trim())
      const rows = [...used].sort().map((name) => ({ name, app: valueOf(appTokens, name), spec: valueOf(specTokens, name) }))
      const mismatched = rows.filter((row) => row.app.length === 0 || JSON.stringify(row.app) !== JSON.stringify(row.spec))
      // 기준 commit(93609c726)에서도 이미 어긋난 기본 테마 토큰(--accent·--fg 등 — 원본·사본이 갈라진 지 오래)은 이 작업의 몫이 아니다. 새로 어긋난 것만 미달.
      const base = (file) => spawnSync('git', ['show', `93609c726:${file}`], { cwd: APP, encoding: 'utf8' }).stdout
      const baseApp = base('app/src/renderer/src/design-tokens.css')
      const baseSpec = base('specs/design-tokens.css')
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      const fresh = mismatched.filter((row) => !(same(valueOf(baseApp, row.name), row.app) && same(valueOf(baseSpec, row.name), row.spec)))
      log('토큰 대조', { used: rows.length, mismatched, preexisting: mismatched.length - fresh.length, fresh: fresh.map((row) => row.name) })
      const named = ['--w-issue-detail', '--w-issue-detail-full', '--cat-cancel'].map((name) => ({ name, app: valueOf(appTokens, name), spec: valueOf(specTokens, name) }))
      log('새 토큰', named)
      judge('G5 상세 css 가 쓰는 토큰 — 기준 commit 대비 새로 어긋난 것 0 · 새 토큰(--w-issue-detail·-full)과 --cat-cancel 이 두 파일에 같은 값', fresh.length === 0 && named.every((row) => row.app.length > 0 && JSON.stringify(row.app) === JSON.stringify(row.spec)), JSON.stringify({ used: rows.length, preexisting: mismatched.map((row) => row.name), fresh: fresh.map((row) => row.name) }))
      break
    }
  }
  const failed = verdicts.filter((verdict) => !verdict.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 && verdicts.length > 0 ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
  exitCode = 1
} finally {
  try { sh(['scripts/l602/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  if (fixture !== null) {
    fixture.kill('SIGTERM')
    await sleep(800)
    log('LA 모의 서버 종료', { pid: fixture.pid, exit: fixture.exitCode, signal: fixture.signalCode })
  }
  log(`# exit ${exitCode}`)
  maskRaw(OUT_FILE)
  process.exit(exitCode)
}
