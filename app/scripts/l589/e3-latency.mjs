// LIFE-589 E3ⓓ — 터미널 입력 지연 A/B (`l580/k9-ab.mjs` 방식). 격리 개발 Electron(g-up.sh /tmp/l589g-*) 한 실행 안에서
//   계획(--plan)의 단계를 교대로 잰다. 단계 = `<이름>:<explorer open|closed>:<drive on|off>`.
//   - explorer open = ⌘⇧E 로 탐색기를 열고(`[data-explorer]` 확인) drive 폴더를 펼친 상태 · closed = 패널을 닫은 상태
//   - drive on = 측정 동안 레포 안 `l589-drive/` 폴더에 파일 생성·삭제 ≥ 5회/초(외부 변경)
// 기준선(구현 전)에는 탐색기가 없으므로 `base:closed:off`·`base-drive:closed:on` 만 돈다.
// 지표(회당): type 주입 시각 → 그 글자를 담은 첫 xterm write ms(36타) · main 이벤트 루프 지연 p99(계측 `loop-delay`).
// 사용(app/ 에서):
//   sh scripts/l577/g-up.sh /tmp/l589g-a /tmp/l589g-fa
//   node scripts/l589/e3-latency.mjs --root /tmp/l589g-a --out <dir> --plan base:closed:off,base-drive:closed:on [--rounds 3] [--samples 36] [--repo <path>]
//   sh scripts/l577/g-down.sh /tmp/l589g-a term herdr
// 종료 코드: 0 실행 완료(놓침 0) · 1 실행 실패 또는 놓침 · 2 사용법. 판정(+10%)은 B 가 있을 때만 계산한다(기준선은 수치 기록).
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, herdr, pct, repoPane, sleep, until, writeJson } from './lib.mjs'

const CHARS = 'abcdefghijklmnopqrstuvwxyz'
const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' }, plan: { type: 'string' }, rounds: { type: 'string', default: '3' }, samples: { type: 'string', default: '36' }, repo: { type: 'string' } } })
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

async function setExplorer(open) {
  // 탐색기 열림 여부는 화면 표식으로 본다. 구현 전에는 표식이 없어 open 단계를 만들 수 없다 — 그때는 실패로 끝낸다.
  const isOpen = async () => (await evalJs(root, `!!document.querySelector('[data-explorer]')`)) === true
  if ((await isOpen()) === open) return
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
      await attach(paneId)
      const drive = step.drive ? driver(path.join(repo, 'l589-drive')) : null
      try {
        await sleep(1_500)
        await ctl(root, { cmd: 'loop-delay' })
        const windowStart = Date.now()
        const samples = await sampleRound(paneId)
        const loopDelay = (await ctl(root, { cmd: 'loop-delay' })).loopDelay ?? null
        const windowEnd = Date.now()
        const changesInWindow = drive === null ? 0 : drive.changes.filter((at) => at >= windowStart && at <= windowEnd).length
        const row = { round: r, step: step.name, explorer: step.explorer, drive: step.drive, windowStart, windowEnd, changesPerSec: Math.round((changesInWindow / ((windowEnd - windowStart) / 1000)) * 100) / 100, loopDelay, ...summary(samples), samples }
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
const result = { at: new Date().toISOString(), method: 'l580/k9-ab 방식 — type 주입 시각 → 그 글자 담은 첫 xterm write. 루프 지연 = 계측 loop-delay 구간별.', config: { rounds, samples: sampleCount, steps }, byStep, failure, misses, raw: rows }
writeJson(path.join(path.resolve(values.out), 'latency.json'), result)
console.log(JSON.stringify(byStep))
process.exit(failure === null && misses === 0 ? 0 : 1)
