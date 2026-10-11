// LIFE-567 fix1 R1-02 — c1.mjs 실패 전파 양성 대조. 리뷰어 codex-r1-raw/driver-failure.mjs 의 가짜 제어 소켓을 시나리오별로 넓혔다.
// 사용(app/ 에서): node scripts/l567/driver-failure.mjs <out 폴더>  — 시나리오마다 c1.mjs 를 띄워 종료코드를 기대값과 대조, 하나라도 어긋나면 exit 1
//   reviewer      : resize-window·shot 전부 ok:false (리뷰어 원본 그대로) → 기대 비정상 종료
//   resize-fail   : shot 은 성공(파일 있음), resize-window 만 ok:false → 기대 비정상 종료
//   no-change     : 모든 응답 ok 인데 창 폭·열이 그대로 → 기대 비정상 종료
//   healthy       : 모든 응답 ok, resize 가 창·열을 실제로 바꿈 → 기대 exit 0 (하네스가 늘 실패만 내지 않는지)
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'

const out = path.resolve(process.argv[2])
fs.mkdirSync(out, { recursive: true })
const png = path.join(out, 'fake.png')
fs.writeFileSync(png, 'not-a-real-png')

async function scenario(name, opts) {
  const sock = path.join('/tmp', `l567n-drv-${name}.sock`)
  fs.rmSync(sock, { force: true })
  let width = 1000, cols = 80
  const state = () => ({ baseY: 0, viewportY: 0, cursorX: 2, cursorY: 20, length: 24, rows: 24, cols, window: { w: width, h: 600 }, lastLine: 'last', firstVisible: 'first' })
  const measure = () => ({ buffer: state(), view: { active: true, text: '한', row: 20 }, textarea: { row: 20 }, cursor: { row: 20 }, viewMinusCursorLeft: 0 })
  const log = []
  const server = net.createServer((socket) => {
    let buf = ''
    socket.on('data', (d) => {
      buf += d
      if (!buf.includes('\n')) return
      const q = JSON.parse(buf.split('\n')[0])
      let res
      if (q.cmd === 'eval') res = { ok: true, result: q.code.includes('viewMinusCursorLeft:') ? measure() : q.code.includes('lastLine:') ? state() : true }
      else if (q.cmd === 'shot') res = opts.shotOk ? { ok: true, file: png } : { ok: false, error: 'injected shot failure' }
      else if (q.cmd === 'resize-window') {
        if (!opts.resizeOk) res = { ok: false, error: 'injected resize-window failure' }
        else { if (opts.resizeApplies) { cols = Math.round(80 * q.width / 1000); width = q.width } res = { ok: true, width: q.width, height: q.height } }
      } else res = { ok: false, error: `unknown ${q.cmd}` }
      log.push({ cmd: q.cmd, ok: res.ok, error: res.error })
      socket.end(JSON.stringify(res) + '\n')
    })
  })
  await new Promise((resolve) => server.listen(sock, resolve))
  const child = spawn(process.execPath, ['scripts/l567/c1.mjs', sock, path.join(out, name), name, '40'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => (output += d)); child.stderr.on('data', (d) => (output += d))
  const exit = await new Promise((resolve) => child.on('exit', resolve))
  server.close(); fs.rmSync(sock, { force: true })
  const raw = fs.existsSync(path.join(out, name)) ? fs.readdirSync(path.join(out, name)) : []
  const pass = opts.expectFail ? exit !== 0 : exit === 0
  const row = { name, expect: opts.expectFail ? 'nonzero' : 'zero', exit, pass, rawFiles: raw, commands: log, output }
  fs.writeFileSync(path.join(out, `${name}.log.json`), JSON.stringify(row, null, 2))
  console.log(JSON.stringify({ name, expect: row.expect, exit, pass, rawFiles: raw }))
  return pass
}

const results = [
  await scenario('reviewer', { shotOk: false, resizeOk: false, resizeApplies: false, expectFail: true }),
  await scenario('resize-fail', { shotOk: true, resizeOk: false, resizeApplies: false, expectFail: true }),
  await scenario('no-change', { shotOk: true, resizeOk: true, resizeApplies: false, expectFail: true }),
  await scenario('healthy', { shotOk: true, resizeOk: true, resizeApplies: true, expectFail: false }),
]
fs.rmSync(png, { force: true })
process.exit(results.every(Boolean) ? 0 : 1)
