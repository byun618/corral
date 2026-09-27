#!/usr/bin/env node
// 하네스 능력 대조 — 절차/매핑/런타임이 서로 어긋나면 멈춘다.
//
//   node .agents/harness/capability-check.mjs names
//     절차 문서가 쓰는 능력 이름 ⊆ capabilities.md 정본 ⊆ 매핑 3개의 절. 매달린 능력 0.
//   node .agents/harness/capability-check.mjs shape
//     매핑의 능력별 절이 명령 · 보장 수준 · 상황→행동(5항목)을 모두 갖는지.
//   node .agents/harness/capability-check.mjs runtime --tool corral|orca|bare
//     매핑이 요구하는 능력 ↔ 런타임이 광고하는 능력. 불일치면 멈춘다.
//
// 종료 코드: 0 통과 · 1 불일치(멈춘다) · 2 사용법·읽기 오류 · 3 대조 불가(광고가 없는 도구)
// 자기 검증용 뒷문: --mapping <경로> 로 매핑 파일을, --advertised <경로> 로 광고 목록(JSON 배열 또는
// status --json 원문)을 갈아 끼울 수 있다. 양성 대조에만 쓴다.

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
        if (!body.includes(s)) problems.push(`${file} 『${starts[k].name}』: 상황 항목 "${s}" 가 없다`);
      }
    }
    note(`${file}: 절 ${starts.length}개 × (절 3개 + 상황 5개) 검사`);
    if (starts.length !== canon.length) problems.push(`${file}: 절 수 ${starts.length} ≠ 정본 ${canon.length}`);
  }
  verdict('shape');
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

function commandNamesIn(text, tool, registry) {
  const re = new RegExp(`(?:^|[^\\w./-])${tool}\\s+([a-z][a-z-]*)(?:\\s+([a-z][a-z-]*))?`, 'g');
  const groups = new Set(['terminal', 'orchestration', 'worktree', 'repo', 'project', 'diagnostics', 'account', 'host', 'environment', 'file', 'skills']);
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, a, b] = m;
    const two = b ? `${a} ${b}` : null;
    if (two && registry.has(two)) out.add(two);
    else if (registry.has(a)) out.add(a);
    else if (two && groups.has(a)) out.add(two);
    else out.add(a);
  }
  return [...out].sort();
}

function checkRuntime() {
  const tool = flag('--tool');
  if (!tool || !MAPPINGS[tool]) fail(2, 'runtime 모드는 --tool corral|orca|bare 가 필요하다');
  const mappingPath = flag('--mapping') || join(ROOT, '.agents/harness', MAPPINGS[tool]);
  const mapping = readFileSync(mappingPath, 'utf8');
  const advFile = flag('--advertised');

  if (tool === 'bare') {
    note('bare: 이 도구는 능력을 광고하지 않는다.');
    note('  tmux·iTerm2 어느 쪽도 "무엇을 보장하는가" 를 기계가 읽을 형태로 내놓지 않는다.');
    note('  → 런타임 대조 불가. 일치도 불일치도 아니다. 판정표에 공백으로 적어라 (bare.md 『전제 점검』).');
    process.exit(3);
  }

  let advertised;
  if (advFile) {
    advertised = advertisedFromFile(advFile);
    note(`광고 출처: ${advFile} (주입 — 양성 대조용)`);
  } else {
    const out = run(tool, ['status', '--json']);
    const parsed = JSON.parse(out);
    advertised = parsed?.result?.runtime?.capabilities;
    if (!Array.isArray(advertised)) fail(2, `${tool} status --json 에 runtime.capabilities 가 없다`);
    note(`광고 출처: ${tool} status --json (실행)`);
  }
  const advSet = new Set(advertised);
  note(`광고 ${advSet.size}개`);

  if (tool === 'corral') {
    // corral 의 광고는 명령 이름 집합이다.
    const required = commandNamesIn(mapping, 'corral', advSet);
    note(`${MAPPINGS[tool]} 가 요구하는 명령 ${required.length}개`);
    for (const c of required) if (!advSet.has(c)) problems.push(`광고에 없는 명령: corral ${c}`);
  } else {
    // orca 의 광고는 기능 토큰이다. 명령 이름은 레지스트리(agent-context)와 따로 대조한다.
    const tokens = new Set();
    for (const m of mapping.matchAll(/\b([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\.v\d+)\b/g)) tokens.add(m[1]);
    note(`${MAPPINGS[tool]} 가 요구하는 기능 토큰 ${tokens.size}개`);
    for (const t of tokens) if (!advSet.has(t)) problems.push(`광고에 없는 기능 토큰: ${t}`);
    const reg = JSON.parse(run(tool, ['agent-context', '--json']));
    const registry = new Set((reg.commands || []).map((c) => c.command));
    if (registry.size === 0) fail(2, `${tool} agent-context --json 에 commands 가 없다`);
    note(`명령 레지스트리 ${registry.size}개`);
    const required = commandNamesIn(mapping, 'orca', registry);
    note(`${MAPPINGS[tool]} 가 요구하는 명령 ${required.length}개`);
    for (const c of required) if (!registry.has(c)) problems.push(`레지스트리에 없는 명령: orca ${c}`);
  }
  verdict(`runtime --tool ${tool}`);
}

if (mode === 'names') checkNames();
else if (mode === 'shape') checkShape();
else if (mode === 'runtime') checkRuntime();
else fail(2, '사용법: capability-check.mjs names|shape|runtime [--tool corral|orca|bare]');
