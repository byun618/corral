// LIFE-582 R1-A3 초안 경합 재현 — 격리 herdr 세션(이 시험이 띄운 것)의 이 시험이 만든 pane 에서만.
//   npx tsx scripts/l582/race.ts <sock> setup <repo>            → workspace + herdr 관리 claude haiku(agent.start), 한가까지 대기
//   npx tsx scripts/l582/race.ts <sock> race  <pane> <n> [--fence <quietMs>]
//        제품 순서 그대로: agent.get(seq·입력 revision) → 화면(draftState) → **가짜 맥 타자**(pane.send_text — 사람 키와 같은 PTY 입력 경로) → prompt.
//        --fence 가 없으면 구 guard 와 같은 `promptAgent`(seq 만), 있으면 `promptAgentIfQuiet`(seq + revision + 조용한 시간).
//   npx tsx scripts/l582/race.ts <sock> pretype <pane> <n> --fence <quietMs>   → 타자가 관측 **직전**(echo 가 화면에 오기 전) — 조용한 시간 관문(`input_recent`)
//   npx tsx scripts/l582/race.ts <sock> control <pane> <n> --fence <quietMs>   → 양성 대조: 타자 없이 같은 관문으로 prompt
//   npx tsx scripts/l582/race.ts <sock> clear <pane>             → 입력 줄 지우기(Ctrl-U) 후 화면 draftState
//   npx tsx scripts/l582/race.ts <sock> echo <pane> <회수>       → 키 1개 → 화면에 보일 때까지 ms(조용한 시간 근거), 끝나면 지움
//   npx tsx scripts/l582/race.ts <sock> count <pane> <n>         → 기록에서 사람 행: 합쳐짐·폰 단독·초안 단독 개수(본문은 출력하지 않는다 — G5)
// 출력은 JSON 한 줄. 판정이 기대와 다르면 exit 1(C3 — exit 0 을 통과로 읽지 않게).
import fs from 'node:fs'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalBackend } from '../../src/main/adapter/index.js'
import { draftState } from '../../src/main/mobile/keys.js'
import { sessionRecordPaths } from '../../src/runtime/terminal/agent.js'

const [sock, command, target, nth, flag, flagValue] = process.argv.slice(2)
if (sock === undefined || !sock.includes('/herdr-dev/sessions/l582-race') || target === undefined) { console.error('usage (isolated l582-race socket only)'); process.exit(2) }
const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 })
const out = (value: Record<string, unknown>, ok = true): never => { console.log(JSON.stringify({ ok, ...value })); process.exit(ok ? 0 : 1) }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

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
const texts = (n: string) => ({ draft: `draft ${n}`, prompt: `reply with only the word ok ${n}` })

switch (command) {
  case 'setup': {
    if (!fs.realpathSync(target).startsWith('/private/tmp/l582-race')) out({ error: 'repo must be under /tmp/l582-race' }, false)
    const created = await herdr('workspace.create', { cwd: target, focus: false })
    const root = isRecord(created.root_pane) ? created.root_pane : {}
    const paneId = String(root.pane_id ?? '')
    await delay(1500)
    await herdr('agent.start', { name: `l582race${Date.now() % 100000}`, kind: 'claude', pane_id: paneId, args: ['--model', 'haiku'], timeout_ms: 30_000 })
    let trusted = false
    for (let i = 0; i < 60; i += 1) {
      await delay(1000)
      const p = await pane(paneId)
      const info = await backend.agentInfo(p, ctx())
      if ((info.status === 'idle' || info.status === 'done') && info.interactiveReady) out({ paneId, status: info.status, seq: info.stateChangeSeq, input: info.input ?? null, trusted })
      const screen = await backend.screenAnsi(p, ctx())
      // 첫 실행 신뢰 확인 — 기본 선택이 「No, exit」라 아래로 한 칸 옮긴 뒤 Enter.
      if (!trusted && /Yes, I trust this folder/.test(screen)) { await backend.send(p, '\u001b[B', ctx()); await delay(400); await backend.send(p, '\r', ctx()); trusted = true }
    }
    out({ paneId, error: 'not ready' }, false)
    break
  }
  case 'race':
  case 'pretype':
  case 'control': {
    const p = await pane(target)
    const t = texts(nth ?? '0')
    const fence = flag === '--fence' ? Number(flagValue) : null
    if (command === 'pretype') await backend.send(p, t.draft, ctx())
    const observed = await backend.agentInfo(p, ctx())
    const draft = draftState({ kind: 'claude', screen: await backend.screenAnsi(p, ctx()) })
    if (draft !== 'empty') out({ error: 'screen not empty before the run', draft }, command === 'pretype')
    if (command === 'race') await backend.send(p, t.draft, ctx())
    let result = 'sent'
    try {
      if (fence === null) await backend.promptAgent(p, t.prompt, observed.stateChangeSeq, ctx())
      else {
        if (observed.input == null) out({ error: 'guard has no input revision' }, false)
        await backend.promptAgentIfQuiet(p, { text: t.prompt, expectedStateChangeSeq: observed.stateChangeSeq, inputRevision: observed.input!.revision, minIdleMs: fence }, ctx())
      }
    } catch (error) {
      result = error instanceof Error && 'code' in error ? String(error.code) : String(error)
    }
    await delay(600)
    const after = draftState({ kind: 'claude', screen: await backend.screenAnsi(p, ctx()) })
    out({ command, n: nth, fence, seq: observed.stateChangeSeq, input: observed.input ?? null, drafted: command !== 'control', screenBefore: draft, prompt: result, screenAfter: after })
    break
  }
  case 'clear': {
    const p = await pane(target)
    await backend.send(p, '\u0015', ctx())
    await delay(500)
    const after = draftState({ kind: 'claude', screen: await backend.screenAnsi(p, ctx()) })
    out({ cleared: after }, after === 'empty')
    break
  }
  case 'echo': {
    const p = await pane(target)
    const samples: number[] = []
    for (let i = 0; i < Number(nth ?? '5'); i += 1) {
      if (draftState({ kind: 'claude', screen: await backend.screenAnsi(p, ctx()) }) !== 'empty') out({ error: 'not empty' }, false)
      const at = Date.now()
      await backend.send(p, 'q', ctx())
      let seen = -1
      while (Date.now() - at < 3000) {
        if (draftState({ kind: 'claude', screen: await backend.screenAnsi(p, ctx()) }) === 'draft') { seen = Date.now() - at; break }
      }
      samples.push(seen)
      await backend.send(p, '\u0015', ctx())
      await delay(700)
    }
    out({ samples, max: Math.max(...samples) }, samples.every(v => v >= 0))
    break
  }
  case 'count': {
    const p = await pane(target)
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
    out({ n: nth, file: file.replace(process.env.HOME ?? '~', '~'), bytes: fs.statSync(file).size, userRows: rows, merged, promptOnly, draftOnly })
    break
  }
  default: process.exit(2)
}
