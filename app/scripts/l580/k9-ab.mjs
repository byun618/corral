// LIFE-580 J6 · L10ⓒ — K9 A/B. 격리 개발 Electron(g-up.sh /tmp/l580g-*) 한 실행 안에서 같은 빌드·같은 기계로
//   A = 모바일 꺼짐   B = 모바일 켜짐 + 구독 클라이언트 1
// 를 교대 3회씩(A B A B A B) 잰다. **상태 변화 구동(≥ 1회/초, 다른 pane 의 에이전트 보고)은 A·B 둘 다에 건다** — 데스크톱도 그 변화를 그리므로
// 차이가 모바일 쪽 비용(목록 만들기·직렬화·전송)만 남게 하려는 것(워커 재량, RESULT.md 에 적음).
//
// 지표(회당): `l353/s2-latency` 와 같은 모양 — 계측 `type` 주입 시각 → 그 글자를 담은 xterm write 완료 시각, 36타(키 사이 220~300 ms) +
//   main 이벤트 루프 지연 p99(계측 `loop-delay`, 구간 앞에서 비우고 뒤에서 읽는다).
// 통과: B 의 p50·p95 가 A 대비 +10% 이내(차이 ≤ 5 ms 면 통과) 이고 A·B 둘 다 옛 통과선(p50 ≤ 117 · p95 ≤ 173 ms) 안. 놓침 0.
//
// 사용(app/ 에서):
//   sh scripts/l577/g-up.sh /tmp/l580g-k /tmp/l580g-fk
//   node scripts/l580/k9-ab.mjs --root /tmp/l580g-k --fake /tmp/l580g-fk --out ../specs/LIFE-580-mobile-list/raw/claude/l10c [--rounds 3]
//   sh scripts/l577/g-down.sh /tmp/l580g-k term herdr
// 종료 코드: 0 통과 · 1 미달 · 2 사용법 오류. 원자료: <out>/k9-ab.json(회차·표본 전부).
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoots, ctl, freshPane, herdr, pct, phone, reportAgent, revokeAll, setMobile, sleep, until, writeJson } from './lib.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, rounds: { type: 'string', default: '3' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (args.out === undefined) throw new Error('--out 필요')
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const ROOT = args.root
const FAKE = args.fake
const OUT = path.resolve(args.out)
const ROUNDS = Number(args.rounds)
const SAMPLES = 36
const FLOOR = { p50: 117, p95: 173 }
const CHARS = 'abcdefghijklmnopqrstuvwxyz'
const gap = () => 220 + Math.floor(Math.random() * 80)

const termRead = async () => (await ctl(ROOT, { cmd: 'term-read' })).term
const countChar = (term, ch) => (term === null ? 0 : term.lines.join('\n').split(ch).length - 1)

/** 셸 pane 을 정적 프롬프트로(에코 외 프레임이 끼지 않게) — l353 `neutralizePrompt` 와 같은 글. */
async function neutralize(paneId) {
  await herdr(ROOT, 'pane.send_text', { pane_id: paneId, text: '\x03' })
  await sleep(150)
  await herdr(ROOT, 'pane.send_text', { pane_id: paneId, text: '\x15' })
  await sleep(120)
  await herdr(ROOT, 'pane.send_text', {
    pane_id: paneId,
    text:
      "precmd() {}; preexec() {}; typeset -ga precmd_functions=(); typeset -ga preexec_functions=(); " +
      "(( $+functions[_zsh_autosuggest_disable] )) && _zsh_autosuggest_disable; fc -p /dev/null 2>/dev/null; " +
      "unset RPROMPT RPS1; PROMPT='READY%# '; clear\n",
  })
  await sleep(500)
}

/** 메인 탭을 눌러 그 pane 을 터미널에 붙인다(streaming 까지). */
async function attach(paneId) {
  const tabId = ((await herdr(ROOT, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  if (tabId === undefined) throw new Error('탭 id 없음')
  const selector = `[data-main-tab="${tabId}"]`
  await until(async () => (await ctl(ROOT, { cmd: 'click', selector })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '탭 클릭' })
  await until(async () => (await ctl(ROOT, { cmd: 'state' })).state?.terminal?.phase === 'streaming', { timeoutMs: 15_000, label: 'streaming' })
}

/** 상태 변화 구동 — 다른 pane 의 에이전트 보고를 working/idle 로 번갈아(간격 600~900 ms ≥ 1회/초). */
function driver(paneId) {
  let stop = false
  let count = 0
  const done = (async () => {
    while (!stop) {
      await reportAgent(ROOT, { paneId, state: count % 2 === 0 ? 'working' : 'idle' }).catch(() => {})
      count += 1
      await sleep(600 + Math.floor(Math.random() * 300))
    }
  })()
  return { stop: async () => { stop = true; await done; return count } }
}

async function sampleRound(paneId) {
  const samples = []
  for (let i = 0; i < SAMPLES; i += 1) {
    const ch = CHARS[i % CHARS.length]
    const before = await termRead()
    const baseCount = countChar(before, ch)
    const injected = await ctl(ROOT, { cmd: 'type', text: ch })
    const injectAt = injected.at
    const seen = await until(async () => {
      const term = await termRead()
      if (countChar(term, ch) <= baseCount) return null
      const after = term.writes.filter((write) => write.at >= injectAt).sort((a, b) => a.at - b.at || a.seq - b.seq)
      return after[0] ?? null
    }, { timeoutMs: 2_000, everyMs: 8, label: `에코 ${ch}` }).catch(() => null)
    samples.push(seen === null ? { i, ch, miss: true } : { i, ch, injectAt, writeAt: seen.value.at, latencyMs: seen.value.at - injectAt })
    await sleep(gap())
  }
  // 줄이 길어지지 않게 지운다(다음 회차 기준선).
  await herdr(ROOT, 'pane.send_text', { pane_id: paneId, text: '\x15' })
  await sleep(200)
  return samples
}

const summary = (samples) => {
  const lat = samples.filter((sample) => !sample.miss).map((sample) => sample.latencyMs)
  return { n: lat.length, misses: samples.length - lat.length, p50: pct(lat, 50), p95: pct(lat, 95), max: lat.length ? Math.max(...lat) : null }
}
const within = (b, a) => b <= a * 1.1 || b - a <= 5

async function main() {
  await setMobile(ROOT, FAKE, false)
  const { paneId } = await freshPane(ROOT)
  const workspaceId = ((await herdr(ROOT, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.workspace_id
  const created = await herdr(ROOT, 'tab.create', { workspace_id: workspaceId, focus: false })
  const drivePane = created.root_pane?.pane_id ?? created.tab?.root_pane?.pane_id
  if (typeof drivePane !== 'string') throw new Error(`구동 pane 없음 ${JSON.stringify(created).slice(0, 200)}`)
  await attach(paneId)
  await neutralize(paneId)
  await ctl(ROOT, { cmd: 'loop-delay' }) // 히스토그램 켜기

  const rounds = []
  for (let r = 0; r < ROUNDS; r += 1) {
    for (const mode of ['A', 'B']) {
      await setMobile(ROOT, FAKE, mode === 'B')
      let client = null
      let lists = 0
      if (mode === 'B') {
        client = await phone(ROOT, { onList: () => { lists += 1 } })
        await until(() => lists > 0, { timeoutMs: 10_000, label: '첫 목록' })
      }
      await attach(paneId)
      const drive = driver(drivePane)
      await sleep(1_500)
      await ctl(ROOT, { cmd: 'loop-delay' }) // 구간 앞 비우기
      const startedAt = Date.now()
      const samples = await sampleRound(paneId)
      const loop = (await ctl(ROOT, { cmd: 'loop-delay' })).loopDelay
      const reports = await drive.stop()
      const seconds = (Date.now() - startedAt) / 1000
      if (client !== null) {
        await client.close()
        await revokeAll(ROOT)
      }
      const row = { round: r + 1, mode, ...summary(samples), loopDelay: loop, reportsPerSec: Math.round((reports / seconds) * 100) / 100, listsReceived: lists, samples }
      rounds.push(row)
      console.log(`회차 ${r + 1}${mode} p50 ${row.p50} · p95 ${row.p95} · 놓침 ${row.misses} · 루프 p99 ${loop.p99}ms · 보고 ${row.reportsPerSec}/s · 목록 ${lists}`)
    }
  }
  await setMobile(ROOT, FAKE, false)

  const all = (mode) => summary(rounds.filter((row) => row.mode === mode).flatMap((row) => row.samples))
  const loopP99 = (mode) => Math.max(...rounds.filter((row) => row.mode === mode).map((row) => row.loopDelay.p99))
  const A = { ...all('A'), loopP99Max: loopP99('A') }
  const B = { ...all('B'), loopP99Max: loopP99('B') }
  const floorOk = (x) => x.p50 <= FLOOR.p50 && x.p95 <= FLOOR.p95
  const pass = A.misses === 0 && B.misses === 0 && within(B.p50, A.p50) && within(B.p95, A.p95) && floorOk(A) && floorOk(B)
  const result = {
    at: new Date().toISOString(),
    method: '같은 실행 안 A(모바일 꺼짐)/B(켜짐+구독 1) 교대. 상태 변화 구동은 A·B 공통. 표본=type 주입 시각→그 글자 담은 첫 xterm write. 루프 지연=monitorEventLoopDelay(10ms) 구간별.',
    rounds: ROUNDS,
    A,
    B,
    rule: 'B p50·p95 ≤ A×1.1 또는 차이 ≤ 5ms, 둘 다 p50 ≤ 117 · p95 ≤ 173, 놓침 0',
    verdict: pass ? '통과' : '미달',
    raw: rounds,
  }
  writeJson(path.join(OUT, 'k9-ab.json'), result)
  console.log(`K9 A p50 ${A.p50}/p95 ${A.p95} · B p50 ${B.p50}/p95 ${B.p95} · 루프 p99 A ${A.loopP99Max} B ${B.loopP99Max} → ${result.verdict}`)
  process.exit(pass ? 0 : 1)
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
