// LIFE-729 C9ⓓ — 만든 corral.app 안에 실제로 든 것 ⊆ 실은 고지 목록(licenses/third-party/third-party.json)인지 대조한다.
// 고지 생성기(build-notices.mjs — 번들러 모듈 목록·package-lock·cargo metadata)와 다른 쪽에서 뽑는다 — 앱 번들 안의 실물:
//   ① app.asar 의 node_modules/**/package.json (이름·버전)
//   ② app.asar 의 out/ JS 마다 빌드 트리의 숨은 소스맵(바이트가 같은 파일일 때만)의 sources → 든 npm 패키지
//      소스맵이 없는 파일(복사된 자산·글꼴·worker 입구)은 내용 sha256 을 node_modules·src 파일과 맞춰 출처를 찾는다
//   ③ 동봉 herdr 바이너리의 문자열(crate 소스 경로 이름-버전)·심볼(Rust crate 이름, 비-Rust 표지)
//   ④ Electron Framework 의 버전 = 고지의 Electron 버전, 고지 원문 파일이 목록의 sha256 과 같다
// 그리고 고지마다 원문이 비지 않았는지(C9ⓒ). 하나라도 어긋나면 exit 1 — package:mac 이 electron-builder 뒤에 불러 빌드를 멈춘다.
// node scripts/verify-notices.mjs <corral.app> [--build <app 폴더 — out/·node_modules/·src/ 가 있는 곳, 기본 이 스크립트의 app/>] [--report <파일>]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readAsar, sha256 } from './notices-lib.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const appBundle = args[0]
if (!appBundle || appBundle.startsWith('--')) {
  console.error('사용: node scripts/verify-notices.mjs <corral.app> [--build <app 폴더>] [--report <파일>]')
  process.exit(2)
}
const buildDir = path.resolve(opt('--build', path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')))
const reportFile = opt('--report', null)
const res = path.join(appBundle, 'Contents/Resources')
const noticeDir = path.join(res, 'licenses/third-party')
const problems = []
const notes = []
const bad = (m) => problems.push(m)

let list
try {
  list = JSON.parse(fs.readFileSync(path.join(noticeDir, 'third-party.json'), 'utf8'))
} catch {
  console.error(`✖ 고지 목록이 없다: ${path.relative(appBundle, noticeDir)}/third-party.json`)
  process.exit(1)
}
const text = fs.readFileSync(path.join(noticeDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
const comps = list.components
const has = (kind, name, version) => comps.some((c) => c.kind === kind && c.name === name && (version === undefined || c.version === version))

// C9ⓒ — 원문이 빈 고지·원문 sha256 이 비거나 원문 파일과 다른 고지
for (const c of comps) {
  if (!c.texts?.length) bad(`원문 없음: ${c.kind} ${c.name}@${c.version}`) // # guard:nv-text
  if (!text.includes(`\n${c.name} ${c.version}\nLicense: `)) bad(`THIRD-PARTY-NOTICES.txt 에 머리줄이 없다: ${c.name} ${c.version}`)
  for (const t of c.texts ?? []) {
    if (!t.file.startsWith('electron/')) continue
    const f = path.join(noticeDir, t.file)
    if (!fs.existsSync(f) || sha256(fs.readFileSync(f)) !== t.sha256) bad(`고지 원문 파일이 목록의 sha256 과 다르거나 없다: ${t.file}`)
  }
}

// ① asar node_modules
const asarFile = path.join(res, 'app.asar')
const asar = readAsar(asarFile)
const npmSeen = new Map() // 이름@버전 → 어디서 봤나
const seeNpm = (name, version, where) => {
  const k = `${name}@${version}`
  if (!npmSeen.has(k)) npmSeen.set(k, where)
}
for (const p of asar.entries.keys()) {
  if (!/(^|\/)node_modules\/(@[^/]+\/)?[^/@][^/]*\/package\.json$/.test(p)) continue
  const pkg = JSON.parse(asar.read(p).toString('utf8'))
  if (pkg.name && pkg.version) seeNpm(pkg.name, pkg.version, `asar:${p}`)
}

// ② 번들 출력 — 소스맵 sources 또는 내용 해시
const pkgOfSource = (abs) => {
  const m = abs.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//)
  if (!m) return null
  const pj = path.join(m[1], 'package.json')
  if (!fs.existsSync(pj)) return null
  const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'))
  return { name: pkg.name, version: pkg.version }
}
const outFiles = [...asar.entries.keys()].filter((p) => p.startsWith('out/'))
const unmapped = []
let mappedSources = 0
for (const p of outFiles) {
  const body = asar.read(p)
  const built = path.join(buildDir, p)
  if (/\.(js|cjs|mjs)$/.test(p) && fs.existsSync(`${built}.map`)) {
    // 빌드 트리 파일이 앱 안 파일과 바이트가 같아야 그 소스맵을 믿는다 — 다른 빌드의 소스맵으로 대조하지 않는다
    if (sha256(fs.readFileSync(built)) !== sha256(body)) { bad(`빌드 트리의 ${p} 가 앱 안 파일과 다르다 — --build 가 이 앱의 빌드가 아니다`); continue } // # guard:nv-tie
    const map = JSON.parse(fs.readFileSync(`${built}.map`, 'utf8'))
    for (const s of map.sources) {
      const abs = path.resolve(path.dirname(built), map.sourceRoot ?? '', s)
      mappedSources++
      const pkg = pkgOfSource(abs)
      if (pkg) seeNpm(pkg.name, pkg.version, `sourcemap:${p}`)
    }
  } else unmapped.push({ p, body })
}
// 소스맵 없는 파일 — 같은 크기 파일만 해시해 node_modules·src 에서 출처를 찾는다
const sizes = new Set(unmapped.map((u) => u.body.length))
const index = new Map()
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) walk(f)
    else if (e.isFile() && sizes.has(fs.statSync(f).size)) {
      const h = sha256(fs.readFileSync(f))
      if (!index.has(h)) index.set(h, [])
      index.get(h).push(f)
    }
  }
}
walk(path.join(buildDir, 'node_modules'))
walk(path.join(buildDir, 'src'))
const ownAssets = path.join(buildDir, 'src/renderer/src/assets')
const vendoredOf = (f) => {
  const rel = path.relative(ownAssets, f)
  if (rel.startsWith('..')) return null
  return { seti: 'Seti file icons (VS Code theme-seti)', codicons: '@vscode/codicons (font)', textmate: 'VS Code TextMate grammars and theme', fonts: 'Geist (font)' }[rel.split('/')[0]] ?? 'own'
}
for (const { p, body } of unmapped) {
  const hits = index.get(sha256(body)) ?? []
  const fromPkg = hits.map(pkgOfSource).find(Boolean)
  if (fromPkg) { seeNpm(fromPkg.name, fromPkg.version, `hash:${p}`); continue }
  const v = hits.map(vendoredOf).find(Boolean)
  if (v && v !== 'own') { if (!has('asset', v)) bad(`반입 자산 고지가 없다: ${v} (${p})`); continue }
  if (v === 'own') { notes.push(`앱 자체 파일: ${p}`); continue }
  // 번들러가 만든 CSS 는 소스맵이 없어 출처를 못 가린다 — 공백으로 보고한다(같은 패키지가 JS 로도 들어와 ②에서 보인다)
  if (p.endsWith('.css')) { notes.push(`출처 대조 공백(생성 CSS, 소스맵 없음): ${p}`); continue }
  if (p === 'out/renderer/index.html' || p.endsWith('/README.md')) { notes.push(`앱 자체 파일: ${p}`); continue }
  bad(`출처를 못 찾은 번들 파일: ${p}`) // # guard:nv-unmapped
}
asar.close()
for (const [k, where] of npmSeen) {
  const at = k.lastIndexOf('@')
  if (!has('npm', k.slice(0, at), k.slice(at + 1))) bad(`npm 고지 누락: ${k} (${where})`) // # guard:nv-npm
}
if (mappedSources === 0) bad('소스맵 sources 를 하나도 못 읽었다 — 대조 불가(빌드 트리에 숨은 소스맵이 없다)') // # guard:nv-nomap

// ③ 동봉 herdr
const herdr = path.join(res, 'backend/herdr')
const bin = fs.readFileSync(herdr)
const strings = bin.toString('latin1')
const crateSeen = new Set()
for (const m of strings.matchAll(/\/registry\/src\/[^/]+\/([A-Za-z0-9_.+-]+?)-(\d+\.\d+\.\d+[A-Za-z0-9.+-]*)\//g)) crateSeen.add(`${m[1]}@${m[2]}`)
for (const k of crateSeen) {
  const at = k.lastIndexOf('@')
  if (!has('crate', k.slice(0, at), k.slice(at + 1))) bad(`crate 고지 누락: ${k} (herdr 문자열의 소스 경로)`) // # guard:nv-crate
}
const syms = execFileSync('nm', ['-j', herdr], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n')
const crateNames = new Set(comps.filter((c) => c.kind === 'crate').map((c) => c.name.replace(/-/g, '_')))
// Rust 표준 라이브러리 crate — 고지는 「Rust standard library」 한 건(rustup 툴체인 lib/rustlib 의 rlib 이름)
const STD = new Set(['core', 'alloc', 'std', 'std_detect', 'compiler_builtins', 'panic_unwind', 'panic_abort', 'unwind', 'addr2line', 'gimli', 'object', 'miniz_oxide', 'adler2', 'hashbrown', 'memchr', 'rustc_demangle', 'cfg_if', 'libc', 'getopts', 'test', 'proc_macro', 'sysroot'])
const CPP_NS = { ghostty: 'libghostty-vt (Ghostty)', simdutf: 'simdutf', hwy: 'highway' }
const symCrates = new Set()
for (const s of syms) {
  const legacy = s.match(/^__ZN(\d+)([A-Za-z_][A-Za-z0-9_]*)/)
  if (legacy && legacy[2].length >= Number(legacy[1])) symCrates.add(legacy[2].slice(0, Number(legacy[1])))
  for (const v0 of s.matchAll(/C(?:s[A-Za-z0-9]*_)?(\d+)([a-z_][a-z0-9_]*)/g)) if (v0[2].length >= Number(v0[1])) symCrates.add(v0[2].slice(0, Number(v0[1])))
}
let symHits = 0
for (const name of symCrates) {
  if (!/^[a-z][a-z0-9_]*$/.test(name) || name === 'herdr') continue
  if (STD.has(name)) { symHits++; if (!has('native', 'Rust standard library')) bad(`Rust 표준 라이브러리 고지 누락 (심볼 ${name})`); continue }
  if (crateNames.has(name)) { symHits++; continue }
  // 같은 꼴(Itanium)로 맹글된 C++ 네임스페이스 — libghostty-vt 의 C++ 코드와 SIMD 의존
  if (CPP_NS[name]) { if (!has('native', CPP_NS[name])) bad(`비-Rust 고지 누락: ${CPP_NS[name]} (herdr 심볼 ${name}::)`); continue }
  // v0 꼴 매칭은 crate 가 아닌 경로 조각도 잡는다 — 레지스트리 경로·legacy 심볼로 본 crate 만 누락으로 센다
  if ([...syms].some((s) => s.startsWith(`__ZN${name.length}${name}`))) bad(`crate 고지 누락: ${name} (herdr 심볼)`) // # guard:nv-sym
}
if (symHits === 0 || crateSeen.size === 0) bad('herdr 에서 crate 표지(심볼·소스 경로)를 못 읽었다 — 대조 불가') // # guard:nv-nosym
const MARKERS = [
  ['libghostty-vt (Ghostty)', (s) => s.startsWith('_ghostty_')],
  ['simdutf', (s) => s.includes('7simdutf')],
  ['highway', (s) => s.includes('3hwy')],
  ['Zig standard library and compiler-rt', (s) => /^_?(Io\.Writer|debug\.Dwarf)/.test(s)],
]
for (const [name, test] of MARKERS) {
  if (syms.some(test) && !has('native', name)) bad(`비-Rust 고지 누락: ${name} (herdr 심볼)`) // # guard:nv-native
}

// ④ Electron
const fw = path.join(appBundle, 'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist')
if (fs.existsSync(fw)) {
  const plist = fs.readFileSync(fw, 'utf8')
  const ver = plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
  if (!has('electron', 'Electron', ver)) bad(`Electron 고지 누락·버전 다름: Electron Framework ${ver}`) // # guard:nv-electron
  if (!has('electron', 'Chromium and its third-party components (in Electron)', ver)) bad(`Chromium 고지 누락·버전 다름: ${ver}`)
} else bad('Electron Framework 가 없다 — corral.app 경로를 확인한다')

const summary = [
  `고지 ${comps.length}건 · asar/소스맵/해시로 본 npm ${npmSeen.size} · 소스맵 sources ${mappedSources} · herdr 경로 crate ${crateSeen.size} · 심볼 crate ${symHits}`,
  ...notes.map((n) => `· ${n}`),
  ...problems.map((p) => `✖ ${p}`),
  problems.length ? `✖ 고지 대조 실패 ${problems.length}건` : '✔ 고지 대조 통과 — 앱 안에서 본 것 ⊆ 고지 목록',
].join('\n')
if (reportFile) fs.writeFileSync(reportFile, summary + '\n')
console.log(summary)
process.exit(problems.length ? 1 : 0)
