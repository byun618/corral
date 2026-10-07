// LIFE-519 하네스 공통 — 격리 경로 가드(504)·관측기·프로세스 정리.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
export const HERE = path.dirname(new URL(import.meta.url).pathname)
export const APP = path.resolve(HERE, '../..')
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
export function header() {
  return { head: execFileSync('git', ['-C', APP, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, tmpdir: process.env.TMPDIR, at: new Date().toISOString() }
}
export function processesUsing(needle) {
  return execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').filter(l => l.includes(needle) && !l.includes(`${process.pid} `) && !/k1b-serve|k1c-open|k2e-cold|observe\.mjs|run\.sh/.test(l))
}
/** 504 가드 — 같은 격리 경로를 쓰는 다른 프로세스가 있으면 측정하지 않는다. */
export function guard(work) {
  if (!/^\/tmp\/l519w[\w-]*$/.test(work)) throw new Error(`격리 경로는 /tmp/l519w*: ${work}`)
  const others = processesUsing(work)
  if (others.length) throw new Error(`504 가드 — ${work} 를 쓰는 프로세스가 있다:\n${others.join('\n')}`)
}
export async function startObserver(endpoint, out) {
  const stop = out + '.stop'; fs.rmSync(stop, { force: true })
  const child = spawn(process.execPath, [path.join(HERE, 'observe.mjs'), endpoint, out, stop], { stdio: 'ignore' })
  for (let i = 0; i < 200 && !fs.existsSync(out + '.ready'); i++) await pause(5)
  // 관측기가 못 뜬 채 진행하면 결과가 「loose 0」 으로 읽힌다 — 준비 표식이 없으면 멈춘다(R1-claude-07).
  if (!fs.existsSync(out + '.ready')) { child.kill('SIGKILL'); throw new Error(`관측기 준비 시간 초과(1s): ${out}`) }
  return { pid: child.pid, finish: async () => { fs.writeFileSync(stop, ''); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); fs.rmSync(stop, { force: true }); return JSON.parse(fs.readFileSync(out, 'utf8')) } }
}
export function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
export async function stopPids(pids, timeout = 15000) {
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* 이미 없음 */ } }
  const until = Date.now() + timeout
  while (Date.now() < until && pids.some(alive)) await pause(50)
  for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL') } catch { /* 이미 없음 */ } }
  await pause(100)
  return pids.filter(alive)
}
/** 격리 corral(사용자 데이터·herdr 세션·제어 소켓 전부 work 아래) — l471 isolation 과 같은 변수. herdr 는 격리 세션으로 띄운다. */
export function isolation(work, session = 'l519') {
  const userData = path.join(work, 'ud'), herdrHome = path.join(work, 'hh')
  const env = { ...process.env }
  for (const key of ['CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key]
  const backend = path.join(herdrHome, 'herdr/sessions', session, 'herdr.sock')
  Object.assign(env, { CORRAL_USER_DATA: userData, CORRAL_UI_PREFS: path.join(work, 'ui-prefs.json'), HERDR_CONFIG_PATH: path.join(herdrHome, 'config.toml'), XDG_CONFIG_HOME: herdrHome,
    CORRAL_CONTROL_SOCKET: path.join(work, 'ctl.sock'), CORRAL_REGISTRY: path.join(userData, 'repos.json'), SHELL: '/bin/sh', CORRAL_BACKEND_SOCKET: backend, CORRAL_SESSION: session })
  return { work, session, userData, herdrHome, backend, env, endpoint: path.join(userData, 'runtime/rpc.sock') }
}
export async function startHerdr(iso) {
  fs.mkdirSync(iso.herdrHome, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(iso.herdrHome, 'config.toml'), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n')
  const fd = fs.openSync(path.join(iso.work, 'herdr.log'), 'a')
  const child = spawn('herdr', ['--session', iso.session, 'server'], { env: iso.env, stdio: ['ignore', fd, fd] }); fs.closeSync(fd)
  for (let i = 0; i < 600 && !fs.existsSync(iso.backend); i++) await pause(50)
  if (!fs.existsSync(iso.backend)) throw new Error('herdr backend socket 안 뜸')
  return child.pid
}
/** 이 격리 userData 로 뜬 Electron(메인·헬퍼) pid — 명령줄의 --user-data-dir 로 찾는다. 메인을 앞에. */
export function electronPids(userData) {
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').filter(l => l.includes(`--user-data-dir=${userData}`))
  const parsed = rows.map(l => l.trim().split(/\s+/)).map(([pid, ppid, ...cmd]) => ({ pid: Number(pid), ppid: Number(ppid), helper: cmd.join(' ').includes('Helper') }))
  return [...parsed.filter(p => !p.helper), ...parsed.filter(p => p.helper)].map(p => p.pid)
}
