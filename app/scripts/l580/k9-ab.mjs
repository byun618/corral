// LIFE-580 J6 · L10ⓒ — K9 A/B. 격리 개발 Electron(g-up.sh /tmp/l580g-*) 한 실행 안에서 같은 빌드·같은 기계로
//   A = 모바일 꺼짐   B = 모바일 켜짐 + 구독 클라이언트 1
// 를 교대로(A B A B A B) 잰다. **상태 변화 구동(≥ 1회/초, 다른 pane 의 에이전트 보고)은 A·B 둘 다에 건다** — J6 은 「폰이 붙어 있는 것」 의
// 비용을 재는 관문이고 상태 변화 자체의 비용은 폰과 무관하다(코디 해석, reviews.md r1 재량 4). 구동이 A 를 얼마나 바꾸는지는
// `--a-idle-ref` 의 A 무구동 참고 회차로 따로 남긴다(판정에는 안 쓴다).
//
// 지표(회당): `l353/s2-latency` 와 같은 모양 — 계측 `type` 주입 시각 → 그 글자를 담은 xterm write 완료 시각 + main 이벤트 루프 지연 p99
//   (계측 `loop-delay`, 구간 앞에서 비우고 뒤에서 읽는다).
//
// **판정(R1-A1 — 측정이 실제로 일어났는지부터 본다)**. 아래가 하나라도 아니면 미달이다:
//   ① 회차 수: A·B 각 ≥ 3, 회당 표본 = 36 개 유한 latency(놓침 0). `--rounds`·`--samples` 를 줄인 실행(스모크)은 그래서 늘 미달이다.
//   ② 구동: 상태 보고가 하나라도 실패하면 **즉시** 그 실행을 실패로 끝낸다(삼키지 않는다). 측정 구간 안에 **성공한** 보고가 ≥ 1회/초.
//   ③ B 수신: 측정 구간 안 성공한 보고 **전부**에 대해, 그 뒤 3초 안에 그 상태(working → working · idle → idle/done)를 담은 목록을 폰이 받았다.
//      구간 안 구독 연결이 닫히지 않았다(구독 유지).
//   ④ 루프 표본: 회차마다 `loop-delay` 표본 수 > 0, p99 가 유한.
//   ⑤ 수치: B 의 p50·p95 가 A 대비 +10% 이내(차이 ≤ 5 ms 면 통과) 이고 A·B 둘 다 p50 ≤ 117 · p95 ≤ 173 ms.
//
// 사용(app/ 에서):
//   sh scripts/l577/g-up.sh /tmp/l580g-k /tmp/l580g-fk
//   node scripts/l580/k9-ab.mjs --root /tmp/l580g-k --fake /tmp/l580g-fk --out ../specs/LIFE-580-mobile-list/raw/claude/l10c [--rounds 3] [--samples 36] [--a-idle-ref]
//   sh scripts/l577/g-down.sh /tmp/l580g-k term herdr
// 종료 코드: 0 통과 · 1 미달(또는 실행 실패) · 2 사용법 오류(0·음수·정수 아님). 원자료: <out>/k9-ab.json(회차·표본·보고·수신 전부).
// 자체 시험: `k9-ab.nodetest.mjs` — 구동 실패·`--rounds 0`·스모크 소표본이 통과하지 못하는지(리뷰 r1 음성 대조) + 정상 양성 대조.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const MIN_ROUNDS = 3
export const MIN_SAMPLES = 36
export const FLOOR = { p50: 117, p95: 173 }
export const MIN_REPORTS_PER_SEC = 1
export const RECEIVE_WITHIN_MS = 3_000
/** herdr 보고 → 목록의 점. provider 없는 보고라 idle 은 한가 또는 (seen 장부 없는) 완료로 보인다. */
export const DOTS_OF = { working: ['working'], idle: ['idle', 'done'] }
const CHARS = 'abcdefghijklmnopqrstuvwxyz'

const positiveInt = (text) => (/^\d+$/.test(text ?? '') && Number(text) >= 1 ? Number(text) : null)

/** 인자 → 설정. 회차·표본은 1 이상의 정수만(0·음수·NaN 은 사용법 오류). */
export function parseK9Args(argv) {
  let values
  try {
    values = parseArgs({
      args: argv,
      options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, rounds: { type: 'string', default: String(MIN_ROUNDS) }, samples: { type: 'string', default: String(MIN_SAMPLES) }, 'a-idle-ref': { type: 'boolean', default: false } },
    }).values
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) }
  }
  if (!/^\/tmp\/l580g-[^/]+$/.test(values.root ?? '')) return { ok: false, error: `ROOT 는 /tmp/l580g-* 여야 한다: ${values.root}` }
  if (!/^\/tmp\/l580g-f[^/]*$/.test(values.fake ?? '')) return { ok: false, error: `FAKE 는 /tmp/l580g-f* 여야 한다: ${values.fake}` }
  if (values.out === undefined) return { ok: false, error: '--out 필요' }
  const rounds = positiveInt(values.rounds)
  const samples = positiveInt(values.samples)
  if (rounds === null) return { ok: false, error: `--rounds 는 1 이상의 정수: ${values.rounds}` }
  if (samples === null) return { ok: false, error: `--samples 는 1 이상의 정수: ${values.samples}` }
  return { ok: true, value: { root: values.root, fake: values.fake, out: path.resolve(values.out), rounds, samples, aIdleRef: values['a-idle-ref'] } }
}

export function pct(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const finiteLatencies = (samples) => samples.filter((sample) => !sample.miss && Number.isFinite(sample.latencyMs) && sample.latencyMs >= 0).map((sample) => sample.latencyMs)

export function summary(samples) {
  const lat = finiteLatencies(samples)
  return { n: lat.length, misses: samples.length - lat.length, p50: pct(lat, 50), p95: pct(lat, 95), max: lat.length > 0 ? Math.max(...lat) : null }
}

/** 한 회차의 유효성(②③④ + 표본 수) — 이유 목록이 비어 있어야 유효. */
export function roundProblems(row, { samples }) {
  const problems = []
  const lat = finiteLatencies(row.samples)
  if (row.samples.length !== samples || lat.length !== samples) problems.push(`표본 ${lat.length}/${samples}(유한 latency)`)
  const windowMs = row.windowEnd - row.windowStart
  if (!(windowMs > 0)) problems.push('측정 구간 없음')
  const inWindow = row.reports.filter((report) => report.ok && report.causeAt >= row.windowStart && report.causeAt <= row.windowEnd)
  const rate = windowMs > 0 ? inWindow.length / (windowMs / 1000) : 0
  if (row.reports.some((report) => !report.ok)) problems.push('상태 보고 실패')
  if (!(rate >= MIN_REPORTS_PER_SEC)) problems.push(`구간 안 성공한 보고 ${rate.toFixed(2)}/s < ${MIN_REPORTS_PER_SEC}/s`)
  if (row.mode === 'B') {
    const missed = inWindow.filter((report) => !row.lists.some((list) => list.recvAt > report.causeAt && list.recvAt <= report.causeAt + RECEIVE_WITHIN_MS && (DOTS_OF[report.state] ?? []).includes(list.dot)))
    if (inWindow.length === 0 || missed.length > 0) problems.push(`B 수신 — 전이 ${inWindow.length} 중 ${missed.length} 놓침`)
    if (row.closedAt !== null && row.closedAt <= row.windowEnd + RECEIVE_WITHIN_MS) problems.push('B 구독 연결이 측정 중 닫혔다')
  }
  const loop = row.loopDelay
  if (loop === null || loop === undefined || !(loop.count > 0) || !Number.isFinite(loop.p99) || loop.started === true) problems.push('루프 지연 표본 없음')
  return { problems, reportsInWindow: inWindow.length, reportsPerSec: Math.round(rate * 100) / 100 }
}

const within = (b, a) => b <= a * 1.1 || b - a <= 5

/** 전체 판정(①~⑤). */
export function judgeK9({ rounds, samples }) {
  const reasons = []
  const checked = rounds.map((row) => ({ row, ...roundProblems(row, { samples }) }))
  for (const item of checked) for (const problem of item.problems) reasons.push(`${item.row.round}${item.row.mode}: ${problem}`)
  const count = (mode) => rounds.filter((row) => row.mode === mode).length
  if (count('A') < MIN_ROUNDS || count('B') < MIN_ROUNDS) reasons.push(`회차 A ${count('A')} · B ${count('B')} < ${MIN_ROUNDS}`)
  if (samples < MIN_SAMPLES) reasons.push(`회당 표본 ${samples} < ${MIN_SAMPLES}`)
  const all = (mode) => summary(rounds.filter((row) => row.mode === mode).flatMap((row) => row.samples))
  const loopP99Max = (mode) => {
    const values = rounds.filter((row) => row.mode === mode).map((row) => row.loopDelay?.p99).filter((value) => Number.isFinite(value))
    return values.length > 0 ? Math.max(...values) : null
  }
  const A = { ...all('A'), loopP99Max: loopP99Max('A') }
  const B = { ...all('B'), loopP99Max: loopP99Max('B') }
  const numbers = [A.p50, A.p95, B.p50, B.p95]
  if (numbers.some((value) => !Number.isFinite(value))) reasons.push('수치 없음(표본 0)')
  else {
    if (!within(B.p50, A.p50)) reasons.push(`B p50 ${B.p50} > A ${A.p50} +10%·5ms`)
    if (!within(B.p95, A.p95)) reasons.push(`B p95 ${B.p95} > A ${A.p95} +10%·5ms`)
    for (const [name, x] of [['A', A], ['B', B]]) {
      if (x.p50 > FLOOR.p50) reasons.push(`${name} p50 ${x.p50} > ${FLOOR.p50}`)
      if (x.p95 > FLOOR.p95) reasons.push(`${name} p95 ${x.p95} > ${FLOOR.p95}`)
    }
  }
  return { pass: reasons.length === 0, reasons, A, B, rounds: checked.map((item) => ({ round: item.row.round, mode: item.row.mode, problems: item.problems, reportsInWindow: item.reportsInWindow, reportsPerSec: item.reportsPerSec })) }
}

const dotOf = (list, paneId) => {
  if (!list?.available) return null
  for (const repo of list.repos) for (const task of repo.tasks) for (const channel of task.channels) if (channel.id === paneId) return channel.dot
  return null
}

/**
 * 측정 본체. `deps` 는 실제 실행에서 `lib.mjs` 의 것을, 자체 시험에서는 가짜를 넣는다 — 판정·흐름 코드는 같다.
 * deps: { ctl, herdr, setMobile, phone, reportAgent, freshPane, revokeAll, sleep, until, now }
 */
export async function runK9({ config, deps, log = () => {} }) {
  const { root, fake, rounds: roundCount, samples: sampleCount } = config
  const termRead = async () => (await deps.ctl(root, { cmd: 'term-read' })).term
  const countChar = (term, ch) => (term === null || term === undefined ? 0 : term.lines.join('\n').split(ch).length - 1)

  /** 메인 탭을 눌러 그 pane 을 터미널에 붙인다 — 오버레이가 없고 클릭이 그 탭에 닿고(hit-test) streaming 까지(R1-A2). */
  const attach = async (paneId) => {
    const tabId = ((await deps.herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
    if (tabId === undefined) throw new Error('탭 id 없음')
    const overlay = await deps.ctl(root, { cmd: 'eval', code: `!!document.querySelector('[data-settings-page],[data-settings-topbar]')` })
    if (overlay.result === true) throw new Error('설정 오버레이가 열려 있다 — 탭을 누를 수 없다')
    const selector = `[data-main-tab="${tabId}"]`
    await deps.until(async () => (await deps.ctl(root, { cmd: 'click', selector })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: `탭 클릭 hit ${selector}` })
    await deps.until(async () => (await deps.ctl(root, { cmd: 'state' })).state?.terminal?.phase === 'streaming', { timeoutMs: 15_000, label: 'streaming' })
  }

  const neutralize = async (paneId) => {
    await deps.herdr(root, 'pane.send_text', { pane_id: paneId, text: '\x03' })
    await deps.sleep(150)
    await deps.herdr(root, 'pane.send_text', { pane_id: paneId, text: '\x15' })
    await deps.sleep(120)
    await deps.herdr(root, 'pane.send_text', {
      pane_id: paneId,
      text:
        "precmd() {}; preexec() {}; typeset -ga precmd_functions=(); typeset -ga preexec_functions=(); " +
        "(( $+functions[_zsh_autosuggest_disable] )) && _zsh_autosuggest_disable; fc -p /dev/null 2>/dev/null; " +
        "unset RPROMPT RPS1; PROMPT='READY%# '; clear\n",
    })
    await deps.sleep(500)
  }

  /** 상태 변화 구동 — 다른 pane 에 working/idle 을 번갈아(간격 400~600 ms — 보고 RPC 시간을 더해도 ≥ 1회/초에 여유. 스모크 s04 에서 600~900 ms 는 1.03/s 까지 내려갔다). 보고 실패는 기록하고 **멈춘다** — 표본 루프가 보고 실행을 끝낸다. */
  const driver = (paneId) => {
    const reports = []
    let stop = false
    let failed = null
    const done = (async () => {
      let i = 0
      while (!stop) {
        const state = i % 2 === 0 ? 'working' : 'idle'
        const causeAt = deps.now()
        try {
          await deps.reportAgent(root, { paneId, state })
          reports.push({ state, causeAt, doneAt: deps.now(), ok: true })
        } catch (error) {
          failed = String(error?.message ?? error)
          reports.push({ state, causeAt, doneAt: deps.now(), ok: false, error: failed })
          return
        }
        i += 1
        await deps.sleep(400 + Math.floor(Math.random() * 200))
      }
    })()
    return { reports, failed: () => failed, stop: async () => { stop = true; await done } }
  }

  const sampleRound = async ({ paneId, drive }) => {
    const samples = []
    for (let i = 0; i < sampleCount; i += 1) {
      if (drive !== null && drive.failed() !== null) throw new Error(`상태 보고 실패 — ${drive.failed()}`)
      const ch = CHARS[i % CHARS.length]
      const before = await termRead()
      const baseCount = countChar(before, ch)
      const injected = await deps.ctl(root, { cmd: 'type', text: ch })
      const injectAt = injected.at
      const seen = await deps.until(async () => {
        const term = await termRead()
        if (countChar(term, ch) <= baseCount) return null
        const after = term.writes.filter((write) => write.at >= injectAt).sort((a, b) => a.at - b.at || a.seq - b.seq)
        // s2 F-1 와 같이 주입 이후 write 수를 남긴다 — 1 이면 잡은 write 가 에코다(판정에는 안 쓰는 확인값).
        return after[0] === undefined ? null : { write: after[0], writesAfterInject: after.length }
      }, { timeoutMs: 2_000, everyMs: 8, label: `에코 ${ch}` }).catch(() => null)
      samples.push(seen === null ? { i, ch, miss: true } : { i, ch, injectAt, writeAt: seen.value.write.at, seq: seen.value.write.seq, writesAfterInject: seen.value.writesAfterInject, latencyMs: seen.value.write.at - injectAt })
      await deps.sleep(220 + Math.floor(Math.random() * 80))
    }
    if (drive !== null && drive.failed() !== null) throw new Error(`상태 보고 실패 — ${drive.failed()}`)
    await deps.herdr(root, 'pane.send_text', { pane_id: paneId, text: '\x15' })
    await deps.sleep(200)
    return samples
  }

  const rounds = []
  const reference = []
  let failure = null
  let drivePane = null
  try {
    await deps.setMobile(root, fake, false)
    const { paneId } = await deps.freshPane(root)
    const workspaceId = ((await deps.herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.workspace_id
    const created = await deps.herdr(root, 'tab.create', { workspace_id: workspaceId, focus: false })
    drivePane = created.root_pane?.pane_id ?? created.tab?.root_pane?.pane_id ?? null
    if (typeof drivePane !== 'string') throw new Error(`구동 pane 없음 ${JSON.stringify(created).slice(0, 200)}`)
    await attach(paneId)
    await neutralize(paneId)
    await deps.ctl(root, { cmd: 'loop-delay' }) // 히스토그램 켜기

    const plan = []
    for (let r = 0; r < roundCount; r += 1) plan.push({ round: r + 1, mode: 'A', drive: true }, { round: r + 1, mode: 'B', drive: true })
    if (config.aIdleRef) plan.push({ round: 'ref', mode: 'A', drive: false })

    for (const step of plan) {
      await deps.setMobile(root, fake, step.mode === 'B')
      const lists = []
      let closedAt = null
      let client = null
      if (step.mode === 'B') {
        client = await deps.phone(root, {
          onList: ({ message, recvAt }) => lists.push({ seq: message.seq, recvAt, dot: dotOf(message.list, drivePane) }),
          onClose: ({ at }) => { closedAt = at },
        })
        await deps.until(() => lists.length > 0, { timeoutMs: 10_000, label: '첫 목록' })
      }
      await attach(paneId)
      const drive = step.drive ? driver(drivePane) : null
      try {
        await deps.sleep(1_500)
        await deps.ctl(root, { cmd: 'loop-delay' }) // 구간 앞 비우기
        const windowStart = deps.now()
        const samples = await sampleRound({ paneId, drive })
        const loopDelay = (await deps.ctl(root, { cmd: 'loop-delay' })).loopDelay ?? null
        const windowEnd = deps.now()
        if (drive !== null) await drive.stop()
        if (drive !== null && drive.failed() !== null) throw new Error(`상태 보고 실패 — ${drive.failed()}`)
        // 구간 끝 직전 보고의 목록이 도착할 시간(≤ 3초)을 준다.
        if (client !== null) await deps.sleep(RECEIVE_WITHIN_MS)
        const row = { round: step.round, mode: step.mode, windowStart, windowEnd, samples, loopDelay, reports: drive === null ? [] : drive.reports, lists, closedAt }
        if (step.round === 'ref') reference.push({ ...row, ...summary(samples), note: 'A 무구동 참고 회차 — 판정에 안 쓴다' })
        else rounds.push(row)
        const check = step.round === 'ref' ? null : roundProblems(row, { samples: sampleCount })
        const sum = summary(samples)
        log(`회차 ${step.round}${step.mode}${step.drive ? '' : '(무구동)'} p50 ${sum.p50} · p95 ${sum.p95} · 놓침 ${sum.misses} · 루프 p99 ${loopDelay?.p99} · 보고 ${check?.reportsPerSec ?? '-'}/s · 목록 ${lists.length}${check !== null && check.problems.length > 0 ? ` · 문제: ${check.problems.join(', ')}` : ''}`)
      } finally {
        if (drive !== null) await drive.stop()
        if (client !== null) {
          await client.close()
          await deps.revokeAll(root)
        }
      }
    }
    await deps.setMobile(root, fake, false)
  } catch (error) {
    failure = String(error?.message ?? error)
    log(`실행 실패: ${failure}`)
  }
  const judged = judgeK9({ rounds, samples: sampleCount })
  const reasons = failure === null ? judged.reasons : [`실행 실패: ${failure}`, ...judged.reasons]
  const pass = failure === null && judged.pass
  return {
    at: new Date(deps.now()).toISOString(),
    method: '같은 실행 안 A(모바일 꺼짐)/B(켜짐+구독 1) 교대. 상태 변화 구동은 A·B 공통(코디 해석, 재량 4). 표본=type 주입 시각→그 글자 담은 첫 xterm write. 루프 지연=monitorEventLoopDelay(10ms) 구간별. 판정은 회차·표본·구동·B 수신·루프 표본 유효성(R1-A1) 뒤 수치.',
    config: { rounds: roundCount, samples: sampleCount, aIdleRef: config.aIdleRef === true },
    rule: 'A·B 각 ≥3회·회당 36 유한 latency · 보고 실패 0 · 구간 안 성공 보고 ≥1/s · B 는 구간 안 전이 전부 3초 안 수신·구독 유지 · 루프 표본>0 · B p50·p95 ≤ A×1.1 또는 차이 ≤5ms · 둘 다 p50 ≤117 · p95 ≤173',
    A: judged.A,
    B: judged.B,
    perRound: judged.rounds,
    verdict: pass ? '통과' : '미달',
    reasons,
    reference,
    raw: rounds,
  }
}

async function cli() {
  const parsed = parseK9Args(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(parsed.error)
    process.exit(2)
  }
  const lib = await import('./lib.mjs')
  const deps = { ctl: lib.ctl, herdr: lib.herdr, setMobile: lib.setMobile, phone: lib.phone, reportAgent: lib.reportAgent, freshPane: lib.freshPane, revokeAll: lib.revokeAll, sleep: lib.sleep, until: lib.until, now: () => Date.now() }
  const result = await runK9({ config: parsed.value, deps, log: (line) => console.log(line) })
  lib.writeJson(path.join(parsed.value.out, 'k9-ab.json'), result)
  console.log(`K9 A p50 ${result.A.p50}/p95 ${result.A.p95} · B p50 ${result.B.p50}/p95 ${result.B.p95} · 루프 p99 A ${result.A.loopP99Max} B ${result.B.loopP99Max} → ${result.verdict}`)
  for (const reason of result.reasons) console.log(`  - ${reason}`)
  process.exit(result.verdict === '통과' ? 0 : 1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => {
    console.error('FAIL', error)
    process.exit(1)
  })
}
