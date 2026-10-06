// LIFE-485 fix1 F1 — 링크만 끊는 프록시. <dir>/herdr.sock(control) · <dir>/herdr-client.sock(스트림)을 진짜 서버 소켓으로 잇는다.
// SIGUSR1 을 받으면 control 연결만 전부 끊고 CUT_MS 동안 새 control 연결을 받자마자 끊는다 — 서버는 그대로 돌고 스트림 소켓은 건드리지 않는다.
// 사용: node link-proxy.mjs <프록시 dir> <진짜 서버 dir> [CUT_MS=6000]
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
const [dir, target, cutArg] = process.argv.slice(2)
const CUT_MS = Number(cutArg ?? 6000)
let cutUntil = 0
const control = new Set()
const serve = (name, track) => {
  const listen = path.join(dir, name)
  fs.rmSync(listen, { force: true })
  net.createServer((client) => {
    if (track && Date.now() < cutUntil) { client.destroy(); console.log(`${new Date().toISOString()} ${name} 거절(차단 중)`); return }
    const upstream = net.createConnection(path.join(target, name))
    client.pipe(upstream).pipe(client)
    const pair = { client, upstream }
    if (track) control.add(pair)
    const end = () => { client.destroy(); upstream.destroy(); control.delete(pair) }
    client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end)
  }).listen(listen, () => console.log(`listening ${listen} → ${path.join(target, name)}`))
}
serve('herdr.sock', true)
serve('herdr-client.sock', false)
process.on('SIGUSR1', () => {
  cutUntil = Date.now() + CUT_MS
  console.log(`${new Date().toISOString()} 차단 시작 — control 연결 ${control.size}개 끊음, ${CUT_MS}ms`)
  for (const pair of [...control]) { pair.client.destroy(); pair.upstream.destroy() }
})
console.log(`pid ${process.pid}`)
