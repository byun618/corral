#!/usr/bin/env node
// LIFE-600 C7 — 토큰 평문 부재 대조. **토큰은 stdin 으로만 받고(에코 없음) 메모리에서만 쓴다** — 화면·파일·인자·환경변수에 남기지 않는다.
// 출력은 건수와 파일 경로뿐이다. 토큰은 접두사·길이·sha256 앞 8자로만 밝힌다.
//
//   node scripts/l600/plaintext-scan.mjs [--expect-sha8 <hex8>] [--plant <폴더>] [--userdata <폴더>] [--trace <파일>] [경로 …]
//   node scripts/l600/plaintext-scan.mjs --self-test
//
// - 경로: 파일 또는 폴더(재귀, 심링크는 따라가지 않는다). userData 전체 · `corral.ndjson` · IPC 응답 기록(`CORRAL_WORK_IPC_TRACE`) 등을 넘긴다.
// - **넘긴 대상은 전부 필수다**(R1-G): 없거나 읽은 파일이 0 이면 그 대상은 「못 봄」 이고 결과는 미달(1)이다 — 빈 결과를 「평문 없음」 으로 세지 않는다.
// - `--userdata <폴더>`: userData 를 대상에 넣고, 그 안의 `corral.ndjson`·`work-connections.json` 이 있어야 한다(없으면 미달).
// - `--trace <파일>`: IPC 응답 기록(`CORRAL_WORK_IPC_TRACE`) — 있어야 하고 비어 있지 않아야 한다.
// - 찾는 꼴: 원문(utf8) · utf16le · base64(원문). 셋 다 바이트 일치로 센다.
// - `--expect-sha8`: 붙여넣은 토큰의 sha256 앞 8자가 이것과 같아야 진행한다(다른 토큰을 넣은 실수를 막는다).
// - `--plant <폴더>`: **양성 대조** — 그 폴더(`/tmp/l600*` 만)에 토큰을 한 번 심은 더미 파일을 만들고 같이 훑은 뒤 지운다. 그 파일에서 1건이 나와야 한다.
// - `--self-test`: 임의 가짜 토큰으로 심은 파일 1건 · 깨끗한 파일 0건을 확인한다(사람 입력 없음).
// 종료 코드: 0 = (양성 대조가 있으면 그것은 1건이고) 나머지 경로 0건 · 1 = 대상에서 발견 · 대상 못 봄 · 양성 대조 실패 · 2 = 사용법.
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sha8 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8)

function walk(target, out) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false })
  if (stat === undefined || stat.isSymbolicLink()) return out
  if (stat.isDirectory()) for (const name of fs.readdirSync(target)) walk(path.join(target, name), out)
  else if (stat.isFile()) out.push(target)
  return out
}

function count(buffer, needle) {
  let found = 0
  let from = 0
  for (;;) {
    const at = buffer.indexOf(needle, from)
    if (at < 0) return found
    found += 1
    from = at + 1
  }
}

export function scanPaths({ token, paths }) {
  const needles = {
    utf8: Buffer.from(token, 'utf8'),
    utf16le: Buffer.from(token, 'utf16le'),
    base64: Buffer.from(Buffer.from(token, 'utf8').toString('base64'), 'utf8'),
  }
  // 대상마다 읽을 파일이 있어야 한다 — 없거나 비면 「못 봄」(missing).
  const missing = []
  const files = paths.flatMap((target) => {
    const found = walk(path.resolve(target), [])
    if (found.length === 0) missing.push(target)
    return found
  })
  const hits = []
  let bytes = 0
  for (const file of files) {
    let buffer
    try {
      buffer = fs.readFileSync(file)
    } catch (error) {
      hits.push({ file, unreadable: String(error.code ?? error) })
      continue
    }
    bytes += buffer.length
    const row = Object.fromEntries(Object.entries(needles).map(([name, needle]) => [name, count(buffer, needle)]))
    if (row.utf8 + row.utf16le + row.base64 > 0) hits.push({ file, ...row })
  }
  const total = hits.reduce((sum, hit) => sum + (hit.utf8 ?? 0) + (hit.utf16le ?? 0) + (hit.base64 ?? 0), 0)
  return { files: files.length, bytes, hits, total, unreadable: hits.filter((hit) => hit.unreadable !== undefined).length, missing }
}

async function readSecret() {
  if (!process.stdin.isTTY) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  process.stderr.write('토큰 붙여넣기(화면에 보이지 않음) 후 Enter: ')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  let value = ''
  return new Promise((resolve) => {
    process.stdin.on('data', (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stderr.write('\n')
          resolve(value.trim())
          return
        }
        if (char === '\u0003') process.exit(130)
        if (char === '\u007f') value = value.slice(0, -1)
        else value += char
      }
    })
  })
}

function describe(token) {
  return `토큰: 접두사 ${token.slice(0, 9)} · 길이 ${token.length} · sha256 앞 8자 ${sha8(token)}`
}

function print({ label, result }) {
  console.log(`[${label}] 파일 ${result.files} · ${result.bytes} bytes · 발견 ${result.total} · 못 읽음 ${result.unreadable} · 못 본 대상 ${result.missing.length}`)
  for (const target of result.missing) console.log(`  못 본 대상(없음·빔) ${target.replaceAll(os.homedir(), '~')}`)
  for (const hit of result.hits) console.log(`  ${hit.file.replaceAll(os.homedir(), '~')} ${hit.unreadable === undefined ? `utf8=${hit.utf8} utf16le=${hit.utf16le} base64=${hit.base64}` : `못 읽음 ${hit.unreadable}`}`)
}

const args = process.argv.slice(2)
if (args[0] === '--self-test') {
  const token = `life_pat_${randomBytes(20).toString('hex')}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l600-plain-'))
  let ok = false
  try {
    fs.writeFileSync(path.join(dir, 'planted.json'), JSON.stringify({ note: 'dummy', value: token }))
    fs.writeFileSync(path.join(dir, 'clean.json'), JSON.stringify({ note: 'dummy', value: token.slice(0, -1) }))
    fs.mkdirSync(path.join(dir, 'empty'))
    console.log(describe(token).replace(/sha256 앞 8자 \w+/, 'sha256 앞 8자 (자가 시험용 임의 값)'))
    const planted = scanPaths({ token, paths: [path.join(dir, 'planted.json')] })
    const clean = scanPaths({ token, paths: [path.join(dir, 'clean.json')] })
    const absent = scanPaths({ token, paths: [path.join(dir, 'no-such-file'), path.join(dir, 'empty')] })
    print({ label: '심은 파일', result: { ...planted, hits: planted.hits.map((hit) => ({ ...hit, file: 'planted.json' })) } })
    print({ label: '깨끗한 파일(끝 1자 뺌)', result: { ...clean, hits: clean.hits.map((hit) => ({ ...hit, file: 'clean.json' })) } })
    print({ label: '없는 대상·빈 폴더', result: { ...absent, missing: ['no-such-file', 'empty/'] } })
    ok = planted.total === 1 && clean.total === 0 && clean.missing.length === 0 && absent.missing.length === 2
    console.log(ok ? '자가 시험 통과 — 심은 파일 1건 · 깨끗한 파일 0건 · 없는 대상·빈 폴더 둘 다 「못 봄」' : '자가 시험 실패')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  // 정리(finally) 뒤에 끝낸다 — try 안의 process.exit 는 finally 를 건너뛴다.
  process.exit(ok ? 0 : 1)
}

let expect = null
let plantDir = null
const targets = []
const required = []
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--expect-sha8') expect = args[++index] ?? null
  else if (arg === '--plant') plantDir = args[++index] ?? null
  else if (arg === '--userdata') {
    const dir = args[++index] ?? ''
    targets.push(dir)
    required.push(path.join(dir, 'corral.ndjson'), path.join(dir, 'work-connections.json'))
  } else if (arg === '--trace') {
    const file = args[++index] ?? ''
    targets.push(file)
    required.push(file)
  } else targets.push(arg)
}
// 필수 파일 — 있어야 하고 비어 있지 않아야 한다. 토큰을 받기 전에 본다(사람이 붙여넣고 나서 헛걸음하지 않게).
const absentRequired = required.filter((file) => {
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  return stat === undefined || !stat.isFile() || stat.size === 0
})
if (absentRequired.length > 0) {
  for (const file of absentRequired) console.error(`필수 대상 없음·빔: ${file.replaceAll(os.homedir(), '~')}`)
  console.log('미달 — 필수 대상을 못 봄')
  process.exit(1)
}
if (targets.length === 0 || (plantDir !== null && !path.resolve(plantDir).startsWith('/tmp/l600'))) {
  console.error('사용법: node scripts/l600/plaintext-scan.mjs [--expect-sha8 <hex8>] [--plant /tmp/l600…] <경로> [경로 …]')
  process.exit(2)
}
const token = await readSecret()
if (token.length < 12) {
  console.error('토큰이 너무 짧다')
  process.exit(2)
}
console.log(describe(token))
if (expect !== null && sha8(token) !== expect) {
  console.error(`sha256 앞 8자가 ${expect} 가 아니다 — 다른 토큰`)
  process.exit(2)
}
let plantedOk = true
if (plantDir !== null) {
  fs.mkdirSync(plantDir, { recursive: true, mode: 0o700 })
  const dummy = path.join(plantDir, `plant-${process.pid}.txt`)
  fs.writeFileSync(dummy, `dummy ${token} dummy\n`, { mode: 0o600 })
  try {
    const planted = scanPaths({ token, paths: [dummy] })
    print({ label: '양성 대조(심은 더미 파일)', result: planted })
    plantedOk = planted.total === 1
  } finally {
    fs.rmSync(dummy, { force: true })
  }
}
const result = scanPaths({ token, paths: targets })
print({ label: '대상', result })
const ok = plantedOk && result.total === 0 && result.unreadable === 0 && result.missing.length === 0 && result.files > 0
console.log(ok ? '평문 부재 — 대상 0건' + (plantDir === null ? '' : ' · 양성 대조 1건') : '미달')
process.exit(ok ? 0 : 1)
