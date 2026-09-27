#!/usr/bin/env node
// 하네스 능력 대조 — 절차/매핑/런타임이 서로 어긋나면 멈춘다.
//
//   node .agents/harness/capability-check.mjs names
//     절차 문서가 쓰는 능력 이름 ⊆ capabilities.md 정본 ⊆ 매핑 3개의 절. 매달린 능력 0.
//   node .agents/harness/capability-check.mjs shape
//     매핑의 능력별 절이 명령 · 보장 수준 · 상황→행동(5항목)을 모두 갖는지.
//     **한계(K9)**: 라벨 존재와 "라벨만 있고 비었나" 만 본다. 적힌 내용이 그 상황에 맞는 행동인지,
//     보장 수준 칸의 어휘가 실제 보장과 맞는지는 **기계가 보지 않는다 — 리뷰어가 본다.**
//   node .agents/harness/capability-check.mjs runtime --tool corral|orca|bare
//     매핑이 **선언한** 명령 ↔ 런타임이 광고하는 것 ↔ 매핑 본문이 실제로 쓰는 명령.
//
// ── 표기 규약 (이 관문의 핵심. 산문에서 명령을 추측으로 뽑지 않기 위한 것) ─────────────
// 매핑 본문의 인라인 코드 스팬(`…`)에 명령이 나오면 아래를 지킨다. 어기면 **불일치(1)** 다.
//   R1. **명령줄이면 도구 접두사 완전 표기.** 플래그(`--x`)나 자리표시자(`<…>`)가 있는 스팬은
//       `corral orchestration send …` 처럼 도구 이름부터 적는다. `send --type …` 는 오류다.
//   R2. **이름만 적는 스팬**은 접두사를 생략할 수 있으나 레지스트리에서 **유일하게** 해소돼야 한다.
//       `check` 는 되고 `send`(terminal send ↔ orchestration send)는 오류다 — 완전 표기로 쓴다.
//   R1b. **명령줄로 쓴 명령은 `required-commands` 에 있어야 한다.** `mentioned-commands` 는 이름 언급 전용이다 —
//       거기 적힌 이름으로 실행을 지시하면 오류다.
//   R3. 해소된 모든 이름은 ```required-commands 또는 ```mentioned-commands 에 **선언되어 있어야** 한다.
//   R4. `required` ⊆ 광고/레지스트리. `mentioned` 는 광고와 대조하지 않되 **사유 주석이 필수**다
//       (없는 명령·폐기된 별칭·"쓰지 말라" 를 적기 위한 칸이다).
//   R5. 선언 항목은 본문에 나와야 한다 (죽은 선언 금지).
// 왜 규약을 강제하나: 라운드 1·2 에서 **추출 휴리스틱을 늘리는 방식이 두 번 연속 새 사각을 냈다**
// (M1·L6 → N1). 규약은 "모르는 표기" 를 통과가 아니라 오류로 만든다 — 관문이 커지지 않고 좁아진다.
//
// 종료 코드: 0 통과 · 1 불일치(멈춘다) · 2 사용법·읽기 오류 · 3 대조 불가(광고가 없는 도구)
//   bare 는 규약·선언 검사를 **전부 돌린 뒤** 광고 대조만 공백이라 3 으로 끝난다. 규약을 어기면 1 이다.
// 뒷문(양성 대조 전용): `--mapping <경로>` 매핑 갈아끼우기 · `--advertised <경로>` 광고 목록 주입.
// 프로필 선택(K8): `--socket <경로>`·`--instance <id>` 를 주면 그 런타임에 그대로 넘긴다 —
//   주지 않으면 기본 프로필을 본다. **다른 프로필을 쓰면서 이 관문을 기본으로 돌리면 쓰지 않는 런타임을 점검한다.**

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HARNESS_DIR, '..', '..');

const NAME_RE = /『([^『』]+)』/g;
const MAPPINGS = { corral: 'corral.md', orca: 'orca.md', bare: 'bare.md' };
// 절차 문서 — 능력 이름으로만 말해야 하는 쪽. capabilities.md 는 정본이라 따로 센다.
const FLOW_DOCS = [
  'AGENTS.md',
  '.agents/agents/reviewer.md',
  '.agents/rules/validation.md',
  '.agents/skills/task-coordinate/SKILL.md',
  '.agents/skills/task-start/SKILL.md',
  '.agents/skills/task-start/defaults.md',
  '.agents/skills/task-coordinate/references/implementation.md',
];
const SECTIONS = ['### 명령', '### 보장 수준', '### 상황 → 행동'];
const SITUATIONS = ['- **차단 화면**', '- **타임아웃·빈 결과**', '- **부분 실패**', '- **복구**', '- **하지 말 우회**'];
const PROOF_ROWS = ['본문이 정확히 한 번 전달됐다', '세대 불변', '오래된 시도', '사람 개입'];

const argv = process.argv.slice(2);
const mode = argv[0];
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const read = (rel) => {
  const p = rel.startsWith('/') ? rel : join(ROOT, rel);
  if (!existsSync(p)) fail(2, `읽을 수 없다: ${p}`);
  return readFileSync(p, 'utf8');
};
const problems = [];
const note = (s) => console.log(s);
function fail(code, msg) {
  console.error(`[capability-check] ${msg}`);
  process.exit(code);
}
function verdict(label) {
  if (problems.length === 0) {
    note(`\n[capability-check] ${label}: 통과`);
    process.exit(0);
  }
  console.error(`\n[capability-check] ${label}: 불일치 ${problems.length}건 — 멈춘다`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// 정본 능력 목록 = capabilities.md 의 "능력 목록" 표에서 행 머리의 『…』
function canonicalNames() {
  const text = read('.agents/harness/capabilities.md');
  const names = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*『([^『』]+)』\s*\|/.exec(line);
    if (m) names.push(m[1]);
  }
  if (names.length === 0) fail(2, 'capabilities.md 의 능력 목록 표를 찾지 못했다');
  return names;
}

function usedNames(text) {
  const out = new Set();
  let m;
  NAME_RE.lastIndex = 0;
  while ((m = NAME_RE.exec(text)) !== null) out.add(m[1]);
  return out;
}

function checkNames() {
  const canon = canonicalNames();
  note(`정본 능력 ${canon.length}개: ${canon.map((n) => `『${n}』`).join(' ')}`);
  const usedInFlow = new Set();
  for (const doc of FLOW_DOCS) {
    const used = usedNames(read(doc));
    for (const n of used) {
      usedInFlow.add(n);
      if (!canon.includes(n)) problems.push(`${doc}: 정본에 없는 능력 이름 『${n}』`);
    }
  }
  for (const [tool, file] of Object.entries(MAPPINGS)) {
    const text = read(`.agents/harness/${file}`);
    const heads = new Set();
    for (const line of text.split('\n')) {
      const m = /^##\s+『([^『』]+)』\s*$/.exec(line);
      if (m) heads.add(m[1]);
    }
    for (const n of canon) if (!heads.has(n)) problems.push(`${file}: 능력 『${n}』 의 절(## 『…』)이 없다`);
    for (const n of heads) if (!canon.includes(n)) problems.push(`${file}: 정본에 없는 절 『${n}』 (매달린 능력)`);
    note(`${file}: 능력 절 ${heads.size}개`);
  }
  for (const n of canon) {
    if (!usedInFlow.has(n)) problems.push(`절차 문서 어디에서도 쓰지 않는 능력 『${n}』 (매달린 능력)`);
  }
  note(`절차 문서가 쓰는 능력 ${usedInFlow.size}개 / 정본 ${canon.length}개`);
  verdict('names');
}

function checkShape() {
  const canon = canonicalNames();
  for (const [tool, file] of Object.entries(MAPPINGS)) {
    const text = read(`.agents/harness/${file}`);
    for (const row of PROOF_ROWS) {
      if (!text.includes(row)) problems.push(`${file}: 보장 요약에 "${row}" 줄이 없다`);
    }
    const lines = text.split('\n');
    const starts = [];
    lines.forEach((line, i) => {
      const m = /^##\s+『([^『』]+)』\s*$/.exec(line);
      if (m) starts.push({ name: m[1], at: i });
    });
    for (let k = 0; k < starts.length; k += 1) {
      const end = k + 1 < starts.length ? starts[k + 1].at : lines.length;
      const body = lines.slice(starts[k].at, end).join('\n');
      for (const s of SECTIONS) {
        if (!body.includes(s)) problems.push(`${file} 『${starts[k].name}』: "${s}" 가 없다`);
      }
      for (const s of SITUATIONS) {
        if (!body.includes(s)) { problems.push(`${file} 『${starts[k].name}』: 상황 항목 "${s}" 가 없다`); continue; }
        // K9 — 라벨만 있고 뒤가 빈 항목을 잡는다. **내용의 타당성은 이 관문이 보지 않는다(리뷰 몫).**
        const at = body.indexOf(s) + s.length;
        const rest = body.slice(at, body.indexOf('\n- **', at) === -1 ? undefined : body.indexOf('\n- **', at));
        const filled = rest.replace(/[\s:·.]/g, '');
        // 임계 3자: `해당 없음.` 같은 정당한 짧은 답은 통과시키고 **라벨만 있고 빈 칸**만 잡는다.
        // 내용이 타당한지는 이 관문이 판단하지 않는다 — 리뷰어 몫이다(K9 의 한계로 문서화).
        if (filled.length < 3) problems.push(`${file} 『${starts[k].name}』: 상황 항목 "${s}" 가 라벨만 있고 비었다(유효 ${filled.length}자)`);
      }
    }
    note(`${file}: 절 ${starts.length}개 × (절 3개 + 상황 5개) 검사`);
    if (starts.length !== canon.length) problems.push(`${file}: 절 수 ${starts.length} ≠ 정본 ${canon.length}`);
  }
  verdict('shape');
}

// ── 선언 블록 ───────────────────────────────────────────────────────────────
// ```required-commands / ```mentioned-commands / ```required-tokens 를 읽는다.
// `#` 뒤는 주석(mentioned 에서는 **사유**라 필수), 빈 줄은 무시.
function declaredBlock(text, kind) {
  const re = new RegExp('```' + kind + '\\n([\\s\\S]*?)```', 'g');
  const entries = [];
  const noReason = [];
  let found = false;
  let m;
  while ((m = re.exec(text)) !== null) {
    found = true;
    for (const raw of m[1].split('\n')) {
      const hash = raw.indexOf('#');
      const name = (hash === -1 ? raw : raw.slice(0, hash)).trim();
      const reason = hash === -1 ? '' : raw.slice(hash + 1).trim();
      if (!name) continue;
      entries.push(name);
      if (!reason) noReason.push(name);
    }
  }
  return { found, entries: [...new Set(entries)].sort(), noReason };
}

// ── 표기 규약 검사 ──────────────────────────────────────────────────────────
// 도구별 어휘. corral·orca 는 런타임이 알려 주고, bare 는 광고가 없으니 **선언이 어휘다**.
function lexicon(tool, oracleNames) {
  const names = [...new Set(oracleNames)];
  const byLast = new Map();
  const firsts = new Set();
  for (const n of names) {
    const parts = n.split(' ');
    firsts.add(parts[0]);
    const last = parts[parts.length - 1];
    if (!byLast.has(last)) byLast.set(last, []);
    byLast.get(last).push(n);
  }
  return { names, byLast, firsts };
}

// 스팬 하나를 규약에 비춰 본다. 반환: {kind, name?, msg?}
//   kind: 'none'(명령이 아니다) · 'name'(이름만, 해소됨) · 'line'(완전 표기 명령줄) · 'error'
function classifySpan(span, tool, lex, declared) {
  const s = span.trim();
  if (!s) return { kind: 'none' };
  const words = s.split(/\s+/);
  const isLine = /--[a-z]/.test(s) || /<[^>]+>/.test(s);
  const prefixes = tool === 'bare' ? ['tmux'] : [tool];
  if (prefixes.includes(words[0])) {
    // 도구 이름만, `corral <명령> --help` 류 일반형, `corral --help` 같은 전역 플래그는 명령 표기가 아니다
    if (words.length === 1 || /^[<[-]/.test(words[1])) return { kind: 'none' };
    const two = words[1] && words[2] ? `${words[1]} ${words[2]}` : null;
    const one = words[1] ? words[1] : null;
    if (tool === 'bare') {
      const pair = one ? `tmux ${one}` : null;
      if (pair && lex.names.includes(pair)) return { kind: isLine ? 'line' : 'name', name: pair };
      return { kind: 'error', msg: `선언에 없는 tmux 명령: \`${s}\`` };
    }
    if (two && lex.names.includes(two)) return { kind: isLine ? 'line' : 'name', name: two };
    if (one && lex.names.includes(one)) return { kind: isLine ? 'line' : 'name', name: one };
    // 레지스트리에 없다 — mentioned-commands 에 사유와 함께 선언했으면 "없다는 사실을 적은 것" 으로 받는다
    if (two && declared.has(two)) return { kind: 'name', name: two };
    if (one && declared.has(one)) return { kind: 'name', name: one };
    return { kind: 'error', msg: `광고·레지스트리에 없는 명령 표기: \`${s}\` (없다는 사실을 적는 것이면 mentioned-commands 에 사유와 함께 선언한다)` };
  }
  if (/^async_[a-z_]+$/.test(words[0])) {
    if (lex.names.includes(words[0])) return { kind: isLine ? 'line' : 'name', name: words[0] };
    return { kind: 'error', msg: `선언에 없는 iTerm2 API: \`${s}\`` };
  }
  // 접두사가 없다 — 알려진 명령 단어로 시작하면 규약 위반 후보다
  const two = words[1] ? `${words[0]} ${words[1]}` : null;
  let resolved = null;
  let ambiguous = null;
  if (two && lex.names.includes(two)) resolved = two;
  else if (lex.names.includes(words[0])) resolved = words[0];
  else if (lex.byLast.has(words[0])) {
    const cands = lex.byLast.get(words[0]);
    if (cands.length === 1) [resolved] = cands;
    else ambiguous = cands;
  } else if (lex.firsts.has(words[0])) {
    // 그룹 이름으로 시작하는데 뒤가 레지스트리에 없다
    if (two && declared.has(two)) return { kind: 'name', name: two };
    return { kind: 'error', msg: `알려진 그룹으로 시작하지만 해소되지 않는다: \`${s}\` (없는 명령이면 mentioned-commands 에 선언한다)` };
  }
  if (!resolved && !ambiguous) return { kind: 'none' };
  if (isLine) {
    return { kind: 'error', msg: `R1 위반 — 명령줄은 \`${tool} …\` 완전 표기로 쓴다: \`${s}\`` };
  }
  if (ambiguous) {
    return { kind: 'error', msg: `R2 위반 — \`${s}\` 는 ${ambiguous.join(' / ')} 로 갈린다. 완전 표기로 쓴다` };
  }
  return { kind: 'name', name: resolved };
}

// ── runtime ────────────────────────────────────────────────────────────────
function advertisedFromFile(path) {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  const caps = parsed?.result?.runtime?.capabilities;
  if (Array.isArray(caps)) return caps;
  fail(2, `${path}: 능력 배열을 찾지 못했다`);
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    fail(2, `${cmd} ${args.join(' ')} 실패: ${e.stderr || e.message}`);
  }
}

function checkRuntime() {
  const tool = flag('--tool');
  if (!tool || !MAPPINGS[tool]) fail(2, 'runtime 모드는 --tool corral|orca|bare 가 필요하다');
  const mappingPath = flag('--mapping') || join(ROOT, '.agents/harness', MAPPINGS[tool]);
  const mapping = readFileSync(mappingPath, 'utf8');
  const advFile = flag('--advertised');
  // 실제로 읽은 파일을 적는다 — 뒷문으로 갈아 끼웠는데 원본 이름을 찍으면 양성 대조가 거짓말이 된다
  note(`매핑: ${mappingPath}`);
  // K8 — 프로필 선택 인자를 그대로 넘긴다. 주지 않으면 기본 프로필이다
  const profile = [];
  if (flag('--socket')) profile.push('--socket', flag('--socket'));
  if (flag('--instance')) profile.push('--instance', flag('--instance'));
  note(profile.length ? `프로필 인자: ${profile.join(' ')}` : '프로필: 기본 (--socket·--instance 없음)');

  // (1) 선언 블록
  const decl = declaredBlock(mapping, 'required-commands');
  const ment = declaredBlock(mapping, 'mentioned-commands');
  if (!decl.found) problems.push('```required-commands 선언 블록이 없다 (요구를 안 적었다)');
  else if (decl.entries.length === 0) problems.push('```required-commands 선언이 비어 있다 — 요구 0개는 통과가 아니다');
  for (const n of ment.noReason) problems.push(`R4 위반 — mentioned-commands \`${n}\` 에 사유 주석이 없다`);
  note(`선언: 요구 ${decl.entries.length}개 · 언급만 ${ment.entries.length}개`);
  const declared = new Set([...decl.entries, ...ment.entries]);

  // (2) 광고/레지스트리
  let advertised = null;
  let registry = null;
  if (tool === 'bare') {
    note('bare: 광고하는 능력이 없다 — 어휘는 이 매핑의 선언이다.');
  } else if (advFile) {
    advertised = new Set(advertisedFromFile(advFile));
    note(`광고 출처: ${advFile} (주입 — 양성 대조용)`);
  } else {
    const parsed = JSON.parse(run(tool, ['status', '--json', ...profile]));
    advertised = new Set(parsed?.result?.runtime?.capabilities || []);
    if (advertised.size === 0) fail(2, `${tool} status --json 에 runtime.capabilities 가 없다`);
    note(`광고 출처: ${tool} status --json${profile.length ? ' ' + profile.join(' ') : ''} (실행)`);
  }
  if (tool === 'orca') {
    const reg = JSON.parse(run(tool, ['agent-context', '--json', ...profile]));
    registry = new Set((reg.commands || []).map((c) => c.command));
    if (registry.size === 0) fail(2, `${tool} agent-context --json 에 commands 가 없다`);
    note(`명령 레지스트리 ${registry.size}개`);
  } else if (tool === 'corral') {
    registry = advertised; // corral 의 광고가 곧 명령 이름 집합이다
  } else {
    registry = declared; // bare
  }
  if (advertised) note(`광고 ${advertised.size}개`);

  // (3) 표기 규약 + 본문이 쓰는 명령 수집
  const prose = mapping.replace(/```required-(?:commands|tokens)\n[\s\S]*?```/g, '')
                       .replace(/```mentioned-commands\n[\s\S]*?```/g, '');
  const lex = lexicon(tool, [...registry]);
  const used = new Set();
  const ranAsLine = new Set();
  let spans = 0;
  let lines = 0;
  const take = (raw) => {
    spans += 1;
    const r = classifySpan(raw, tool, lex, declared);
    if (r.kind === 'error') problems.push(r.msg);
    else if (r.kind === 'name' || r.kind === 'line') {
      used.add(r.name);
      if (r.kind === 'line') { lines += 1; ranAsLine.add(r.name); }
    }
  };
  // ⓐ 인라인 코드 스팬
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) take(m[1]);
  // ⓑ 펜스 블록의 각 줄 — 『명령』 절이 바로 여기다. 주석·이어지는 플래그 줄은 건너뛴다
  let fenced = 0;
  for (const m of prose.matchAll(/```(?:bash|sh|text)?\n([\s\S]*?)```/g)) {
    for (const raw of m[1].split('\n')) {
      const line = raw.replace(/\\$/, '').replace(/\s+#.*$/, '').trim();
      if (!line || line.startsWith('#') || line.startsWith('--') || line.startsWith('|')) continue;
      fenced += 1;
      take(line);
    }
  }
  note(`코드 스팬 ${spans}개(인라인 + 펜스 ${fenced}줄) 검사 — 완전 표기 명령줄 ${lines}건 · 본문이 쓰는 명령 ${used.size}종`);

  // (4) 본문 ⊆ 선언 (R3) — bare 에서도 돈다
  for (const n of [...used].sort()) {
    if (!declared.has(n)) problems.push(`R3 위반 — 선언에 없는데 본문이 쓰는 명령: ${n}`);
  }
  // (4b) **명령줄로 쓴 명령은 required 여야 한다.** mentioned 는 "이름만 언급" 칸이므로
  // 거기 있는 이름으로 실행을 지시하면 조용히 통과한다 — 그 구멍을 막는다.
  for (const n of [...ranAsLine].sort()) {
    if (!decl.entries.includes(n)) {
      problems.push(`R1b 위반 — mentioned(또는 미선언) 명령을 명령줄로 지시한다: ${n} — 실행을 지시하려면 required-commands 에 올린다`);
    }
  }
  // (5) required ⊆ 광고/레지스트리 (R4). bare 는 대조할 광고가 없다
  if (tool !== 'bare') {
    for (const n of decl.entries) {
      if (!registry.has(n)) problems.push(`${tool === 'orca' ? '레지스트리' : '광고'}에 없는 명령: ${tool} ${n}`);
    }
  }
  // (6) 죽은 선언 (R5)
  for (const n of [...declared].sort()) {
    if (!used.has(n)) problems.push(`R5 위반 — 선언에만 있고 본문에 없는 명령: ${n}`);
  }
  // (7) orca 기능 토큰
  if (tool === 'orca') {
    const tdecl = declaredBlock(mapping, 'required-tokens');
    if (!tdecl.found) problems.push('```required-tokens 선언 블록이 없다 (orca 의 광고는 기능 토큰이다)');
    else if (tdecl.entries.length === 0) problems.push('```required-tokens 선언이 비어 있다');
    note(`선언한 요구 기능 토큰 ${tdecl.entries.length}개`);
    for (const t of tdecl.entries) if (advertised && !advertised.has(t)) problems.push(`광고에 없는 기능 토큰: ${t}`);
    const proseTokens = new Set();
    for (const m of prose.matchAll(/\b([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\.v\d+)\b/g)) proseTokens.add(m[1]);
    for (const t of [...proseTokens].sort()) {
      if (!tdecl.entries.includes(t)) problems.push(`선언에 없는데 본문이 쓰는 기능 토큰: ${t}`);
    }
  }

  if (tool === 'bare') {
    if (problems.length > 0) verdict('runtime --tool bare');
    note('bare: 규약·선언·본문 세 방향은 돌렸다. **광고 대조만 불가**다 —');
    note('  tmux·iTerm2 어느 쪽도 "무엇을 보장하는가" 를 기계가 읽을 형태로 내놓지 않는다.');
    note('  → 그 한 방향은 공백이다. 판정표에 공백으로 적어라 (bare.md 『전제 점검』).');
    process.exit(3);
  }
  verdict(`runtime --tool ${tool}`);
}

if (mode === 'names') checkNames();
else if (mode === 'shape') checkShape();
else if (mode === 'runtime') checkRuntime();
else fail(2, '사용법: capability-check.mjs names|shape|runtime [--tool corral|orca|bare]');
