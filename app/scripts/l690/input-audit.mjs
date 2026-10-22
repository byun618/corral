// LIFE-690 f2 — 사용자 입력 혼입 대조기. 격리 로그의 `input.raw` 전량이 드라이버가 보낸 키(control `key` = sendInputEvent)와 순서·개수로 맞는지 본다.
//
// main 은 계측 실행에서 `before-input-event` 마다 **keyUp 과, control·meta·alt 가 낀 keyDown** 만 `input.raw` 로 남긴다(src/main/index.ts 의 before-input-event).
// 그래서 드라이버의 `key` 한 번이 남길 줄은 그 규칙으로 정해진다 — keyUp 1줄 + (control·meta·alt 가 있으면) keyDown 1줄. `type`(char 이벤트)은 줄을 남기지 않는다.
// 사람이 창에 친 키는 수정자 없는 평범한 글자여도 keyUp 이 남으므로, 드라이버 목록에 없는 줄이 하나라도 있으면 혼입이다. 마우스는 이 대조로 못 본다.
//
// 기대 목록은 두 곳에서 만든다: ⓐ 로그 안의 control.cmd `key` 줄(main 이 받은 드라이버 요청) ⓑ 드라이버가 따로 적은 keys.json(있으면 ⓐ 와도 같아야 한다).
// 사용: node scripts/l690/input-audit.mjs <corral.ndjson>[,<다음 구간 ndjson>…] [<keys.json>]  → 결과 JSON 출력, 종료코드 0 = 일치, 1 = 어긋남(혼입·누락), 2 = 읽기 실패
import fs from 'node:fs'

const KEY_NAMES = { Return: 'Enter', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Space: ' ' }
const has = (modifiers, names) => modifiers.some((m) => names.includes(String(m).toLowerCase()))

/** 드라이버 `key` 요청 하나가 `input.raw` 에 남길 줄들(순서대로). */
export function expectedRaw(request) {
  const modifiers = Array.isArray(request.modifiers) ? request.modifiers : []
  const flags = {
    control: has(modifiers, ['control', 'ctrl']),
    meta: has(modifiers, ['meta', 'command', 'cmd']),
    alt: has(modifiers, ['alt', 'option']),
    shift: has(modifiers, ['shift']),
  }
  const key = KEY_NAMES[request.keyCode] ?? String(request.keyCode)
  const types = request.type === 'keyDown' || request.type === 'keyUp' ? [request.type] : ['keyDown', 'keyUp']
  return types.filter((type) => type === 'keyUp' || flags.control || flags.meta || flags.alt).map((type) => ({ type, key, ...flags }))
}

const norm = (row) => ({ type: row.type, key: String(row.key).toLowerCase(), control: !!row.control, meta: !!row.meta, alt: !!row.alt, shift: !!row.shift })
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b))

function parseLog(text) {
  const keyRequests = []
  const raw = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.tag === 'input.raw') raw.push({ at: row.at, type: row.type, key: row.key, control: row.control, meta: row.meta, alt: row.alt, shift: row.shift })
    if (row.tag === 'control.cmd' && typeof row.line === 'string') {
      try {
        const request = JSON.parse(row.line)
        if (request.cmd === 'key') keyRequests.push({ at: row.at, keyCode: request.keyCode, modifiers: request.modifiers ?? [], type: request.type })
      } catch {
        // control.cmd 의 line 이 JSON 이 아니면 키 요청이 아니다
      }
    }
  }
  return { keyRequests, raw }
}

/** logs = 구간 순서대로의 ndjson 본문, sentKeys = 드라이버가 적은 `key` 요청 목록(없으면 null). */
export function audit({ logs, sentKeys }) {
  const parsed = logs.map(parseLog)
  const keyRequests = parsed.flatMap((p) => p.keyRequests)
  const raw = parsed.flatMap((p) => p.raw)
  const expected = keyRequests.flatMap((request) => expectedRaw(request).map((row) => ({ ...row, from: `${request.keyCode}${request.modifiers.length ? '+' + request.modifiers.join('+') : ''}` })))
  let firstMismatch = null
  const length = Math.max(expected.length, raw.length)
  for (let i = 0; i < length; i += 1) {
    if (expected[i] === undefined || raw[i] === undefined || !same(expected[i], raw[i])) {
      firstMismatch = { index: i, expected: expected[i] ?? null, actual: raw[i] ?? null }
      break
    }
  }
  let sentMatch = null
  if (sentKeys !== null) {
    const a = sentKeys.map((k) => JSON.stringify([k.keyCode, k.modifiers ?? []]))
    const b = keyRequests.map((k) => JSON.stringify([k.keyCode, k.modifiers]))
    sentMatch = JSON.stringify(a) === JSON.stringify(b)
  }
  const pass = firstMismatch === null && sentMatch !== false
  return { pass, keyRequests: keyRequests.length, sentKeys: sentKeys?.length ?? null, sentMatch, expected: expected.length, raw: raw.length, firstMismatch, rawRows: raw, expectedRows: expected }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [logsArg, keysArg] = process.argv.slice(2)
  if (!logsArg) {
    console.error('사용: node scripts/l690/input-audit.mjs <corral.ndjson>[,<…>] [<keys.json>]')
    process.exit(2)
  }
  let logs
  let sentKeys = null
  try {
    logs = logsArg.split(',').map((file) => fs.readFileSync(file, 'utf8'))
    if (keysArg) sentKeys = JSON.parse(fs.readFileSync(keysArg, 'utf8'))
  } catch (error) {
    console.error(`읽기 실패 ${error.message}`)
    process.exit(2)
  }
  const result = audit({ logs, sentKeys })
  console.log(JSON.stringify(result, null, 1))
  console.log(`audit ${result.pass ? 'PASS' : 'FAIL'} raw ${result.raw} / expected ${result.expected} (key 요청 ${result.keyRequests}${sentKeys ? `, keys.json ${result.sentKeys} 일치=${result.sentMatch}` : ''})`)
  process.exit(result.pass ? 0 : 1)
}
