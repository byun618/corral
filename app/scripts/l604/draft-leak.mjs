#!/usr/bin/env node
// LIFE-604 R1-G ③ — 초안 글이 디스크·로그에 남지 않는지(C5 「메모리 전용」). 격리 앱의 userData(<ROOT>/ud) 아래 **모든 파일**에서 고유 문자열을 찾는다
// (ui-prefs.json · corral.ndjson · work-connections.json · work-activity.json 포함, 크롬 캐시까지). 만들기 전 초안 회차 = 0 이어야 한다.
//   node scripts/l604/draft-leak.mjs <ROOT/ud> <고유 문자열>   → {"hits":[{file,encoding}],"files":n,"readFailures":[…]} · 0건 exit 0 · 있으면 exit 1
//                                                                 · 읽을 파일 0 이거나 **읽기 실패가 하나라도** 있으면 exit 2(관측 없음 — 못 읽은 파일에 있을 수 있다)
//   node scripts/l604/draft-leak.mjs --self-test               → 양성 대조: UTF-8 파일 1 · UTF-16LE 파일 1 · 깨끗한 파일 1 = 2건, 읽기 실패 파일이 있으면 exit 2 여야 exit 0
// 문자열은 바이트로 찾는다(이진 파일 안에서도) — 인코딩 변형 UTF-8 · UTF-16LE(크롬 저장소·V8 문자열) · Latin-1(글이 0xFF 이하 글자만일 때만; 아니면 표현 불가라 뺀다).
// 만든 뒤(생성 요청이 나간 뒤)에는 출처·활동 기록에 제목이 남을 수 있다 — 초안 단계에서만 쓴다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function variants(needle) {
  const list = [{ encoding: 'utf8', bytes: Buffer.from(needle, 'utf8') }, { encoding: 'utf16le', bytes: Buffer.from(needle, 'utf16le') }]
  if ([...needle].every((char) => char.codePointAt(0) <= 0xff)) list.push({ encoding: 'latin1', bytes: Buffer.from(needle, 'latin1') })
  return list
}

export function scan({ dir, needle }) {
  const forms = variants(needle)
  const hits = []
  const readFailures = []
  let files = 0
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) continue
      files += 1
      let body
      try { body = fs.readFileSync(full) } catch (error) { readFailures.push({ file: path.relative(dir, full), code: error?.code ?? 'unknown' }); continue }
      for (const form of forms) if (body.includes(form.bytes)) hits.push({ file: path.relative(dir, full), encoding: form.encoding })
    }
  }
  walk(dir)
  return { hits, files, readFailures, encodings: forms.map((form) => form.encoding) }
}

const exitCode = (result) => (result.files === 0 || result.readFailures.length > 0 ? 2 : result.hits.length === 0 ? 0 : 1)

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l604-leak-'))
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'ui-prefs.json'), JSON.stringify({ tasksPage: { view: 'board' } }))
  fs.writeFileSync(path.join(dir, 'sub', 'corral.ndjson'), '{"tag":"x","title":"초안양성대조글"}\n')
  fs.writeFileSync(path.join(dir, 'sub', 'local-storage.leveldb'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('초안양성대조글', 'utf16le'), Buffer.from([3])]))
  const found = scan({ dir, needle: '초안양성대조글' })
  const clean = scan({ dir, needle: '없는글자열' })
  // 읽기 실패 — 권한 없는 파일 하나 → exit 2(적중 0 이어도 「없음」 으로 세지 않는다)
  const locked = path.join(dir, 'locked.bin')
  fs.writeFileSync(locked, '초안양성대조글')
  fs.chmodSync(locked, 0o000)
  const failed = scan({ dir, needle: '없는글자열' })
  fs.chmodSync(locked, 0o600)
  fs.rmSync(dir, { recursive: true })
  const files = found.hits.map((hit) => `${hit.file}:${hit.encoding}`).sort()
  const pass = files.join(',') === [`${path.join('sub', 'corral.ndjson')}:utf8`, `${path.join('sub', 'local-storage.leveldb')}:utf16le`].sort().join(',')
    && found.files === 3 && exitCode(found) === 1 && clean.hits.length === 0 && exitCode(clean) === 0
    && failed.readFailures.length === 1 && exitCode(failed) === 2
    && variants('draft-é-01').map((form) => form.encoding).join(',') === 'utf8,utf16le,latin1' && !variants('초안').some((form) => form.encoding === 'latin1')
  console.log(JSON.stringify({ selfTest: pass ? 'pass' : 'fail', found, clean, failed: { readFailures: failed.readFailures, exit: exitCode(failed) } }))
  return pass ? 0 : 1
}

const args = process.argv.slice(2)
if (args[0] === '--self-test') process.exit(selfTest())
const [dir, needle] = args
if (dir === undefined || needle === undefined || needle.length < 6) { console.error('쓰기: draft-leak.mjs <ROOT/ud> <고유 문자열(6자 이상)> | --self-test'); process.exit(2) }
const result = scan({ dir, needle })
console.log(JSON.stringify(result))
process.exit(exitCode(result))
