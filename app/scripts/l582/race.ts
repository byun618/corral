// LIFE-582 R1-A3·R2-A3 초안 경합 재현 — 격리 herdr 세션(이 시험이 띄운 것)의 이 시험이 만든 pane 에서만.
//   npx tsx scripts/l582/race.ts <sock> setup <repo> [claude|codex|grok]   → workspace + herdr 관리 에이전트(agent.start), 한가까지 대기
//        claude = `--model haiku` · codex = `-c check_for_update_on_startup=false -c model_reasoning_effort="low"` · grok = 인자 없음.
//   npx tsx scripts/l582/race.ts <sock> race  <pane> <n> [--fence <quietMs>]
//        제품 순서 그대로: agent.get(seq) → 화면(같은 guard 턴의 입력 revision·조용한 시간, R2-A3) → **가짜 맥 타자**(pane.send_text — 사람 키와 같은
//        PTY 입력 경로) → prompt. --fence 가 없으면 구 guard 와 같은 `promptAgent`(seq 만), 있으면 `promptAgentIfQuiet`(seq + 화면 revision + 조용한 시간).
//   npx tsx scripts/l582/race.ts <sock> pretype <pane> <n> --fence <quietMs>   → 타자가 관측 **직전**(echo 가 화면에 오기 전)
//   npx tsx scripts/l582/race.ts <sock> control <pane> <n> --fence <quietMs>   → 양성 대조: 타자 없이 같은 관문으로 prompt
//   npx tsx scripts/l582/race.ts <sock> bypass <pane> <n>                     → R2-A3: guard 칸 없는 agent.prompt(CLI 경로)도 revision 을 올리나 +
//        그 전 revision 으로 울타리 친 prompt 가 `input_changed` 인가
//   npx tsx scripts/l582/race.ts <sock> clear <pane>             → 입력 줄 지우기(Ctrl-U) 후 화면 draftState
//   npx tsx scripts/l582/race.ts <sock> echo <pane> <회수>       → 키 1개 → 화면에 보일 때까지 ms(조용한 시간 근거), 끝나면 지움(Backspace). provider 는 pane 의 agent 종류
//   npx tsx scripts/l582/race.ts <sock> count <pane> <n> --expect refused|delivered → 기록에서 사람 행: 합쳐짐·폰 단독·초안 단독 개수(본문은 출력하지 않는다 — G5)
// 출력은 JSON 한 줄. **판정이 기대와 다르면 exit 1**(C3·C6 — exit 0 을 통과로 읽을 수 있게): race·pretype = 넣지 않음, control = sent,
// bypass = revision 증가 + input_changed, count --expect refused = 합쳐짐 0·폰 단독 0, --expect delivered = 합쳐짐 0·폰 단독 1, echo = 모든 표본이 보임.
import fs from 'node:fs'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalBackend } from '../../src/main/adapter/index.js'
import { draftState, screenPlain } from '../../src/main/mobile/keys.js'
import type { MobileAgentKind } from '../../src/main/mobile/list.js'
import { sessionRecordPaths } from '../../src/runtime/terminal/agent.js'

const [sock, command, target, nth, flag, flagValue] = process.argv.slice(2)
if (sock === undefined || !sock.includes('/herdr-dev/sessions/l582-race') || target === undefined) { console.error('usage (isolated l582-race socket only)'); process.exit(2) }
const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 })
const out = (value: Record<string, unknown>, ok: boolean): never => { console.log(JSON.stringify({ ok, ...value })); process.exit(ok ? 0 : 1) }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const kindOf = (value: string | null | undefined): MobileAgentKind | null => (value === 'claude' || value === 'codex' || value === 'grok' ? value : null)
const codeOf = (error: unknown): string => (error instanceof Error && 'code' in error ? String(error.code) : String(error))

function herdr(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock!)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l582race', method, params }) + '\n'))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      socket.destroy()
      const message: unknown = JSON.parse(buffer.slice(0, index))
      if (!isRecord(message)) return reject(new Error('bad reply'))
      if (isRecord(message.error)) return reject(new Error(`${method}: ${String(message.error.code)}`))
      resolve(isRecord(message.result) ? message.result : {})
    })
  })
}

const backend = new TerminalBackend(sock)
const epoch = await backend.epoch(ctx())
async function pane(paneId: string) {
  const found = (await backend.list(epoch, ctx())).find(p => p.paneId === paneId)
  if (found === undefined || !fs.realpathSync(found.path).startsWith('/private/tmp/l582-race')) out({ error: 'not an l582-race pane' }, false)
  return found!
}
/** 그 pane 의 agent 종류 — 화면 판독(draftState)이 provider 마다 다르다. */
async function kindAt(p: Awaited<ReturnType<typeof pane>>): Promise<MobileAgentKind> {
  const kind = kindOf((await backend.agentInfo(p, ctx())).kind)
  if (kind === null) out({ error: 'no provider in pane' }, false)
  return kind!
}
const texts = (n: string) => ({ draft: `draft ${n}`, prompt: `reply with only the word ok ${n}` })
const ARGS: Record<MobileAgentKind, string[]> = {
  claude: ['--model', 'haiku'],
  codex: ['-c', 'check_for_update_on_startup=false', '-c', 'model_reasoning_effort="low"'],
  grok: [],
}

switch (command) {
  case 'setup': {
    if (!fs.realpathSync(target).startsWith('/private/tmp/l582-race')) out({ error: 'repo must be under /tmp/l582-race' }, false)
    const kind = kindOf(nth ?? 'claude')
    if (kind === null) out({ error: 'kind' }, false)
    const created = await herdr('workspace.create', { cwd: target, focus: false })
    const root = isRecord(created.root_pane) ? created.root_pane : {}
    const paneId = String(root.pane_id ?? '')
    await delay(1500)
    await herdr('agent.start', { name: `l582race${Date.now() % 100000}`, kind, pane_id: paneId, args: ARGS[kind!], timeout_ms: 30_000 })
    let trusted = false
    let screen = ''
    for (let i = 0; i < 60; i += 1) {
      await delay(1000)
      const p = await pane(paneId)
      const info = await backend.agentInfo(p, ctx())
      if ((info.status === 'idle' || info.status === 'done') && info.interactiveReady) out({ paneId, kind, status: info.status, seq: info.stateChangeSeq, input: info.input ?? null, trusted }, true)
      screen = (await backend.screenRead(p, ctx())).text
      // 첫 실행 신뢰 확인 — Claude 는 기본 선택이 「No, exit」 라 아래로 한 칸 옮긴 뒤 Enter. Codex 는 기본이 신뢰라 Enter.
      if (!trusted && kind === 'claude' && /Yes, I trust this folder/.test(screen)) { await backend.send(p, '\u001b[B', ctx()); await delay(400); await backend.send(p, '\r', ctx()); trusted = true }
      if (!trusted && kind === 'codex' && /Trust this folder\?|trust the contents of this directory|Do you trust/i.test(screen)) { await backend.send(p, '\r', ctx()); trusted = true }
    }
    out({ paneId, kind, error: 'not ready', screenTail: screenPlain(screen).split('\n').slice(-12).join('\n') }, false)
    break
  }
  case 'race':
  case 'pretype':
  case 'control': {
    const p = await pane(target)
    const kind = await kindAt(p)
    const t = texts(nth ?? '0')
    const fence = flag === '--fence' ? Number(flagValue) : null
    if (command === 'pretype') await backend.send(p, t.draft, ctx())
    const observed = await backend.agentInfo(p, ctx())
    const shot = await backend.screenRead(p, ctx())
    const draft = draftState({ kind, screen: shot.text })
    // 제품과 같은 판정 — 화면이 비지 않았거나, 화면을 잡을 때 입력이 조용하지 않았으면(echo 가 아직 없을 수 있다) 넣지 않는다.
    const notQuiet = fence !== null && (shot.input === null || shot.input.idleMs < fence)
    if (draft !== 'empty' || notQuiet) {
      const held = { command, n: nth, fence, screenBefore: draft, screenInput: shot.input, prompt: draft !== 'empty' ? 'not_sent_draft' : 'not_sent_input_recent' }
      out(held, command === 'pretype')
    }
    if (command === 'race') await backend.send(p, t.draft, ctx())
    let result = 'sent'
    try {
      if (fence === null) await backend.promptAgent(p, t.prompt, observed.stateChangeSeq, ctx())
      else {
        if (shot.input === null || shot.seq === null) out({ error: 'guard has no screen-turn input revision' }, false)
        if (shot.seq !== observed.stateChangeSeq) out({ error: 'seq moved between agent.get and screen', seq: observed.stateChangeSeq, screenSeq: shot.seq }, false)
        await backend.promptAgentIfQuiet(p, { text: t.prompt, expectedStateChangeSeq: observed.stateChangeSeq, inputRevision: shot.input!.revision, minIdleMs: fence }, ctx())
      }
    } catch (error) {
      result = codeOf(error)
    }
    await delay(600)
    const after = draftState({ kind, screen: (await backend.screenRead(p, ctx())).text })
    // race·pretype 는 넣지 않아야 통과(울타리 없는 구 guard 경로는 재현용 — sent 면 exit 1), control 은 sent 여야 통과.
    const ok = command === 'control' ? result === 'sent' : result !== 'sent'
    out({ command, n: nth, fence, seq: observed.stateChangeSeq, screenInput: shot.input, drafted: command !== 'control', screenBefore: draft, prompt: result, screenAfter: after }, ok)
    break
  }
  case 'bypass': {
    const p = await pane(target)
    const kind = await kindAt(p)
    const t = texts(nth ?? '0')
    const before = await backend.agentInfo(p, ctx())
    const shot = await backend.screenRead(p, ctx())
    if (draftState({ kind, screen: shot.text }) !== 'empty' || shot.input === null) out({ error: 'screen not empty or guard without input revision' }, false)
    // CLI `terminal prompt` 와 같은 칸 없는 agent.prompt — R2-A3 이전 guard 는 이 제출로 revision 을 올리지 않았다(리뷰 native3 6→6).
    let cli = 'sent'
    try { await backend.promptAgent(p, t.prompt, before.stateChangeSeq, ctx()) } catch (error) { cli = codeOf(error) }
    const after = await backend.agentInfo(p, ctx())
    // 그 턴이 끝나 다시 준비될 때까지 — 그래야 거절 사유가 seq(agent_not_ready)가 아니라 입력 revision 이다.
    let ready = after
    for (let i = 0; i < 90; i += 1) {
      if ((ready.status === 'idle' || ready.status === 'done') && ready.interactiveReady && ready.stateChangeSeq !== before.stateChangeSeq) break
      await delay(1000)
      ready = await backend.agentInfo(p, ctx())
    }
    let fenced = 'sent'
    try {
      await backend.promptAgentIfQuiet(p, { text: `${t.prompt} fenced`, expectedStateChangeSeq: ready.stateChangeSeq, inputRevision: shot.input!.revision, minIdleMs: 0 }, ctx())
    } catch (error) {
      fenced = codeOf(error)
    }
    const moved = before.input != null && after.input != null && after.input.revision > before.input.revision
    out({ n: nth, cli, revisionBefore: before.input?.revision ?? null, revisionAfterCli: after.input?.revision ?? null, screenRevision: shot.input!.revision, readySeq: ready.stateChangeSeq, fencedWithOldRevision: fenced }, cli === 'sent' && moved && fenced === 'input_changed')
    break
  }
  case 'clear': {
    const p = await pane(target)
    const kind = await kindAt(p)
    await backend.send(p, '\u0015', ctx())
    await delay(500)
    const after = draftState({ kind, screen: (await backend.screenRead(p, ctx())).text })
    out({ cleared: after }, after === 'empty')
    break
  }
  case 'echo': {
    const p = await pane(target)
    const kind = await kindAt(p)
    const samples: number[] = []
    for (let i = 0; i < Number(nth ?? '5'); i += 1) {
      if (draftState({ kind, screen: (await backend.screenRead(p, ctx())).text }) !== 'empty') out({ kind, error: 'not empty', samples }, false)
      const at = Date.now()
      await backend.send(p, 'q', ctx())
      let seen = -1
      while (Date.now() - at < 3000) {
        if (draftState({ kind, screen: (await backend.screenRead(p, ctx())).text }) === 'draft') { seen = Date.now() - at; break }
      }
      samples.push(seen)
      await backend.send(p, '\u007f', ctx())
      await delay(700)
    }
    out({ kind, samples, max: Math.max(...samples), min: Math.min(...samples) }, samples.every(v => v >= 0))
    break
  }
  case 'count': {
    const p = await pane(target)
    const expect = flag === '--expect' ? flagValue : undefined
    if (expect !== 'refused' && expect !== 'delivered') out({ error: 'count needs --expect refused|delivered' }, false)
    const info = await backend.agentInfo(p, ctx())
    if (info.session === null) out({ error: 'no session ref' }, false)
    const file = sessionRecordPaths('claude', { sessionId: info.session!.value, cwd: p.path, t0Ms: 0, nowMs: 0 })[0]!
    const t = texts(nth ?? '0')
    let merged = 0, promptOnly = 0, draftOnly = 0, rows = 0
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      let row: unknown
      try { row = JSON.parse(line) } catch { continue }
      if (!isRecord(row) || row.type !== 'user' || !isRecord(row.message)) continue
      const content = row.message.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(isRecord).map(part => String(part.text ?? '')).join('') : ''
      rows += 1
      const hasDraft = text.includes(t.draft), hasPrompt = text.includes(t.prompt)
      if (hasDraft && hasPrompt) merged += 1
      else if (hasPrompt) promptOnly += 1
      else if (hasDraft) draftOnly += 1
    }
    const ok = merged === 0 && promptOnly === (expect === 'delivered' ? 1 : 0)
    out({ n: nth, expect, file: file.replace(process.env.HOME ?? '~', '~'), bytes: fs.statSync(file).size, userRows: rows, merged, promptOnly, draftOnly }, ok)
    break
  }
  default: process.exit(2)
}
