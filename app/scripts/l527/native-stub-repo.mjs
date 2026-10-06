// LIFE-527 K9ⓓ — 네이티브 토스트 1회 준비: 사용자 레지스트리에 **이미 등록된** 첫 레포를 폴더 선택 스텁으로 건다(레지스트리 무변경 — 「이미 등록」 결과).
// 경로는 출력하지 않는다(원자료에 사용자 경로를 남기지 않는다). 실행: node native-stub-repo.mjs <ctl.sock>
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { rpc } from '../gui-diff/lib/corral.mjs'
const registry = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/corral/repos.json'), 'utf8'))
const first = registry.repos[0]
const root = typeof first === 'string' ? first : first.root ?? first.path
if (typeof root !== 'string') throw new Error('첫 레포 경로를 못 읽었다')
const reply = await rpc(process.argv[2], { cmd: 'browse-stub', path: root })
console.log(JSON.stringify({ ok: reply.ok, stubbed: reply.ok ? '등록된 첫 레포(경로 생략)' : null, repos: registry.repos.length }))
process.exit(0)
