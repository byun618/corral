// LIFE-515 G5 — 명령 한 번을 실행하고 명시 실행 목록(runs.md)에 자기 행을 남긴다(시작에 `실행 중`, 끝에 결과 — gui-diff/lib/runs.mjs).
// 출력(stdout+stderr)과 종료코드를 원자료 파일로 남긴다. 사용(저장소 루트에서):
//   node app/scripts/l515/run.mjs --criterion "K9ⓐ typecheck" --raw specs/LIFE-515-default-agent/raw/claude/k9/typecheck.txt [--cwd app] [--expect 0] -- npm run typecheck
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { beginRun, finishRun } from '../gui-diff/lib/runs.mjs'

const argv = process.argv.slice(2)
const split = argv.indexOf('--')
if (split < 0) throw new Error('-- 뒤에 명령')
const opts = Object.fromEntries(argv.slice(0, split).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const cmd = argv.slice(split + 1)
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const ledger = path.join(repo, 'specs/LIFE-516-general-sidebar/raw/claude/runs.md')
const raw = opts.raw
const expectedExit = Number(opts.expect ?? 0)
const cwd = path.resolve(repo, opts.cwd ?? '.')
const command = `${opts.cwd ? `(cd ${opts.cwd} && ` : ''}${cmd.join(' ')}${opts.cwd ? ')' : ''}`
const id = beginRun(ledger, { criterion: opts.criterion, command, expectedExit, raw })
const started = new Date()
const result = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: process.env })
const actualExit = result.status ?? `signal ${result.signal}`
fs.mkdirSync(path.dirname(path.join(repo, raw)), { recursive: true })
fs.writeFileSync(path.join(repo, raw), `# ${id} · ${opts.criterion}\n# 명령: ${command}\n# 시작 ${started.toISOString()} · 끝 ${new Date().toISOString()} · node ${process.version}\n# 종료코드 ${actualExit} (기대 ${expectedExit})\n\n${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n[spawn error] ${result.error}` : ''}`)
const pass = actualExit === expectedExit
finishRun(ledger, id, { criterion: opts.criterion, command, expectedExit, actualExit, raw, result: pass ? '통과' : '실패' })
console.log(`${id} ${opts.criterion} → exit ${actualExit} ${pass ? '통과' : '실패'} (${raw})`)
process.exit(pass ? 0 : 1)
