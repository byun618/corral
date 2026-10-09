// LIFE-577 최종 관문 — 격리 회차 공용 도구(제어 소켓·가짜 CLI 상태·프로세스 트리·lsof). 실제 tailscale·설치본 무접촉.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 제어 소켓 NDJSON 한 번. */
export function ctl(root, request, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(root, 'ctl/ctl.sock'))
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`ctl 시간 초과 ${JSON.stringify(request).slice(0, 80)}`)) }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.end()
      resolve(JSON.parse(buffer.slice(0, index)))
    })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

export const status = async (root) => (await ctl(root, { cmd: 'mobile-status' })).mobile
export const evalJs = async (root, code) => (await ctl(root, { cmd: 'eval', code })).result

/** 조건이 참이 될 때까지(시각 기록용으로 걸린 ms 를 돌려준다). */
export async function until(check, { timeoutMs = 20_000, everyMs = 100, label = 'until' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const value = await check()
    if (value) return { value, ms: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} 시간 초과`)
    await sleep(everyMs)
  }
}

/** 설정 › Mobile 을 연다 — DOM 합성 클릭(sendInputEvent). OS 입력 없음. */
export async function openMobile(root) {
  // 기동 직후엔 렌더러가 아직 그리는 중이다 — 설정 버튼이 생길 때까지, 그리고 클릭은 히트테스트가 통과할 때까지 다시 시도한다.
  const clickUntilOk = async (selector) => {
    let last = null
    await until(async () => { last = await ctl(root, { cmd: 'click', selector }); return last.ok }, { timeoutMs: 15_000, everyMs: 250, label: selector }).catch(() => null)
    if (!last?.ok) throw new Error(`클릭 실패 ${JSON.stringify(last)}`)
  }
  const open = await evalJs(root, `!!document.querySelector('[data-settings-nav-item="mobile"]')`)
  if (!open) {
    await until(() => evalJs(root, `!!document.querySelector('[data-settings-open]')`), { timeoutMs: 20_000, label: '렌더러 준비' })
    await clickUntilOk('[data-settings-open]')
    await until(() => evalJs(root, `!!document.querySelector('[data-settings-nav-item="mobile"]')`), { label: '설정 화면' })
  }
  await clickUntilOk('[data-settings-nav-item="mobile"]')
  await until(() => evalJs(root, `!!document.querySelector('[data-settings-mobile-row="enabled"] [data-settings-switch]')`), { label: 'Mobile 절' })
}

export const switchChecked = (root) => evalJs(root, `document.querySelector('[data-settings-mobile-row="enabled"] [data-settings-switch]')?.getAttribute('aria-checked')`)
export async function clickSwitch(root) {
  const click = await ctl(root, { cmd: 'click', selector: '[data-settings-mobile-row="enabled"] [data-settings-switch]' })
  if (!click.ok) throw new Error(`스위치 클릭 실패 ${JSON.stringify(click)}`)
  return click
}

/** 가짜 CLI 상태·호출 기록. */
export const fakeState = (fake) => { try { return JSON.parse(fs.readFileSync(path.join(fake, 'state.json'), 'utf8')) } catch { return null } }
export function setFake(fake, patch) {
  const base = fakeState(fake) ?? { backendState: 'Running', dnsName: 'fake-mac.example.ts.net', certDomains: ['fake-mac.example.ts.net'], serve: {} }
  fs.mkdirSync(fake, { recursive: true })
  fs.writeFileSync(path.join(fake, 'state.json'), JSON.stringify({ ...base, ...patch }, null, 2))
}
export function calls(fake) {
  const file = path.join(fake, 'calls.ndjson')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}
export const serveWrites = (list) => list.filter((call) => call.argv[0] === 'serve' && call.argv[1] !== 'status')

/** 앱 pid(최소 = main) + 그 자손 전부 + herdr 이름 세션 서버와 자손. pid 목록 산출 근거를 같이 돌려준다. */
export function processSet(root) {
  const table = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null
  }).filter(Boolean)
  // 씨앗: 명령줄에 이 ROOT 경로가 든 프로세스(앱 main·helper·혹시 있을 런타임) 중 부모가 씨앗이 아닌 것 + herdr 이름 세션 서버(herdr.pid).
  const mine = (row) => row.command.includes(`${root}/`) && !row.command.includes("scripts/l577/g-")
  const seeds = table.filter((row) => mine(row) && !table.some((parent) => parent.pid === row.ppid && mine(parent)))
  const herdrPid = Number(fs.readFileSync(path.join(root, 'herdr.pid'), 'utf8').trim())
  const roots = [...seeds.map((row) => row.pid), ...(table.some((row) => row.pid === herdrPid) ? [herdrPid] : [])]
  const all = new Set(roots)
  let grew = true
  while (grew) {
    grew = false
    for (const row of table) if (all.has(row.ppid) && !all.has(row.pid)) { all.add(row.pid); grew = true }
  }
  const rows = table.filter((row) => all.has(row.pid)).map((row) => ({ pid: row.pid, ppid: row.ppid, command: row.command.replaceAll(process.env.HOME ?? '~', '~').slice(0, 160) }))
  return { roots, pids: [...all].sort((a, b) => a - b), rows }
}

/** `lsof -nP -iTCP -sTCP:LISTEN -a -p <pids>` — 0줄이면 lsof 는 exit 1. 줄 목록을 돌려준다. */
export function lsofListen(pids) {
  try {
    return execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(',')], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch (error) {
    return typeof error.stdout === 'string' ? error.stdout.split('\n').filter(Boolean) : []
  }
}

/** 원자료 기록기 — 파일 하나에 줄을 덧붙인다. 홈 경로는 ~ 로. */
export function recorder(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  const home = process.env.HOME ?? '~'
  return (...parts) => {
    const line = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ').replaceAll(home, '~')
    fs.appendFileSync(file, line + '\n')
    console.log(line)
  }
}
