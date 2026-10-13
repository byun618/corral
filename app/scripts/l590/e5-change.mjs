// LIFE-590 E5 열린 탭 외부 변경 — 격리 개발 Electron. 「외부」 = 이 스크립트가 node fs 로 쓰는 것(터미널·에이전트 대역 — 실제 claude pane 회차는 네이티브 관문).
// 조건마다 `--runs`(기본 10)회: ⓐ 활성 탭·패널 열림 ⓑ1 패널 닫힘 ⓑ2 탭 비활성(터미널 탭 활성 — 바뀐 뒤 탭을 누르면 새 내용) ⓒ 삭제 → 「삭제됨」·다시 생김 → 해제+갱신
// ⓓ 감시 유실 주입(`file-watch-drop`) 뒤 변경 ⓔ 파일 탭 50개 열고 닫기 전후 main 프로세스 fd·폴더 감시 수.
// ⓐⓑ1ⓓ 지연 = 렌더러가 모델을 바꾼 시각(`data-editor-updated`, 렌더러 Date.now) − 쓰기 시각(같은 기계 시계). 스크롤 = 첫 보이는 줄 번호가 그대로인가.
// 사용(app/ 에서): node scripts/l590/e5-change.mjs --root /tmp/l590g-x --repo /tmp/l590g-t/repo --out <file.json> [--runs 10]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, pct, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, runs: { type: 'string', default: '10' } } })
checkRoot(values.root)
const root = values.root
const repo = values.repo
const runs = Number(values.runs)
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `click ${selector}` })
const dblclick = (selector) => until(async () => (await ctl(root, { cmd: 'dblclick', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `dblclick ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const panelOpen = async () => (await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
const setPanel = async (open) => {
  if ((await panelOpen()) !== open) await key('L', ['meta'])
  await until(async () => (await panelOpen()) === open, { label: `panel ${open}` })
}
const expanded = async (rel) => (await js(`document.querySelector('[data-explorer-row="${rel}"]')?.getAttribute('aria-expanded') ?? null`)) === 'true'

const LONG = 'notes/long.txt'
const longPath = path.join(repo, LONG)
const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} — 외부 변경 측정용`)
fs.writeFileSync(longPath, lines.join('\n') + '\n')
const mutate = (tag) => {
  // 10 줄마다 표식 — 스크롤 자리가 어디든 보이는 창에 하나 이상 들어온다(줄 수는 그대로라 스크롤 자리 비교가 뜻이 있다).
  const next = lines.map((line, index) => (index % 10 === 0 ? `line ${String(index + 1).padStart(3, '0')} — ${tag}` : line))
  const t0 = Date.now()
  fs.writeFileSync(longPath, next.join('\n') + '\n')
  return t0
}
const host = `document.querySelector('[data-file-view="${LONG}"] [data-file-editor]')`
const updatedAt = () => js(`Number(${host}?.dataset.editorUpdated ?? 0)`)
const firstLine = () => js(`Math.min(...[...document.querySelectorAll('[data-file-view="${LONG}"] .margin-view-overlays .line-numbers')].map((el) => Number(el.textContent)).filter((n) => n > 0))`)
const tabDeleted = () => js(`document.querySelector('[data-main-tab="file:${LONG}"]')?.classList.contains('is-deleted') ?? null`)

const { paneId } = await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
await setPanel(true)
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
if (!(await expanded('notes'))) await click('[data-explorer-row="notes"]')
await until(() => expanded('notes'), { label: 'notes' })
await until(() => js(`document.querySelector('[data-explorer-row="${LONG}"]') !== null`), { label: 'long row' })
await dblclick(`[data-explorer-row="${LONG}"]`)
await until(() => js(`${host}?.dataset.editorReady ?? null`), { label: 'editor' })
// 180 줄쯤으로 스크롤 — 편집기를 누르고 PageDown(실제 키 입력). 합성 wheel 은 Monaco 가 받지 않았다(첫 줄 1 그대로 — 시험 회차에서 확인).
const scrollDown = async () => {
  await click(`[data-file-view="${LONG}"] [data-file-editor]`)
  for (let i = 0; i < 6; i += 1) {
    await key('PageDown')
    await sleep(60)
  }
  await sleep(300)
  const line = await firstLine()
  if (!(line > 100)) throw new Error(`스크롤 안 됨 — 첫 줄 ${line}`)
  return line
}
await scrollDown()
const result = { root, repo, runs, conditions: {} }
// 수정 r2 — 구간 계측: 렌더러 수신 시각(이 스크립트가 단 리스너) + main 확인 기록(`file-watch-status.recent`). 판정 기준은 그대로(전체 ms).
await js(`(() => { window.__e5 = []; window.corral.onFileEvent((push) => { if (push.rel === ${JSON.stringify(LONG)}) window.__e5.push({ at: Date.now(), exists: push.exists, stamp: push.stamp }) }); return true })()`)
const phases = async ({ t0, updateAt, receiptsBefore }) => {
  const receipts = (await js(`window.__e5.slice(${receiptsBefore})`)) ?? []
  const status = await ctl(root, { cmd: 'file-watch-status' })
  const checks = (status.fileWatch?.recent ?? []).filter((row) => row.endAt >= t0 - 5)
  const detect = checks.find((row) => row.pushed > 0 && !row.deferred) ?? null
  const receipt = receipts[0] ?? null
  return {
    detectMs: detect === null ? null : detect.endAt - t0,
    detectVia: detect?.via ?? null,
    ipcMs: detect === null || receipt === null ? null : receipt.at - detect.endAt,
    renderMs: receipt === null || updateAt === null ? null : updateAt - receipt.at,
    checks: checks.map((row) => ({ via: row.via, start: row.startAt - t0, end: row.endAt - t0, pushed: row.pushed, stale: row.stale, deferred: row.deferred })),
    pushes: receipts.map((push) => ({ afterT0: push.at - t0, size: typeof push.stamp === 'string' ? Number(push.stamp.split(':')[2]) : null })),
  }
}

const measureActive = async (name, before) => {
  const rows = []
  for (let i = 0; i < runs; i += 1) {
    if (before) await before(i)
    const lineBefore = await firstLine()
    const prior = await updatedAt()
    const receiptsBefore = await js(`window.__e5.length`)
    const t0 = mutate(`${name} ${i}`)
    let ms = null
    let error = null
    let updateAt = null
    try {
      const done = await until(async () => {
        const at = await updatedAt()
        return at > prior ? at : 0
      }, { timeoutMs: 5000, everyMs: 20, label: `${name} ${i}` })
      updateAt = done.value
      ms = done.value - t0
    } catch (caught) {
      error = String(caught)
    }
    await sleep(150)
    const phase = await phases({ t0, updateAt, receiptsBefore })
    const lineAfter = await firstLine()
    const shown = await js(`[...document.querySelectorAll('[data-file-view="${LONG}"] .view-line')].some((el) => el.textContent.replace(/\u00a0/g, " ").includes(${JSON.stringify(`${name} ${i}`)}))`)
    rows.push({ i, ms, error, lineBefore, lineAfter, scrollKept: lineBefore === lineAfter, shown, phase })
    await sleep(300)
  }
  const ms = rows.map((row) => row.ms).filter((value) => value !== null)
  result.conditions[name] = { rows, max: ms.length ? Math.max(...ms) : null, p50: pct(ms, 50), pass: rows.every((row) => row.ms !== null && row.ms <= 2000 && row.scrollKept && row.shown) }
  console.log(name, JSON.stringify({ max: result.conditions[name].max, p50: result.conditions[name].p50, pass: result.conditions[name].pass }))
}

// ⓐ 활성·패널 열림
await measureActive('a-active-panel-open')
// ⓑ1 패널 닫힘
await setPanel(false)
await measureActive('b1-panel-closed')
await setPanel(true)
// ⓓ 감시 유실 주입 — 회차마다 폴더 감시를 끊는다(안전망 주기 1 s 가 맞춘다)
await measureActive('d-watch-dropped', async () => {
  const status = await ctl(root, { cmd: 'file-watch-drop' })
  if (status.fileWatch?.dirWatchers !== 0) throw new Error(`drop 안 됨 ${JSON.stringify(status)}`)
})

// ⓑ2 탭 비활성 — 터미널 탭을 활성으로 두고 바꾼 뒤, 파일 탭을 누르면 새 내용
{
  const rows = []
  await click(`[data-main-tab="file:${LONG}"]`)
  await scrollDown()
  for (let i = 0; i < runs; i += 1) {
    await click('[data-main-tab]:not([data-file-tab])')
    await until(() => js(`document.querySelector('[data-file-view="${LONG}"]') === null`), { label: 'inactive' })
    const tag = `b2-inactive ${i}`
    mutate(tag)
    await sleep(1500)
    const t1 = Date.now()
    await click(`[data-main-tab="file:${LONG}"]`)
    let ms = null
    try {
      ms = (await until(() => js(`[...document.querySelectorAll('[data-file-view="${LONG}"] .view-line')].some((el) => el.textContent.replace(/\u00a0/g, " ").includes(${JSON.stringify(tag)}))`), { timeoutMs: 5000, everyMs: 20, label: tag })).ms
    } catch {
      ms = null
    }
    const seen = ms === null ? await js(`[...document.querySelectorAll('[data-file-view="${LONG}"] .view-line')].slice(0, 4).map((el) => el.textContent)`) : null
    // 탭을 오가도 스크롤 자리 유지(E3ⓕ) — 비활성 동안 내용이 바뀌어도 view state 로 돌아온다.
    const lineAfter = await firstLine()
    rows.push({ i, msAfterActivate: ms, sinceActivateStart: Date.now() - t1, seen, lineAfter, scrollKept: lineAfter > 100 })
  }
  result.conditions['b2-inactive'] = { rows, pass: rows.every((row) => row.msAfterActivate !== null && row.msAfterActivate <= 2000 && row.scrollKept) }
  console.log('b2-inactive', JSON.stringify({ pass: result.conditions['b2-inactive'].pass, max: Math.max(...rows.map((row) => row.msAfterActivate ?? Infinity)) }))
}

// ⓒ 삭제 → 「삭제됨」(비활성 탭에서도) → 다시 생김 → 해제 + 내용
{
  const rows = []
  for (let i = 0; i < runs; i += 1) {
    const inactive = i % 2 === 1
    if (inactive) await click('[data-main-tab]:not([data-file-tab])')
    else await click(`[data-main-tab="file:${LONG}"]`)
    await sleep(200)
    const t0 = Date.now()
    fs.rmSync(longPath)
    let goneMs = null
    try {
      goneMs = (await until(() => tabDeleted(), { timeoutMs: 5000, everyMs: 20, label: 'deleted' })).ms
    } catch {
      goneMs = null
    }
    const tag = `c-back ${i}`
    const t1 = mutate(tag)
    let backMs = null
    try {
      backMs = (await until(async () => (await tabDeleted()) === false, { timeoutMs: 5000, everyMs: 20, label: 'back' })).ms
    } catch {
      backMs = null
    }
    if (inactive) await click(`[data-main-tab="file:${LONG}"]`)
    let contentOk = false
    try {
      await until(() => js(`[...document.querySelectorAll('[data-file-view="${LONG}"] .view-line')].some((el) => el.textContent.replace(/\u00a0/g, " ").includes(${JSON.stringify(tag)}))`), { timeoutMs: 5000, everyMs: 20, label: 'content' })
      contentOk = true
    } catch {
      contentOk = false
    }
    rows.push({ i, inactive, goneMs, backMs, contentOk, wroteAt: t0, rewroteAt: t1 })
  }
  result.conditions['c-delete-recreate'] = { rows, pass: rows.every((row) => row.goneMs !== null && row.goneMs <= 2000 && row.backMs !== null && row.backMs <= 2000 && row.contentOk) }
  console.log('c-delete-recreate', JSON.stringify({ pass: result.conditions['c-delete-recreate'].pass, goneMax: Math.max(...rows.map((row) => row.goneMs ?? Infinity)), backMax: Math.max(...rows.map((row) => row.backMs ?? Infinity)) }))
}

// ⓔ 자원 — 파일 50개를 고정 탭으로 열고 닫기 전후 main fd 수·폴더 감시 수
{
  const dir = path.join(repo, 'many')
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 50; i += 1) fs.writeFileSync(path.join(dir, `f${String(i).padStart(2, '0')}.txt`), `file ${i}\n`)
  const mainPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim())
  const fds = () => Number(execFileSync('sh', ['-c', `lsof -p ${mainPid} 2>/dev/null | wc -l`], { encoding: 'utf8' }).trim())
  const status = async () => (await ctl(root, { cmd: 'file-watch-status' })).fileWatch
  await click('[data-main-tab]:not([data-file-tab])')
  await sleep(500)
  const before = { fds: fds(), watch: await status() }
  await until(() => js(`document.querySelector('[data-explorer-row="many"]') !== null`), { label: 'many row', timeoutMs: 10_000 })
  await click('[data-explorer-row="many"]')
  // 탐색기는 가상 스크롤 — 보이는 곳 밖의 행은 DOM 에 없다. 행이 나올 때까지 스크롤 상자를 내린다.
  const showRow = (rel) =>
    until(() => js(`(() => { const row = document.querySelector('[data-explorer-row="${rel}"]'); if (row) { row.scrollIntoView({ block: 'center' }); return true } const box = document.querySelector('.explorer-scroll'); box.scrollTop += 110; return false })()`), { label: `row ${rel}`, everyMs: 50 })
  for (let i = 0; i < 50; i += 1) {
    const rel = `many/f${String(i).padStart(2, '0')}.txt`
    await showRow(rel)
    await sleep(60)
    await dblclick(`[data-explorer-row="${rel}"]`)
  }
  await sleep(1500)
  const open = { fds: fds(), watch: await status(), tabs: await js(`document.querySelectorAll('[data-main-tab^="file:many/"]').length`) }
  // 닫기 — 터미널 탭 메뉴 「다른 탭 닫기」 대신 파일 탭마다 닫기(이 작업 범위의 길)
  for (let i = 0; i < 50; i += 1) {
    const rel = `many/f${String(i).padStart(2, '0')}.txt`
    await js(`document.querySelector('[data-main-tab="file:${rel}"]')?.scrollIntoView() ?? null`)
    await click(`[data-main-tab="file:${rel}"]`)
    await key('W', ['meta'])
    await until(() => js(`document.querySelector('[data-main-tab="file:${rel}"]') === null`), { label: `close ${rel}`, timeoutMs: 5000 })
  }
  await sleep(1500)
  const after = { fds: fds(), watch: await status(), tabs: await js(`document.querySelectorAll('[data-main-tab^="file:many/"]').length`) }
  result.conditions['e-resources'] = { before, open, after, pass: after.tabs === 0 && after.fds <= before.fds + 2 && (after.watch?.dirWatchers ?? 99) <= (before.watch?.dirWatchers ?? 0) }
  console.log('e-resources', JSON.stringify(result.conditions['e-resources']))
}

result.paneId = paneId
writeJson(values.out, result)
const failed = Object.entries(result.conditions).filter(([, value]) => !value.pass).map(([name]) => name)
console.log(JSON.stringify({ failed }))
process.exit(failed.length === 0 ? 0 : 1)
