// LIFE-519 K3ⓑⓒⓓ — 서버 쪽 기존 동작이 그대로인지: 살아 있는 owner 두 번째 기동 · 살아 있는 남의 소켓(EADDRINUSE, inode 보존)
// · 죽은 owner 의 남은 소켓 회수 · 죽은 owner 기록과 다른 inode(남의 소켓)는 회수하지 않음. 각 시나리오 전후 umask 를 적는다.
// 사용: node --import tsx k3-server.mjs <src 루트(app/src)> <work=/tmp/l519w*> <out.json>
// 출력의 codes 를 기준 코드(내보낸 사본)와 고친 코드에서 각각 돌려 대조한다. exit 0 = 스크립트가 끝까지 돌았고 umask 가 매번 같았다.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { header, guard, pause, processesUsing } from './lib.mjs'
const [src, work, out] = process.argv.slice(2)
guard(work)
fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true, mode: 0o700 })
for (const key of ['CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION']) delete process.env[key]
const { startRuntime } = await import(path.resolve(src, 'runtime/server.ts'))
const { localCall, request } = await import(path.resolve(src, 'runtime/transport.ts'))
const umask = () => { const u = process.umask(0o022); process.umask(u); return u.toString(8) }
process.umask(0o022)
const result = { ...header(), src: path.resolve(src), scenarios: {} }
const code = e => e?.code ?? String(e)
const status = endpoint => localCall(endpoint, request({ command: 'status', flags: {}, args: [], cwd: '/tmp' }, undefined, 2000)).then(r => r.ok ? 'ok' : r.error.code, code)
async function scenario(name, fn) { const before = umask(); let value; try { value = await fn() } catch (e) { value = { threw: code(e), message: String(e?.message ?? e) } } result.scenarios[name] = { ...value, umaskBefore: before, umaskAfter: umask() }; console.log(name, JSON.stringify(result.scenarios[name])) }
// ① 살아 있는 런타임이 있는 userData 로 두 번째 기동
await scenario('live-owner-second-start', async () => {
  const ud = path.join(work, 'a'); const first = await startRuntime({ userData: ud })
  try { await startRuntime({ userData: ud }); return { second: 'started' } } catch (e) { return { second: code(e), firstStillServes: await status(path.join(ud, 'runtime/rpc.sock')) } } finally { await first.close() }
})
// ② 살아 있는 남의 소켓(CORRAL_RUNTIME_SOCKET) 위 기동 → EADDRINUSE, 그 inode 보존·연결 유지
await scenario('foreign-live-socket', async () => {
  const ud = path.join(work, 'b'); fs.mkdirSync(ud, { mode: 0o700 }); const socket = path.join(ud, 'foreign.sock')
  const foreign = net.createServer(s => s.end()); await new Promise(r => foreign.listen(socket, r)); fs.chmodSync(socket, 0o600)
  const inode = fs.lstatSync(socket).ino; process.env.CORRAL_RUNTIME_SOCKET = socket
  try { await startRuntime({ userData: ud }); return { start: 'started' } } catch (e) {
    const after = fs.lstatSync(socket); const reachable = await new Promise(r => { const c = net.createConnection(socket); c.once('connect', () => { c.destroy(); r(true) }); c.once('error', () => r(false)) })
    return { start: code(e), inodeKept: after.ino === inode, foreignReachable: reachable, ownerJsonLeft: fs.existsSync(path.join(ud, 'runtime/owner.json')) }
  } finally { delete process.env.CORRAL_RUNTIME_SOCKET; await new Promise(r => foreign.close(r)) }
})
// ③ 죽은 owner(SIGKILL)의 남은 소켓 → 기록된 inode 면 회수 후 기동 성공
async function deadOwner(ud) {
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', `const { startRuntime } = await import(${JSON.stringify(path.resolve(src, 'runtime/server.ts'))}); await startRuntime({ userData: ${JSON.stringify(ud)} }); console.log('up'); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'inherit'], cwd: path.resolve(src, '..') })
  await new Promise((resolve, reject) => { child.stdout.on('data', d => String(d).includes('up') && resolve()); child.once('exit', c => reject(new Error(`child exit ${c}`))) })
  const endpoint = path.join(ud, 'runtime/rpc.sock'), inode = fs.lstatSync(endpoint).ino
  process.kill(child.pid, 'SIGKILL'); await new Promise(r => child.exitCode !== null || child.signalCode ? r() : child.once('exit', r))
  return { endpoint, inode, pid: child.pid }
}
await scenario('dead-owner-reclaim', async () => {
  const ud = path.join(work, 'c'); const dead = await deadOwner(ud)
  const left = fs.existsSync(dead.endpoint), owner = JSON.parse(fs.readFileSync(path.join(ud, 'runtime/owner.json'), 'utf8'))
  const rt = await startRuntime({ userData: ud })
  try { const ino = fs.lstatSync(dead.endpoint).ino; return { socketLeftByDead: left, ownerRecordedInode: owner.socketInode === dead.inode, start: 'started', newInode: ino !== dead.inode, mode: (fs.lstatSync(dead.endpoint).mode & 0o777).toString(8), status: await status(dead.endpoint) } }
  finally { await rt.close() }
})
// ④ 죽은 owner 인데 endpoint 가 기록과 다른 inode(남의 소켓)면 지우지 않는다 → 기동 실패, 남의 소켓 보존
await scenario('dead-owner-foreign-inode-kept', async () => {
  const ud = path.join(work, 'd'); const dead = await deadOwner(ud)
  fs.unlinkSync(dead.endpoint)
  const foreign = net.createServer(s => s.end()); await new Promise(r => foreign.listen(dead.endpoint, r)); fs.chmodSync(dead.endpoint, 0o600)
  const inode = fs.lstatSync(dead.endpoint).ino
  try { await startRuntime({ userData: ud }); return { start: 'started' } } catch (e) { return { start: code(e), foreignInodeKept: fs.lstatSync(dead.endpoint).ino === inode } } finally { await new Promise(r => foreign.close(r)) }
})
await pause(100)
result.leftovers = processesUsing(work)
result.umaskStable = Object.values(result.scenarios).every(s => s.umaskBefore === s.umaskAfter)
fs.writeFileSync(out, JSON.stringify(result, null, 1) + '\n')
console.log('umaskStable', result.umaskStable, 'leftovers', result.leftovers.length)
process.exit(result.umaskStable && result.leftovers.length === 0 ? 0 : 1)
