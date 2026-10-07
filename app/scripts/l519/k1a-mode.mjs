// LIFE-519 K1ⓐ/K2 보조 — 제품 serveSocket(src/runtime/transport.ts, tsx 로 직접)을 부르고, 그 안의 chmodSync 직전에
// endpoint 모드를 lstat 한다 = bind 뒤 권한 확정 전에 최종 경로에 보이는 모드. 처리 전후 umask 도 적는다.
// 사용: node --import tsx k1a-mode.mjs <dir> <loose|private>  — 기대와 맞으면 exit 0
import fs from 'node:fs'
import path from 'node:path'
const [dir, expect] = process.argv.slice(2)
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const endpoint = path.join(dir, 'rpc.sock')
const { serveSocket } = await import('../../src/runtime/transport.ts')
const seen = []
const original = fs.chmodSync
fs.chmodSync = function (file, mode) { if (String(file) === endpoint) seen.push((fs.lstatSync(endpoint).mode & 0o777).toString(8)); return original.call(this, file, mode) }
const umaskBefore = process.umask(0o022); process.umask(umaskBefore)
const stop = await serveSocket(endpoint, async req => ({ id: req.id, ok: true, result: null, _meta: { runtimeId: 'x', outcome: 'completed' } }))
const umaskAfter = process.umask(0o022); process.umask(umaskAfter)
const final = (fs.lstatSync(endpoint).mode & 0o777).toString(8)
await stop()
fs.chmodSync = original
const loose = seen.some(m => parseInt(m, 8) & 0o077)
const result = { node: process.version, endpoint, modeAtChmod: seen, finalMode: final, umaskBefore: umaskBefore.toString(8), umaskAfter: umaskAfter.toString(8), looseVisible: loose, expect }
console.log(JSON.stringify(result))
process.exit((expect === 'loose' ? loose : !loose && seen.length > 0) && umaskBefore === umaskAfter ? 0 : 1)
