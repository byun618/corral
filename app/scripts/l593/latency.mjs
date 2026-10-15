// LIFE-593 사본(l592/latency.mjs → 루트 /tmp/l593g-* 만 바꿈). E7ⓔ 「전」(기준 빌드 A 단계)·최종 관문 A/B 에 쓴다
// LIFE-592 E10ⓓ(최종 관문) — 다섯째 칸 `op` = **탐색기 열림 + 조작 직후**: 측정 직전 탐색기 조작 4회(실제 창 → preload → ipcMain `explorerOp` — 새 파일·이름 변경)를 몰아서 하고
//   측정 동안에도 0.8~1.2 s 마다 1회씩 계속한다(레포 `l593-lat/`). 판정 B 조건 = 탐색기 열림 + 측정 구간 조작 ≥ 0.5회/초. 예: --plan a:closed:off:off,b:open:off:off:op --a a --b b
//   글자 주입 전 Shift keyDown 하나(main 이 막은 keyDown 뒤 char 버림 — residual.md 하네스 주의) · 측정 전 터미널 화면 클릭으로 xterm 포커스 확인(`focusTerm` —
//   ⌘⇧E 가 트리에 준 포커스가 남아 글자가 트리로 가던 하네스 문제: F28·기준 B07 회차 3 b 놓침 36, 진단 dev27 activeElement = explorer-tree).
// LIFE-591 E7ⓓ(최종 관문) — 넷째 칸 `dirty` = **수정된 1 MB 파일 탭**(`big/1mb.txt`)을 오른쪽 새 영역에 열고 한 글자 쳐서 수정 상태로 둔 채(디스크 무변경·다시 쓰기 없음) 잰다.
//   A 로 돌아갈 때 탭을 닫으면 확인 대화상자가 뜨므로 `file-dialog-stub` 으로 「저장 안 함」 을 답한다(계측 실행). 판정 B 조건 = 탭 열림 + 수정 표시.
// LIFE-590 E8ⓔ (l589/e3-latency.mjs 사본 — 루트 /tmp/l591g-*) · LIFE-589 E3ⓓ — 터미널 입력 지연 A/B (`l580/k9-ab.mjs` 방식). 격리 개발 Electron(g-up.sh /tmp/l589g-*) 한 실행 안에서
//   계획(--plan)의 단계를 교대로 잰다. 단계 = `<이름>:<explorer open|closed>:<drive on|off>`.
//   - explorer open = 패널 `[data-right-panel="open"]` + 실제 폭 > 0 · closed = `[data-right-panel="closed"]`(패널은 닫혀도 탐색기를 마운트 유지하므로
//     `[data-explorer]` 존재로는 가리지 못한다 — 리뷰 r1 R1-H)
//   - drive on = 측정 동안 레포 안 `l589-drive/` 폴더에 파일 생성·삭제 ≥ 5회/초(외부 변경). explorer open 이면 그 폴더 행을 **펼치고**(aria-expanded)
//     탐침 파일 하나가 하위 행으로 나타나는 것(반영)을 확인한 뒤 잰다
// 기준선(구현 전)에는 탐색기가 없으므로 `base:closed:off`·`base-drive:closed:on` 만 돈다.
// LIFE-590 E8ⓔ — 넷째 칸 `file on` = 10 MB 파일 탭(`big/10mb.txt`)을 **오른쪽 새 영역**에 열어 두고(터미널은 왼쪽 영역에 보인다) 그 파일을 측정 동안
//   ≥ 1회/초 다시 쓴다(외부 변경 — 렌더러가 10 MB 를 다시 읽어 같은 모델에 넣는다). 판정 B 는 `탐색기 열림 + drive` **또는** `file on`.
// 지표(회당): type 주입 시각 → 그 글자를 담은 첫 xterm write ms(36타) · main 이벤트 루프 지연 p99(계측 `loop-delay`).
// 사용(app/ 에서):
//   sh scripts/l577/g-up.sh /tmp/l589g-a /tmp/l589g-fa
//   node scripts/l589/e3-latency.mjs --root /tmp/l589g-a --out <dir> --plan base:closed:off,base-drive:closed:on [--rounds 3] [--samples 36] [--repo <path>]
//   sh scripts/l577/g-down.sh /tmp/l589g-a term herdr
//   A/B 판정: --a <A 단계 이름> --b <B 단계 이름> 을 주면 스크립트가 판정까지 낸다(E3ⓓ):
//     · 최소 조건 — 두 단계 모두 회차 ≥ 3·회당 샘플 ≥ 36·놓침 0, B 는 회차마다 변경 ≥ 5회/초·drive 펼침·반영 확인
//     · 통과선 — B 의 p50·p95 가 각각 A 의 +10% 이내 **또는** 차이 ≤ 5 ms
// 종료 코드: 0 실행 완료(놓침 0)이고 A/B 를 줬으면 판정 통과 · 1 실행 실패·놓침·최소 조건 미달·판정 미달 · 2 사용법. A/B 를 안 주면(기준선) 수치만 기록.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, exposeMonaco, herdr, pct, repoPane, sleep, until, writeJson } from './lib.mjs'

const CHARS = 'abcdefghijklmnopqrstuvwxyz'
const MIN_ROUNDS = 3
const MIN_SAMPLES = 36
const MIN_CHANGES_PER_SEC = 5
const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' }, plan: { type: 'string' }, rounds: { type: 'string', default: '3' }, samples: { type: 'string', default: '36' }, repo: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' } } })
try { checkRoot(values.root) } catch (error) { console.error(String(error.message)); process.exit(2) }
if (values.out === undefined || values.plan === undefined) { console.error('--out · --plan 필요'); process.exit(2) }
const root = values.root
const rounds = Number(values.rounds)
const sampleCount = Number(values.samples)
const steps = values.plan.split(',').map((text) => {
  const [name, explorer, drive, file, op] = text.split(':')
  return { name, explorer: explorer === 'open', drive: drive === 'on', file: file === 'on' || file === 'dirty', dirty: file === 'dirty', op: op === 'op' }
})

const termRead = async () => (await ctl(root, { cmd: 'term-read' })).term
const countChar = (term, ch) => (term == null ? 0 : term.lines.join('\n').split(ch).length - 1)

async function attach(paneId) {
  const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  if (tabId === undefined) throw new Error('탭 id 없음')
  const selector = `[data-main-tab="${tabId}"]`
  await until(async () => (await ctl(root, { cmd: 'click', selector })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: `탭 클릭 ${selector}` })
  await until(async () => (await ctl(root, { cmd: 'state' })).state?.terminal?.phase === 'streaming', { timeoutMs: 15_000, label: 'streaming' })
}

async function neutralize(paneId) {
  await herdr(root, 'pane.send_text', { pane_id: paneId, text: '\x03' })
  await sleep(150)
  await herdr(root, 'pane.send_text', { pane_id: paneId, text: '\x15' })
  await sleep(120)
  await herdr(root, 'pane.send_text', { pane_id: paneId, text: "precmd() {}; preexec() {}; typeset -ga precmd_functions=(); typeset -ga preexec_functions=(); (( $+functions[_zsh_autosuggest_disable] )) && _zsh_autosuggest_disable; fc -p /dev/null 2>/dev/null; unset RPROMPT RPS1; PROMPT='READY%# '; clear\n" })
  await sleep(500)
}

/** 외부 변경 구동 — drive 폴더에 파일 생성·삭제를 번갈아 ≥ 5회/초(120~180ms 간격). */
function driver(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const changes = []
  let stop = false
  const done = (async () => {
    let i = 0
    while (!stop) {
      const file = path.join(dir, `f${i % 20}.txt`)
      if (fs.existsSync(file)) fs.rmSync(file)
      else fs.writeFileSync(file, String(i))
      changes.push(Date.now())
      i += 1
      await sleep(120 + Math.floor(Math.random() * 60))
    }
  })()
  return { changes, stop: async () => { stop = true; await done } }
}

/**
 * drive 폴더 행을 펼치고 반영을 확인한다 — 행이 보일 때까지 기다려 펼치고(aria-expanded=true), 탐침 파일을 만들어 하위 행이 나타나는 데 걸린 ms 를 돌려준다.
 * 탐침은 지운다(지운 행이 사라지는 것도 확인).
 */
async function expandDrive(dir, round) {
  const rel = path.basename(dir)
  const row = `[data-explorer-row="${rel}"]`
  await until(async () => (await evalJs(root, `!!document.querySelector('${row}')`)) === true, { timeoutMs: 15_000, label: `drive 행 ${rel}` })
  if ((await evalJs(root, `document.querySelector('${row}')?.getAttribute('aria-expanded')`)) !== 'true') await ctl(root, { cmd: 'click', selector: row })
  await until(async () => (await evalJs(root, `document.querySelector('${row}')?.getAttribute('aria-expanded')`)) === 'true', { timeoutMs: 5_000, label: 'drive 펼침' })
  const probe = `probe-${round}-${Date.now()}.txt`
  const probeRow = `[data-explorer-row="${rel}/${probe}"]`
  const startedAt = Date.now()
  fs.writeFileSync(path.join(dir, probe), 'probe')
  await until(async () => (await evalJs(root, `!!document.querySelector('${probeRow}')`)) === true, { timeoutMs: 5_000, everyMs: 20, label: 'drive 반영(생성)' })
  const reflectMs = Date.now() - startedAt
  fs.rmSync(path.join(dir, probe))
  await until(async () => (await evalJs(root, `!!document.querySelector('${probeRow}')`)) === false, { timeoutMs: 5_000, everyMs: 20, label: 'drive 반영(삭제)' })
  return { expanded: true, reflectMs }
}

async function setExplorer(open) {
  // 패널 상태는 `[data-right-panel]` 의 값과 실제 폭으로 본다 — 탐색기는 닫혀도 마운트 유지라 `[data-explorer]` 존재로는 못 가린다(R1-H).
  // 구현 전(패널 없음)에는 open 단계를 만들 수 없다 — 그때는 실패로 끝내고, closed 는 패널이 없으면 이미 닫힌 것으로 본다.
  const state = async () => evalJs(root, `(() => { const el = document.querySelector('[data-right-panel]'); if (!el) return 'none'; return el.getAttribute('data-right-panel') === 'open' && el.getBoundingClientRect().width > 0 ? 'open' : 'closed' })()`)
  const isOpen = async () => (await state()) === 'open'
  if ((await isOpen()) === open) return
  if (!open && (await state()) === 'none') return
  await ctl(root, { cmd: 'key', keyCode: open ? 'E' : 'L', modifiers: open ? ['meta', 'shift'] : ['meta'] })
  await until(async () => (await isOpen()) === open, { timeoutMs: 5_000, label: `탐색기 ${open ? '열기' : '닫기'}` })
}

const BIG = steps.some((step) => step.dirty) ? 'big/1mb.txt' : 'big/10mb.txt'
/** 10 MB 파일 탭을 오른쪽 새 영역에 연다(이미 있으면 그대로). 탐색기를 잠깐 열어 행을 더블클릭(고정) → ⌘⌥D(활성 탭을 새 영역으로). */
async function ensureFileTab() {
  const open = async () => evalJs(root, `!!document.querySelector('[data-file-view="${BIG}"] [data-editor-ready]')`)
  if (await open()) return true
  await setExplorer(true)
  const expanded = async () => (await evalJs(root, `document.querySelector('[data-explorer-row="big"]')?.getAttribute('aria-expanded')`)) === 'true'
  await until(async () => evalJs(root, `!!document.querySelector('[data-explorer-row="big"]')`), { label: 'big 행' })
  if (!(await expanded())) await ctl(root, { cmd: 'click', selector: '[data-explorer-row="big"]' })
  await until(expanded, { label: 'big 펼침' })
  await until(async () => (await ctl(root, { cmd: 'dblclick', selector: `[data-explorer-row="${BIG}"]` })).ok === true, { label: '10mb 더블클릭' })
  await until(open, { timeoutMs: 20_000, label: '10mb 편집기' })
  await ctl(root, { cmd: 'key', keyCode: 'D', modifiers: ['meta', 'alt'] })
  await until(async () => (await evalJs(root, `document.querySelectorAll('[data-tab-group]').length`)) === 2, { label: '새 영역' })
  await until(open, { timeoutMs: 20_000, label: '10mb 편집기(새 영역)' })
  return true
}
const tabDirty = () => evalJs(root, `document.querySelector('[data-main-tab="file:${BIG}"]')?.dataset.fileDirty === 'true'`)
/** E7ⓓ B — 편집기에 한 글자 쳐서 수정 상태로(이미 수정이면 그대로). */
async function ensureDirty() {
  if (await tabDirty()) return true
  // 편집기 입력은 EditContext 라 합성 글자(type)가 편집기에 닿지 않는다 — final.mjs 와 같이 Monaco 인스턴스로 한 글자 친다(사용자 편집과 같은 type 명령).
  await exposeMonaco(root)
  await evalJs(root, `(() => { const host = document.querySelector('[data-file-view="${BIG}"] [data-file-editor]'); const e = window.l593Monaco.editor.getEditors().find((x) => host !== null && host.contains(x.getContainerDomNode())); e.setPosition({ lineNumber: 1, column: 1 }); e.trigger('keyboard', 'type', { text: 'Q' }); return true })()`)
  await until(tabDirty, { timeoutMs: 5_000, label: '1mb 수정 표시' })
  return true
}
async function closeFileTab() {
  if (!(await evalJs(root, `!!document.querySelector('[data-main-tab="file:${BIG}"]')`))) return
  // × 버튼으로 닫는다 — 합성 ⌘W(main before-input-event 가 가로채는 키) 뒤에는 합성 글자 입력이 문서에 닿지 않았다(Q12 A 2·3회차 놓침 36,
  // 수식키 없는 키 하나를 보내면 풀림 — 하네스 입력 상태 문제로 본다. 원자료 runs/Q12.log·DONE.md).
  if (await tabDirty()) await ctl(root, { cmd: 'file-dialog-stub', answers: ['discard'] })
  await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab="file:${BIG}"]` })).ok === true, { label: '10mb 탭' })
  await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab-close="file:${BIG}"]` })).ok === true, { label: '10mb 닫기 ×' })
  await until(async () => !(await evalJs(root, `!!document.querySelector('[data-main-tab="file:${BIG}"]')`)), { label: '10mb 닫힘' })
}
/** 10 MB 파일 다시 쓰기 ≥ 1회/초(700~900 ms) — 첫 줄 표식만 바꾼 같은 크기. */
function fileDriver(file) {
  const base = fs.readFileSync(file)
  const changes = []
  let stop = false
  const done = (async () => {
    let i = 0
    while (!stop) {
      const tag = Buffer.from(`tick ${String(i).padStart(8, '0')} `)
      tag.copy(base, 0)
      fs.writeFileSync(file, base)
      changes.push(Date.now())
      i += 1
      await sleep(700 + Math.floor(Math.random() * 200))
    }
  })()
  return { changes, stop: async () => { stop = true; await done } }
}

/** 탐색기 조작(E10ⓓ B) — 실제 창 IPC 로 새 파일 → 이름 변경을 번갈아. 루트는 탐색기가 쓰는 값(`data-explorer-root`). */
let opSeq = 0
async function explorerOpOnce() {
  const opRoot = await evalJs(root, `document.querySelector('[data-explorer-root]')?.dataset.explorerRoot ?? null`)
  opSeq += 1
  const name = `l593-lat-${opSeq}.txt`
  const made = await evalJs(root, `window.corral.explorerOp(${JSON.stringify({ op: 'create', root: opRoot, dir: 'l593-lat', name, kind: 'file' })})`)
  const moved = await evalJs(root, `window.corral.explorerOp(${JSON.stringify({ op: 'move', root: opRoot, from: `l593-lat/${name}`, to: `l593-lat/r-${name}` })})`)
  return made?.ok === true && moved?.ok === true
}
function opDriver() {
  const ops = []
  let stop = false
  const done = (async () => {
    while (!stop) {
      if (await explorerOpOnce()) ops.push(Date.now())
      await sleep(800 + Math.floor(Math.random() * 400))
    }
  })()
  return { ops, stop: async () => { stop = true; await done } }
}

/**
 * 터미널에 키 포커스 — 탭 클릭(attach)은 이미 활성인 탭이면 포커스를 옮기지 않는다. `⌘⇧E`(탐색기 보이기)가 트리에 포커스를 준 뒤엔 글자가 트리로 간다
 * (F28 회차 3 b·기준 B07 회차 3 b 놓침 36 — dev27 진단: activeElement = explorer-tree). 측정 전 터미널 화면을 눌러 xterm 입력칸 포커스를 확인한다.
 */
async function focusTerm() {
  const focused = () => evalJs(root, `document.activeElement?.classList?.contains('xterm-helper-textarea') === true`)
  await until(async () => {
    if (await focused()) return true
    await ctl(root, { cmd: 'term-click', fx: 0.5, fy: 0.5 })
    await sleep(120)
    return focused()
  }, { timeoutMs: 8_000, everyMs: 200, label: '터미널 포커스' })
  return true
}

async function sampleRound(paneId) {
  await evalJs(root, `(() => { if (!window.__l593latProbe) { window.__l593latProbe = true; window.__l593latKeys = []; for (const t of ['keydown', 'keypress', 'input']) window.addEventListener(t, (e) => { window.__l593latKeys.push([t, e.key ?? e.data ?? null, (e.target?.className || e.target?.tagName || '').toString().slice(0, 40), Date.now()]); if (window.__l593latKeys.length > 50) window.__l593latKeys.shift() }, true) } return true })()`)
  await ctl(root, { cmd: 'key', keyCode: 'Shift' })
  const samples = []
  for (let i = 0; i < sampleCount; i += 1) {
    const ch = CHARS[i % CHARS.length]
    const baseCount = countChar(await termRead(), ch)
    const injectAt = (await ctl(root, { cmd: 'type', text: ch })).at
    const seen = await until(async () => {
      const term = await termRead()
      if (countChar(term, ch) <= baseCount) return null
      const after = term.writes.filter((write) => write.at >= injectAt).sort((a, b) => a.at - b.at || a.seq - b.seq)
      return after[0] ?? null
    }, { timeoutMs: 2_000, everyMs: 8, label: `에코 ${ch}` }).catch(() => null)
    // 놓치면 그 순간 상태를 남긴다(원인 진단 — 첫 놓침·마지막 놓침): 포커스·터미널 단계·창 포커스·페이지가 키를 받았는지
    const diag = seen === null && (samples.every((x) => !x.miss) || i === sampleCount - 1)
      ? { page: await evalJs(root, `({ active: (document.activeElement?.className || document.activeElement?.tagName || '').toString().slice(0, 80), hasFocus: document.hasFocus(), visibility: document.visibilityState, keys: (window.__l593latKeys ?? []).slice(-4) })`).catch((error) => String(error)), state: (await ctl(root, { cmd: 'state' }).catch(() => null))?.state?.terminal ?? null }
      : undefined
    samples.push(seen === null ? { i, ch, miss: true, diag } : { i, ch, injectAt, writeAt: seen.value.at, latencyMs: seen.value.at - injectAt })
    await sleep(220 + Math.floor(Math.random() * 80))
  }
  await herdr(root, 'pane.send_text', { pane_id: paneId, text: '\x15' })
  await sleep(200)
  return samples
}

const summary = (samples) => {
  const lat = samples.filter((s) => !s.miss).map((s) => s.latencyMs)
  return { n: lat.length, misses: samples.length - lat.length, p50: pct(lat, 50), p95: pct(lat, 95), max: lat.length > 0 ? Math.max(...lat) : null }
}

const rows = []
let failure = null
try {
  const { repo, paneId } = await repoPane(root, values.repo === undefined ? {} : { repo: values.repo })
  await attach(paneId)
  await neutralize(paneId)
  await ctl(root, { cmd: 'loop-delay' })
  for (let r = 1; r <= rounds; r += 1) {
    for (const step of steps) {
      const fileTabOpen = step.file ? await ensureFileTab() : (await closeFileTab(), false)
      const fileDirty = step.dirty ? await ensureDirty() : null
      await setExplorer(step.explorer)
      const driveDir = path.join(repo, 'l589-drive')
      if (step.drive) fs.mkdirSync(driveDir, { recursive: true })
      const driveView = step.drive && step.explorer ? await expandDrive(driveDir, r) : { expanded: false, reflectMs: null }
      await attach(paneId)
      if (step.op) {
        fs.mkdirSync(path.join(repo, 'l593-lat'), { recursive: true })
        for (let i = 0; i < 4; i += 1) await explorerOpOnce()
      }
      const opDrive = step.op ? opDriver() : null
      const drive = step.drive ? driver(driveDir) : null
      const fileDrive = step.file && !step.dirty ? fileDriver(path.join(repo, BIG)) : null
      try {
        await sleep(step.op ? 200 : 1_500)
        await ctl(root, { cmd: 'loop-delay' })
        const terminalFocused = await focusTerm()
        const windowStart = Date.now()
        const samples = await sampleRound(paneId)
        const loopDelay = (await ctl(root, { cmd: 'loop-delay' })).loopDelay ?? null
        const windowEnd = Date.now()
        const changesInWindow = drive === null ? 0 : drive.changes.filter((at) => at >= windowStart && at <= windowEnd).length
        const fileChangesInWindow = fileDrive === null ? 0 : fileDrive.changes.filter((at) => at >= windowStart && at <= windowEnd).length
        const opsInWindow = opDrive === null ? 0 : opDrive.ops.filter((at) => at >= windowStart && at <= windowEnd).length
        const fileUpdated = step.file && !step.dirty ? await evalJs(root, `Number(document.querySelector('[data-file-view="${BIG}"] [data-file-editor]')?.dataset.editorUpdated ?? 0) >= ${windowStart}`) : null
        const row = { round: r, step: step.name, explorer: step.explorer, drive: step.drive, driveExpanded: driveView.expanded, driveReflectMs: driveView.reflectMs, windowStart, windowEnd, changesPerSec: Math.round((changesInWindow / ((windowEnd - windowStart) / 1000)) * 100) / 100, file: step.file, fileTabOpen, fileDirty: step.dirty ? await tabDirty() : null, fileDirtyBefore: fileDirty, fileChangesPerSec: Math.round((fileChangesInWindow / ((windowEnd - windowStart) / 1000)) * 100) / 100, fileUpdated, terminalFocused, op: step.op, opsPerSec: Math.round((opsInWindow / ((windowEnd - windowStart) / 1000)) * 100) / 100, loopDelay, ...summary(samples), samples }
        rows.push(row)
        console.log(`회차 ${r} ${step.name} p50 ${row.p50} p95 ${row.p95} 놓침 ${row.misses} 루프 p99 ${loopDelay?.p99} 변경 ${row.changesPerSec}/s`)
      } finally {
        if (opDrive !== null) await opDrive.stop()
        if (drive !== null) await drive.stop()
        if (fileDrive !== null) await fileDrive.stop()
      }
    }
  }
} catch (error) {
  failure = String(error?.message ?? error)
  console.log(`실행 실패: ${failure}`)
}
const byStep = Object.fromEntries(steps.map((step) => {
  const all = rows.filter((row) => row.step === step.name)
  const loops = all.map((row) => row.loopDelay?.p99).filter(Number.isFinite)
  return [step.name, { rounds: all.length, ...summary(all.flatMap((row) => row.samples)), loopP99Max: loops.length > 0 ? Math.max(...loops) : null }]
}))
const misses = rows.reduce((sum, row) => sum + row.misses, 0)

/** E3ⓓ 판정 — 최소 조건과 +10%(또는 ≤ 5 ms) 통과선. A/B 를 안 줬으면 null. */
function judge(aName, bName) {
  if (aName === undefined || bName === undefined) return null
  const problems = []
  const stepRows = (name) => rows.filter((row) => row.step === name)
  for (const name of [aName, bName]) {
    const all = stepRows(name)
    if (all.length < MIN_ROUNDS) problems.push(`${name} 회차 ${all.length} < ${MIN_ROUNDS}`)
    for (const row of all) {
      if (row.n < MIN_SAMPLES) problems.push(`${name} 회차 ${row.round} 샘플 ${row.n} < ${MIN_SAMPLES}`)
      if (row.misses > 0) problems.push(`${name} 회차 ${row.round} 놓침 ${row.misses}`)
    }
  }
  const bStep = steps.find((step) => step.name === bName)
  const aStep = steps.find((step) => step.name === aName)
  if (aStep === undefined || bStep === undefined) problems.push('A/B 단계 이름이 계획에 없다')
  else {
    if (aStep.explorer || aStep.file) problems.push(`A(${aName}) 는 탐색기 닫힘·파일 탭 없음이어야 한다`)
    if (!bStep.file && (!bStep.explorer || (!bStep.drive && !bStep.op))) problems.push(`B(${bName}) 는 탐색기 열림 + drive on·op, 또는 file on 이어야 한다`)
  }
  for (const row of stepRows(bName)) {
    if (bStep?.dirty) {
      if (!row.fileTabOpen) problems.push(`B 회차 ${row.round} 1 MB 파일 탭 없음`)
      if (row.fileDirty !== true) problems.push(`B 회차 ${row.round} 측정 끝에 수정 표시 없음`)
      continue
    }
    if (bStep?.op) {
      if (!row.explorer) problems.push(`B 회차 ${row.round} 탐색기 닫힘`)
      if (row.opsPerSec < 0.5) problems.push(`B 회차 ${row.round} 조작 ${row.opsPerSec}/s < 0.5`)
      continue
    }
    if (bStep?.file) {
      if (!row.fileTabOpen) problems.push(`B 회차 ${row.round} 10 MB 파일 탭 없음`)
      if (row.fileChangesPerSec < 1) problems.push(`B 회차 ${row.round} 파일 변경 ${row.fileChangesPerSec}/s < 1`)
      if (row.fileUpdated !== true) problems.push(`B 회차 ${row.round} 측정 구간에 파일 탭 갱신 없음`)
      continue
    }
    if (row.changesPerSec < MIN_CHANGES_PER_SEC) problems.push(`B 회차 ${row.round} 변경 ${row.changesPerSec}/s < ${MIN_CHANGES_PER_SEC}`)
    if (!row.driveExpanded || row.driveReflectMs === null) problems.push(`B 회차 ${row.round} drive 펼침·반영 확인 없음`)
  }
  const a = byStep[aName]
  const b = byStep[bName]
  const metric = (key) => {
    const av = a?.[key]
    const bv = b?.[key]
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return { a: av ?? null, b: bv ?? null, pass: false, reason: '값 없음' }
    const diff = bv - av
    const pass = bv <= av * 1.1 || diff <= 5
    return { a: av, b: bv, diffMs: Math.round(diff * 100) / 100, ratio: av > 0 ? Math.round((bv / av) * 1000) / 1000 : null, pass }
  }
  const p50 = metric('p50')
  const p95 = metric('p95')
  const minimumOk = problems.length === 0
  return { a: aName, b: bName, rule: 'B ≤ A × 1.10 또는 B − A ≤ 5 ms (p50·p95 각각)', minimum: { rounds: MIN_ROUNDS, samples: MIN_SAMPLES, changesPerSec: MIN_CHANGES_PER_SEC, ok: minimumOk, problems }, p50, p95, pass: minimumOk && p50.pass && p95.pass }
}

const verdict = judge(values.a, values.b)
const result = { at: new Date().toISOString(), method: 'l580/k9-ab 방식 — type 주입 시각 → 그 글자 담은 첫 xterm write. 루프 지연 = 계측 loop-delay 구간별.', config: { rounds, samples: sampleCount, steps, a: values.a ?? null, b: values.b ?? null }, byStep, verdict, failure, misses, raw: rows }
writeJson(path.join(path.resolve(values.out), 'latency.json'), result)
console.log(JSON.stringify(byStep))
if (verdict !== null) console.log(`판정 ${verdict.pass ? '통과' : '미달'} — ${JSON.stringify({ p50: verdict.p50, p95: verdict.p95, problems: verdict.minimum.problems })}`)
process.exit(failure === null && misses === 0 && (verdict === null || verdict.pass) ? 0 : 1)
