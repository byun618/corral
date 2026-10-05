// LIFE-511 — 명령 하나를 돌려 원자료(stdout+stderr+종료코드)를 남기고 명시 실행 목록에 한 행 적는다(시작 때 쓰고 끝에 고친다).
// 사용: node run-ledgered.mjs --ledger <runs.md> --raw <원자료 파일> --criterion <기준> --cwd <폴더> -- <명령…>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { beginRun, finishRun } from '../gui-diff/lib/runs.mjs'

const argv = process.argv.slice(2)
const split = argv.indexOf('--')
const opts = {}
for (let i = 0; i < split; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1]
const command = argv.slice(split + 1)
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const rawRel = path.relative(repoRoot, path.resolve(opts.raw))
const commandText = `(cd ${opts.cwd}) ${command.join(' ')}`
const id = beginRun(opts.ledger, { criterion: opts.criterion, command: commandText, raw: rawRel })
const result = spawnSync(command[0], command.slice(1), { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: process.env })
const exit = result.status ?? 1
fs.mkdirSync(path.dirname(opts.raw), { recursive: true })
fs.writeFileSync(opts.raw, `$ ${commandText}\n# run ${id} · ${new Date().toISOString()} · exit ${exit}\n\n${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error}` : ''}\n# exit ${exit}\n`)
const expected = Number(opts.expect ?? 0)
finishRun(opts.ledger, id, { criterion: opts.criterion, command: commandText, expectedExit: expected, actualExit: exit, raw: rawRel, result: exit === expected ? '통과' : `실패 — 종료코드 ${exit}` })
process.stdout.write(`${id} exit ${exit}\n`)
process.exitCode = exit === expected ? 0 : 1
