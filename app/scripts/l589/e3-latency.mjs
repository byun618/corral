// LIFE-589 E3ⓓ — 터미널 입력 지연 A/B (`l580/k9-ab.mjs` 방식). 격리 개발 Electron(g-up.sh /tmp/l589g-*) 한 실행 안에서
//   계획(--plan)의 단계를 교대로 잰다. 단계 = `<이름>:<explorer open|closed>:<drive on|off>`.
//   - explorer open = 패널 `[data-right-panel="open"]` + 실제 폭 > 0 · closed = `[data-right-panel="closed"]`(패널은 닫혀도 탐색기를 마운트 유지하므로
//     `[data-explorer]` 존재로는 가리지 못한다 — 리뷰 r1 R1-H)
//   - drive on = 측정 동안 레포 안 `l589-drive/` 폴더에 파일 생성·삭제 ≥ 5회/초(외부 변경). explorer open 이면 그 폴더 행을 **펼치고**(aria-expanded)
//     탐침 파일 하나가 하위 행으로 나타나는 것(반영)을 확인한 뒤 잰다
// 기준선(구현 전)에는 탐색기가 없으므로 `base:closed:off`·`base-drive:closed:on` 만 돈다.
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
import { checkRoot, ctl, evalJs, herdr, pct, repoPane, sleep, until, writeJson } from './lib.mjs'

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
  const [name, explorer, drive] = text.split(':')
  return { name, explorer: explorer === 'open', drive: drive === 'on' }
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

async function sampleRound(paneId) {
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
    samples.push(seen === null ? { i, ch, miss: true } : { i, ch, injectAt, writeAt: seen.value.at, latencyMs: seen.value.at - injectAt })
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
      await setExplorer(step.explorer)
      const driveDir = path.join(repo, 'l589-drive')
      if (step.drive) fs.mkdirSync(driveDir, { recursive: true })
      const driveView = step.drive && step.explorer ? await expandDrive(driveDir, r) : { expanded: false, reflectMs: null }
      await attach(paneId)
      const drive = step.drive ? driver(driveDir) : null
      try {
        await sleep(1_500)
        await ctl(root, { cmd: 'loop-delay' })
        const windowStart = Date.now()
        const samples = await sampleRound(paneId)
        const loopDelay = (await ctl(root, { cmd: 'loop-delay' })).loopDelay ?? null
        const windowEnd = Date.now()
        const changesInWindow = drive === null ? 0 : drive.changes.filter((at) => at >= windowStart && at <= windowEnd).length
        const row = { round: r, step: step.name, explorer: step.explorer, drive: step.drive, driveExpanded: driveView.expanded, driveReflectMs: driveView.reflectMs, windowStart, windowEnd, changesPerSec: Math.round((changesInWindow / ((windowEnd - windowStart) / 1000)) * 100) / 100, loopDelay, ...summary(samples), samples }
        rows.push(row)
        console.log(`회차 ${r} ${step.name} p50 ${row.p50} p95 ${row.p95} 놓침 ${row.misses} 루프 p99 ${loopDelay?.p99} 변경 ${row.changesPerSec}/s`)
      } finally {
        if (drive !== null) await drive.stop()
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
    if (aStep.explorer) problems.push(`A(${aName}) 는 탐색기 닫힘이어야 한다`)
    if (!bStep.explorer || !bStep.drive) problems.push(`B(${bName}) 는 탐색기 열림 + drive on 이어야 한다`)
  }
  for (const row of stepRows(bName)) {
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
