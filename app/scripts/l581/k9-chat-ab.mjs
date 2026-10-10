// LIFE-581 Y10ⓒ — 580 J6 방식 A/B 의 대화판. 격리 개발 Electron(g-up.sh /tmp/l581g-* · HOME=<ROOT>/home) 한 실행 안에서
//   A = 모바일 꺼짐   B = 모바일 켜짐 + 폰 자리 1(목록 구독 + **대화 구독 1**)
// 를 교대로(A B A B A B) 잰다. 구동 두 가지는 **A·B 둘 다**: ① 580 과 같은 다른 pane 상태 보고 ≥ 1회/초 ② 대화 pane 의 합성 기록에 새 줄 ≥ 1회/초.
// 데스크톱이 같은 변화를 읽고 그리는 비용은 양쪽에 같고, 차이는 모바일(목록 push + 대화 판독·push)만 남는다.
// 지표·판정은 580 `k9-ab.mjs` 그대로(`judgeK9` — 회차·표본·보고·B 목록 수신·루프 표본, 수치: B p50·p95 ≤ A×1.1 또는 차이 ≤ 5 ms, 둘 다 p50 ≤ 117 · p95 ≤ 173)
// + 대화 조건: 회차마다 대화 줄 ≥ 1회/초, B 는 구간 안에 쓴 줄 전부를 3초 안에 `chat.items` 로 받았다.
//
//   sh scripts/l577/g-up.sh /tmp/l581g-e /tmp/l581g-fe HOME=/tmp/l581g-e/home
//   node scripts/l581/k9-chat-ab.mjs --root /tmp/l581g-e --fake /tmp/l581g-fe --out <dir> [--rounds 3] [--samples 36] [--a-idle-ref]
// 종료 코드: 0 통과 · 1 미달(또는 실행 실패) · 2 사용법. 원자료: <out>/k9-chat-ab.json.
import path from 'node:path'
import { parseArgs } from 'node:util'
import { judgeK9, MIN_REPORTS_PER_SEC, MIN_ROUNDS, MIN_SAMPLES, RECEIVE_WITHIN_MS, summary, roundProblems } from '../l580/k9-ab.mjs'

const CHARS = 'abcdefghijklmnopqrstuvwxyz'
const dotOf = (list, paneId) => {
  if (!list?.available) return null
  for (const repo of list.repos) for (const task of repo.tasks) for (const channel of task.channels) if (channel.id === paneId) return channel.dot
  return null
}

export async function runChatK9({ config, deps, log = () => {} }) {
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

  /** 대화 줄 쓰기 — 대화 pane 의 합성 기록에 답·도구를 번갈아(간격 600~800 ms ≥ 1회/초). A·B 공통(구동과 같은 이유 — 데스크톱 판독 비용은 양쪽에 같다). */
  const writer = (conv) => {
    const writes = []
    let stop = false
    let n = 0
    const done = (async () => {
      while (!stop) {
        const marker = `L581-K9-${Date.now().toString(36)}-${n}`
        const kind = n % 2 === 0 ? 'reply' : 'tool'
        // 호출 id 는 표지로 — 회차마다 같은 id 를 다시 쓰면 판독기가 같은 호출의 중복 기록으로 합친다(F-E1 — 도구 결함, 제품은 설계대로).
        writes.push({ marker, kind, writeAt: conv.write(kind, marker, { callId: marker }) })
        n += 1
        await deps.sleep(600 + Math.floor(Math.random() * 200))
      }
    })()
    return { writes, stop: async () => { stop = true; await done } }
  }

  const rounds = []
  const reference = []
  const chatRows = []
  let failure = null
  let drivePane = null
  try {
    await deps.setMobile(root, fake, false)
    const { paneId } = await deps.freshPane(root)
    const workspaceId = ((await deps.herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.workspace_id
    const created = await deps.herdr(root, 'tab.create', { workspace_id: workspaceId, focus: false })
    drivePane = created.root_pane?.pane_id ?? created.tab?.root_pane?.pane_id ?? null
    if (typeof drivePane !== 'string') throw new Error(`구동 pane 없음 ${JSON.stringify(created).slice(0, 200)}`)
    const chatConv = deps.conversation()
    const { paneId: chatPane } = await deps.agentPane({ root, name: `k9-chat-${Date.now().toString(36)}`, agent: 'claude', id: chatConv.id, state: 'idle' })
    await attach(paneId)
    await neutralize(paneId)
    await deps.ctl(root, { cmd: 'loop-delay' }) // 히스토그램 켜기

    const plan = []
    for (let r = 0; r < roundCount; r += 1) plan.push({ round: r + 1, mode: 'A', drive: true }, { round: r + 1, mode: 'B', drive: true })
    if (config.aIdleRef) plan.push({ round: 'ref', mode: 'A', drive: false })

    for (const step of plan) {
      await deps.setMobile(root, fake, step.mode === 'B')
      const lists = []
      const chats = []
      let closedAt = null
      let client = null
      if (step.mode === 'B') {
        const token = await deps.pairDevice(root, { name: 'l581-k9' })
        client = await deps.phone(root, {
          token,
          name: 'l581-k9',
          onFrame: ({ message, recvAt, raw }) => {
            if (message.type === 'list') lists.push({ seq: message.seq, recvAt, dot: dotOf(message.list, drivePane) })
            else if (message.type.startsWith('chat.')) chats.push({ type: message.type, recvAt, raw })
          },
          onClose: ({ at }) => { closedAt = at },
        })
        await deps.until(() => lists.some((list) => list.dot !== null), { timeoutMs: 10_000, label: '첫 목록' })
        client.chat(chatPane)
        await deps.until(() => chats.some((frame) => frame.type === 'chat.page'), { timeoutMs: 10_000, label: '대화 첫 페이지' })
      }
      await attach(paneId)
      const drive = step.drive ? driver(drivePane) : null
      const chatWrite = step.drive ? writer(chatConv) : null
      try {
        await deps.sleep(1_500)
        await deps.ctl(root, { cmd: 'loop-delay' }) // 구간 앞 비우기
        const windowStart = deps.now()
        const samples = await sampleRound({ paneId, drive })
        const loopDelay = (await deps.ctl(root, { cmd: 'loop-delay' })).loopDelay ?? null
        const windowEnd = deps.now()
        if (drive !== null) await drive.stop()
        if (chatWrite !== null) await chatWrite.stop()
        if (drive !== null && drive.failed() !== null) throw new Error(`상태 보고 실패 — ${drive.failed()}`)
        // 구간 끝 직전 보고의 목록이 도착할 시간(≤ 3초)을 준다.
        if (client !== null) await deps.sleep(RECEIVE_WITHIN_MS)
        const row = { round: step.round, mode: step.mode, windowStart, windowEnd, samples, loopDelay, reports: drive === null ? [] : drive.reports, lists, closedAt }
        if (step.round !== 'ref') {
          const writes = chatWrite === null ? [] : chatWrite.writes.filter((write) => write.writeAt >= windowStart && write.writeAt <= windowEnd)
          const windowS = (windowEnd - windowStart) / 1000
          const received = writes.map((write) => {
            const frame = chats.find((item) => item.type === 'chat.items' && item.recvAt >= write.writeAt && item.raw.includes(write.marker))
            return { kind: write.kind, writeAt: write.writeAt, recvMs: frame === undefined ? null : frame.recvAt - write.writeAt }
          })
          chatRows.push({ round: step.round, mode: step.mode, writes: writes.length, writesPerSec: Math.round((writes.length / windowS) * 100) / 100, chatFrames: chats.filter((item) => item.type === 'chat.items').length, received })
        }
        if (step.round === 'ref') reference.push({ ...row, ...summary(samples), note: 'A 무구동 참고 회차 — 판정에 안 쓴다' })
        else rounds.push(row)
        const check = step.round === 'ref' ? null : roundProblems(row, { samples: sampleCount })
        const sum = summary(samples)
        const chatRow = chatRows.find((item) => item.round === step.round && item.mode === step.mode)
        log(`회차 ${step.round}${step.mode}${step.drive ? '' : '(무구동)'} 대화 줄 ${chatRow?.writes ?? '-'}(${chatRow?.writesPerSec ?? '-'}/s)·수신 ${chatRow === undefined ? '-' : chatRow.received.filter((item) => item.recvMs !== null).length} · p50 ${sum.p50} · p95 ${sum.p95} · 놓침 ${sum.misses} · 루프 p99 ${loopDelay?.p99} · 보고 ${check?.reportsPerSec ?? '-'}/s · 목록 ${lists.length}${check !== null && check.problems.length > 0 ? ` · 문제: ${check.problems.join(', ')}` : ''}`)
      } finally {
        if (drive !== null) await drive.stop()
        if (chatWrite !== null) await chatWrite.stop()
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
  // 대화 조건(LIFE-581 Y10ⓒ): 회차마다 대화 줄 ≥ 1회/초(A·B), B 는 구간 안 쓴 줄 **전부**를 3초 안에 chat.items 로 받았다.
  const chatReasons = []
  for (const row of chatRows) {
    if (!(row.writesPerSec >= MIN_REPORTS_PER_SEC)) chatReasons.push(`${row.round}${row.mode}: 대화 줄 ${row.writesPerSec}/s < 1/s`)
    if (row.mode === 'B') {
      const missed = row.received.filter((item) => item.recvMs === null || item.recvMs > RECEIVE_WITHIN_MS).length
      if (row.writes === 0 || missed > 0) chatReasons.push(`${row.round}B: 대화 줄 ${row.writes} 중 ${missed} 놓침(3초)`)
    }
  }
  const reasons = [...(failure === null ? [] : [`실행 실패: ${failure}`]), ...judged.reasons, ...chatReasons]
  const pass = failure === null && judged.pass && chatReasons.length === 0
  return {
    at: new Date(deps.now()).toISOString(),
    chat: chatRows,
    method: 'LIFE-581: 580 J6 와 같은 A/B 에 B = 모바일 켜짐 + 목록·대화 구독 1(합성 Claude 기록), 대화 줄 쓰기(≥1회/초)는 A·B 공통. 같은 실행 안 A(모바일 꺼짐)/B(켜짐+구독 1) 교대. 상태 변화 구동은 A·B 공통(코디 해석, 재량 4). 표본=type 주입 시각→그 글자 담은 첫 xterm write. 루프 지연=monitorEventLoopDelay(10ms) 구간별. 판정은 회차·표본·구동·B 수신·루프 표본 유효성(R1-A1) 뒤 수치.',
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
  let values
  try {
    values = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, rounds: { type: 'string', default: String(MIN_ROUNDS) }, samples: { type: 'string', default: String(MIN_SAMPLES) }, 'a-idle-ref': { type: 'boolean', default: false } } }).values
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(2)
  }
  const lib = await import('./lib.mjs')
  const rec = await import('./rec.mjs')
  const positive = (text) => (/^\d+$/.test(text ?? '') && Number(text) >= 1 ? Number(text) : null)
  try {
    lib.checkRoots({ root: values.root, fake: values.fake })
    if (values.out === undefined) throw new Error('--out 필요')
    if (positive(values.rounds) === null || positive(values.samples) === null) throw new Error('--rounds·--samples 는 1 이상의 정수')
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(2)
  }
  const config = { root: values.root, fake: values.fake, out: path.resolve(values.out), rounds: positive(values.rounds), samples: positive(values.samples), aIdleRef: values['a-idle-ref'] }
  const reportAgent = async (root, { paneId, state }) => { await lib.herdr(root, 'pane.report_agent', { pane_id: paneId, source: 'l581-measure', agent: 'claude', state }) }
  const conversation = () => new rec.Conversation({ root: config.root, agent: 'claude', id: `l581-k9-${Date.now().toString(36)}` })
  const deps = { ctl: lib.ctl, herdr: lib.herdr, setMobile: lib.setMobile, phone: lib.phone, pairDevice: lib.pairDevice, reportAgent, freshPane: lib.freshPane, agentPane: rec.agentPane, conversation, revokeAll: lib.revokeAll, sleep: lib.sleep, until: lib.until, now: () => Date.now() }
  const result = await runChatK9({ config, deps, log: (line) => console.log(line) })
  lib.writeJson(path.join(config.out, 'k9-chat-ab.json'), result)
  console.log(`K9(대화) A p50 ${result.A.p50}/p95 ${result.A.p95} · B p50 ${result.B.p50}/p95 ${result.B.p95} · 루프 p99 A ${result.A.loopP99Max} B ${result.B.loopP99Max} → ${result.verdict}`)
  for (const reason of result.reasons) console.log(`  - ${reason}`)
  process.exit(result.verdict === '통과' ? 0 : 1)
}

cli().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
