#!/usr/bin/env node
// LIFE-605 C1⑤ — 자격 글이 디스크·로그에 남지 않는지. 격리 userData(<ROOT>/ud) 아래 **모든 파일**을 바이트로 훑는다(연결 파일·활동·로그·ui-prefs 포함).
//   node scripts/l605/secret-grep.mjs <ROOT/ud> <needles.json>   → {"files":n,"hits":[{needle,file,encoding}],"readFailures":[…]}
//     needles.json = [{ "label": "token", "value": "…", "allowIn": ["work-connections.json"]? }] — 글 자체는 출력하지 않는다(label · sha256 앞 8자만).
//     `allowIn` = 그 값이 있어도 되는 파일(이메일은 연결 파일 표시 칸에 있다 — 설계 메모 §1). 그 밖 파일의 적중만 센다.
//     0건 exit 0 · 적중 exit 1 · 읽은 파일 0·읽기 실패 하나라도 exit 2(관측 없음).
//   node scripts/l605/secret-grep.mjs --self-test   → 양성 대조: 심은 파일(UTF-8 로그 · UTF-16LE 이진)은 잡고, 허용 파일은 넘기고, 깨끗한 디렉터리는 0 이어야 exit 0.
// 인코딩 변형: UTF-8 · UTF-16LE · Latin-1(0xFF 이하 글자만). LIFE-604 draft-leak.mjs 와 같은 방식(그 파일은 import 하면 바로 실행돼 옮겨 적었다).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sha8 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8)

function variants(value) {
  const list = [{ encoding: 'utf8', bytes: Buffer.from(value, 'utf8') }, { encoding: 'utf16le', bytes: Buffer.from(value, 'utf16le') }]
  if ([...value].every((char) => char.codePointAt(0) <= 0xff)) list.push({ encoding: 'latin1', bytes: Buffer.from(value, 'latin1') })
  return list
}

function scan({ dir, needles }) {
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
      const rel = path.relative(dir, full)
      for (const needle of needles) {
        if ((needle.allowIn ?? []).includes(rel)) continue
        for (const form of variants(needle.value)) if (body.includes(form.bytes)) hits.push({ needle: `${needle.label}#${sha8(needle.value)}`, file: rel, encoding: form.encoding })
      }
    }
  }
  walk(dir)
  return { files, hits, readFailures, needles: needles.map((needle) => `${needle.label}#${sha8(needle.value)}(len ${needle.value.length})`) }
}

const exitCode = (result) => (result.files === 0 || result.readFailures.length > 0 ? 2 : result.hits.length === 0 ? 0 : 1)

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l605-secret-'))
  const needles = [{ label: 'token', value: 'ATATTselftest0000' }, { label: 'email', value: 'self@fixture.invalid', allowIn: ['work-connections.json'] }]
  fs.writeFileSync(path.join(dir, 'work-connections.json'), JSON.stringify({ account: { email: 'self@fixture.invalid' } }))
  const clean = scan({ dir, needles })
  fs.writeFileSync(path.join(dir, 'corral.ndjson'), '{"tag":"x","detail":"ATATTselftest0000 self@fixture.invalid"}\n')
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1]), Buffer.from('ATATTselftest0000', 'utf16le')]))
  const found = scan({ dir, needles })
  fs.rmSync(dir, { recursive: true })
  const got = found.hits.map((hit) => `${hit.needle.split('#')[0]}@${hit.file}:${hit.encoding}`).sort().join(',')
  const want = ['email@corral.ndjson:utf8', 'email@corral.ndjson:latin1', 'token@blob.bin:utf16le', 'token@corral.ndjson:utf8', 'token@corral.ndjson:latin1'].sort().join(',')
  const pass = exitCode(clean) === 0 && clean.files === 1 && got === want && exitCode(found) === 1
  console.log(JSON.stringify({ selfTest: pass ? 'pass' : 'fail', clean: { files: clean.files, hits: clean.hits.length }, found: got }))
  return pass ? 0 : 1
}

const args = process.argv.slice(2)
if (args[0] === '--self-test') process.exit(selfTest())
const [dir, needleFile] = args
if (dir === undefined || needleFile === undefined) { console.error('쓰기: secret-grep.mjs <ROOT/ud> <needles.json> | --self-test'); process.exit(2) }
const needles = JSON.parse(fs.readFileSync(needleFile, 'utf8'))
if (!Array.isArray(needles) || needles.length === 0 || needles.some((needle) => typeof needle.value !== 'string' || needle.value.length < 6)) { console.error('needles.json — 6자 이상 값이 하나 이상'); process.exit(2) }
const result = scan({ dir, needles })
console.log(JSON.stringify(result))
process.exit(exitCode(result))
