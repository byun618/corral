// LIFE-518 K3ⓖ 양성 대조 — check-boundary.nodetest.mjs 의 판정식이 **약해진 검사기를 실제로 떨어뜨리는지** 본다.
// 검사기 원문을 메모리에서 바꿔 runProbes 에 넣는다(작업 트리 무변경). 각 변이마다 nodetest 와 같은 판정식으로 틀린 칸을 센다.
// 사용: node scripts/l518/k3g-mutation.mjs — 모든 변이가 1칸 이상 틀려야 exit 0.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, PROBES, cellOk, runProbes } from './boundary-probes.mjs'

const head = fs.readFileSync(path.join(APP_DIR, 'scripts/check-boundary.mjs'), 'utf8')
const replaceOnce = ({ source = head, from, to }) => {
  if (!source.includes(from)) throw new Error(`변이 지점 없음: ${from}`)
  return source.replace(from, to)
}
const MUTANTS = [
  { 이름: '기준 검사기(e92e66da) — 오탐 7파일·IPC 오탐', source: execFileSync('git', ['show', 'e92e66da:app/scripts/check-boundary.mjs'], { cwd: APP_DIR, encoding: 'utf8' }) },
  { 이름: '액션 id 면제를 envelope 자리에서도 적용', source: replaceOnce({ from: "if (ACTION_IDS.has(name) && !ENVELOPE_BEFORE.test(before)) {", to: "if (ACTION_IDS.has(name)) return 'action-id'\n  if (false) {" }) },
  { 이름: '로그 태그 면제를 실제 herdr 메서드에도 적용', source: replaceOnce({ from: '&& !HERDR_METHODS.has(name) &&', to: '&&' }) },
  { 이름: '메서드 지문 면제 전부(모든 메서드 토큰 통과)', source: replaceOnce({ from: 'function methodExemption({ source, index, name, zone, importsMainLog, sourceFile }) {', to: "function methodExemption({ source, index, name, zone, importsMainLog, sourceFile }) {\n  return 'action-id'" }) },
  { 이름: 'IPC 검사를 늘 참으로', source: replaceOnce({ from: 'const ipcTypesFromShared = ipcTypeImports.every(', to: 'const ipcTypesFromShared = true || ipcTypeImports.every(' }) },
  { 이름: '닫는 따옴표 앞 역슬래시 허용 제거', source: replaceOnce({ from: "layout\\.\\w+)\\\\?['\"`]/g", to: "layout\\.\\w+)['\"`]/g" }) },
  // fix1 (R1-claude-04) — r1 에서 살아남은 4종
  { 이름: '로그 면제의 zone === main 조건 제거', source: replaceOnce({ from: "if (zone === 'main' && importsMainLog", to: 'if (importsMainLog' }) },
  { 이름: 'envelope 글자 창 80자 → 12자', source: replaceOnce({ from: 'source.slice(Math.max(0, index - 80), index)', to: 'source.slice(Math.max(0, index - 12), index)' }) },
  { 이름: '주석언급을 면제 뒤 토큰(wire)으로 계산 — codeTokens 되돌림', source: replaceOnce({ from: '!codeTokens.has(token))', to: '!new Set(wire.map((item) => item.token)).has(token))' }) },
  { 이름: 'LOG_FIRST_ARG_BEFORE lookbehind 제거', source: replaceOnce({ from: 'const LOG_FIRST_ARG_BEFORE = /(?<![\\w.$])log\\(\\s*$/', to: 'const LOG_FIRST_ARG_BEFORE = /log\\(\\s*$/' }) },
  // fix1 — 새로 넣은 판정의 변이
  { 이름: '어휘 파생이 주석을 안 벗김 (R1-claude-05 되돌림)', source: replaceOnce({ from: "block.exec(stripComments(fs.readFileSync(path.join(SRC, file), 'utf8')))", to: "block.exec(fs.readFileSync(path.join(SRC, file), 'utf8'))" }) },
  { 이름: 'AST envelope 판정 끔 (R1-claude-01 되돌림)', source: replaceOnce({ from: 'function boundToMethod({ literal }) {', to: 'function boundToMethod({ literal }) {\n  return false' }) },
  { 이름: 'switch case 규칙 제거', source: replaceOnce({ from: 'if (ts.isCaseClause(parent) && parent.expression === child) return mentions(parent.parent.parent.expression)', to: '' }) },
  { 이름: '호출 인자 규칙 제거 (includes)', source: replaceOnce({ from: 'if (ts.isCallExpression(parent) && parent.arguments.some((arg) => arg !== child && mentions(arg))) return true', to: '' }) },
  { 이름: '이항식 규칙 제거 (yoda)', source: replaceOnce({ from: 'if (ts.isBinaryExpression(parent) && mentions(parent.left === child ? parent.right : parent.left)) return true', to: '' }) },
  { 이름: '함수 식 너머로 올라가지 않음', source: replaceOnce({ from: 'if (!(ts.isArrowFunction(owner) || ts.isFunctionExpression(owner))) return false', to: 'return false' }) },
  { 이름: 'method 언급을 글자 전체 검색으로 (문장 꼴 문자열도 이름으로)', source: replaceOnce({ from: '  const mentions = mentionsMethod\n', to: '  const mentions = (node) => /method/i.test(node.getText())\n' }) },
  // fix2 (R2-claude-03) — 리뷰어 변이 M-c·M-f·M-i·M-l·M-m 과 fix2 새 규칙
  { 이름: 'M-c 문장 경계를 파일만으로', source: replaceOnce({ from: 'const isStatementBoundary = (node) =>\n', to: 'const isStatementBoundary = (node) => ts.isSourceFile(node)\nconst unusedBoundary = (node) =>\n' }) },
  { 이름: 'M-f 리터럴 못 찾음(null)을 면제로 (fail-open 되돌림)', source: replaceOnce({ from: 'if (literal !== null && !boundToMethod({ literal })) return', to: 'if (literal === null || !boundToMethod({ literal })) return' }) },
  { 이름: '파싱 오류 파일도 믿음 (parseDiagnostics 무시)', source: replaceOnce({ from: 'const trusted = Array.isArray(diagnostics) && diagnostics.length === 0', to: 'const trusted = true || diagnostics' }) },
  { 이름: 'M-i tsx 를 TS 로 파싱', source: replaceOnce({ from: "file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS", to: 'ts.ScriptKind.TS' }) },
  { 이름: 'M-l 함수 식 오름을 화살표에만', source: replaceOnce({ from: 'if (!(ts.isArrowFunction(owner) || ts.isFunctionExpression(owner))) return false', to: 'if (!ts.isArrowFunction(owner)) return false' }) },
  { 이름: 'M-m 호출 인자 판정에 자기 인자 포함', source: replaceOnce({ from: 'parent.arguments.some((arg) => arg !== child && mentions(arg))', to: 'parent.arguments.some((arg) => mentions(arg))' }) },
  { 이름: '반환 자리를 문장 전체로 (콜백 문장에서도 오름)', source: replaceOnce({ from: '(ts.isReturnStatement(parent) && parent.expression === child)', to: '((ts.isReturnStatement(parent) && parent.expression === child) || ts.isExpressionStatement(parent))' }) },
  { 이름: '이름 있는 함수·getter 반환 규칙 제거', source: replaceOnce({ from: 'if (namedMethod(owner)) return true', to: '' }) },
  { 이름: '타입 별칭 이름 규칙 제거', source: replaceOnce({ from: 'if (ts.isTypeAliasDeclaration(parent) && namedMethod(parent)) return true', to: '' }) },
  { 이름: 'enum 멤버의 enum 이름 규칙 제거', source: replaceOnce({ from: ' || (ts.isEnumMember(parent) && namedMethod(parent.parent))', to: '' }) },
  { 이름: '파라미터·구조 분해·enum 멤버 값 규칙 제거', source: replaceOnce({ from: 'ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isEnumMember(parent)', to: 'false' }) },
  { 이름: 'JSX 속성·타입 멤버 규칙 제거', source: replaceOnce({ from: '(ts.isPropertySignature(parent) && parent.type === child) || ts.isJsxAttribute(parent)', to: 'false' }) },
  { 이름: '호출 대상(callee) 이름 규칙 제거', source: replaceOnce({ from: 'if (ts.isCallExpression(parent) && parent.arguments.includes(child) && mentions(parent.expression)) return true', to: '' }) },
]

let allFailed = true
for (const mutant of MUTANTS) {
  const { clean, cells } = runProbes({ checkerSource: mutant.source })
  const wrong = PROBES.flatMap((probe, index) => (cellOk({ probe, cell: cells[index] }) ? [] : [probe.id]))
  const cleanWrong = !(clean.exit === 0 && clean.위반 === 0 && clean.ipc === true)
  const failed = cleanWrong || wrong.length > 0
  allFailed &&= failed
  console.log(`${failed ? '떨어짐' : '통과(!)'} — ${mutant.이름} · 깨끗한 src exit ${clean.exit} 위반 ${clean.위반} IPC ${clean.ipc} · 틀린 칸 ${wrong.length}: ${wrong.join(', ')}`)
}
console.log(`판정: ${allFailed ? '모든 변이가 nodetest 판정식에서 떨어진다' : '떨어지지 않은 변이가 있다'}`)
process.exit(allFailed ? 0 : 1)
