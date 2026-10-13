#!/usr/bin/env node
// LIFE-600 C4 — renderer 에 작업 출처(LA·Jira …) 이름 분기가 없는지 기계로 본다. 화면은 능력 표와 main 이 준 표시 정보만 그린다(P2).
//
//   node scripts/l600/renderer-source-branch.mjs                 # app/src/renderer 검사 — 위반 0 이면 exit 0, 있으면 1
//   node scripts/l600/renderer-source-branch.mjs --root <폴더>    # 다른 renderer 사본 검사(양성 대조). 폴더가 없거나 읽은 파일 0 이면 실패(2) — 빈 검사를 통과로 세지 않는다(R1-G)
//   node scripts/l600/renderer-source-branch.mjs --self-test      # 양성 대조: 사본에 분기 한 줄을 넣으면 실패, 깨끗한 사본은 통과
//
// 무엇을 위반으로 보나(주석은 벗기고 TS AST 로 읽는다 — 문구 속 낱말은 세지 않는다):
//   ① 문자열 리터럴이 출처 id(main `src/main/work/*-source.ts` 의 `*_SOURCE_ID` 에서 파생) · 출처 이름(jira·atlassian·life-assistant) 과 같다
//   ② 문자열 리터럴이 토큰 접두사(같은 파일들의 `*_TOKEN_PREFIX` 에서 파생)를 담는다
//   ③ 식별자를 camelCase·밑줄로 쪼갠 낱말에 la · jira · lifeassistant 가 있다(`isLa`·`jiraSpace`·`LA_COLOR` …).
//      단 **한 낱말짜리 `la`** 는 세지 않는다 — 짧은 변수 이름(`ime-composition.ts` 의 명도 `la`)과 가를 수 없다. 출처 id 와 비교하려면
//      문자열 `'la'` 가 있어야 하므로 ① 이 잡는다.
// 테스트 파일(`*.test.*`)은 보지 않는다 — 분기는 제품 코드의 문제다. 읽은 파일 수를 결과에 싣는다(덮은 범위 확인).
// 알려진 한계: 값 흐름은 추적하지 않는다 — 서버가 준 문자열을 다른 변수로 비교하는 꼴(`source.id === x`, x 가 main 값)은 분기가 아니라 통과다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = path.join(APP, 'src/main/work')

function derived() {
  const ids = new Set()
  const prefixes = new Set()
  for (const name of fs.readdirSync(WORK).filter((file) => /-source\.ts$/.test(file))) {
    const text = fs.readFileSync(path.join(WORK, name), 'utf8')
    for (const match of text.matchAll(/export const [A-Z_]*SOURCE_ID = '([^']+)'/g)) ids.add(match[1])
    for (const match of text.matchAll(/export const [A-Z_]*TOKEN_PREFIX = '([^']+)'/g)) prefixes.add(match[1])
  }
  return { ids, prefixes }
}

const { ids, prefixes } = derived()
// 파생이 조용히 비면 검사가 아무것도 못 잡는다 — 그 실패는 통과로 보이므로 여기서 멈춘다.
if (ids.size < 2 || prefixes.size < 1) {
  console.error(`지문 파생 실패: 출처 id ${ids.size}개 · 토큰 접두사 ${prefixes.size}개`)
  process.exit(2)
}
const NAMES = new Set([...ids, 'jira', 'atlassian', 'life-assistant', 'lifeassistant'].map((name) => name.toLowerCase()))
const WORDS = new Set(['la', 'jira', 'lifeassistant', 'atlassian'])

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

function words(identifier) {
  return identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_$]+/).filter(Boolean).map((word) => word.toLowerCase())
}

export function scan(root) {
  const stat = fs.statSync(root, { throwIfNoEntry: false })
  const files = stat !== undefined && stat.isDirectory() ? walk(root) : []
  const violations = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node) => {
      const at = () => `${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
      if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) {
        const value = ts.isJsxText(node) ? node.text.trim() : node.text
        if (!ts.isJsxText(node) && NAMES.has(value.toLowerCase())) violations.push({ at: at(), kind: 'source-name', text: value })
        for (const prefix of prefixes) if (value.includes(prefix)) violations.push({ at: at(), kind: 'token-prefix', text: prefix })
      } else if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        const parts = words(node.text)
        const hit = parts.find((word) => WORDS.has(word) && !(word === 'la' && parts.length === 1))
        if (hit !== undefined) violations.push({ at: at(), kind: 'identifier', text: node.text })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { files: files.length, violations }
}

function report({ label, result }) {
  console.log(`[${label}] 읽은 파일 ${result.files} · 위반 ${result.violations.length}`)
  for (const violation of result.violations) console.log(`  ${violation.kind} ${violation.at} — ${violation.text}`)
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true })
}

const args = process.argv.slice(2)
console.log(`지문: 출처 id ${[...ids].join(', ')} · 토큰 접두사 ${prefixes.size}개 · 이름 ${[...NAMES].join(', ')}`)
if (args[0] === '--self-test') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'l600-branch-'))
  let ok = false
  try {
    const clean = path.join(temp, 'clean')
    const dirty = path.join(temp, 'dirty')
    copyDir(path.join(APP, 'src/renderer'), clean)
    copyDir(path.join(APP, 'src/renderer'), dirty)
    const target = path.join(dirty, 'src/components/ConnectionsSection.tsx')
    const firstId = [...ids][0]
    fs.appendFileSync(target, `\nexport const injected = (sourceId: string): boolean => sourceId === '${firstId}'\n`)
    fs.mkdirSync(path.join(temp, 'empty'))
    const cleanResult = scan(clean)
    const dirtyResult = scan(dirty)
    const emptyResult = scan(path.join(temp, 'empty'))
    const absentResult = scan(path.join(temp, 'no-such-dir'))
    report({ label: '깨끗한 사본', result: cleanResult })
    report({ label: `분기 한 줄을 넣은 사본 (sourceId === '${firstId}')`, result: dirtyResult })
    report({ label: '빈 폴더', result: emptyResult })
    report({ label: '없는 폴더', result: absentResult })
    ok = cleanResult.files > 0 && cleanResult.violations.length === 0
      && dirtyResult.violations.some((violation) => violation.at.startsWith('src/components/ConnectionsSection.tsx'))
      && emptyResult.files === 0 && absentResult.files === 0
    console.log(ok ? '양성 대조 통과 — 깨끗한 사본 0건, 넣은 사본에서 잡힘, 빈·없는 폴더는 읽은 파일 0(본 실행이면 실패로 끝난다)' : '양성 대조 실패')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
  // 정리(finally) 뒤에 끝낸다 — try 안의 process.exit 는 finally 를 건너뛴다.
  process.exit(ok ? 0 : 1)
}
const root = args[0] === '--root' && args[1] !== undefined ? path.resolve(args[1]) : path.join(APP, 'src/renderer')
const result = scan(root)
report({ label: path.relative(APP, root) || root, result })
if (result.files === 0) {
  console.error(`검사 대상 없음 — ${root} 에서 읽은 파일 0 (없는 폴더·빈 폴더). 통과로 세지 않는다.`)
  process.exit(2)
}
process.exit(result.violations.length === 0 ? 0 : 1)
