#!/usr/bin/env node
// LIFE-601 최종 관문 1단계 — `native-checklist.md` C5·C7·C9 표의 `격리-스크립트` 분기 전부를 한 실행으로. app/ 에서(먼저 `npm run build`):
//
//   node scripts/l601/q-final.mjs <ROOT=/tmp/l601g-*> <OUT 파일>
//
// 격리 개발 앱(up.sh — 모의 출처 `CORRAL_WORK_MOCK=1`, 임시 userData) 하나에서 연결 토큰을 분기마다 바꿔 가며(`addWorkConnection replaceId` —
// 모의 출처의 서버 상태는 앱 실행 동안 하나라 앞 분기의 쓰기가 남는다. 그래서 기대는 고정 키가 아니라 **분기 시작 때 서버 재조회 값**에서 정한다).
// 끌기는 전부 raw-mouse(`webContents.sendInputEvent`). 기대가 서버 값인 분기는 renderer `workRequest` 로 **서버를 다시 읽어** 판정한다.
// 단추 누르기(배너·빈 상태·메뉴)는 control `click` 또는 DOM click, 입력 값은 DOM setter — 끌기만 실제 마우스 경로다.
// 분기별 결과 = <OUT>.branches.json · 캡처 = <ROOT>/shots/g-<분기>.png.
// 음성 대조: `L601_INVERT=<분기 id,…>` 면 그 분기의 판정을 뒤집는다(판정식이 실패를 잡는지 — 종료코드 1 이어야 한다).
// 쓰기 수 = main 로그 `work.request` 의 쓰기 op 줄 — **응답 때** 남는다(f4-12 교훈). 그래서 「쓰기 0」 은 놓은 뒤 충분히 기다린 수로 본다.
// 종료 코드: 0 분기 전부 통과 · 1 하나라도 미달(또는 오류) · 2 사용법.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const [ROOT, OUT] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l601g-') || OUT === undefined) {
  console.error('사용법: node scripts/l601/q-final.mjs /tmp/l601g-<n> <OUT 파일>')
  process.exit(2)
}
const INVERT = new Set((process.env.L601_INVERT ?? '').split(',').filter((entry) => entry.length > 0))
const log = recorder(path.resolve(OUT))
const branches = []
const judge = ({ id, table, token, expect, pass, detail }) => {
  const inverted = INVERT.has(id)
  const result = inverted ? !pass : pass
  branches.push({ id, table, token, expect, pass: result, inverted, detail })
  log(`[분기] ${id} ${result ? '통과' : '미달'}${inverted ? ' (음성 대조 — 판정 뒤집음)' : ''} — ${expect}`, JSON.stringify(detail))
  // 하네스 고치기용 — 그 분기까지만 돌고 멈춘다(판정 실행에는 쓰지 않는다).
  if (process.env.L601_STOP === id) throw new Error('L601_STOP')
}
const sh = (args) => {
  const run = spawnSync('sh', args, { cwd: APP, encoding: 'utf8' })
  log(`$ sh ${args.join(' ')} → exit ${run.status}`)
  log((run.stdout + run.stderr).trim().replaceAll(process.env.HOME ?? '~', '~'))
  if (run.status !== 0) throw new Error(`${args[0]} 실패`)
}
const js = (code) => evalJs(ROOT, code)
const q = (selector) => js(`!!document.querySelector(${JSON.stringify(selector)})`)
const click = async (selector) => {
  let last = null
  await until(async () => { last = await ctl(ROOT, { cmd: 'click', selector }); return last.ok }, { timeoutMs: 10_000, everyMs: 250, label: selector }).catch(() => null)
  if (!last?.ok) throw new Error(`클릭 실패 ${selector} ${JSON.stringify(last)}`)
}
const clickText = (selector, text) => js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!e) return false; e.click(); return true })()`)
const shot = async (name) => { const r = await ctl(ROOT, { cmd: 'shot', name: `g-${name}` }); return r.file?.replaceAll(ROOT, '<ROOT>') ?? null }
const pageOpen = () => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`)
const toggle = async (want) => {
  if ((await pageOpen()) === want) return
  await ctl(ROOT, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
  await until(async () => (await pageOpen()) === want, { timeoutMs: 10_000, label: want ? '열림' : '닫힘' })
  await sleep(300)
}
const center = (selector, where = 'mid') => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 120)), y: Math.round(${where === 'bottom' ? 'r.bottom - 6' : where === 'top' ? 'r.top + 3' : 'r.y + r.height / 2'}) } })()`)
const writeLines = () => {
  try { return fs.readFileSync(path.join(ROOT, 'ud/corral.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"tag":"work.request"') && /"op":"(changeStatus|setPlacement|reorder)"/.test(line)).length } catch { return null }
}
const opLines = (op) => {
  try { return fs.readFileSync(path.join(ROOT, 'ud/corral.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"tag":"work.request"') && line.includes(`"op":"${op}"`)).length } catch { return null }
}
const setInput = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
const setSelect = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)

let connectionId = null
const ask = (call) => js(`window.corral.workRequest({ requestId: 'q-final-' + Date.now() + Math.random(), connectionId: ${JSON.stringify(connectionId)}, call: ${JSON.stringify(call)} })`)
/** 서버 재조회 — 스페이스의 전 쪽(서버 순서 그대로). */
const serverItems = async (spaceKey = 'CORE') => {
  const all = []
  let cursor = null
  for (let page = 0; page < 10; page += 1) {
    const response = await ask({ op: 'listItems', spaceKey, cursor })
    if (!response?.ok) return null
    all.push(...response.result.items)
    cursor = response.result.nextCursor
    if (cursor === null) break
  }
  return all
}
const serverItem = async (key) => {
  const response = await ask({ op: 'findByKey', key })
  return response?.ok && response.result.op === 'findByKey' ? response.result.item : null
}
const cardColumn = (key) => js(`document.querySelector('[data-issue-card="${key}"]')?.closest('[data-board-column]')?.getAttribute('data-board-column') ?? null`)
const columnCards = (column) => js(`[...document.querySelectorAll('[data-board-column="${column}"] [data-issue-card]')].map((e) => e.getAttribute('data-issue-card'))`)
const view = async (tab) => {
  await click(`[data-tasks-view-tab="${tab}"]`)
  await sleep(300)
}
const settled = async () => {
  await until(async () => !(await q('[data-tasks-loading]')) && !(await q('[data-tasks-refreshing]')), { timeoutMs: 15_000, everyMs: 200, label: '불러오기 끝' }).catch(() => null)
  await sleep(400)
}
/** 연결 토큰 바꾸기 — 처음이면 더하고, 있으면 그 연결을 교체(세대 +1 → 페이지가 다시 받는다). */
const connect = async (token) => {
  const result = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: ${JSON.stringify(token)}, replaceId: ${JSON.stringify(connectionId)} }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null, generation: r.ok ? r.connection.generation : null, kind: r.ok ? null : r.error.kind }))`)
  log('connect', { token, ...result })
  if (!result?.ok) throw new Error(`연결 실패 ${token}`)
  connectionId = result.id
  await sleep(500)
  await settled()
  // 오류 토큰이 아니면 앞 분기의 배너(그동안 손잡이가 잠긴다)가 걷힐 때까지 — 걷히기 전 끌기는 잠금으로 시작되지 않는다(g-final-03).
  if (!token.includes('fault')) await until(async () => !(await q('[data-tasks-banner]')) && !(await js(`!!document.querySelector('[data-issue-card].is-locked')`)), { timeoutMs: 10_000, everyMs: 200, label: '배너·잠금 걷힘' }).catch(() => log('배너·잠금이 걷히지 않음', token))
  return result
}
/** 남은 쪽을 다 받는다 — 다음 쪽이 남아 있으면 검색·필터 빈 상태를 그리지 않는다(「더 있습니다」 — 받은 것만으로 「없음」 이라 말하지 않는 설계). */
const loadAll = async () => {
  for (let index = 0; index < 5; index += 1) {
    if (!(await q('[data-tasks-more-button]'))) return
    await click('[data-tasks-more-button]')
    await sleep(800)
  }
}
/** 앞 분기가 남긴 검색어·필터를 지운다. */
const clearView = async () => {
  await setInput('[data-tasks-search]', '')
  if (await q('[data-clear-filters]')) await click('[data-clear-filters]')
  await sleep(300)
}
const chooseSpace = async (key) => {
  await click('[data-space-switch]')
  await click(`[data-space-row="${key}"]`)
  await settled()
}
/** raw-mouse 끌기 — 누름 → 문턱 → 목표(두 번 — 틈이 밀어낸 뒤 다시 잰다) → `during` 관측 → 놓음(`upAt` 이 있으면 거기서). */
const drag = async ({ from, to, during = null, upAt = null, holdMs = 400, quick = false }) => {
  if (from === null) throw new Error('끌 대상 없음')
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', ...from })
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', x: from.x + 10, y: from.y })
  await sleep(quick ? 30 : 250)
  const point = typeof to === 'function' ? await to() : to
  if (point === null) throw new Error('놓을 자리 없음')
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', ...point })
  await sleep(quick ? 40 : holdMs)
  const again = typeof to === 'function' ? await to() : point
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseMove', ...again })
  await sleep(quick ? 20 : 120)
  const probe = await js(`({ preview: !!document.querySelector('.tasks-drag-preview'), at: document.elementFromPoint(${from.x}, ${from.y})?.className ?? null })`)
  const seen = during === null ? { probe } : { ...(await during()), probe }
  await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', ...(upAt ?? again) })
  await sleep(200)
  return { from, to: again, seen }
}
const columnView = (column) => js(`(() => { const c = document.querySelector('[data-board-column="${column}"]'); if (!c) return null; return { mode: (c.className.match(/drag-(\\w+)/) ?? [])[1] ?? null, reason: c.querySelector('[data-column-reason]')?.textContent ?? null, gap: !!c.querySelector('[data-drop-gap]') } })()`)
const sectionView = (section) => js(`(() => { const c = document.querySelector('[data-backlog-section="${section}"]'); if (!c) return null; return { mode: (c.className.match(/drag-(\\w+)/) ?? [])[1] ?? null, reason: c.querySelector('[data-column-reason]')?.textContent ?? null, gap: !!c.querySelector('[data-drop-gap]') } })()`)
const toastText = (kind) => js(`[...document.querySelectorAll('[data-toast="${kind}"]')].map((e) => e.textContent)`)
const dismissToasts = () => js(`(() => { for (const b of document.querySelectorAll('[data-sonner-toast] button[data-close-button]')) b.click(); return true })()`)
const NEXT = { 'core-todo': 'core-doing', 'core-doing': 'core-review', 'core-review': 'core-doing', 'core-done': 'core-review' }
const NOT_ALLOWED = { 'core-todo': 'core-done', 'core-doing': 'core-done', 'core-review': 'core-todo', 'core-done': 'core-todo' }
/** 보드에 보이는(서버 board 배치·알려진 상태) 카드 하나 — 조건에 맞는 첫 것. */
const pickCard = async (filter = () => true) => {
  const items = await serverItems()
  const shown = await js(`[...document.querySelectorAll('[data-tasks-board] [data-issue-card]')].map((e) => e.getAttribute('data-issue-card'))`)
  return items?.find((item) => item.placement === 'board' && NEXT[item.statusKey] !== undefined && shown.includes(item.key) && filter(item)) ?? null
}
const cardPoint = (key) => center(`[data-tasks-board] [data-issue-card="${key}"]`)
const zonePoint = (zone) => () => center(`[data-drop-zone="${zone}"]`, 'bottom')

/** 분기 하나가 예외로 끝나도 나머지를 돈다 — 예외는 미달 분기로 남긴다. */
const safe = async (fn) => {
  try { await fn() } catch (error) {
    if (String(error).includes('L601_STOP')) throw error
    judge({ id: `error-after-${branches.at(-1)?.id ?? 'start'}`, table: '-', token: '-', expect: '예외 없이 끝남', pass: false, detail: { error: String(error?.stack ?? error) } })
    await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', x: 5, y: 5 }).catch(() => null)
  }
}
fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 })
log(`# LIFE-601 q-final ${new Date().toISOString()} ROOT=${ROOT} invert=${[...INVERT].join(',') || '-'}`)
let exitCode = 1
try {
  sh(['scripts/l601/up.sh', ROOT])
  await until(() => q('[data-tasks-open]'), { timeoutMs: 30_000, label: '사이드바 「작업」' })
  // 보드 칸 넷이 다 창 안에 들게 — 기본 1180 폭이면 완료 칸이 창 밖에 걸쳐 놓는 점이 창 밖이 된다(R3-F 취소, g-final-04).
  await ctl(ROOT, { cmd: 'resize-window', width: 1500, height: 900 })
  await sleep(500)

  // ===== C5 =====
  await safe(async () => {
    await toggle(true)
    await until(() => q('[data-tasks-empty="no-connection"]'), { timeoutMs: 8_000, label: '연결 없음' }).catch(() => null)
    const detail = { empty: await q('[data-tasks-empty="no-connection"]'), action: await js(`[...document.querySelectorAll('[data-tasks-empty="no-connection"] button')].map((e) => e.textContent)`), shot: await shot('c5-no-connection') }
    judge({ id: 'c5-no-connection', table: 'C5', token: '(연결 0)', expect: 'data-tasks-empty=no-connection + 「연결 설정 열기」', pass: detail.empty === true && detail.action.includes('연결 설정 열기'), detail })
  })
  await connect('mock_demo')
  await safe(async () => {
    await chooseSpace('EMPTY')
    await until(() => q('[data-tasks-empty="space"]'), { timeoutMs: 8_000, label: '빈 스페이스' }).catch(() => null)
    const detail = { empty: await js(`document.querySelector('[data-tasks-empty]')?.getAttribute('data-tasks-empty') ?? null`), shot: await shot('c5-empty-space') }
    judge({ id: 'c5-empty-space', table: 'C5', token: 'mock_demo · 스페이스 EMPTY', expect: 'data-tasks-empty=space', pass: detail.empty === 'space', detail })
    await chooseSpace('CORE')
  })
  await safe(async () => {
    await loadAll()
    await setInput('[data-tasks-search]', 'zz없는글자zz')
    await until(() => q('[data-tasks-empty="search"]'), { timeoutMs: 5_000, label: '검색 빈' }).catch(() => null)
    const before = { empty: await js(`document.querySelector('[data-tasks-empty]')?.getAttribute('data-tasks-empty') ?? null`), action: await js(`[...document.querySelectorAll('[data-tasks-empty] button')].map((e) => e.textContent)`), shot: await shot('c5-empty-search') }
    await clickText('[data-tasks-empty] button', '검색어 지우기')
    await sleep(400)
    const after = { empty: await q('[data-tasks-empty]'), query: await js(`document.querySelector('[data-tasks-search]')?.value ?? null`), cards: await js(`document.querySelectorAll('[data-issue-card]').length`) }
    judge({ id: 'c5-empty-search', table: 'C5', token: 'mock_demo', expect: 'data-tasks-empty=search + 「검색어 지우기」(누르면 비워지고 카드가 돌아온다)', pass: before.empty === 'search' && before.action.includes('검색어 지우기') && after.empty === false && after.query === '' && after.cards > 0, detail: { before, after } })
  })
  await safe(async () => {
    await loadAll()
    await click('[data-filter="priority"]')
    const picked = await clickText('[data-tasks-menu="priority"] [role="menuitemcheckbox"]', '가장 낮음')
    await click('[data-filter="priority"]').catch(() => null)
    await until(() => q('[data-tasks-empty="filter"]'), { timeoutMs: 5_000, label: '필터 빈' }).catch(() => null)
    const before = { picked, empty: await js(`document.querySelector('[data-tasks-empty]')?.getAttribute('data-tasks-empty') ?? null`), action: await js(`[...document.querySelectorAll('[data-tasks-empty] button')].map((e) => e.textContent)`), shot: await shot('c5-empty-filter') }
    await clickText('[data-tasks-empty] button', '필터 지우기')
    await sleep(400)
    const after = { empty: await q('[data-tasks-empty]'), cards: await js(`document.querySelectorAll('[data-issue-card]').length`) }
    judge({ id: 'c5-empty-filter', table: 'C5', token: 'mock_demo', expect: '우선순위 「가장 낮음」 만 → data-tasks-empty=filter + 「필터 지우기」(누르면 카드가 돌아온다)', pass: picked === true && before.empty === 'filter' && before.action.includes('필터 지우기') && after.empty === false && after.cards > 0, detail: { before, after } })
  })
  await safe(async () => {
    await view('working')
    await until(() => q('[data-tasks-empty="working"]'), { timeoutMs: 5_000, label: '작업 중 빈' }).catch(() => null)
    const detail = { empty: await js(`document.querySelector('[data-tasks-empty]')?.getAttribute('data-tasks-empty') ?? null`), shot: await shot('c5-empty-working') }
    judge({ id: 'c5-empty-working', table: 'C5', token: 'mock_demo', expect: 'data-tasks-empty=working', pass: detail.empty === 'working', detail })
    await view('board')
  })
  for (const [kind, token, action] of [['auth', 'mock_fault-auth', '토큰 다시 붙여넣기'], ['forbidden', 'mock_fault-forbidden', null], ['offline', 'mock_fault-network', '다시 시도']]) {
    await safe(async () => {
    await connect(token)
    await until(() => q(`[data-tasks-banner="${kind}"]`), { timeoutMs: 8_000, label: `배너 ${kind}` }).catch(() => null)
    const detail = {
      banner: await js(`document.querySelector('[data-tasks-banner]')?.getAttribute('data-tasks-banner') ?? null`),
      text: await js(`document.querySelector('[data-tasks-banner]')?.textContent ?? null`),
      actions: await js(`[...document.querySelectorAll('[data-tasks-banner] button')].map((e) => e.textContent)`),
      empty: await q('[data-tasks-empty]'),
      cards: await js(`document.querySelectorAll('[data-issue-card]').length`),
      locked: await js(`[...document.querySelectorAll('[data-issue-card]')].map((e) => ({ locked: e.classList.contains('is-locked'), title: e.getAttribute('title') }))`),
      shot: await shot(`c5-banner-${kind}`),
    }
    // 토큰 교체(새 세대)는 그 스페이스 자료를 비우고 다시 받으므로 첫 응답부터 오류면 카드가 0 이다 — 그때 손잡이 흐림은 관측할 카드가 없다(단위 근거 `TasksPage.test.tsx`).
    // 카드가 있으면 전부 흐림 + 이유여야 한다.
    const lockedAll = detail.locked.every((entry) => entry.locked && typeof entry.title === 'string' && entry.title.length > 0)
    let retry = null
    if (kind === 'offline') {
      const before = opLines('listItems')
      await click('[data-tasks-retry]')
      await sleep(1_500)
      retry = { before, after: opLines('listItems') }
    }
    judge({
      id: `c5-banner-${kind}`, table: 'C5', token,
      expect: `data-tasks-banner=${kind}${action === null ? '' : ` + 「${action}」`} · 빈 상태 없음 · (카드가 있으면) 끌기 손잡이 흐림 + 이유${kind === 'offline' ? ' · 「다시 시도」 → 목록 다시 받음' : ''}`,
      pass: detail.banner === kind && (action === null || detail.actions.includes(action)) && detail.empty === false && lockedAll && (retry === null || (typeof retry.before === 'number' && retry.after > retry.before)),
      detail: { ...detail, retry },
    })
    })
  }

  // ===== C7 =====
  await connect('mock_demo')
  await clearView()
  await safe(async () => {
    const card = await pickCard()
    const target = `st:${NEXT[card?.statusKey]}`
    const blocked = `st:${NOT_ALLOWED[card?.statusKey]}`
    const writes0 = writeLines()
    const moved = await drag({ from: await cardPoint(card?.key), to: zonePoint(`col:${target}`), holdMs: 700, during: async () => ({ target: await columnView(target), blocked: await columnView(blocked), shot: await shot('c7-allowed-dragging') }) })
    await until(async () => (await toastText('moved')).length > 0, { timeoutMs: 5_000, label: '이동 토스트' }).catch(() => null)
    await sleep(500)
    const after = { column: await cardColumn(card?.key), toast: await toastText('moved'), server: (await serverItem(card?.key))?.statusKey, writes: writeLines() - writes0 }
    judge({
      id: 'c7-allowed-after', table: 'C7', token: 'mock_demo',
      expect: '허용 칸 = 틈 + 쓰기 + 토스트 + 서버 재조회 값 바뀜 · 불허 칸 흐림 + 「워크플로에 이 전이가 없습니다」',
      pass: card !== null && moved.seen.target?.gap === true && moved.seen.target?.mode === 'target' && moved.seen.blocked?.mode === 'blocked' && moved.seen.blocked?.reason?.includes('워크플로에 이 전이가 없습니다')
        && after.column === target && after.toast.length > 0 && after.server === NEXT[card.statusKey] && after.writes === 1,
      detail: { card: card?.key, from: card?.statusKey, seen: moved.seen, after },
    })
    await dismissToasts()
  })
  await connect('mock_delay-800')
  await safe(async () => {
    const card = await pickCard()
    const target = `st:${NEXT[card?.statusKey]}`
    const writes0 = writeLines()
    const moved = await drag({ from: await cardPoint(card?.key), to: zonePoint(`col:${target}`), quick: true, during: async () => ({ target: await columnView(target) }) })
    await sleep(2_500)
    const after = { column: await cardColumn(card?.key), server: (await serverItem(card?.key))?.statusKey, writes: writeLines() - writes0 }
    judge({
      id: 'c7-allowed-before', table: 'C7', token: 'mock_delay-800',
      expect: '허용 전이를 받기 전 놓기 = 칸 흐림 「허용 전이를 받는 중…」 · 쓰기 0 · 서버 값 그대로',
      pass: card !== null && moved.seen.target?.mode === 'blocked' && moved.seen.target?.reason?.includes('허용 전이를 받는 중') && after.writes === 0 && after.server === card.statusKey && after.column === `st:${card.statusKey}`,
      detail: { card: card?.key, from: card?.statusKey, seen: moved.seen, after },
    })
  })
  await connect('mock_transition-any')
  await safe(async () => {
    // 허용 목록 밖이어야 한다 — core-done 으로 바로 못 가는 상태(core-todo·core-doing)의 카드.
    const card = await pickCard((item) => item.statusKey === 'core-todo' || item.statusKey === 'core-doing')
    const target = 'st:core-done'
    const writes0 = writeLines()
    const moved = await drag({ from: await cardPoint(card?.key), to: zonePoint(`col:${target}`), during: async () => ({ target: await columnView(target) }) })
    await until(async () => (await toastText('moved')).length > 0, { timeoutMs: 5_000, label: '이동 토스트' }).catch(() => null)
    await sleep(500)
    const after = { column: await cardColumn(card?.key), toast: await toastText('moved'), server: (await serverItem(card?.key))?.statusKey, writes: writeLines() - writes0 }
    judge({
      id: 'c7-any', table: 'C7', token: 'mock_transition-any',
      expect: '모든 상태 칸 열림 · 허용 목록 밖 칸(→ core-done)에 놓아도 출처가 받는다(토스트 + 서버 재조회 core-done)',
      pass: card !== null && NOT_ALLOWED[card.statusKey] === 'core-done' && moved.seen.target?.mode === 'target' && after.column === target && after.toast.length > 0 && after.server === 'core-done' && after.writes === 1,
      detail: { card: card?.key, from: card?.statusKey, seen: moved.seen, after },
    })
    await dismissToasts()
  })
  /** 같은 칸 세로 — 카드가 둘 이상인 칸의 마지막 카드를 맨 위로. */
  const verticalBranch = async ({ id, token, expect, judgeFn }) => {
    await connect(token)
    const columns = await js(`[...document.querySelectorAll('[data-tasks-board] [data-board-column]')].map((c) => ({ id: c.getAttribute('data-board-column'), cards: [...c.querySelectorAll('[data-issue-card]')].map((e) => e.getAttribute('data-issue-card')) })).filter((c) => !c.id.includes('__unmapped'))`)
    const column = columns.sort((a, b) => b.cards.length - a.cards.length)[0]
    const key = column?.cards.at(-1)
    const serverOrder = async () => (await serverItems())?.filter((item) => `st:${item.statusKey}` === column?.id && item.placement === 'board').map((item) => item.key) ?? null
    const before = await serverOrder()
    const writes0 = writeLines()
    const moved = await drag({ from: await cardPoint(key), to: () => center(`[data-board-column="${column?.id}"] [data-issue-card]`, 'top'), during: async () => ({ column: await columnView(column?.id), shot: await shot(`${id}-dragging`) }) })
    await sleep(1_500)
    const after = { screen: await columnCards(column?.id), server: await serverOrder(), writes: writeLines() - writes0 }
    judge({ id, table: 'C7', token, expect, pass: column !== undefined && column.cards.length >= 2 && judgeFn({ key, before, seen: moved.seen, after }), detail: { column: column?.id, key, before, seen: moved.seen, after } })
    await dismissToasts()
  }
  await safe(() => verticalBranch({
    id: 'c7-order-on', token: 'mock_demo', expect: '같은 칸 세로 = reorder 쓰기 1 · 서버 재조회 순서에서 맨 앞 · 화면 = 서버',
    judgeFn: ({ key, seen, after }) => seen.column?.mode === 'target' && after.writes === 1 && after.server?.[0] === key && JSON.stringify(after.screen) === JSON.stringify(after.server),
  }))
  await safe(() => verticalBranch({
    id: 'c7-order-off', token: 'mock_cap-order-off', expect: '세로 = 칸 흐림 + 「순서를 바꿀 수 없습니다 — …」 · 요청 0 · 서버 순서 그대로',
    judgeFn: ({ before, seen, after }) => seen.column?.mode === 'blocked' && seen.column?.reason?.includes('순서를 바꿀 수 없습니다') && after.writes === 0 && JSON.stringify(after.server) === JSON.stringify(before),
  }))
  await safe(() => verticalBranch({
    id: 'c7-order-hide', token: 'mock_cap-order-hide', expect: '세로 = 표시 없음(이유 줄·틈 없음) · 요청 0 · 서버 순서 그대로',
    judgeFn: ({ before, seen, after }) => seen.column?.mode === 'source' && seen.column?.reason === null && seen.column?.gap === false && after.writes === 0 && JSON.stringify(after.server) === JSON.stringify(before),
  }))
  await connect('mock_demo')
  await safe(async () => {
    await view('backlog')
    const key = await js(`document.querySelector('[data-backlog-section="board"] [data-issue-row]')?.getAttribute('data-issue-row') ?? null`)
    const writes0 = writeLines()
    const moved = await drag({ from: await center(`[data-backlog-section="board"] [data-issue-row="${key}"] .tasks-grip`), to: () => center('[data-drop-zone="sec:backlog"]', 'bottom'), during: async () => ({ section: await sectionView('backlog') }) })
    await until(async () => (await serverItem(key))?.placement === 'backlog', { timeoutMs: 5_000, label: '배치 backlog' }).catch(() => null)
    const mid = { section: await js(`document.querySelector('[data-issue-row="${key}"]')?.closest('[data-backlog-section]')?.getAttribute('data-backlog-section') ?? null`), server: (await serverItem(key))?.placement }
    await dismissToasts()
    await drag({ from: await center(`[data-backlog-section="backlog"] [data-issue-row="${key}"] .tasks-grip`), to: () => center('[data-drop-zone="sec:board"]', 'bottom') })
    await until(async () => (await serverItem(key))?.placement === 'board', { timeoutMs: 5_000, label: '배치 board' }).catch(() => null)
    const after = { server: (await serverItem(key))?.placement, writes: writeLines() - writes0 }
    judge({
      id: 'c7-placement-on', table: 'C7', token: 'mock_demo', expect: '섹션 사이 = setPlacement — 서버 재조회 backlog, 반대로 끌면 board(쓰기 2)',
      pass: key !== null && moved.seen.section?.mode === 'target' && mid.section === 'backlog' && mid.server === 'backlog' && after.server === 'board' && after.writes === 2,
      detail: { key, seen: moved.seen, mid, after },
    })
    await dismissToasts()
    await view('board')
  })
  await connect('mock_cap-placement-off')
  await safe(async () => {
    const tab = await js(`(() => { const t = document.querySelector('[data-tasks-view-tab="backlog"]'); return t ? { disabled: t.getAttribute('aria-disabled'), title: t.getAttribute('title'), cls: t.className } : null })()`)
    await click('[data-tasks-view-tab="backlog"]')
    await sleep(400)
    const after = { backlogShown: await q('[data-tasks-backlog]'), shot: await shot('c7-placement-off-tab') }
    judge({
      id: 'c7-placement-off', table: 'C7', token: 'mock_cap-placement-off', expect: '백로그 탭 흐림(aria-disabled) + 이유(title) · 눌러도 백로그 보기로 가지 않음(섹션 끌기는 보기가 없어 닿지 않음)',
      pass: tab?.disabled === 'true' && typeof tab.title === 'string' && tab.title.length > 0 && after.backlogShown === false,
      detail: { tab, after },
    })
  })
  await connect('mock_cap-placement-hide')
  await safe(async () => {
    const tabs = await js(`[...document.querySelectorAll('[data-tasks-view-tab]')].map((e) => e.getAttribute('data-tasks-view-tab'))`)
    judge({ id: 'c7-placement-hide', table: 'C7', token: 'mock_cap-placement-hide', expect: '백로그 탭 없음', pass: Array.isArray(tabs) && tabs.length > 0 && !tabs.includes('backlog'), detail: { tabs } })
  })
  await connect('mock_reject-writes')
  await safe(async () => {
    const card = await pickCard()
    const target = `st:${NEXT[card?.statusKey]}`
    const writes0 = writeLines()
    await drag({ from: await cardPoint(card?.key), to: zonePoint(`col:${target}`), holdMs: 700 })
    await until(async () => (await toastText('failed')).length > 0, { timeoutMs: 5_000, label: '오류 토스트' }).catch(() => null)
    await sleep(800)
    const after = { column: await cardColumn(card?.key), failed: await toastText('failed'), server: (await serverItem(card?.key))?.statusKey, writes: writeLines() - writes0, shot: await shot('c7-reject') }
    judge({
      id: 'c7-reject', table: 'C7', token: 'mock_reject-writes', expect: '놓은 뒤 카드가 원래 칸 + 오류 토스트 · 서버 값 그대로',
      pass: card !== null && after.column === `st:${card.statusKey}` && after.failed.length > 0 && after.server === card.statusKey && after.writes === 1,
      detail: { card: card?.key, from: card?.statusKey, after },
    })
    await dismissToasts()
  })
  await connect('mock_demo')
  const undoPoint = (label) => js(`(() => { const t = [...document.querySelectorAll('[data-toast="moved"]')].find((e) => e.textContent.includes(${JSON.stringify(label)})); const b = t?.querySelector('[data-toast-undo]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const press = async (point) => {
    await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseDown', ...point })
    await ctl(ROOT, { cmd: 'raw-mouse', type: 'mouseUp', ...point })
  }
  for (const otherSpace of [false, true]) {
    await safe(async () => {
    const id = otherSpace ? 'c7-undo-other-space' : 'c7-undo'
    const card = await pickCard()
    const target = `st:${NEXT[card?.statusKey]}`
    await drag({ from: await cardPoint(card?.key), to: zonePoint(`col:${target}`), holdMs: 700 })
    await until(async () => (await undoPoint(card?.key)) !== null, { timeoutMs: 5_000, label: '되돌리기 버튼' }).catch(() => null)
    const moved = (await serverItem(card?.key))?.statusKey
    if (otherSpace) await chooseSpace('WEB')
    const point = await undoPoint(card?.key)
    if (point !== null) await press(point)
    await until(async () => (await serverItem(card?.key))?.statusKey === card?.statusKey, { timeoutMs: 5_000, label: '되돌림 서버' }).catch(() => null)
    const after = { server: (await serverItem(card?.key))?.statusKey, undone: await toastText('undone') }
    if (otherSpace) await chooseSpace('CORE')
    const screen = await cardColumn(card?.key)
    judge({
      id, table: 'C7', token: 'mock_demo', expect: `토스트 「되돌리기」 → 역요청 · 서버 원래 값${otherSpace ? ' — 다른 스페이스(WEB)로 옮긴 뒤 눌러도' : ''} · 화면 = 서버`,
      pass: card !== null && moved === NEXT[card.statusKey] && point !== null && after.server === card.statusKey && screen === `st:${card.statusKey}`,
      detail: { card: card?.key, from: card?.statusKey, moved, point, after, screen },
    })
    await dismissToasts()
    })
  }
  // 경합 — 같은 카드: 확인 전 같은 카드 다시 끌기 = 손잡이 흐림 · 쓰기 0. 잠금 창을 넓히려고 모든 요청 1.5초(`delay-1500`) — flip 은 홀짝에 따라 첫 쓰기가 안 늦을 수 있다.
  await connect('mock_delay-1500')
  await safe(async () => {
    const card = await pickCard()
    const target = `st:${NEXT[card?.statusKey]}`
    await sleep(1_000)
    const writes0 = writeLines()
    await drag({ from: await cardPoint(card?.key), to: zonePoint(`col:${target}`), holdMs: 2_000 })
    await sleep(100)
    const lock = await js(`(() => { const e = document.querySelector('[data-issue-card="${card?.key}"]'); return e ? { locked: e.classList.contains('is-locked'), title: e.getAttribute('title') } : null })()`)
    const lockShot = await shot('c7-race-same-locked')
    const second = await drag({ from: await cardPoint(card?.key), to: zonePoint(`col:st:${card?.statusKey}`), during: async () => ({ preview: await q('.tasks-drag-preview') }) })
    await sleep(3_500)
    const after = { column: await cardColumn(card?.key), server: (await serverItem(card?.key))?.statusKey, writes: writeLines() - writes0 }
    judge({
      id: 'c7-race-same', table: 'C7', token: 'mock_delay-1500', expect: '확인 전 같은 카드 = 손잡이 흐림 + 「앞 변경을 출처가 확인하는 중…」 · 다시 끌기 사본 없음 · 쓰기 1(두 번째 0) · 확인 뒤 화면 = 서버 재조회 값',
      pass: card !== null && lock?.locked === true && lock.title?.includes('확인하는 중') && second.seen.preview === false && after.writes === 1 && after.server === NEXT[card.statusKey] && after.column === `st:${after.server}`,
      detail: { card: card?.key, from: card?.statusKey, lock, lockShot, second: second.seen, after },
    })
    await dismissToasts()
  })
  // 경합 — 다른 카드 순서 둘(q-entry R3-A 와 같은 모양).
  await connect('mock_transition-any_flip-2000')
  await safe(async () => {
    await view('backlog')
    await sleep(2_500)
    for (let index = 0; index < 3; index += 1) {
      const started = Date.now()
      await ask({ op: 'getItem', itemId: 'm-1' })
      if (Date.now() - started < 1_000) break
    }
    const shownRows = () => js(`[...document.querySelectorAll('[data-backlog-section="board"] [data-issue-row]')].map((e) => e.dataset.issueRow)`)
    const edge = (which) => () => js(`(() => { const rows = [...document.querySelectorAll('[data-backlog-section="board"] [data-issue-row]')]; const r = rows[${which === 'bottom' ? 'rows.length - 1' : '0'}].getBoundingClientRect(); return { x: Math.round(r.x + 200), y: Math.round(${which === 'bottom' ? 'r.bottom - 2' : 'r.top + 2'}) } })()`)
    const traceBefore = (() => { try { return fs.readFileSync(path.join(ROOT, 'ipc-trace.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"op":"reorder"')).length } catch { return 0 } })()
    const initial = await shownRows()
    const moveA = initial.at(-2)
    const moveB = initial.at(-1)
    await drag({ from: await center(`[data-backlog-section="board"] [data-issue-row="${moveA}"] .tasks-grip`), to: edge('bottom'), holdMs: 120 })
    const afterA = await shownRows()
    await drag({ from: await center(`[data-backlog-section="board"] [data-issue-row="${moveB}"] .tasks-grip`), to: edge('top'), holdMs: 120 })
    const afterB = await shownRows()
    let final = null
    await until(async () => {
      const screen = await shownRows()
      const server = (await serverItems())?.filter((item) => item.placement === 'board').map((item) => item.key) ?? null
      final = { screen, server: server?.filter((key) => screen.includes(key)) ?? null }
      return final.server !== null && JSON.stringify(final.screen) === JSON.stringify(final.server)
    }, { timeoutMs: 20_000, everyMs: 1_000, label: '화면 = 서버 순서' }).catch(() => null)
    const replies = (() => { try { return fs.readFileSync(path.join(ROOT, 'ipc-trace.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"op":"reorder"')).slice(traceBefore).map((line) => JSON.parse(line).value?.result?.item?.key ?? null) } catch { return null } })()
    judge({
      id: 'c7-race-reorder-two', table: 'C7', token: 'mock_transition-any_flip-2000', expect: '다른 카드 순서 둘 — IPC 응답 B→A · 둘 다 옮겨짐 · 끝나면 화면 순서 = 서버 재조회 순서',
      pass: JSON.stringify(replies) === JSON.stringify([moveB, moveA]) && initial.length >= 3 && afterA.at(-1) === moveA && afterB[0] === moveB && final !== null && JSON.stringify(final.screen) === JSON.stringify(final.server),
      detail: { initial, moveA, moveB, afterA, afterB, replies, final, shot: await shot('c7-race-reorder-two') },
    })
    await view('board')
  })
  // 경합 — 다른 카드·새로고침: 두 카드를 옮기는 사이 페이지를 닫았다 열어(조용한 재조회) 끼운다. 두 모드 각각, 끝나면 화면 = 서버.
  for (const token of ['mock_flip-400', 'mock_flipapply-400']) {
    await safe(async () => {
    await connect(token)
    const first = await pickCard()
    const second = await pickCard((item) => item.key !== first?.key && item.statusKey !== first?.statusKey) ?? await pickCard((item) => item.key !== first?.key)
    const writes0 = writeLines()
    await drag({ from: await cardPoint(first?.key), to: zonePoint(`col:st:${NEXT[first?.statusKey]}`), holdMs: 1_000 })
    await toggle(false)
    await toggle(true)
    const reopened = await cardColumn(first?.key)
    await drag({ from: await cardPoint(second?.key), to: zonePoint(`col:st:${NEXT[second?.statusKey]}`), holdMs: 1_000 })
    await sleep(3_000)
    const server = { first: (await serverItem(first?.key))?.statusKey, second: (await serverItem(second?.key))?.statusKey }
    const screen = { first: await cardColumn(first?.key), second: await cardColumn(second?.key) }
    const items = await serverItems()
    const whole = await js(`[...document.querySelectorAll('[data-tasks-board] [data-issue-card]')].map((e) => [e.getAttribute('data-issue-card'), e.closest('[data-board-column]')?.getAttribute('data-board-column')])`)
    const mismatch = whole.filter(([key, column]) => { const item = items?.find((entry) => entry.key === key); return item === undefined || `st:${item.statusKey}` !== column && !column.includes('__unmapped') })
    const id = token === 'mock_flip-400' ? 'c7-race-refresh-flip' : 'c7-race-refresh-flipapply'
    judge({
      id, table: 'C7', token, expect: '옮기는 중 새로고침(닫고 열기)이 끼어도 옮긴 값이 남는다 · 두 쓰기 반영 · 끝난 뒤 화면 = 서버 재조회 값(보드 전부)',
      pass: first !== null && second !== null && reopened === `st:${NEXT[first.statusKey]}` && server.first === NEXT[first.statusKey] && server.second === NEXT[second.statusKey]
        && screen.first === `st:${server.first}` && screen.second === `st:${server.second}` && mismatch.length === 0 && writeLines() - writes0 === 2,
      detail: { first: first?.key, firstFrom: first?.statusKey, second: second?.key, secondFrom: second?.statusKey, reopened, server, screen, mismatch, writes: writeLines() - writes0 },
    })
    await dismissToasts()
    })
  }

  // ===== C9 =====
  await connect('mock_demo')
  const freshList = async () => {
    await chooseSpace('WEB')
    await chooseSpace('CORE')
    await view('list')
    await sleep(400)
  }
  const listRows = () => js(`[...document.querySelectorAll('[data-tasks-list] [data-issue-row]')].map((e) => e.getAttribute('data-issue-row'))`)
  await safe(async () => {
    await freshList()
    const before = await listRows()
    const bar = await js(`document.querySelector('[data-tasks-more]')?.getAttribute('data-tasks-more') ?? null`)
    await click('[data-tasks-more-button]')
    await until(async () => (await listRows()).length > before.length, { timeoutMs: 8_000, label: '다음 쪽' }).catch(() => null)
    const after = { rows: await listRows(), bar: await js(`document.querySelector('[data-tasks-more]')?.getAttribute('data-tasks-more') ?? null`) }
    const total = (await serverItems())?.length ?? null
    judge({ id: 'c9-cursor', table: 'C9', token: 'mock_demo', expect: '「더 불러오기」 → 다음 쪽이 붙고(행 = 서버 전체) 줄이 사라진다', pass: bar === '' && after.rows.length > before.length && after.rows.length === total && after.bar === null, detail: { before, bar, after, total } })
  })
  // 늦은 쪽 폐기 — 「더 불러오기」 직후 정렬을 바꾸면 늦게 온 쪽을 붙이지 않는다. 쪽 요청이 늦어야 해서 `delay-1500`(flip 은 홀짝에 따라 안 늦을 수 있다).
  await connect('mock_delay-1500')
  await safe(async () => {
    await freshList()
    await sleep(2_000)
    const before = await listRows()
    const sort0 = await js(`document.querySelector('[data-tasks-sort]')?.value ?? null`)
    await click('[data-tasks-more-button]')
    await sleep(100)
    const loading = await js(`document.querySelector('[data-tasks-more-button]')?.textContent ?? null`)
    const other = await js(`[...document.querySelector('[data-tasks-sort]').options].map((o) => o.value).find((v) => v !== ${JSON.stringify(sort0)}) ?? null`)
    await setSelect('[data-tasks-sort]', other)
    await sleep(3_000)
    const after = { rows: await listRows(), button: await js(`document.querySelector('[data-tasks-more-button]')?.textContent ?? null`), disabled: await js(`document.querySelector('[data-tasks-more-button]')?.disabled ?? null`) }
    await click('[data-tasks-more-button]')
    await until(async () => (await listRows()).length > before.length, { timeoutMs: 8_000, label: '다시 받은 쪽' }).catch(() => null)
    const again = await listRows()
    await setSelect('[data-tasks-sort]', sort0)
    judge({
      id: 'c9-late-page', table: 'C9', token: 'mock_delay-1500', expect: '「더 불러오기」 직후 정렬 변경 → 늦게 온 쪽을 붙이지 않음 · 단추가 「불러오는 중」 에 갇히지 않음 · 다시 누르면 붙는다(양성)',
      pass: loading?.includes('불러오는 중') && after.rows.length === before.length && after.button === '더 불러오기' && after.disabled === false && again.length > before.length,
      detail: { before: before.length, sort0, other, loading, after: { ...after, rows: after.rows.length }, again: again.length },
    })
  })
  await connect('mock_demo')
  await safe(async () => {
    await freshList()
    await click('[data-tasks-more-button]')
    await until(async () => (await js(`document.querySelector('[data-tasks-more]')`)) === null, { timeoutMs: 8_000, label: '전부 받음' }).catch(() => null)
    // 스크롤이 생기게 창을 낮춘다 — 스크롤 위치는 DOM scrollTop 으로 둔다(사용자 휠과 같은 상태).
    await ctl(ROOT, { cmd: 'resize-window', width: 1100, height: 430 })
    await sleep(600)
    await js(`(() => { const s = document.querySelector('[data-tasks-scroll="list"]'); s.scrollTop = 60; s.dispatchEvent(new Event('scroll')); return s.scrollTop })()`)
    await sleep(200)
    const before = { rows: await listRows(), scroll: await js(`document.querySelector('[data-tasks-scroll="list"]')?.scrollTop ?? null`), max: await js(`(() => { const s = document.querySelector('[data-tasks-scroll="list"]'); return s.scrollHeight - s.clientHeight })()`) }
    await toggle(false)
    await toggle(true)
    await settled()
    const after = { rows: await listRows(), scroll: await js(`document.querySelector('[data-tasks-scroll="list"]')?.scrollTop ?? null`), view: await js(`document.querySelector('[data-tasks-view-tab][aria-selected="true"]')?.getAttribute('data-tasks-view-tab') ?? null`) }
    await ctl(ROOT, { cmd: 'resize-window', width: 1500, height: 900 })
    judge({
      id: 'c9-reopen', table: 'C9', token: 'mock_demo', expect: '「더 불러오기」 뒤 ⌘I 닫기·열기 → 받은 행 수·스크롤 그대로',
      pass: before.rows.length > 0 && before.scroll > 0 && JSON.stringify(after.rows) === JSON.stringify(before.rows) && Math.abs(after.scroll - before.scroll) <= 2 && after.view === 'list',
      detail: { before: { ...before, rows: before.rows.length }, after: { ...after, rows: after.rows.length } },
    })
  })

  const failed = branches.filter((branch) => !branch.pass)
  log(`분기 ${branches.length - failed.length}/${branches.length} 통과`, failed.map((branch) => branch.id).join(',') || '-')
  exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  log('오류', String(error?.stack ?? error))
  exitCode = 1
} finally {
  fs.writeFileSync(path.resolve(`${OUT}.branches.json`), JSON.stringify({ at: new Date().toISOString(), root: ROOT, invert: [...INVERT], total: branches.length, passed: branches.filter((branch) => branch.pass).length, branches }, null, 2))
  try { sh(['scripts/l601/down.sh', ROOT, 'herdr']) } catch (error) { log('down 실패', String(error)) }
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
