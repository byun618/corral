#!/usr/bin/env node
// LIFE-604 R1-G ③ — 초안 글이 디스크·로그에 남지 않는지(C5 「메모리 전용」). 격리 앱의 userData(<ROOT>/ud) 아래 **모든 파일**에서 고유 문자열을 찾는다
// (ui-prefs.json · corral.ndjson · work-connections.json · work-activity.json 포함, 크롬 캐시까지). 만들기 전 초안 회차 = 0 이어야 한다.
//   node scripts/l604/draft-leak.mjs <ROOT/ud> <고유 문자열>   → {"hits":[…],"files":n} · 0건 exit 0 · 있으면 exit 1 · 읽을 파일 0 이면 exit 2(관측 없음)
//   node scripts/l604/draft-leak.mjs --self-test               → 양성 대조: 알려진 글을 넣은 파일 1개 + 깨끗한 파일 1개 = 1건이어야 exit 0
// 문자열은 UTF-8 바이트로 찾는다(이진 파일 안에서도). 만든 뒤(생성 요청이 나간 뒤)에는 출처·활동 기록에 제목이 남을 수 있다 — 초안 단계에서만 쓴다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function scan({ dir, needle }) {
  const bytes = Buffer.from(needle, 'utf8')
  const hits = []
  let files = 0
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) continue
      files += 1
      let body
      try { body = fs.readFileSync(full) } catch { continue }
      if (body.includes(bytes)) hits.push(path.relative(dir, full))
    }
  }
  walk(dir)
  return { hits, files }
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l604-leak-'))
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'ui-prefs.json'), JSON.stringify({ tasksPage: { view: 'board' } }))
  fs.writeFileSync(path.join(dir, 'sub', 'corral.ndjson'), '{"tag":"x","title":"초안양성대조글"}\n')
  const found = scan({ dir, needle: '초안양성대조글' })
  const clean = scan({ dir, needle: '없는글자열' })
  fs.rmSync(dir, { recursive: true })
  const pass = found.hits.length === 1 && found.hits[0] === path.join('sub', 'corral.ndjson') && clean.hits.length === 0 && found.files === 2
  console.log(JSON.stringify({ selfTest: pass ? 'pass' : 'fail', found, clean }))
  return pass ? 0 : 1
}

const args = process.argv.slice(2)
if (args[0] === '--self-test') process.exit(selfTest())
const [dir, needle] = args
if (dir === undefined || needle === undefined || needle.length < 6) { console.error('쓰기: draft-leak.mjs <ROOT/ud> <고유 문자열(6자 이상)> | --self-test'); process.exit(2) }
const result = scan({ dir, needle })
console.log(JSON.stringify(result))
process.exit(result.files === 0 ? 2 : result.hits.length === 0 ? 0 : 1)
