#!/usr/bin/env node
// LIFE-602 빠른 층 「핵심 진입점 1회」 — 격리 개발 앱에서 작업 페이지의 카드를 눌러 상세가 그려지는지. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l602/q-entry.mjs <ROOT=/tmp/l602q-*> <OUT 파일> [샷 복사 경로]
//
// 흐름: 앱 기동(모의 출처 — l602/up.sh) → 모의 연결 추가(렌더러 IPC, 가짜 토큰) → ⌘I(앱 내부 sendInputEvent) → 보드 카드 클릭(제어 소켓 click)
//       → 상세(머리·부모 경로·본문 markdown·raw HTML 요소 없음·키 자동 링크·연결·자식·활동) → file 링크 클릭 = 메인 창 이동 없음
//       → 우선순위 즉시 저장 → 활동 저장소 파일(ROOT/ud/work-activity.json)에 한 줄 · 로그에 본문 전문 없음 → ⤢ 전체 → Esc 단계 → 정리.
// 실제 LA·사용자 키체인·설치본 무접촉. 토큰은 가짜(`mock_…`)뿐. https 링크는 누르지 않는다(사용자 브라우저를 열 수 있다).
// 종료 코드: 0 판정 전부 통과 · 1 하나라도 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT, SHOT_COPY] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l602q-') || OUT === undefined) {
  console.error('사용법: node scripts/l602/q-entry.mjs /tmp/l602q-<n> <OUT 파일> [샷 복사 경로]')
  process.exit(2)
}
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
const pageOpen = () => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`)
const readText = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
/**
 * 로그 누출 판정(수정 1 R1-L) — 로그를 읽지 못하면 관측이 없으므로 **실패**다. 읽었으면 로그가 실제로 쌓였다는 신호(이번 실행의 `work.request` 줄)를 먼저 보고,
 * 줄마다 JSON 으로 읽어 `tag === 'control.cmd'`(측정 모드 제어 소켓이 받은 명령 = 이 스크립트의 eval 코드)만 구조로 뺀다. JSON 이 아닌 줄은 빼지 않는다.
 */
function logLeak({ file, needles }) {
  const text = readText(file)
  if (text === null) return { pass: false, reason: 'log-unreadable', file }
  const lines = text.split('\n').filter((line) => line.length > 0)
  const kept = []
  let control = 0
  let requests = 0
  for (const line of lines) {
    let tag = null
    try { const parsed = JSON.parse(line); tag = typeof parsed?.tag === 'string' ? parsed.tag : null } catch { tag = null }
    if (tag === 'control.cmd') { control += 1; continue }
    if (tag === 'work.request') requests += 1
    kept.push(line)
  }
  if (requests === 0) return { pass: false, reason: 'no-work-request-lines', lines: lines.length, control }
  const hits = needles.filter((needle) => kept.some((line) => line.includes(needle)))
  return { pass: hits.length === 0, reason: hits.length === 0 ? 'clean' : 'leak', lines: lines.length, control, requests, hits: hits.length }
}

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-602 q-entry ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  sh(['scripts/l602/up.sh', ROOT])
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: 'mock_l602_demo', replaceId: null }).then((r) => ({ ok: r.ok, spaces: r.ok ? (r.connection.spaces ?? []).map((s) => s.key) : null }))`)
  log('addWorkConnection', added)
  judge('모의 연결 추가(가짜 토큰)', added?.ok === true, JSON.stringify(added))

  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(pageOpen, { timeoutMs: 10_000, label: '⌘I 로 열림' })
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="CORE-2"]')`), { timeoutMs: 15_000, label: '보드 카드 CORE-2' })
  const href0 = await js('location.href')

  // 카드 클릭 → 상세
  await click('[data-tasks-board] [data-issue-card="CORE-2"]')
  await until(() => js(`!!document.querySelector('[data-issue-detail="CORE-2"] [data-issue-title]')`), { timeoutMs: 10_000, label: '상세 CORE-2' })
  const head = await js(`(() => {
    const d = document.querySelector('[data-issue-detail]')
    const r = d.getBoundingClientRect()
    return { key: d.getAttribute('data-issue-detail'), width: Math.round(r.width), title: d.querySelector('[data-issue-title]').value,
      parents: [...d.querySelectorAll('[data-issue-parent]')].map((e) => e.getAttribute('data-issue-parent')),
      full: d.querySelector('[data-issue-full]').getAttribute('data-issue-full'), status: d.querySelector('[data-issue-status]').textContent,
      links: [...d.querySelectorAll('[data-link-row]')].map((e) => e.getAttribute('data-link-row')) }
  })()`)
  log('상세 머리', head)
  judge('C1 카드 클릭 → 상세 CORE-2 · 패널 560 · 부모 경로 CORE-1', head.key === 'CORE-2' && head.full === 'panel' && head.width === 560 && JSON.stringify(head.parents) === '["CORE-1"]', JSON.stringify(head))
  const shot = await ctl(ROOT, { cmd: 'shot', name: 'l602-detail-panel' })
  log('shot', { ...shot, file: shot.file?.replaceAll(ROOT, '<ROOT>') })

  // 본문 — 데모 씨앗(체크리스트·키·https/file 링크·raw <img onerror>)이 있는 CORE-1 로 부모 경로 이동
  await click('[data-issue-parent="CORE-1"]')
  await until(() => js(`!!document.querySelector('[data-issue-detail="CORE-1"] [data-md-rendered]')`), { timeoutMs: 10_000, label: '상세 CORE-1 본문' })
  const body = await js(`(() => {
    const v = document.querySelector('[data-issue-detail="CORE-1"] [data-issue-body] [data-md-rendered]')
    return { imgs: v.querySelectorAll('img').length, onerror: v.querySelectorAll('[onerror]').length, rawText: v.textContent.includes('<img'),
      checks: v.querySelectorAll('input[type="checkbox"]').length, keyLinks: [...v.querySelectorAll('.md-key')].map((e) => e.getAttribute('data-issue-key')),
      hrefs: [...v.querySelectorAll('a[href]')].map((e) => e.getAttribute('href')),
      children: [...document.querySelectorAll('[data-child-row]')].map((e) => e.getAttribute('data-child-row')),
      relations: [...document.querySelectorAll('[data-link-row]')].map((e) => e.getAttribute('data-link-row') + '@' + (e.querySelector('[data-link-space]')?.getAttribute('data-link-space') ?? '')) }
  })()`)
  log('본문·연결·자식', body)
  judge('C4 본문 — raw HTML 은 글자로(요소 0) · 체크 칸 · 키 자동 링크', body.imgs === 0 && body.onerror === 0 && body.rawText === true && body.checks > 0 && body.keyLinks.length > 0, JSON.stringify(body))
  judge('C6·C7 연결(다른 스페이스 표시)·자식 목록', body.relations.some((entry) => entry === 'WEB-1@WEB') && body.children.includes('CORE-2'), JSON.stringify({ relations: body.relations, children: body.children }))

  // file: 링크 — react-markdown 기본 URL 정화가 href 를 비운다. 막힌 링크(data-md-link≠external)를 누른다.
  const fileLink = await js(`(() => { const a = [...document.querySelectorAll('[data-issue-body] a.md-link')].find((e) => e.getAttribute('data-md-link') !== 'external'); if (!a) return null; a.click(); return { href: a.getAttribute('href'), kind: a.getAttribute('data-md-link'), title: a.title } })()`)
  await sleep(500)
  const href1 = await js('location.href')
  judge('C4 file 링크 클릭 → 메인 창 이동 없음', fileLink !== null && href1 === href0, JSON.stringify({ fileLink, same: href1 === href0 }))

  // 우선순위 즉시 저장 → 활동
  await click('[data-issue-detail="CORE-1"] [data-field="priority"]')
  await click('[data-priority-row="high"]')
  await until(() => js(`[...document.querySelectorAll('[data-activity-row="change"][data-activity-origin="corral"]')].some((e) => e.textContent.includes('우선순위'))`), { timeoutMs: 10_000, label: '활동 줄' })
  await sleep(300)
  const activityFile = readText(path.join(ROOT, 'ud/work-activity.json'))
  let parsed = null
  try { parsed = JSON.parse(activityFile ?? 'null') } catch { parsed = null }
  const mode = activityFile === null ? null : (fs.statSync(path.join(ROOT, 'ud/work-activity.json')).mode & 0o777).toString(8)
  log('활동 파일', { version: parsed?.version, records: parsed?.records?.length, last: parsed?.records?.at(-1), mode })
  judge('C9 활동 저장소 — userData/work-activity.json v1 에 우선순위 한 줄 · 0600', parsed?.version === 1 && parsed.records.some((record) => record.itemId === 'm-1' && record.change.field === 'priority') && mode === '600', JSON.stringify({ records: parsed?.records?.length, mode }))
  const needles = ['결제 흐름을 새 PG', 'onerror', 'mock_l602_demo']
  const leak = logLeak({ file: path.join(ROOT, 'ud/corral.ndjson'), needles })
  judge('보안 — 로그를 읽었고(work.request 줄 있음) control.cmd 를 구조로 뺀 나머지에 본문 전문·토큰 원문 없음', leak.pass, JSON.stringify(leak))
  // 판별식 양성 대조: 없는 파일은 실패, 바늘이 든 줄이 있으면 실패여야 한다.
  const absent = logLeak({ file: path.join(ROOT, 'ud/absent.ndjson'), needles })
  const planted = path.join(ROOT, 'planted.ndjson')
  fs.writeFileSync(planted, JSON.stringify({ tag: 'work.request', op: 'getItem' }) + '\n' + JSON.stringify({ tag: 'x', body: '결제 흐름을 새 PG' }) + '\n' + JSON.stringify({ tag: 'control.cmd', code: 'mock_l602_demo' }) + '\n')
  const plantedLeak = logLeak({ file: planted, needles })
  judge('판별식 양성 대조 — 없는 로그 = 실패 · 바늘 든 제품 줄 = 실패(control.cmd 줄의 바늘은 세지 않음)', absent.pass === false && absent.reason === 'log-unreadable' && plantedLeak.pass === false && plantedLeak.hits === 1, JSON.stringify({ absent, plantedLeak }))

  // ⤢ 전체 → Esc 단계
  await click('[data-issue-full]')
  await until(() => js(`document.querySelector('[data-issue-full]')?.getAttribute('data-issue-full') === 'full'`), { timeoutMs: 5_000, label: '전체' })
  const fullWidth = await js(`Math.round(document.querySelector('.issue-detail .issue-detail-inner').getBoundingClientRect().width)`)
  log('전체 본문 폭', fullWidth)
  const shotFull = await ctl(ROOT, { cmd: 'shot', name: 'l602-detail-full' })
  log('shot', { ...shotFull, file: shotFull.file?.replaceAll(ROOT, '<ROOT>') })
  judge('C1 ⤢ 페이지 전체 · 본문 폭 ≤ 820', fullWidth > 0 && fullWidth <= 820, String(fullWidth))
  await ctl(ROOT, { cmd: 'key', keyCode: 'Escape' })
  await until(async () => (await js(`!document.querySelector('[data-issue-detail]')`)) === true, { timeoutMs: 5_000, label: 'Esc 상세 닫기' })
  const stillOpen = await pageOpen()
  await ctl(ROOT, { cmd: 'key', keyCode: 'Escape' })
  await until(async () => !(await pageOpen()), { timeoutMs: 5_000, label: 'Esc 페이지 닫기' })
  judge('C1 Esc 단계 — 상세 닫기 → 페이지 닫기', stillOpen === true && !(await pageOpen()))

  // C9 재시작(수정 1 R1-J) — 격리 앱 종료 → 같은 격리 userData 로 재기동 → 같은 작업의 활동이 다시 보인다.
  const recordsBefore = parsed?.records?.length ?? null
  sh(['scripts/l602/down.sh', ROOT])
  sh(['scripts/l602/up.sh', ROOT])
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '재기동 사이드바' })
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(pageOpen, { timeoutMs: 10_000, label: '재기동 ⌘I' })
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="CORE-1"]')`), { timeoutMs: 15_000, label: '재기동 보드 CORE-1' })
  await click('[data-tasks-board] [data-issue-card="CORE-1"]')
  const shown = await until(() => js(`[...document.querySelectorAll('[data-issue-detail="CORE-1"] [data-activity-row="change"][data-activity-origin="corral"]')].filter((e) => e.textContent.includes('우선순위')).length`), { timeoutMs: 10_000, label: '재기동 활동 줄' }).then((hit) => hit.value).catch(() => 0)
  const afterRestart = (() => { try { return JSON.parse(readText(path.join(ROOT, 'ud/work-activity.json')) ?? 'null') } catch { return null } })()
  log('재기동 뒤', { shown, recordsBefore, recordsAfter: afterRestart?.records?.length ?? null })
  judge('C9 재시작 — 같은 격리 userData 로 재기동 뒤 CORE-1 활동에 「나 · corral」 우선순위 줄이 다시 보임 · 파일 줄 수 그대로', shown >= 1 && afterRestart?.records?.length === recordsBefore, JSON.stringify({ shown, recordsBefore, recordsAfter: afterRestart?.records?.length ?? null }))
  const restartShot = await ctl(ROOT, { cmd: 'shot', name: 'l602-detail-restart' })
  log('shot', { ...restartShot, file: restartShot.file?.replaceAll(ROOT, '<ROOT>') })

  if (SHOT_COPY !== undefined && shot.file) fs.copyFileSync(shot.file, SHOT_COPY)
  const failed = verdicts.filter((verdict) => !verdict.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
  exitCode = 1
} finally {
  try { sh(['scripts/l602/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
