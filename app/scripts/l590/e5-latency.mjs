// LIFE-590 수정 r2 — E5ⓓ 감시 유실 주입 지연을 구간으로 나눈다(리뷰 r2 관찰: 10회 중 1회 2,535 ms). 격리 개발 Electron.
// 회차마다: 폴더 감시 끊기(`file-watch-drop`) → 0~1 s 무작위로 쉬고(안전망 주기와의 위상을 고르게) → node fs 로 쓰기(t0) → 렌더러 모델 갱신까지.
// 구간: ① t0 → main 감지(그 파일을 민 시각 — `file-watch-status.pushes` 를 rel·stamp 로 렌더러 수신과 대응, 수정 r3 R3-A. 확인 끝 `recent.endAt` 은 「전체 확인 시간」 칸으로만) ② 감지 → 렌더러 수신(이 스크립트가 단 `onFileEvent` 리스너, 렌더러 Date.now)
//       ③ 수신 → 모델 갱신(`data-editor-updated`). 그 사이 **변경을 못 본 확인**(t0 뒤 시작했는데 민 것 0)과 같은 변경에 대한 push 수·크기(잘린 쓰기 관측 여부)도 적는다.
// 같은 기계 시계(main·렌더러·이 스크립트 모두 Date.now). 사용(app/ 에서): node scripts/l590/e5-latency.mjs --root /tmp/l590g-* --repo /tmp/l590g-t/repo --out <json> [--runs 30]
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, pct, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, runs: { type: 'string', default: '30' }, drop: { type: 'string', default: 'yes' }, jitter: { type: 'string', default: 'yes' }, extra: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const repo = values.repo
const runs = Number(values.runs)
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `click ${selector}` })
const dblclick = (selector) => until(async () => (await ctl(root, { cmd: 'dblclick', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `dblclick ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })

const LONG = 'notes/long.txt'
const longPath = path.join(repo, LONG)
const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} — 외부 변경 측정용`)
fs.mkdirSync(path.dirname(longPath), { recursive: true })
fs.writeFileSync(longPath, lines.join('\n') + '\n')
const mutate = (tag) => {
  const next = lines.map((line, index) => (index % 10 === 0 ? `line ${String(index + 1).padStart(3, '0')} — ${tag}` : line))
  const t0 = Date.now()
  fs.writeFileSync(longPath, next.join('\n') + '\n')
  return { t0, t1: Date.now(), size: fs.statSync(longPath).size }
}
const host = `document.querySelector('[data-file-view="${LONG}"] [data-file-editor]')`
const updatedAt = () => js(`Number(${host}?.dataset.editorUpdated ?? 0)`)

await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
if ((await js(`document.querySelector('[data-explorer-row="notes"]')?.getAttribute('aria-expanded') ?? null`)) !== 'true') await click('[data-explorer-row="notes"]')
await until(() => js(`document.querySelector('[data-explorer-row="${LONG}"]') !== null`), { label: 'long row' })
// --extra <rel> — 다른 폴더의 파일 탭을 하나 더 고정으로 열어 둔다(리뷰 r2 e5.json 회차는 files 2·폴더 감시 2 였다).
if (values.extra !== undefined) {
  await until(() => js(`document.querySelector('[data-explorer-row="${values.extra}"]') !== null`), { label: 'extra row' })
  await dblclick(`[data-explorer-row="${values.extra}"]`)
  await until(() => js(`!!document.querySelector('[data-file-view="${values.extra}"] [data-editor-ready]')`), { label: 'extra editor' })
}
await dblclick(`[data-explorer-row="${LONG}"]`)
await until(() => js(`${host}?.dataset.editorReady ?? null`), { label: 'editor' })
await js(`(() => { window.__e5 = []; window.corral.onFileEvent((push) => { if (push.rel === ${JSON.stringify(LONG)}) window.__e5.push({ at: Date.now(), exists: push.exists, stamp: push.stamp }) }); return true })()`)
await sleep(1500)

const sizeOf = (stamp) => (typeof stamp === 'string' ? Number(stamp.split(':')[2]) : null)
const rows = []
for (let i = 0; i < runs; i += 1) {
  let dropAt = null
  if (values.drop === 'yes') {
    const status = await ctl(root, { cmd: 'file-watch-drop' })
    if (status.fileWatch?.dirWatchers !== 0) throw new Error(`drop 안 됨 ${JSON.stringify(status)}`)
    dropAt = status.at
  }
  // jitter=no — e5-change ⓓ 와 같이 끊은 직후 바로 쓴다(안전망 주기가 감시를 다시 붙이기 전).
  if (values.jitter === 'yes') await sleep(Math.floor(Math.random() * 1000))
  const prior = await updatedAt()
  const receiptsBefore = await js(`window.__e5.length`)
  const tag = `d-latency ${i}`
  const written = mutate(tag)
  let updateAt = null
  try {
    updateAt = (await until(async () => {
      const at = await updatedAt()
      return at > prior ? at : 0
    }, { timeoutMs: 6000, everyMs: 10, label: tag })).value
  } catch {
    updateAt = null
  }
  await sleep(1300) // 늦게 오는 두 번째 push(잘린 쓰기 뒤 완성본)까지 받게
  const shown = await js(`[...document.querySelectorAll('[data-file-view="${LONG}"] .view-line')].some((el) => el.textContent.replace(/\\u00a0/g, " ").includes(${JSON.stringify(tag)}))`)
  const receipts = (await js(`window.__e5.slice(${receiptsBefore})`)) ?? []
  const status = await ctl(root, { cmd: 'file-watch-status' })
  const checks = (status.fileWatch?.recent ?? []).filter((row) => row.endAt >= written.t0 - 5)
  const detect = checks.find((row) => row.pushed > 0 && !row.deferred) ?? null
  const missed = checks.filter((row) => !row.deferred && row.pushed === 0 && row.startAt >= written.t1 && (detect === null || row.startAt < detect.startAt))
  const receipt = receipts[0] ?? null
  // 수정 r3 R3-A — 같은 변경(rel·stamp)의 main push 시각. 확인 `endAt` 은 「전체 확인 시간」(뒤 파일 검사 포함)으로만 쓴다.
  const pushed = receipt === null ? null : (status.fileWatch?.pushes ?? []).find((row) => row.rel === LONG && row.stamp === receipt.stamp && row.pushAt >= written.t0 - 5) ?? null
  const row = {
    i,
    dropAt,
    t0: written.t0,
    writeMs: written.t1 - written.t0,
    size: written.size,
    total: updateAt === null ? null : updateAt - written.t0,
    detectMs: pushed === null ? null : pushed.pushAt - written.t0,
    detectVia: pushed?.via ?? null,
    ipcMs: pushed === null || receipt === null ? null : receipt.at - pushed.pushAt,
    checkEndMs: detect === null ? null : detect.endAt - written.t0,
    renderMs: receipt === null || updateAt === null ? null : updateAt - receipt.at,
    missedChecks: missed.map((row) => ({ via: row.via, afterT0: row.startAt - written.t0 })),
    stale: checks.reduce((sum, row) => sum + row.stale, 0),
    deferred: checks.filter((row) => row.deferred).length,
    pushes: receipts.map((push) => ({ afterT0: push.at - written.t0, size: sizeOf(push.stamp) })),
    truncatedSeen: receipts.some((push) => sizeOf(push.stamp) !== written.size),
    shown,
  }
  rows.push(row)
  console.log(JSON.stringify({ i, total: row.total, detectMs: row.detectMs, via: row.detectVia, ipcMs: row.ipcMs, renderMs: row.renderMs, missed: row.missedChecks.length, pushes: row.pushes.length, truncated: row.truncatedSeen, shown }))
}
const pick = (name) => rows.map((row) => row[name]).filter((value) => typeof value === 'number')
const summary = {
  runs,
  drop: values.drop,
  jitter: values.jitter,
  extra: values.extra ?? null,
  total: { p50: pct(pick('total'), 50), p95: pct(pick('total'), 95), max: Math.max(...pick('total')) },
  detect: { p50: pct(pick('detectMs'), 50), max: Math.max(...pick('detectMs')) },
  ipc: { min: Math.min(...pick('ipcMs')), max: Math.max(...pick('ipcMs')) },
  matched: rows.filter((row) => row.ipcMs !== null).length,
  render: { p50: pct(pick('renderMs'), 50), max: Math.max(...pick('renderMs')) },
  overTwoSeconds: rows.filter((row) => row.total === null || row.total > 2000).map((row) => row.i),
  missedAny: rows.filter((row) => row.missedChecks.length > 0).map((row) => row.i),
  truncatedAny: rows.filter((row) => row.truncatedSeen).map((row) => row.i),
  notShown: rows.filter((row) => !row.shown).map((row) => row.i),
}
summary.pass = summary.overTwoSeconds.length === 0 && summary.notShown.length === 0
writeJson(values.out, { root, repo, summary, rows })
console.log(JSON.stringify(summary))
process.exit(summary.pass ? 0 : 1)
