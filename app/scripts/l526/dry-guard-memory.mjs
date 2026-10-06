// LIFE-526 fix3 R3-01 · fix4 R4-01 대조 ② — native-footer-dry.mjs 의 **호출부**(runDry)를 가짜 의존성으로 돌린다. 앱·herdr·폴더 삭제·OS 입력 없음.
// 가짜 collect 가 대조 ①의 프로세스 사슬을 그대로 공급하고(자기 pid = 실제 process.pid 로 바꿔 끼움), 가짜 rmSync·mkdirSync·ensureFixtureRepo·launchCorral 은
// 호출을 기록만 한다(launchCorral 은 기록 뒤 「가짜 — 기동하지 않음」 오류). 기대: 가드 실패 경우 → 반환 3 · 기록된 호출 0회. 통과 경우 → rm·mkdir·fixture·launch 순서로 호출(양성).
// 원출력은 회차 꼬리표 파일: <raw>/dry-guard-memory-<tag>.json · 각 경우 guard-before.json 은 <raw>/dry-memory-<tag>/<경우>/
// 사용(저장소 루트): node app/scripts/l526/dry-guard-memory.mjs <raw 폴더> <tag>
import fs from 'node:fs'
import path from 'node:path'
import { runDry } from './native-footer-dry.mjs'

const out = path.resolve(process.argv[2])
const tag = process.argv[3]
if (!tag) throw new Error('<tag> 필요 — 회차마다 다른 파일명')
const file = path.join(out, `dry-guard-memory-${tag}.json`)
if (fs.existsSync(file)) throw new Error(`이미 있다(덮어쓰지 않는다): ${file}`)
fs.mkdirSync(out, { recursive: true })
const me = process.pid
const sh = `${me} 400 node native-footer-dry.mjs /review/output`
const CASES = [
  { name: '1-조상-셸-명령문에-경로', lines: [sh, "400 300 /bin/zsh -c node native-footer-dry.mjs /x && ls /tmp/l526i-dry", '300 1 /usr/sbin/sshd'], expectGuard: false },
  { name: '2-조상-herdr-세션서버', lines: [sh, '400 300 /bin/zsh', '300 1 /opt/homebrew/bin/herdr --session l443-gui-diff server'], expectGuard: false },
  { name: '3-조상-격리경로-Electron', lines: [sh, '400 300 /bin/zsh', '300 1 /path/Electron.app/Contents/MacOS/Electron --user-data-dir=/private/tmp/l526i-dry/corral-userdata'], expectGuard: false },
  { name: '4-비조상-점유', lines: [sh, '400 300 /bin/zsh', '300 1 /usr/sbin/sshd', '301 1 /opt/homebrew/bin/herdr --session l443-gui-diff server'], expectGuard: false },
  { name: '5-비점유', lines: [sh, '400 300 /bin/zsh', '300 1 /usr/sbin/sshd'], expectGuard: true },
  { name: '6-조상-셸이름-비셸-경로', lines: [sh, '400 300 /tmp/x/bash owner.mjs /tmp/l526i-dry', '300 1 -zsh'], expectGuard: false },
  { name: '7-조상-로그인셸-경로없음', lines: [sh, '400 300 -zsh', '300 1 /usr/sbin/sshd'], expectGuard: true },
]
const rows = []
for (const { name, lines, expectGuard } of CASES) {
  const calls = []
  const deps = {
    collect: ({ ports }) => ({ ps: { ok: true, lines, error: null }, portRows: ports.map((port) => ({ port, ok: true, listeners: [], error: null })), selfPid: me }),
    rmSync: (dir) => calls.push(`rmSync ${dir}`),
    mkdirSync: (dir) => calls.push(`mkdirSync ${dir}`),
    ensureFixtureRepo: (work) => { calls.push(`ensureFixtureRepo ${work}`); return { root: path.join(work, 'gui-diff-fixture') } },
    launchCorral: async ({ workDir, port }) => { calls.push(`launchCorral ${workDir} ${port}`); throw new Error('가짜 — 기동하지 않음') },
  }
  const code = await runDry({ rawd: path.join(out, `dry-memory-${tag}`, name), deps })
  const destructive = calls.filter((call) => /^(rmSync|mkdirSync|ensureFixtureRepo|launchCorral) /.test(call))
  const pass = expectGuard
    ? code !== 3 && destructive.join('|') === ['rmSync /tmp/l526i-dry', 'mkdirSync /tmp/l526i-dry', 'rmSync /tmp/l526n-dry', 'mkdirSync /tmp/l526n-dry', 'ensureFixtureRepo /tmp/l526i-dry', 'launchCorral /tmp/l526i-dry 9527'].join('|')
    : code === 3 && destructive.length === 0
  rows.push({ name, expectGuard, code, calls, pass })
  console.log(`${pass ? '맞음' : '틀림'} ${name}: 반환 ${code} · 호출 ${calls.length ? calls.join(' → ') : '0회'}`)
}
fs.writeFileSync(file, `${JSON.stringify({ tag, at: new Date().toISOString(), selfPid: me, rows }, null, 1)}\n`)
process.exit(rows.every((row) => row.pass) ? 0 : 1)
