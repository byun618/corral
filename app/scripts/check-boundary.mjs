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
import ts from 'typescript'

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

/**
 * LIFE-518 — 메서드 지문(`tab.\w+` 류)은 **이름만으로는** 단축키 액션 id 와 herdr 메서드를 못 가른다.
 * `tab.rename` 은 둘 다다(액션 id 이면서 `ALLOWED_METHODS` 의 실제 메서드). 그래서 가르는 축은 이름이 아니라
 * **쓰인 자리**다: 액션 id 어휘의 토큰은 요청 envelope 위치(`method:` 값 · `"method":"…"` · `msg.method = …`)에
 * 있을 때만 위반이다. 어휘는 손으로 적지 않고 진실의 원천에서 읽는다(L-6 와 같은 이유) — 액션 id 는
 * `shared/keybindings.ts` 의 `ACTIONS`, 실제 herdr 메서드는 어댑터 `request.ts` 의 `ALLOWED_METHODS`.
 */
function derivedList({ file, block, item }) {
  // 주석은 어휘가 아니다 (LIFE-518 fix1 R1-claude-05) — 주석 속 `id: '…'` 한 줄이 면제 어휘를 늘리지 않게 벗기고 읽는다.
  const match = block.exec(stripComments(fs.readFileSync(path.join(SRC, file), 'utf8')))
  return new Set([...(match?.[1] ?? '').matchAll(item)].map((found) => found[1]))
}
const ACTION_IDS = derivedList({ file: 'shared/keybindings.ts', block: /export const ACTIONS = \[([\s\S]*?)\n\] as const/, item: /\bid: '([^']+)'/g })
const HERDR_METHODS = derivedList({ file: 'main/adapter/internal/request.ts', block: /const ALLOWED_METHODS[^=]*=\s*\[([\s\S]*?)\n\]/, item: /'([a-z_.]+)'/g })
// 이벤트 지문과 같다 — 파생이 조용히 비면 면제가 사라지거나(오탐 복귀) 로그 면제가 넓어진다. 멈춘다.
if (ACTION_IDS.size < 10 || HERDR_METHODS.size < 10) {
  console.error(`지문 파생 실패: 액션 id ${ACTION_IDS.size}개 · herdr 메서드 ${HERDR_METHODS.size}개만 읽혔다`)
  process.exit(2)
}
const MAIN_LOG = path.join(SRC, 'main/log.ts')
/**
 * LIFE-577 — 모바일 프로토콜(폰 ↔ corral WS)은 herdr 와 **다른 어휘**인데 메시지 이름 `ping` 이 herdr 메서드 지문과 겹친다
 * (A5 가 M1 메시지를 `hello`·`pair`·`ping` 으로 고정). 그래서 ③ 을 둔다: `src/main/mobile/` 안이고, 그 파일이 어댑터를 import 하지 않고,
 * 토큰이 모바일 프로토콜 어휘(`main/mobile/protocol.ts` 의 `CLIENT_TYPES` 에서 파생)이며 **method 자리·envelope 글자 밖**일 때만(fix1 R1-A5).
 * 어휘는 손으로 적지 않는다(L-6 와 같은 이유).
 */
const MOBILE_DIR = path.join(SRC, 'main/mobile')
const MOBILE_TYPES = derivedList({ file: 'main/mobile/protocol.ts', block: /export const CLIENT_TYPES = \[([^\]]*)\]/, item: /'([a-z_]+)'/g })
if (!MOBILE_TYPES.has('ping') || MOBILE_TYPES.size < 3) {
  console.error(`지문 파생 실패: 모바일 프로토콜 어휘 ${[...MOBILE_TYPES].join(',') || '(없음)'}`)
  process.exit(2)
}

/**
 * 토큰 바로 앞이 요청 envelope 자리인가 — `method:` · `"method":` · `.method =` · `method ===` · `\"method\":\"`
 * · 템플릿 안 JSON 의 보간 `{"method":"${'…'}"}` (fix1).
 */
const ENVELOPE_BEFORE = /method\\?['"`]?\]?\s*(?::|={1,3}|!==?)\s*\\?(?:['"]?\$\{\s*)?$/i
/** 토큰 바로 앞이 `log(` 의 첫 인자 자리인가 — `console.log(`·`x.log(` 는 아니다. */
const LOG_FIRST_ARG_BEFORE = /(?<![\w.$])log\(\s*$/

const METHOD_IDENTIFIER = /method/i
const METHOD_WORD = /^[\w$]*method[\w$]*$/i
/**
 * 노드가 method 를 **이름으로** 말하는가 — 식별자(`msg.method`·`RENAME_METHOD`) 또는 이름 꼴 문자열(`msg['method']`·`"method":`).
 * 문장 꼴 문자열(테스트 이름 `'method 를 보여 준다'`)은 이름이 아니다.
 */
function mentionsMethod(node) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return METHOD_IDENTIFIER.test(node.text)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return METHOD_WORD.test(node.text)
  return ts.forEachChild(node, mentionsMethod) === true
}
/** 문장·함수·블록 경계 — envelope 판정이 이 너머로 올라가지 않는다. */
const isStatementBoundary = (node) =>
  ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isCaseClause(node) ||
  (node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement)

/** 글자 노드 — 문자열·템플릿 조각·JSX 텍스트. 토큰이 이 안에 있으면 코드가 아니라 글이다. */
const isTextNode = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
  ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)

/**
 * `pos` 의 토큰이 어떤 글자 노드에 있는가 (fix3 R3-claude-01).
 *   { literal } — `pos` 에서 **시작하는** 문자열 리터럴 그 자체(`'tab.rename'`) — AST 로 묶음을 본다
 *   { inside }  — 더 긴 글자 노드 안(오류 메시지·JSON 문자열·테스트 제목·템플릿 문장·JSX 텍스트)
 *   null        — 어느 글자 노드에도 없다(AST 와 글자 위치가 어긋남) — 판정할 수 없다
 */
function textAt({ sourceFile, pos }) {
  let found = null
  const visit = (node) => {
    if (pos < node.pos || pos >= node.end) return
    if (isTextNode(node) && node.getStart(sourceFile) <= pos) {
      const whole = (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.getStart(sourceFile) === pos
      found = whole ? { literal: node } : { inside: node }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

const BINDING_OPERATORS = (kind) =>
  kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
  kind === ts.SyntaxKind.EqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken ||
  (kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment)

/** 이름 있는 선언(함수·메서드·getter·enum·타입 별칭)의 이름이 method 를 말하는가. */
const namedMethod = (node) => node.name !== undefined && mentionsMethod(node.name)

/**
 * LIFE-518 fix1 (R1-claude-01) · fix2 (R2-claude-02) — 리터럴이 **같은 식 안에서 `method` 자리와 묶인 값**인가.
 * 리터럴에서 부모로 올라가며(문장 경계에서 멈춤) 다음 중 하나면 envelope 이다:
 *   이름에 method 가 든 속성·변수·파라미터·구조 분해·enum 멤버·JSX 속성·타입 멤버의 값
 *     (`method: x ?? 'A'` · `RENAME_METHOD = 'A'` · `(method = 'A') =>` · `<Req method={'A'} />` · `enum HerdrMethod { R = 'A' }`)
 *   이항식의 다른 쪽이 method 를 말한다(`'A' === frame.method` · `msg.method = 'A'`)
 *   호출: 리터럴이 호출 대상 쪽이고 인자가 method 를 말한다(`['A'].includes(msg.method)`) · 리터럴이 인자이고 호출 대상이
 *     method 를 말한다(`callMethod('A')`) · 리터럴이 **직접 인자**(함수 식·배열 리터럴을 거치지 않음)이고 **형제 인자**가
 *     method 를 말한다(`assert.equal(frame.method, 'A')` · `Object.is(frame.method, 'A')`). 형제가 배열 리터럴(의존성 배열
 *     `[method]`)이면 묶지 않는다(fix4 R4-claude-01). 함수·객체 형제 안 method 는 보지 않는다(오탐 방지 — 콜백·옵션 객체
 *     `on('A', (ctx) => ctx.method)` · `addMenuItem('A', { method: 'keyboard' })`). 그 꼴의 누출은 ⓔ① 사각(fix5 R5-claude-01)
 *   `switch (frame.method)` 의 `case 'A':` · 이름에 method 가 든 타입 별칭(`type HerdrMethod = 'A' | 'B'`)
 *   **반환 값**: 이름에 method 가 든 함수·메서드·getter 가 돌려준다(`get method() { return 'A' }`). 이름 없는 함수 **식**이
 *     돌려주면 그 함수 식에서 다시 올라간다(`method: (() => { return 'A' })()`). 반환이 아닌 문장(콜백 안 `track('A')`)에서는 멈춘다
 */
function boundToMethod({ literal }) {
  const mentions = mentionsMethod
  let child = literal
  // 형제 인자 규칙의 「직접 인자」 판정 — 리터럴에서 여기까지 함수 식이나 배열 리터럴을 거쳤는가
  let indirect = false
  for (let parent = literal.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isArrayLiteralExpression(parent)) indirect = true
    if (ts.isCaseClause(parent) && parent.expression === child) return mentions(parent.parent.parent.expression)
    // 반환 자리 — `return 'A'` 또는 식 몸체 화살표 `() => 'A'`
    const returned = (ts.isReturnStatement(parent) && parent.expression === child) || (ts.isArrowFunction(parent) && parent.body === child && !ts.isBlock(child))
    if (returned) {
      let owner = parent
      while (owner && !ts.isSourceFile(owner) && !ts.isFunctionLike(owner)) owner = owner.parent
      if (!owner || ts.isSourceFile(owner)) return false
      if (namedMethod(owner)) return true
      if (!(ts.isArrowFunction(owner) || ts.isFunctionExpression(owner))) return false
      indirect = true
      child = owner
      parent = owner
      continue
    }
    if (ts.isTypeAliasDeclaration(parent) && namedMethod(parent)) return true
    if (isStatementBoundary(parent)) return false
    const valued =
      ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) ||
      ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isEnumMember(parent)
    if (valued && parent.initializer === child && (mentions(parent.name) || (ts.isEnumMember(parent) && namedMethod(parent.parent)))) return true
    if ((ts.isPropertySignature(parent) && parent.type === child) || ts.isJsxAttribute(parent)) {
      if (mentions(parent.name)) return true
    }
    // 이항식은 **비교·대입**만 묶는다(fix3 R3-claude-02) — `&&`·`||`·`??`·`+` 는 묶지 않고 계속 올라간다(`method: x ?? 'A'` 는 위 속성에서 잡힌다)
    if (ts.isBinaryExpression(parent) && BINDING_OPERATORS(parent.operatorToken.kind) && mentions(parent.left === child ? parent.right : parent.left)) return true
    // 호출 — 리터럴이 호출 대상 쪽이면 인자가 method 를 말할 때 묶는다(`['A'].includes(msg.method)`)
    if (ts.isCallExpression(parent) && parent.expression === child && parent.arguments.some(mentions)) return true
    if (ts.isCallExpression(parent) && parent.arguments.includes(child)) {
      // 리터럴이 인자 쪽이면: 호출 대상이 method 를 말하거나(`callMethod('A')`), 직접 인자이고 배열 아닌 형제 인자가 method 를 말한다
      // (`assert.equal(frame.method, 'A')` — fix4 R4-claude-01). 콜백 안 리터럴·의존성 배열은 묶지 않는다(fix3 R3-claude-02 유지).
      // 함수·객체 리터럴 형제는 안을 보지 않는다 — 콜백·옵션 객체 안 method 는 오탐이다(fix5 R5-claude-01, 그 꼴의 누출은 ⓔ① 사각)
      if (mentions(parent.expression)) return true
      const siblings = parent.arguments.filter((arg) => arg !== child && !ts.isArrayLiteralExpression(arg) &&
        !ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg) && !ts.isObjectLiteralExpression(arg))
      if (!indirect && siblings.some(mentions)) return true
    }
  }
  return false
}

/**
 * 메서드 지문에 걸린 토큰을 위반에서 빼는 두 경우(01-criteria K3ⓔ 의 오탐 꼴 정의 그대로). 그 밖은 null(위반).
 *   ① 액션 id 어휘의 토큰이 envelope 자리 밖에 있다 — 액션 표·`bindingLabel('tab.rename')`·액션 id 키 객체·테스트 기대값.
 *      envelope 자리 = 바로 앞이 `method:` 류(문자열 안 JSON 포함 — 글자로 본다) **또는** 같은 식 안에서 method 와 묶인 값(AST)
 *   ② main 의 `log()`(`main/log.ts` 를 import 한 파일) 첫 인자 태그이고, 실제 herdr 메서드 이름이 아니다
 * 뺀 토큰은 결과의 `면제` 칸에 싣는다 — 숨기지 않는다.
 *
 * fix2 (R2-claude-01) — **판정할 수 없으면 면제하지 않는다.** 주석을 벗긴 원문이 파싱 오류를 내거나(`stripComments` 가
 * JSX 텍스트의 `//` 를 주석으로 먹는 경우 등) 토큰 자리에서 글자 노드를 못 찾으면 ①을 주지 않는다 — 못 풀었다는 이유로 통과시키지 않는다.
 * fix3 (R3-claude-01) — 토큰이 **더 긴 글자 노드 안**(오류 메시지·JSON 픽스처·테스트 제목·템플릿 문장)이면 글이다.
 * envelope 글자 규칙(`"method":"…"`)에 안 걸렸으면 ①을 준다.
 */
function methodExemption({ source, index, name, zone, importsMainLog, sourceFile, file, importsAdapter }) {
  const before = source.slice(Math.max(0, index - 80), index)
  // ③ 모바일 어휘(LIFE-577) — fix1 R1-A5: 「mobile 폴더 + 어댑터 import 없음」 만으로는 와이어를 모른다는 근거가 아니다.
  // ① 과 같은 판정으로 좁힌다: envelope 글자(`"method":"ping"`)가 아니고, 글자 노드 **그 자체**(긴 문장 안이 아님)이며,
  // 같은 식 안에서 `method` 자리와 묶이지 않은 값(`{type:'ping'}`·`message.type === 'ping'`·`case 'ping'` 의 switch 대상이 type)만.
  // 판정할 수 없으면(파싱 진단·글자 노드 못 찾음) 면제하지 않는다(R2-claude-01 fail-closed 와 같다).
  if (zone === 'main' && inside(file, MOBILE_DIR) && !importsAdapter && MOBILE_TYPES.has(name) && !ENVELOPE_BEFORE.test(before)) {
    const parsed = sourceFile()
    const diagnostics = parsed.parseDiagnostics
    const trusted = Array.isArray(diagnostics) && diagnostics.length === 0
    const text = trusted ? textAt({ sourceFile: parsed, pos: index }) : null
    if (text?.literal && !boundToMethod({ literal: text.literal })) return 'mobile-protocol'
  }
  if (ACTION_IDS.has(name) && !ENVELOPE_BEFORE.test(before)) {
    const parsed = sourceFile()
    const diagnostics = parsed.parseDiagnostics
    // `parseDiagnostics` 는 typescript 내부 필드다 — 없어지면(배열이 아니면) 믿을 수 없는 쪽으로 본다.
    const trusted = Array.isArray(diagnostics) && diagnostics.length === 0
    // 믿을 수 없거나(파싱 진단) 글자 노드를 못 찾으면 면제하지 않는다(R2-claude-01 fail-closed).
    // 더 긴 글자 안의 토큰은 글이다 — envelope 글자 규칙(위)에 안 걸렸으면 면제한다(R3-claude-01).
    const text = trusted ? textAt({ sourceFile: parsed, pos: index }) : null
    if (text?.inside) return 'action-id'
    if (text?.literal && !boundToMethod({ literal: text.literal })) return 'action-id'
  }
  if (zone === 'main' && importsMainLog && !HERDR_METHODS.has(name) && LOG_FIRST_ARG_BEFORE.test(before)) return 'log-tag'
  return null
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
    // 닫는 따옴표 앞 역슬래시도 본다 (LIFE-518) — 이스케이프한 JSON 문자열 `"{\\"method\\":\\"tab.rename\\"}"` 안의 토큰.
      /['"`](?:ping|session\.snapshot|workspace\.\w+|worktree\.\w+|tab\.\w+|pane\.\w+|agent\.\w+|events\.\w+|layout\.\w+)\\?['"`]/g,
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
const exemptions = []

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
  const codeTokens = new Set()
  const exempt = new Set()
  if (!isAdapter) {
    const importsMainLog = resolved.some(({ target }) => target === MAIN_LOG)
    const importsAdapter = resolved.some(({ target }) => target !== null && inside(target, ADAPTER))
    // 주석을 벗긴 원문을 파싱한다 — 토큰 위치(index)가 그 원문 기준이다. 액션 id 토큰이 있는 파일만 실제로 파싱한다.
    let parsed = null
    const sourceFile = () => (parsed ??= ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS))
    for (const { kind, pattern } of WIRE_FINGERPRINTS) {
      for (const match of source.matchAll(pattern)) {
        codeTokens.add(match[0])
        const name = match[0].replace(/^['"`]|\\?['"`]$/g, '')
        const reason = kind === 'method' ? methodExemption({ source, index: match.index, name, zone, importsMainLog, sourceFile, file, importsAdapter }) : null
        if (reason === null) wire.push({ kind, token: match[0] })
        else exempt.add(`${reason}\t${match[0]}`)
      }
    }
  }
  if (wire.length > 0) {
    violations.push({ rule: 'R4-wire-leak', zone, file: rel(file), tokens: [...new Set(wire.map((item) => item.token))] })
  }

  for (const entry of exempt) {
    const [사유, token] = entry.split('\t')
    exemptions.push({ file: rel(file), zone, token, 사유 })
  }

  // 주석에서만 나온 언급 — 위반은 아니지만 숨기지 않는다.
  if (!isAdapter) {
    const inRaw = new Set()
    for (const { pattern } of WIRE_FINGERPRINTS) for (const match of raw.matchAll(pattern)) inRaw.add(match[0])
    const onlyComment = [...inRaw].filter((token) => !codeTokens.has(token))
    if (onlyComment.length > 0) commentMentions.push({ file: rel(file), zone, tokens: onlyComment })
  }

  scanned.push({ file: rel(file), zone, imports: specifiers.length, wireHits: wire.length })
}

/**
 * IPC 표면 — 경계를 건너는 payload 타입이 어디서 오나 (N2ⓐ).
 * LIFE-518 — 묻는 것은 「preload 가 main·renderer·어댑터가 아니라 shared 에서만 가져오나」 다. 전에는 지정자 문자열에
 * `shared/types` 가 들었는지 봐서, preload 가 `shared/terminal-settings` 처럼 shared 의 다른 모듈을 쓰자 미달이 됐다.
 * 이제 지정자를 실제 경로로 풀어 `src/shared/` 안인지 본다 — `src/shared-x/` 같은 형제는 `inside` 가 막는다.
 */
const PRELOAD = path.join(SRC, 'preload/index.ts')
const preloadSource = stripComments(fs.readFileSync(PRELOAD, 'utf8'))
const ipcTypeImports = importSpecifiers(preloadSource).filter((item) => item.startsWith('.'))
const ipcTypesFromShared = ipcTypeImports.every((item) => inside(resolveSpecifier(PRELOAD, item), path.join(SRC, 'shared')))

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
    'src/shared 만인가': ipcTypesFromShared,
  },
  검사한파일: scanned,
  주석언급: {
    설명: '주석에만 나온 herdr 와이어 이름. 실행되지 않으므로 위반이 아니다 — 값의 출처를 적어 둔 자리다.',
    항목: commentMentions,
  },
  면제: {
    설명: '메서드 지문에 걸렸지만 위반이 아닌 토큰 (LIFE-518). action-id = 단축키 액션 id 가 요청 envelope 자리 밖에 있다. log-tag = main log() 의 첫 인자 태그이고 herdr 메서드 이름이 아니다. mobile-protocol = src/main/mobile/ 안(어댑터 import 없음)의 모바일 프로토콜 메시지 이름이 method 자리·envelope 글자 밖에 있다(LIFE-577 fix1).',
    '모바일 프로토콜 어휘 (main/mobile/protocol.ts CLIENT_TYPES 에서 파생)': [...MOBILE_TYPES],
    '액션 id (shared/keybindings.ts ACTIONS 에서 파생)': ACTION_IDS.size,
    'herdr 메서드 (adapter request.ts ALLOWED_METHODS 에서 파생)': HERDR_METHODS.size,
    항목: exemptions,
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
