#!/usr/bin/env node
// LIFE-702 최종 관문 D8 — 설치본(교체 뒤) 관찰 스크립트. **준비만 — 이 작업의 워커는 사용자 런타임에 돌리지 않는다**(d8-checklist.md 순서로 사용자 승인 뒤).
//   node scripts/l702/d8-observe.mjs <CDP 포트> <OUT 파일> [최근 완료 키=LIFE-699]
//   설치본을 `--remote-debugging-port=<포트>` 로 띄운 회차에서 CDP `Runtime.evaluate` 만 쓴다(키 입력 없음 — 입력은 DOM 클릭·값 setter, 메모리 installed-app-cdp-gate).
// 판정(DOM 값):
//   ⓐ 실행 시 LA 읽기 조회(앱의 window.corral.workRequest listItems — 사용자 연결, 읽기만)로 고른 오래된 완료 키(doneAt 14일 + 1시간 이상, 보드 배치)가 보드에 없다
//   ⓑ 그 키로 검색하면 보드에 보인다 → 검색을 지우면 다시 없다
//   ⓒ 14일 미만 완료(기본 LIFE-699 — 조건이 안 맞으면 가장 최근 doneAt 의 보드 배치 완료로 대체, 대체 사실을 기록)가 보드에 보인다
// 쓰기: LA 쓰기 없음. 앱 UI 상태(작업 페이지 열림·스페이스·보기 탭)를 바꾸므로 시작 값을 적고 끝에 되돌린다(검색어는 지운다).
// 종료 코드: 0 전부 통과 · 1 미달 · 2 사용법 · 3 전제 없음(LA 연결·corral 스페이스·후보 키).
import fs from 'node:fs'
import { connect } from '../l601/cdp-drag.mjs'

const [PORT, OUT, RECENT_WANT = 'LIFE-699'] = process.argv.slice(2)
if (!/^\d+$/.test(PORT ?? '') || OUT === undefined) {
  console.error('사용법: node scripts/l702/d8-observe.mjs <CDP 포트> <OUT 파일> [최근 완료 키]')
  process.exit(2)
}
const DAY = 86_400_000
const HIDE_MS = 14 * DAY
const MARGIN_MS = 3_600_000
const lines = []
const log = (...parts) => {
  const line = parts.join(' ')
  lines.push(line)
  console.log(line)
  fs.writeFileSync(OUT, `${lines.join('\n')}\n`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push(pass)
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, JSON.stringify(detail ?? ''))
}

const cdp = await connect(PORT)
const js = (code) => cdp.evaluate(code)
const until = async (check, { timeoutMs, label }) => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await check()) return
    await sleep(250)
  }
  throw new Error(`${label} 시간 초과`)
}
const click = (selector) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e?.click(); return !!e })()`)
const boardCards = () => js(`[...document.querySelectorAll('[data-tasks-board] [data-issue-card]')].map((e) => e.getAttribute('data-issue-card'))`)
const setSearch = (value) => js(`(() => { const input = document.querySelector('[data-tasks-search]'); if (!(input instanceof HTMLInputElement)) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
const pageState = () => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return { open: !!p && !p.classList.contains('is-closed'), view: p?.getAttribute('data-tasks-view') ?? null, space: document.querySelector('[data-space-switch]')?.textContent?.trim() ?? null } })()`)

let exitCode = 1
let start = null
try {
  log(`# d8-observe ${new Date().toISOString()} port=${PORT}`)
  log('앱', JSON.stringify(await js(`({ url: location.href.replace(/^file:\\/\\/[^]*\\/app\\.asar/, 'app.asar'), ua: navigator.userAgent.match(/corral\\/[\\d.]+|Electron\\/[\\d.]+/g) })`)))
  // 1) LA 읽기 조회 — 사용자 연결로 corral 스페이스 listItems(쪽 끝까지). 쓰기 호출 없음.
  const pick = await js(`(async () => {
    const settings = await window.corral.getWorkSettings()
    const connection = settings.connections.find((c) => c.sourceId === 'la')
    if (!connection) return { error: 'LA 연결 없음' }
    const space = connection.spaces.find((s) => s.name === 'corral')
    if (!space) return { error: 'corral 스페이스 없음', spaces: connection.spaces.map((s) => s.name) }
    const items = []
    let cursor = null
    for (let page = 0; page < 20; page += 1) {
      const response = await window.corral.workRequest({ requestId: 'l702-d8-' + Date.now() + '-' + page, connectionId: connection.id, call: { op: 'listItems', spaceKey: space.key, cursor } })
      if (!response.ok) return { error: 'listItems ' + response.error.kind + ' ' + response.error.message }
      items.push(...response.result.items)
      cursor = response.result.nextCursor
      if (cursor === null) break
    }
    return { connectionId: connection.id, spaceKey: space.key, items: items.map((i) => ({ key: i.key, category: i.category, doneAt: i.doneAt, placement: i.placement, title: i.title })) }
  })()`)
  if (pick?.error) { log('전제 없음', JSON.stringify(pick)); exitCode = 3; throw new Error(pick.error) }
  const now = Date.now()
  const age = (item) => (item.doneAt === null ? null : now - Date.parse(item.doneAt))
  const doneOnBoard = pick.items.filter((item) => item.category === 'done' && item.placement !== 'backlog')
  const old = doneOnBoard.filter((item) => age(item) !== null && age(item) >= HIDE_MS + MARGIN_MS).sort((a, b) => age(a) - age(b))[0] ?? null
  const young = (item) => age(item) !== null && age(item) < HIDE_MS - MARGIN_MS
  const wanted = doneOnBoard.find((item) => item.key === RECENT_WANT && young(item)) ?? null
  const recent = wanted ?? doneOnBoard.filter(young).sort((a, b) => age(a) - age(b))[0] ?? null
  const ageDays = (item) => (item === null ? null : Math.round((age(item) / DAY) * 10) / 10)
  log('LA 읽기', JSON.stringify({ items: pick.items.length, doneOnBoard: doneOnBoard.length, doneOld: doneOnBoard.filter((item) => age(item) !== null && age(item) >= HIDE_MS).length, doneNull: doneOnBoard.filter((item) => item.doneAt === null).length }))
  log('고른 키', JSON.stringify({ old: old && { key: old.key, doneAt: old.doneAt, days: ageDays(old) }, recent: recent && { key: recent.key, doneAt: recent.doneAt, days: ageDays(recent) }, recentFallback: wanted === null ? `${RECENT_WANT} 가 14일 미만 보드 완료가 아니라 대체` : null }))
  if (old === null || recent === null) { exitCode = 3; throw new Error('후보 키 없음') }

  // 2) 화면 — 시작 값을 적고 작업 페이지 · corral 스페이스 · 보드 보기
  const first = await pageState()
  if (!first.open) { await click('[data-tasks-open]'); await until(async () => (await pageState()).open, { timeoutMs: 10_000, label: '작업 페이지' }) }
  await click('[data-space-switch]')
  await sleep(300)
  const spaceRow = await js(`document.querySelector('[data-tasks-menu="space"] .tasks-menu-row.is-on')?.getAttribute('data-space-row') ?? null`)
  await click('[data-space-switch]')
  start = { ...first, view: first.open ? first.view : (await pageState()).view, spaceRow }
  log('시작 UI', JSON.stringify(start))
  await setSearch('')
  await click('[data-space-switch]')
  await sleep(300)
  if (!(await click(`[data-space-row="${pick.spaceKey}"]`))) throw new Error('스페이스 행 없음')
  if ((await pageState()).view !== 'board') await click('[data-tasks-view-tab="board"]')
  await until(async () => (await boardCards())?.includes(recent.key), { timeoutMs: 20_000, label: '보드 카드' }).catch(() => null)
  await sleep(800)

  const board = await boardCards()
  log('ⓐ 보드 카드 수', board.length, '오래된 키 있음', board.includes(old.key), '최근 키 있음', board.includes(recent.key))
  judge(`ⓐ 오래된 완료 ${old.key}(${ageDays(old)}일) 보드에 없음`, !board.includes(old.key), { old: old.key, cards: board.length })
  judge(`ⓒ 14일 미만 완료 ${recent.key}(${ageDays(recent)}일) 보드에 보임`, board.includes(recent.key), { recent: recent.key })

  await setSearch(old.key)
  await until(async () => (await boardCards())?.includes(old.key), { timeoutMs: 10_000, label: '검색' }).catch(() => null)
  const searched = await boardCards()
  log('ⓑ 검색', old.key, JSON.stringify(searched))
  judge(`ⓑ ${old.key} 검색 → 보드에 보임`, searched.includes(old.key), { searched })
  await setSearch('')
  await sleep(1200)
  const cleared = await boardCards()
  judge('ⓑ 검색 지우면 다시 없음', !cleared.includes(old.key) && cleared.includes(recent.key), { cards: cleared.length })
  exitCode = verdicts.every(Boolean) && verdicts.length === 4 ? 0 : 1
} catch (error) {
  log('오류', String(error?.message ?? error))
} finally {
  // 3) UI 되돌리기 — 검색어 지움 · 시작 스페이스 · 시작 보기 탭 · 시작이 닫힘이면 닫는다.
  if (start !== null) {
    await setSearch('').catch(() => null)
    if (start.spaceRow !== null) {
      await click('[data-space-switch]').catch(() => null)
      await sleep(300)
      await click(`[data-space-row="${start.spaceRow}"]`).catch(() => null)
    }
    if (start.view !== null) await click(`[data-tasks-view-tab="${start.view}"]`).catch(() => null)
    if (!start.open) await click('[data-tasks-close]').catch(() => null)
    await sleep(300)
    log('끝 UI', JSON.stringify(await pageState().catch(() => null)))
  }
  log(`판정 ${verdicts.filter(Boolean).length}/${verdicts.length} 통과 · exit ${exitCode}`)
  cdp.close()
  process.exit(exitCode)
}
