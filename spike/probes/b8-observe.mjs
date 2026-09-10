// ⓑ B8 — 대조군: herdr terminal session observe 스트림.
//
// 이 스트림은 JSON 소켓 메서드 목록(102개)에 없다. 바이너리 endpoint 경로라서
// corral 이 현실적으로 쓸 방법은 CLI 를 서브프로세스로 띄우고 stdout NDJSON 을 읽는 것이다
// (01-criteria.md §B8). 프로브도 그렇게 짠다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/b8-observe.mjs

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Raw, sleep, pct } from '../lib/raw.mjs'
import { RAW_DIR, socketPath } from '../lib/herdr.mjs'
import { makeApi, run, readText } from '../lib/pane.mjs'
import { makeTerm, write, grid, cursor, compare, wideStarts, rowText } from '../lib/xterm.mjs'

const raw = new Raw('b8-observe')
const api = makeApi(raw)
const SPIKE = path.resolve(new URL('..', import.meta.url).pathname)
const SOCK = socketPath()
const R = {}

const P = (await api('pane.list', {})).panes[0].pane_id
for (const p of (await api('pane.list', {})).panes.slice(1)) await api('pane.close', { pane_id: p.pane_id })
await run(api, P, `cd ${SPIKE}`, { settleMs: 600 })

/** pane 안의 셸에게 직접 물어 실제 PTY 크기를 확인한다. */
async function paneSize() {
  await run(api, P, "printf '\\033[2J\\033[H'; stty size", { settleMs: 900 })
  const t = await readText(api, P, 'visible')
  const m = t.text.match(/(\d+)\s+(\d+)/)
  return m ? { rows: Number(m[1]), cols: Number(m[2]) } : null
}

/** observe 를 서브프로세스로 띄우고 프레임을 모은다. */
function observe(target, { cols, rows, label } = {}) {
  const args = ['terminal', 'session', 'observe', target]
  if (cols) args.push('--cols', String(cols))
  if (rows) args.push('--rows', String(rows))
  const startedAt = Date.now()
  const frames = []
  let buf = ''
  const proc = spawn('herdr', args, { env: { ...process.env, HERDR_SOCKET_PATH: SOCK } })
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const at = Date.now()
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        frames.push({ at, parseError: true, line })
        continue
      }
      const bytes = msg.bytes ? Buffer.from(msg.bytes, 'base64').toString('utf8') : null
      frames.push({
        at,
        ms: at - startedAt,
        keys: Object.keys(msg),
        bytes,
        width: msg.width ?? null,
        height: msg.height ?? null,
        seq: msg.seq ?? null,
        full: msg.full ?? null,
        frameType: msg.type ?? null,
        encodingField: msg.encoding ?? null,
        raw: bytes ? null : msg,
      })
      raw.log('observe.frame', { label, ms: at - startedAt, keys: Object.keys(msg), byteLen: bytes?.length ?? 0 })
    }
  })
  const stderr = []
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (d) => stderr.push(d))
  const exit = { at: null, code: null, signal: null }
  proc.on('exit', (code, signal) => {
    exit.at = Date.now()
    exit.code = code
    exit.signal = signal
    raw.log('observe.exit', { label, ms: Date.now() - startedAt, code, signal })
  })
  return {
    proc,
    frames,
    stderr,
    startedAt,
    exit,
    stop() {
      proc.kill('SIGTERM')
    },
    allBytes() {
      return frames.map((f) => f.bytes ?? '').join('')
    },
  }
}

// --- 1) 스트림 포맷 · 첫 프레임 지연 · 잘못된 타깃 ------------------------
{
  const bad = observe('1')
  await sleep(1500)
  bad.stop()
  const ok = observe(P, { label: 'format' })
  await sleep(2000)
  const first = ok.frames[0]
  ok.stop()
  R.format = {
    target: P,
    badTargetResponse: bad.frames[0]?.raw ?? bad.frames[0] ?? null,
    frameKeys: [...new Set(ok.frames.flatMap((f) => f.keys))],
    encoding: 'NDJSON, 프레임마다 {"bytes": base64(ANSI)}',
    firstFrameMs: first?.ms ?? null,
    firstFrameHead: first?.bytes ? JSON.stringify(first.bytes.slice(0, 180)) : null,
    framesIn2s: ok.frames.length,
    totalBytesIn2s: ok.allBytes().length,
  }
  fs.writeFileSync(path.join(RAW_DIR, 'b8-first-frame.ansi'), first?.bytes ?? '')
  console.log('포맷:', JSON.stringify({ ...R.format, firstFrameHead: undefined }))
}

// --- 2) 붙었을 때 원본 pane 이 리사이즈되는가 ----------------------------
{
  const before = await paneSize()
  const steps = [{ when: 'observe 전', size: before }]

  const o1 = observe(P, { label: 'noflags' })
  await sleep(1200)
  steps.push({ when: 'observe 붙은 중 (플래그 없음)', size: await paneSize() })
  o1.stop()
  await sleep(800)
  steps.push({ when: 'observe 뗀 뒤', size: await paneSize() })

  const o2 = observe(P, { cols: 60, rows: 20, label: 'cols60rows20' })
  await sleep(1200)
  steps.push({ when: 'observe 붙은 중 (--cols 60 --rows 20)', size: await paneSize() })
  o2.stop()
  await sleep(1000)
  steps.push({ when: 'observe 뗀 뒤 (2)', size: await paneSize() })

  const sizes = steps.map((s) => `${s.size?.cols}x${s.size?.rows}`)
  R.resizeSideEffect = {
    steps,
    changedWithoutFlags: sizes[1] !== sizes[0],
    changedWithFlags: sizes[3] !== sizes[0],
    restoredAfterDetach: sizes[4] === sizes[0],
  }
  console.log('리사이즈:', JSON.stringify(steps.map((s) => [s.when, `${s.size?.cols}x${s.size?.rows}`])))
}

// --- 3) 관찰자 2개 동시 ---------------------------------------------------
{
  const sizeBefore = await paneSize()
  const a = observe(P, { label: 'dualA' })
  const b = observe(P, { label: 'dualB' })
  await sleep(1500)
  const sizeDuring = await paneSize()
  await sleep(800)
  const bothGotFrames = a.frames.length > 0 && b.frames.length > 0
  a.stop()
  b.stop()
  R.dualObservers = {
    sizeBefore,
    sizeDuring,
    framesA: a.frames.length,
    framesB: b.frames.length,
    bothGotFrames,
    aStderr: a.stderr.join('').slice(0, 300),
    bStderr: b.stderr.join('').slice(0, 300),
  }
  console.log('관찰자 2개:', JSON.stringify({ ...R.dualObservers, aStderr: undefined, bStderr: undefined }))
}

/** ANSI 이스케이프를 벗긴 순수 글자. 토큰이 시퀀스로 쪼개져도 찾을 수 있게. */
function stripAnsi(t) {
  return t.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b./g, '')
}

// --- 4) 갱신 지연 — pane 에 글자를 넣고 스트림에 뜨기까지 -----------------
{
  const o = observe(P, { label: 'latency' })
  await sleep(1500)
  const marks = []
  for (let i = 0; i < 20; i++) {
    const token = `MARK${i}${'x'.repeat(3)}`
    const before = o.frames.length
    const t0 = Date.now()
    await api('pane.send_text', { pane_id: P, text: `printf '${token}\\n'\n` })
    // 스트림에 토큰이 나타날 때까지 기다린다
    // 토큰이 프레임 경계에 걸쳐 쪼개질 수 있다 — 프레임별로 찾지 말고 이어붙여 찾는다.
    let seenAt = null
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const since = o.frames.slice(before)
      let acc = ''
      for (const f of since) {
        acc += f.bytes ?? ''
        // 프레임 안에서도 커서 이동 시퀀스가 글자 사이에 낄 수 있다. 이스케이프를 벗기고 찾는다.
        if (stripAnsi(acc).includes(token)) {
          seenAt = f.at
          break
        }
      }
      if (seenAt) break
      await sleep(5)
    }
    marks.push({ i, ms: seenAt ? seenAt - t0 : null })
    await sleep(200)
  }
  o.stop()
  const ok = marks.filter((m) => m.ms !== null).map((m) => m.ms)
  R.updateLatency = {
    samples: marks.length,
    delivered: ok.length,
    // 중간에 끊기면 그게 결과의 일부다 — 스트림이 언제 왜 죽었는지 남긴다
    streamExit: o.exit,
    streamExitAfterMs: o.exit.at ? o.exit.at - o.startedAt : null,
    closeFrames: o.frames.filter((f) => f.frameType && f.frameType !== 'terminal.output').map((f) => f.raw ?? { type: f.frameType }),
    stderr: o.stderr.join('').slice(0, 500),
    lastFrameMs: o.frames.length ? o.frames[o.frames.length - 1].ms : null,
    p50: ok.length ? +pct(ok, 50).toFixed(1) : null,
    p95: ok.length ? +pct(ok, 95).toFixed(1) : null,
    max: ok.length ? Math.max(...ok) : null,
    marks,
    note: '입력 주입(send_text)부터 그 글자가 observe 프레임에 나타날 때까지. 셸 에코·실행 시간 포함',
  }
  console.log('갱신 지연:', JSON.stringify({ p50: R.updateLatency.p50, p95: R.updateLatency.p95, delivered: `${ok.length}/20` }))
}

// --- 5) B1~B4 를 observe 경로로도 잰다 ------------------------------------
function fixtureBytes(file, { holdMs = 500 } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const p = spawn('sh', [path.join(SPIKE, 'fixtures', file)], { cwd: SPIKE })
    p.stdout.on('data', (c) => chunks.push(c))
    setTimeout(() => {
      p.kill('SIGKILL')
      // tty 의 ONLCR 과 같은 변환 (b-snapshot.mjs 와 동일)
      resolve(Buffer.concat(chunks).toString('utf8').replace(/(?<!\r)\n/g, '\r\n'))
    }, holdMs)
  })
}

{
  R.replay = {}
  const FIXTURES = [
    { key: 'log', file: '01-log.sh', alt: false },
    { key: 'cjk', file: '02-cjk.sh', alt: false },
    { key: 'tui', file: '03-tui.sh', alt: true },
  ]
  for (const fx of FIXTURES) {
    const size = await paneSizeQuiet()
    // 화면을 sleep 으로 붙잡는다. 프롬프트가 다시 그려지면 화면이 밀려서
    // "픽스처 출력이 0행부터"라는 전제가 깨진다 — 처음에 이걸로 21% 가 나왔다.
    await run(api, P, `printf '\\033[2J\\033[H'; sh fixtures/${fx.file}; sleep 30`, { settleMs: 1800 })

    // 관찰자는 기본값으로 붙으면 pane 격자가 아니라 자기 격자(120x40)를 쓴다.
    // 스트림이 절대 커서 좌표로 그리므로 격자가 다르면 그대로 어긋난다 — 처음에 이걸로 3% 가 나왔다.
    // pane 과 같은 크기를 명시해 붙는다.
    const o = observe(P, { cols: size.cols, rows: size.rows, label: `replay-${fx.key}` })
    await sleep(2000)
    o.stop()
    const stream = o.allBytes()
    // 프레임이 스스로 알려주는 격자 크기 (width/height) 를 우선 쓴다.
    const meta = o.frames.find((f) => f.keys.includes('width'))
    const declared = meta ? { cols: meta.width ?? null, rows: meta.height ?? null } : null
    fs.writeFileSync(path.join(RAW_DIR, `b8-${fx.key}-stream.ansi`), stream)

    const bytes = await fixtureBytes(fx.file)
    // 프레임이 선언한 격자를 진실로 삼는다 (없으면 pane 격자).
    const gcols = declared?.cols ?? size.cols
    const grows = declared?.rows ?? size.rows
    const A = makeTerm(gcols, grows)
    await write(A, '\x1b[2J\x1b[H')
    await write(A, bytes)
    const B = makeTerm(gcols, grows)
    await write(B, stream)

    const ga = grid(A)
    const gb = grid(B)
    let last = -1
    ga.forEach((row, y) => {
      if (rowText(row).trim() !== '') last = y
    })
    const rows = last + 1
    const cmp = compare(ga, gb, { rows })
    const wideMismatch = []
    for (let y = 0; y < rows; y++) {
      const wa = wideStarts(ga[y] ?? [])
      const wb = wideStarts(gb[y] ?? [])
      if (!(wa.length === wb.length && wa.every((c, i) => c.x === wb[i]?.x && c.ch === wb[i]?.ch)))
        wideMismatch.push({ y, a: wa, b: wb })
    }
    const ca = cursor(A)
    const cb = cursor(B)
    R.replay[fx.key] = {
      grid: size,
      frameDeclaredGrid: declared,
      comparedGrid: { cols: declared?.cols ?? size.cols, rows: declared?.rows ?? size.rows },
      streamBytes: stream.length,
      frames: o.frames.length,
      comparedRows: rows,
      B1_textMatch: +(cmp.textMatch * 100).toFixed(2),
      B2_styleMatch: +(cmp.styleMatch * 100).toFixed(2),
      B3_wideMismatchRows: wideMismatch.length,
      B4_cursor: { a: { x: ca.x, y: ca.y }, b: { x: cb.x, y: cb.y }, match: ca.x === cb.x && ca.y === cb.y },
      textDiff: cmp.textDiff.slice(0, 20),
      rowsA: ga.slice(0, rows).map(rowText),
      rowsB: gb.slice(0, rows).map(rowText),
    }
    const r = R.replay[fx.key]
    console.log(`observe ${fx.key}: B1 ${r.B1_textMatch}% B2 ${r.B2_styleMatch}% B3 ${r.B3_wideMismatchRows} B4 ${r.B4_cursor.match} (프레임 ${r.frames})`)
    A.dispose()
    B.dispose()
    // 모든 픽스처가 sleep 으로 화면을 잡고 있다 — 다음으로 넘어가기 전에 끊는다.
    await api('pane.send_text', { pane_id: P, text: '\x03' })
    await sleep(700)
    if (fx.alt) {
      await api('pane.send_text', { pane_id: P, text: '\x03' })
      await sleep(600)
    }
  }
}

async function paneSizeQuiet() {
  const s = await paneSize()
  return s ?? { cols: 93, rows: 39 }
}

raw.close({ probe: 'b8-observe', at: new Date().toISOString(), results: R })
process.exit(0)
