// LIFE-526 fix4 R4-01 실수집 경로 대조 — 셸 이름(`bash`)으로 띄운 **셸 아닌** 실행 파일(node 심링크)이 조상 점유자일 때 실제 ps 수집으로 가드가 멈추는가.
// 새 작업용 임시 폴더(/tmp/l526fix4-*, 격리 경로 /tmp/l526i*·/tmp/l526n* 아님)에 node → bin/bash 심링크를 만들고, 그 `bash` 로 owner 를 띄운다.
// owner 는 지킬 폴더의 파일을 열어 쥔 채 자식으로 probe 를 띄운다(owner = probe 의 조상). probe 는 실제 collectPreWipe 로 probePreWipe 를 돌린다.
// 기대: pass=false · hit 에 owner pid(조상 표시) · owner 종료 확인. 앱·herdr·포트 무접촉. 끝나면 이 대조가 만든 임시 폴더만 지운다.
// 사용(저장소 루트): node app/scripts/l526/real-bash-owner-control.mjs <raw 폴더> <tag>
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const out = path.resolve(process.argv[2])
const tag = process.argv[3]
if (!tag) throw new Error('<tag> 필요 — 회차마다 다른 파일명')
const file = path.join(out, `real-bash-owner-control-${tag}.json`)
if (fs.existsSync(file)) throw new Error(`이미 있다(덮어쓰지 않는다): ${file}`)
fs.mkdirSync(out, { recursive: true })
const here = path.dirname(new URL(import.meta.url).pathname)
const temp = fs.mkdtempSync('/tmp/l526fix4-')
const owned = path.join(temp, 'owned')
fs.mkdirSync(owned)
fs.mkdirSync(path.join(temp, 'bin'))
const bash = path.join(temp, 'bin', 'bash')
fs.symlinkSync(process.execPath, bash)
const verdictFile = path.join(temp, 'verdict.json')
fs.writeFileSync(path.join(temp, 'probe.mjs'), `import fs from 'node:fs'
import { probePreWipe } from ${JSON.stringify(path.join(here, 'pre-wipe-guard.mjs'))}
fs.writeFileSync(process.argv[3], JSON.stringify(probePreWipe({ dirs: [process.argv[2]], ports: [], session: null })))
`)
fs.writeFileSync(path.join(temp, 'owner.mjs'), `import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const fd = fs.openSync(process.argv[2] + '/held.txt', 'w')
const run = spawnSync(process.execPath, [${JSON.stringify(path.join(temp, 'probe.mjs'))}, process.argv[2], ${JSON.stringify(verdictFile)}], { encoding: 'utf8', timeout: 30_000 })
fs.closeSync(fd)
process.stdout.write(JSON.stringify({ probeStatus: run.status, probeSignal: run.signal, probeStderr: run.stderr }))
`)
const owner = await new Promise((resolve) => {
  const proc = spawn(bash, [path.join(temp, 'owner.mjs'), owned], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', (chunk) => { stdout += chunk })
  proc.stderr.on('data', (chunk) => { stderr += chunk })
  proc.on('error', (error) => resolve({ pid: proc.pid, status: null, signal: null, stdout, stderr, error: String(error) }))
  proc.on('close', (status, signal) => resolve({ pid: proc.pid, status, signal, stdout, stderr, error: null }))
})
const alive = spawnSync('ps', ['-p', String(owner.pid), '-o', 'pid=,command='], { encoding: 'utf8' })
const verdict = fs.existsSync(verdictFile) ? JSON.parse(fs.readFileSync(verdictFile, 'utf8')) : null
const ownerHit = verdict?.hits.find((hit) => hit.pid === owner.pid) ?? null
const checks = {
  probeRan: verdict !== null,
  passFalse: verdict?.pass === false,
  ownerIsAncestorHit: ownerHit?.ancestor === true,
  ownerLineIsBashName: ownerHit?.line.startsWith(bash) === true,
  ownerEnded: owner.status !== null && alive.stdout.trim() === '',
}
const pass = Object.values(checks).every(Boolean)
fs.writeFileSync(file, `${JSON.stringify({ tag, at: new Date().toISOString(), temp, owned, bash, bashTarget: fs.readlinkSync(bash), owner, afterPs: { status: alive.status, stdout: alive.stdout }, checks, pass, verdict }, null, 1)}\n`)
fs.rmSync(temp, { recursive: true, force: true })
console.log(`${pass ? '맞음' : '틀림'} 실수집 bash-심링크 owner(pid ${owner.pid}): pass=${verdict?.pass} · ${JSON.stringify(checks)} · 임시 ${temp} 지움`)
process.exit(pass ? 0 : 1)
