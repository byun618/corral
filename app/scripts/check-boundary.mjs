// N2 — **어댑터 경계를 기계가 검사한다.** 사람 눈 확인은 근거가 아니다 (기준 N2 판정 방법).
//
// 무엇을 검사하나:
//   ① 어댑터 **바깥의 모든 파일**이 `src/main/adapter/internal/` 을 import 하지 않는다
//   ② renderer·preload·shared 는 어댑터를 **전혀** import 하지 않는다 (공개 입구조차)
//   ③ `src/shared/` 는 main·renderer 를 import 하지 않는다 — 경계 어휘는 아무 층에도 안 붙는다
//   ④ herdr **와이어 모양**(메서드 이름·snake_case 필드)이 어댑터 바깥 src/ 에 나타나지 않는다
//
// 무효 조건(샘플링 금지)을 지키려고 `src/**` 의 .ts/.tsx 를 **한 파일도 빼지 않고** 읽는다.
// 읽은 파일 목록을 결과에 그대로 실어서, 덮은 범위가 결과만 보고 확인되게 한다.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.join(APP_DIR, 'src')
const ADAPTER = path.join(SRC, 'main/adapter')
const ADAPTER_INTERNAL = path.join(ADAPTER, 'internal')

/**
 * 이벤트 지문을 **어댑터의 목록에서 파생시킨다** (수정 2회차 L-6 — codex).
 *
 * 1회차까지는 이벤트 이름이 이 파일에 손으로 박혀 있었다. 그래서 수정 1회차가 `tab.moved` 를
 * 구독 목록에 늘렸을 때 **지문만 안 늘었고**, 그 이름이 어댑터 밖에 심겨도 검사는 통과했다.
 * 목록이 진실이니 목록에서 읽는다: 구독 타입(`SUBSCRIPTION_TYPES`, 점→밑줄)과 store 가
 * 실제로 처리하는 `case '...'` 라벨의 합집합이다. 어휘가 늘면 지문도 저절로 는다.
 */
function wireEventNames() {
  const read = (file) => fs.readFileSync(path.join(ADAPTER_INTERNAL, file), 'utf8')
  const names = new Set()
  const block = /export const SUBSCRIPTION_TYPES[^=]*=\s*\[([\s\S]*?)\n\]/.exec(read('protocol.ts'))
  for (const match of (block?.[1] ?? '').matchAll(/'([a-z]+(?:\.[a-z_]+)+)'/g)) {
    names.add(match[1].replace(/\./g, '_'))
  }
  // 구독은 안 하지만 처리하는 이름도 있다 (`pane.agent_status_changed` 는 별도 커넥션).
  for (const match of read('store.ts').matchAll(/case '([a-z]+_[a-z_]+)':/g)) names.add(match[1])
  return [...names].sort()
}

const EVENT_NAMES = wireEventNames()
// 파생이 깨지면(정규식이 목록을 못 읽으면) 지문이 **조용히 비어** 검사가 아무것도 안 잡는다.
// 그 실패는 통과로 보이므로 여기서 멈춘다 — 검사가 자기 입력을 의심하는 자리다.
if (EVENT_NAMES.length < 10) {
  console.error(`지문 파생 실패: 이벤트 이름 ${EVENT_NAMES.length}개만 읽혔다`)
  process.exit(2)
}

const rel = (file) => path.relative(APP_DIR, file)

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out.sort()
}

/**
 * 주석을 지운다 — **주석은 실행되지 않는다.**
 *
 * 경계가 묻는 것은 "이 코드가 herdr 와이어 모양을 아는가" 다. 주석이 `open_workspace_id` 를
 * 언급하는 것은 아는 게 아니라 **어디서 온 값인지 적어 둔 것**이고, 그건 오히려 근거다.
 * 통과선을 낮추는 게 아니라 재는 대상을 정확히 하는 것이라, 주석에서만 나온 언급은
 * 버리지 않고 결과의 참고칸(`주석언급`)에 그대로 싣는다 — 숨기지 않는다.
 */
function stripComments(source) {
  let out = ''
  let mode = 'code'
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    const next = source[i + 1]
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i++; continue }
      if (ch === '/' && next === '*') { mode = 'block'; i++; continue }
      if (ch === "'" || ch === '"' || ch === '`') { mode = ch; out += ch; continue }
      out += ch
      continue
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch }
      continue
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; i++ }
      continue
    }
    // 템플릿 리터럴 안의 `${…}` 는 **코드다** (수정 1회차 L2). 문자열로 삼키면 그 안에 박힌
    // 지문을 놓친다 — control.ts 의 clickProbe 가 실제로 큰 템플릿 리터럴이다.
    if (mode === '`' && ch === '$' && next === '{') {
      out += '${'
      i++
      let depth = 1
      while (++i < source.length && depth > 0) {
        const inner = source[i]
        if (inner === '{') depth++
        else if (inner === '}') depth--
        out += inner
      }
      i--
      continue
    }
    // 문자열 안 — 이스케이프를 건너뛰고 닫는 따옴표를 찾는다.
    out += ch
    if (ch === '\\') { out += source[i + 1] ?? ''; i++; continue }
    if (ch === mode) mode = 'code'
  }
  return out
}

/** import/export 의 **모듈 지정자**만 뽑는다 (문자열 리터럴 전부가 아니라). */
function importSpecifiers(source) {
  const out = []
  const patterns = [
    /\bimport\s+type\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1])
  }
  return [...new Set(out)]
}

/** 상대 지정자를 실제 파일 경로로 푼다. 패키지 지정자(`electron`·`react`)는 null. */
function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  // 못 풀어도 **경로 문자열로는** 판정한다 — 못 풀었다는 이유로 통과시키지 않는다.
  return base
}

const inside = (file, dir) => file === dir || file.startsWith(dir + path.sep)

/**
 * herdr 와이어 지문 — 이게 어댑터 밖에 있으면 그 파일은 herdr 를 "안다".
 * 메서드 이름과 실측 응답의 snake_case 필드 이름을 함께 본다.
 */
const WIRE_FINGERPRINTS = [
  // 따옴표 3종을 다 본다 (수정 1회차 L2). 1회차는 작은따옴표만 봐서, 검사의 통과선이
  // prettier 설정에 기대고 있었다 — `"pane.list"` 나 백틱 표기는 그냥 통과했다.
  {
    kind: 'method',
    pattern:
      /['"`](?:ping|session\.snapshot|workspace\.\w+|worktree\.\w+|tab\.\w+|pane\.\w+|agent\.\w+|events\.\w+|layout\.\w+)['"`]/g,
  },
  { kind: 'field', pattern: /\b(?:workspace_id|pane_id|tab_id|agent_status|open_workspace_id|is_linked_worktree|repo_root|repo_name|foreground_cwd|terminal_title|display_agent|pane_count|tab_count|socket_path|process_info|foreground_process_group_id|shell_pid)\b/g },
  // 목록에서 파생된다 (L-6) — 손으로 적지 않는다.
  { kind: 'event', pattern: new RegExp(`\\b(?:${EVENT_NAMES.join('|')})\\b`, 'g') },
  { kind: 'envelope', pattern: /events\.subscribe|"subscriptions"|'subscriptions'/g },
]

const files = walk(SRC)
const violations = []
const scanned = []

const commentMentions = []

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  const source = stripComments(raw)
  const isAdapter = inside(file, ADAPTER)
  const zone = isAdapter
    ? 'adapter'
    : inside(file, path.join(SRC, 'renderer'))
      ? 'renderer'
      : inside(file, path.join(SRC, 'preload'))
        ? 'preload'
        : inside(file, path.join(SRC, 'shared'))
          ? 'shared'
          : 'main'

  const specifiers = importSpecifiers(source)
  const resolved = specifiers.map((specifier) => ({ specifier, target: resolveSpecifier(file, specifier) }))

  for (const { specifier, target } of resolved) {
    if (target === null) continue
    // ① 어댑터 바깥 → 어댑터 internal 금지
    if (!isAdapter && inside(target, ADAPTER_INTERNAL)) {
      violations.push({ rule: 'R1-internal', zone, file: rel(file), specifier })
    }
    // ② renderer·preload·shared → 어댑터 전체 금지
    if ((zone === 'renderer' || zone === 'preload' || zone === 'shared') && inside(target, ADAPTER)) {
      violations.push({ rule: 'R2-adapter', zone, file: rel(file), specifier })
    }
    // ③ shared → main·renderer 금지
    if (zone === 'shared' && (inside(target, path.join(SRC, 'main')) || inside(target, path.join(SRC, 'renderer')))) {
      violations.push({ rule: 'R3-shared-pure', zone, file: rel(file), specifier })
    }
  }

  // ④ 와이어 지문 — 어댑터 밖에는 없어야 한다
  const wire = []
  if (!isAdapter) {
    for (const { kind, pattern } of WIRE_FINGERPRINTS) {
      for (const match of source.matchAll(pattern)) wire.push({ kind, token: match[0] })
    }
  }
  if (wire.length > 0) {
    violations.push({ rule: 'R4-wire-leak', zone, file: rel(file), tokens: [...new Set(wire.map((item) => item.token))] })
  }

  // 주석에서만 나온 언급 — 위반은 아니지만 숨기지 않는다.
  if (!isAdapter) {
    const inRaw = new Set()
    for (const { pattern } of WIRE_FINGERPRINTS) for (const match of raw.matchAll(pattern)) inRaw.add(match[0])
    const inCode = new Set(wire.map((item) => item.token))
    const onlyComment = [...inRaw].filter((token) => !inCode.has(token))
    if (onlyComment.length > 0) commentMentions.push({ file: rel(file), zone, tokens: onlyComment })
  }

  scanned.push({ file: rel(file), zone, imports: specifiers.length, wireHits: wire.length })
}

/** IPC 표면 — 경계를 건너는 payload 타입이 어디서 오나 (N2ⓐ). */
const preloadSource = stripComments(fs.readFileSync(path.join(SRC, 'preload/index.ts'), 'utf8'))
const ipcTypeImports = importSpecifiers(preloadSource).filter((item) => item.startsWith('.'))
const ipcTypesFromShared = ipcTypeImports.every((item) => item.includes('shared/types'))

const out = {
  at: new Date().toISOString(),
  질문: 'herdr 타입·와이어 모양이 어댑터 디렉터리 밖으로 새는가',
  범위: {
    루트: rel(SRC),
    어댑터: rel(ADAPTER),
    파일수: files.length,
    샘플링: false,
    설명: 'src/ 아래 .ts/.tsx 전부. 한 파일도 건너뛰지 않는다 (N2 무효 조건).',
  },
  '지문 — 이벤트 이름 (어댑터 목록에서 파생)': { 개수: EVENT_NAMES.length, 이름: EVENT_NAMES },
  규칙: {
    'R1-internal': '어댑터 바깥 파일이 adapter/internal/* 을 import',
    'R2-adapter': 'renderer·preload·shared 가 어댑터를 import (공개 입구 포함)',
    'R3-shared-pure': 'shared 가 main·renderer 를 import',
    'R4-wire-leak': 'herdr 메서드명·snake_case 필드·이벤트명이 어댑터 밖 소스에 등장',
  },
  'IPC 표면': {
    preload가_import하는_상대모듈: ipcTypeImports,
    'shared/types 만인가': ipcTypesFromShared,
  },
  검사한파일: scanned,
  주석언급: {
    설명: '주석에만 나온 herdr 와이어 이름. 실행되지 않으므로 위반이 아니다 — 값의 출처를 적어 둔 자리다.',
    항목: commentMentions,
  },
  위반: violations,
  판정: violations.length === 0 && ipcTypesFromShared ? '통과' : '미달',
}

const target = process.argv[2]
if (target !== undefined) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n')
  console.log('wrote', target)
}
console.log(JSON.stringify({ 판정: out.판정, 파일수: files.length, 위반: violations.length }, null, 2))
if (violations.length > 0) console.log(JSON.stringify(violations, null, 2))
process.exit(out.판정 === '통과' ? 0 : 1)
