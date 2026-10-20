#!/usr/bin/env node
// LIFE-603 최종 관문 (R3-L · C7) — 한 이름의 「worktree · pane · 런타임 영수증」 개수를 원자료 셋에서 그대로 센다.
//   app/ 에서: node scripts/l603/collect.mjs <ROOT=/tmp/l603g-*> <REPO> <NAME>
//   ① `git -C <REPO> worktree list --porcelain` 에서 경로 꼬리가 `/<NAME>` 인 줄
//   ② 구현 CLI `terminal list --json`(격리 소켓 <ROOT>/ud/runtime/rpc.sock) 에서 path 꼬리가 `/<NAME>` 인 터미널 — handle 은 가린다
//   ③ <ROOT>/ud/runtime/terminal-receipts/*.json 중 result.worktree.path 꼬리가 `/<NAME>` 인 영수증(= worktree create 한 번)
// 출력 JSON 한 줄 + exit 0. 원자료를 못 읽으면 exit 1(0줄 없음). 판정은 하지 않는다 — 개수를 보고 회차 기록이 판정한다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cli/corral.mjs')
const tail = (value, name) => typeof value === 'string' && value.endsWith(`/${name}`)

export function collect({ root, repo, name }) {
  const porcelain = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  const gitWorktrees = porcelain.split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9)).filter((entry) => tail(entry, name))
  const listed = JSON.parse(execFileSync(process.execPath, [CLI, 'terminal', 'list', '--json'], { encoding: 'utf8', env: { ...process.env, CORRAL_RUNTIME_SOCKET: path.join(root, 'ud/runtime/rpc.sock') } }))
  if (!listed.ok) throw new Error(`terminal list 실패 ${JSON.stringify(listed.error)}`)
  const terminals = listed.result.terminals.filter((entry) => tail(entry.path, name)).map((entry) => ({ paneId: entry.paneId, path: entry.path, handle: 't1.<handle-redacted>' }))
  const dir = path.join(root, 'ud/runtime/terminal-receipts')
  const receipts = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).flatMap((file) => {
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    return tail(receipt.result?.worktree?.path, name) ? [{ file, state: receipt.state, createdAt: receipt.createdAt }] : []
  })
  return { name, gitWorktrees: gitWorktrees.length, terminals: terminals.length, receipts: receipts.length, detail: { gitWorktrees, terminals, receipts } }
}

const invokedDirectly = () => { try { return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } }
if (invokedDirectly()) {
  const [root, repo, name] = process.argv.slice(2)
  if (!root?.startsWith('/tmp/l603g-') || /\.\.|\s/.test(root) || !repo || !name) { console.log(JSON.stringify({ ok: false, code: 'usage' })); process.exit(2) }
  try { console.log(JSON.stringify({ ok: true, ...collect({ root, repo, name }) })) } catch (error) { console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) })); process.exit(1) }
}
