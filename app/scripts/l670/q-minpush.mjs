#!/usr/bin/env node
// LIFE-670 수정 1(r1 M1) — 최소 밀기 폭 넘침 검사. 밀기 임계 바로 위(main = 560 + --w-tasks-body-min)에서 네 보기·필터 줄이 패널 밑으로 잘리지 않는가.
// app/ 에서(먼저 `npm run build`):  node scripts/l670/q-minpush.mjs <ROOT=/tmp/l670q-*> <OUT 파일> <샷 복사 폴더>
//
// - 앱 사본 = fixture-app.sh(보드 칸 7 · 질의 `jql:` 에 긴 검색 안내). 창이 가려지면 rAF·ResizeObserver 가 멈춰 측정이 무효라
//   `--disable-backgrounding-occluded-windows` 로 띄운다(리뷰 r1 환경 주의).
// - 창 폭은 main 실측으로 맞춘다: 1241 로 연 뒤 main 이 960 이 되게 고쳐 다시 연다. 상세는 보드 카드 CORE-2 로 연 채 보기를 바꾼다.
// - 판정(보기마다): .tasks-body.right <= aside.left · 검사 대상 요소마다 scrollWidth <= clientWidth · 그 요소의 보이는 자손 right <= aside.left.
//   보드는 칸이 가로 스크롤 그릇(.tasks-scroll) 안에 있는 것이 설계라 그릇만 본다(그릇 right <= aside.left) — 칸 머리·카드는 그릇 안에서 잘린다.
// - 필터 줄은 두 번: 기본 칩 4 · 「이번 주 마감」 칩(리스트 프리셋 week) + 검색 안내(검색어 `jql:x`)를 켠 상태.
// 실제 LA·사용자 키체인·설치본 무접촉. 종료 코드: 0 전부 통과 · 1 하나라도 미달 · 2 사용법.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT, SHOT_DIR] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l670q-') || OUT === undefined || SHOT_DIR === undefined) {
  console.error('사용법: node scripts/l670/q-minpush.mjs /tmp/l670q-<n> <OUT 파일> <샷 복사 폴더>')
  process.exit(2)
}
const FIXTURE = `${ROOT}-app`
const log = recorder(path.resolve(OUT))
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
const shot = async (name) => {
  const result = await ctl(ROOT, { cmd: 'shot', name })
  if (!result.file) { log('shot 실패', result); return }
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const target = path.join(SHOT_DIR, `${name}.png`)
  fs.copyFileSync(result.file, target)
  log('copied', { target: path.relative(path.resolve(APP, '..'), target), bytes: fs.statSync(target).size })
}
const pageOpen = () => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`)
const mainWidth = () => js(`Math.round(document.querySelector('.tasks-main').getBoundingClientRect().width * 100) / 100`)

// 넘침 측정 — 대상 선택자들의 scroll/client 폭과 보이는 자손의 최대 right. `scroller` 는 그릇만(자손 안 봄).
const measure = (targets) => js(`(() => {
  const aside = document.querySelector('[data-issue-detail]')
  const asideLeft = aside ? Math.round(aside.getBoundingClientRect().left) : null
  const body = document.querySelector('.tasks-body').getBoundingClientRect()
  const out = []
  for (const { selector, scroller } of ${JSON.stringify(targets)}) {
    const els = [...document.querySelectorAll(selector)]
    for (const el of els.slice(0, 12)) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      let maxRight = Math.round(r.right)
      let worst = null
      if (!scroller) for (const child of el.querySelectorAll('*')) {
        const c = child.getBoundingClientRect()
        if (c.width === 0 || c.height === 0) continue
        if (c.right > maxRight) { maxRight = Math.round(c.right); worst = (child.className || child.tagName).toString().slice(0, 40) + ':' + (child.textContent || '').trim().slice(0, 20) }
      }
      out.push({ selector, scrollW: el.scrollWidth, clientW: el.clientWidth, right: Math.round(r.right), maxRight, worst,
        ok: (scroller || el.scrollWidth <= el.clientWidth) && maxRight <= asideLeft })
    }
  }
  return { asideLeft, body: { left: Math.round(body.left), right: Math.round(body.right), width: Math.round(body.width) },
    placement: document.querySelector('.tasks-main')?.dataset.detailLayout ?? null, items: out }
})()`)

const VIEWS = {
  board: [{ selector: '[data-tasks-scroll="board"]', scroller: true }, { selector: '.tasks-filters' }],
  backlog: [{ selector: '[data-tasks-scroll="backlog"]', scroller: true }, { selector: '.tasks-backlog-head' }, { selector: '[data-tasks-scroll="backlog"] .tasks-row' }],
  list: [{ selector: '.tasks-list-scroll', scroller: true }, { selector: '.tasks-list-tools' }, { selector: '.tasks-list-scroll .tasks-row' }, { selector: '.tasks-list-group' }],
  working: [{ selector: '.tasks-body > *', scroller: true }, { selector: '.tasks-body .tasks-empty, .tasks-body .tasks-working-item' }],
}

fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-670 q-minpush ${new Date().toISOString()} ROOT=${ROOT}`)
let exitCode = 1
try {
  sh(['scripts/l670/fixture-app.sh', FIXTURE])
  sh(['scripts/l670/up.sh', ROOT, 'L670_EXTRA_ARGS=--disable-backgrounding-occluded-windows'], { L670_APP_DIR: FIXTURE })
  await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: 'mock_l670_minpush', replaceId: null }).then((r) => ({ ok: r.ok }))`)
  judge('모의 연결 추가(가짜 토큰)', added?.ok === true, JSON.stringify(added))
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(pageOpen, { timeoutMs: 10_000, label: '⌘I 로 열림' })
  await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="CORE-2"]')`), { timeoutMs: 15_000, label: '보드 카드 CORE-2' })
  const tokens = await js(`(() => { const s = getComputedStyle(document.querySelector('.tasks-main')); return { panel: s.getPropertyValue('--w-issue-detail').trim(), min: s.getPropertyValue('--w-tasks-body-min').trim() } })()`)
  const target = Number.parseFloat(tokens.panel) + Number.parseFloat(tokens.min)
  log('토큰', { ...tokens, targetMain: target })
  // 창 폭 맞추기 — 1241 에서 main 을 재고 차이만큼 고친다(사이드바·경계선 실측).
  let windowWidth = 1241
  await ctl(ROOT, { cmd: 'resize-window', width: windowWidth, height: 800 })
  await sleep(400)
  const first = await mainWidth()
  windowWidth = Math.round(windowWidth + (target - first))
  await ctl(ROOT, { cmd: 'resize-window', width: windowWidth, height: 800 })
  await sleep(400)
  const fitted = await mainWidth()
  log('창 맞춤', { first, windowWidth, main: fitted, inner: await js('innerWidth') })
  judge('창 맞춤 — main = 패널 + 최소 폭', fitted === target, JSON.stringify({ windowWidth, main: fitted, target }))
  // rAF 살아 있음(창 가림 무효 판정) — 500ms 동안 프레임 수.
  const frames = await js(`new Promise((resolve) => { let n = 0; const t0 = performance.now(); const tick = () => { n += 1; if (performance.now() - t0 < 500) requestAnimationFrame(tick); else resolve(n) }; requestAnimationFrame(tick) })`)
  judge('측정 유효 — rAF 가 돈다(창 가림 아님)', frames >= 10, String(frames))

  await click('[data-tasks-board] [data-issue-card="CORE-2"]')
  await until(() => js(`!!document.querySelector('[data-issue-detail="CORE-2"]')`), { timeoutMs: 10_000, label: '상세 CORE-2' })
  await sleep(300)
  for (const view of ['board', 'backlog', 'list', 'working']) {
    await click(`[data-tasks-view-tab="${view}"]`)
    await until(() => js(`document.querySelector('[data-tasks-page]')?.getAttribute('data-tasks-view') === '${view}'`), { timeoutMs: 5_000, label: `보기 ${view}` })
    await sleep(300)
    const m = await measure(VIEWS[view])
    log(`측정 ${view}`, m)
    const bad = m.items.filter((item) => !item.ok)
    judge(`M1 ${view} — 밀기 · body.right <= aside.left · 대상 ${m.items.length}개 넘침 0`, m.placement === 'push' && m.body.right <= m.asideLeft && m.items.length > 0 && bad.length === 0, JSON.stringify({ placement: m.placement, body: m.body, asideLeft: m.asideLeft, n: m.items.length, bad }))
    await shot(`q-minpush-${view}`)
  }

  // 필터 줄 최악 — 리스트 프리셋 week(「이번 주 마감」 칩) + 검색 안내.
  await click('[data-tasks-view-tab="list"]')
  await click('[data-tasks-preset="week"]')
  await until(() => js(`!!document.querySelector('[data-filter="due-week"]')`), { timeoutMs: 5_000, label: '이번 주 마감 칩' })
  await click('[data-tasks-search]')
  await ctl(ROOT, { cmd: 'type', text: 'jql:x' })
  const noted = await until(() => js(`!!document.querySelector('[data-search-note]')`), { timeoutMs: 10_000, label: '검색 안내' }).then(() => true).catch(() => false)
  await sleep(300)
  const f = await measure([{ selector: '.tasks-filters' }, { selector: '.tasks-list-tools' }])
  const note = await js(`(() => { const n = document.querySelector('[data-search-note]'); return n ? { text: n.textContent.slice(0, 40), width: Math.round(n.getBoundingClientRect().width), scrollW: n.scrollWidth } : null })()`)
  log('측정 filters-worst', { ...f, note })
  const fbad = f.items.filter((item) => !item.ok)
  judge('M1 필터 줄 최악(이번 주 마감 칩 + 검색 안내) — 넘침 0', noted && f.placement === 'push' && fbad.length === 0, JSON.stringify({ noted, note, bad: fbad, asideLeft: f.asideLeft }))
  await shot('q-minpush-filters-worst')

  const failed = verdicts.filter((verdict) => !verdict.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
  exitCode = 1
} finally {
  try { sh(['scripts/l670/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
