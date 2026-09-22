// LIFE-409 R4 — a crash injector for the commit window itself, loaded into `corral serve` with
// `NODE_OPTIONS=--import`. **No product code is involved**: this wraps `fs.renameSync` and
// `fs.fsyncSync` in the runtime process and kills that process inside the window named by
// `L409_KILL_WINDOW`, for writes of one file only (`L409_KILL_TARGET`, the orchestration document,
// and its temporaries).
//
//   before_rename — the temporary file is written and fsynced, the rename has not happened yet.
//                   What must survive: the old document, plus a stray `.tmp` nothing cleaned up.
//   after_rename  — the rename returned; the receipt that would mark the request complete has not
//                   been written. What must survive: the new document, and a receipt still pending,
//                   so the same --request-id answers `outcome_unknown` instead of running twice.
//
// The injector is **armed by a file** (`L409_KILL_ARM_FILE`): until the harness creates it, writes
// pass through untouched. Without that, the first write of a fresh runtime is the runtime-start
// reconcile sweep, and killing *that* would look exactly like killing the mutation while proving
// nothing about it. Every hit is appended to `L409_KILL_LOG` before the signal, so "the window was
// actually hit" is evidence in the raw record rather than an inference from timing.
import fs from 'node:fs'

const window = process.env.L409_KILL_WINDOW ?? ''
const target = process.env.L409_KILL_TARGET ?? ''
const log = process.env.L409_KILL_LOG ?? ''
if (window && target) {
  const realRename = fs.renameSync.bind(fs)
  const realAppend = fs.appendFileSync.bind(fs)
  const note = event => { if (log) realAppend(log, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event }) + '\n') }
  const armFile = process.env.L409_KILL_ARM_FILE ?? ''
  const armed = () => armFile === '' || fs.existsSync(armFile)
  const mine = file => typeof file === 'string' && (file === target || file.startsWith(target + '.'))
  // N11 = C16: there is no fsync wrapper. The identity one r1 installed looked like a witness and
  // proved nothing; what actually shows the temporary file was complete before the rename is
  // `tmpBytes` below, measured on the file itself at the moment of the kill.
  fs.renameSync = (from, to) => {
    if (!mine(String(to)) || !armed()) return realRename(from, to)
    const bytes = (() => { try { return fs.statSync(String(from)).size } catch { return null } })()
    if (window === 'before_rename') { note({ window, from: String(from), to: String(to), tmpBytes: bytes }); process.kill(process.pid, 'SIGKILL') }
    const result = realRename(from, to)
    if (window === 'after_rename') { note({ window, from: String(from), to: String(to), tmpBytes: bytes }); process.kill(process.pid, 'SIGKILL') }
    return result
  }
  note({ window, armed: true, target })
}
