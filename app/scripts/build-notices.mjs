// LIFE-729 C9 — dmg 제3자 고지를 `build/notices/` 에 만든다. `npm run package:mac` 이 bundle-herdr 뒤·electron-builder 앞에 부르고,
// electron-builder 가 `Contents/Resources/licenses/third-party/` 로 싣는다. 끝나면 `verify-notices.mjs` 가 만든 앱 쪽에서 따로 대조한다.
//
// 입력(이 빌드의 실물만 본다):
//   - 동봉 herdr: CORRAL_BACKEND_BUILD_ROOT 의 release 영수증·`herdr.metadata.json`(build-terminal-backend.sh 가 같은 빌드에서 쓴 cargo metadata).
//     런타임 의존 = 루트에서 normal 의존만 따라간 crate(build 의존·proc-macro 제외). 비-Rust 정적 코드는 libghostty-vt 빌드 입력(build.zig.zon)에서.
//   - Electron: node_modules/electron/dist 의 LICENSE·LICENSES.chromium.html.
//   - npm: ① 번들러가 실제로 읽은 모듈(build/notices-input/*.json — electron.vite.config.ts·build-runtime.mjs 가 쓴다)이 든 패키지
//          ② asar 의 node_modules = package-lock 의 dev 아닌 패키지(electron-builder 가 싣는 production 의존)
//   - 앱에 파일로 반입한 자산(Seti·codicons·TextMate·Geist) — 고지 원문이 레포에 있다.
// 출력: THIRD-PARTY-NOTICES.txt(원문) · third-party.json(목록·원문 sha256) · electron/{LICENSE,LICENSES.chromium.html}.
// 원문을 못 찾은 건은 고지에 「License text not found」 로 남기고 stderr 에 목록을 낸다(exit 0 — 대조기가 빈 원문을 실패로 센다).
import fs from 'node:fs'
import path from 'node:path'
import { key, npmComponent, packageRootOf, renderJson, renderText, resolveTexts, licenseFiles, spdxText, sha256 } from './notices-lib.mjs'

const app = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const fail = (message) => {
  console.error(`build-notices: ${message}`)
  process.exit(1)
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

// ── 동봉 herdr ──
const work = process.env.CORRAL_BACKEND_BUILD_ROOT
if (!work) fail('CORRAL_BACKEND_BUILD_ROOT 가 필요하다 — bundle-herdr.mjs 와 같은 build root')
const tree = path.join(work, 'herdr-0.9.0')
const binary = path.join(tree, 'target/release/herdr')
let receipt
try {
  receipt = readJson(`${binary}.json`)
} catch {
  fail('release 영수증(target/release/herdr.json)이 없다')
}
const bundled = readJson(path.join(app, 'build/backend/herdr.json'))
if (bundled.buildBinarySHA256 !== receipt.binarySHA256) fail('build/backend 의 herdr 가 이 build root 의 빌드가 아니다 — bundle-herdr.mjs 를 먼저 돌린다')
const metaFile = `${binary}.metadata.json`
if (!fs.existsSync(metaFile) || !receipt.metadataSHA256) fail('herdr.metadata.json 이 없다 — 이 build root 는 고지 입력을 쓰기 전 빌드다. 새 build root 로 다시 빌드한다')
if (sha256(fs.readFileSync(metaFile)) !== receipt.metadataSHA256) fail('herdr.metadata.json 이 영수증의 sha256 과 다르다')
const meta = readJson(metaFile)
const tools = receipt.toolchainRoot
const pkgs = new Map(meta.packages.map((p) => [p.id, p]))
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
const isProcMacro = (p) => p.targets.some((t) => t.kind.includes('proc-macro'))
const runtime = new Set()
const queue = [meta.resolve.root]
while (queue.length) {
  const id = queue.pop()
  if (runtime.has(id)) continue
  runtime.add(id)
  for (const dep of nodes.get(id).deps) {
    if (!dep.dep_kinds.some((k) => k.kind === null)) continue // build·dev 의존은 링크되지 않는다
    if (isProcMacro(pkgs.get(dep.pkg))) continue // proc-macro 는 컴파일러 안에서만 돈다
    queue.push(dep.pkg)
  }
}
runtime.delete(meta.resolve.root) // herdr 자신은 backend/LICENSE-herdr·NOTICE-herdr.md
const crates = [...runtime].map((id) => {
  const p = pkgs.get(id)
  const copyright = p.authors?.length ? `${p.authors.join(', ')} (Cargo.toml authors)` : ''
  return { kind: 'crate', name: p.name, version: p.version, license: p.license ?? null, source: p.repository ?? `https://crates.io/crates/${p.name}`, ...resolveTexts({ dir: path.dirname(p.manifest_path), license: p.license, copyright }) }
})

// 비-Rust 정적 코드 — libghostty-vt(Zig) 와 그 SIMD·유니코드 의존, Zig 표준 라이브러리·compiler-rt, Rust 표준 라이브러리
const vt = path.join(tree, 'vendor/libghostty-vt')
const zonHash = (file, dep) => {
  const m = fs.readFileSync(file, 'utf8').match(new RegExp(`\\.${dep} = \\.\\{[^}]*?\\.hash = "([^"]+)"`, 's'))
  if (!m) fail(`${path.relative(tree, file)} 에서 ${dep} 의 hash 를 못 찾았다 — libghostty-vt 빌드 입력이 바뀌었다`)
  return path.join(tools, 'zig-cache/p', m[1])
}
const mustDir = (dir, what) => (fs.existsSync(dir) ? dir : fail(`${what} 자리가 없다: ${dir}`))
const vendorJson = readJson(path.join(tree, 'vendor/libghostty-vt.vendor.json'))
const simdutfHeader = fs.readFileSync(path.join(vt, 'pkg/simdutf/vendor/simdutf.h'), 'utf8')
const simdutfVersion = simdutfHeader.match(/#define SIMDUTF_VERSION "([^"]+)"/)?.[1] ?? fail('simdutf.h 에 SIMDUTF_VERSION 이 없다')
// simdutf 묶음 파일 안에 든 다른 저작권 고지(isadetection.h — pytorch 유래 BSD-3) 를 원문 그대로
const isaNotice = simdutfHeader.match(/\/\* begin file include\/simdutf\/internal\/isadetection\.h \*\/\n\/\*([\s\S]*?)\*\//)?.[1] ?? fail('simdutf.h 의 isadetection.h 고지 주석을 못 찾았다')
const spdx = (id) => ({ file: `SPDX:${id}`, text: spdxText(id) ?? fail(`spdx/${id}.txt 가 없다`) })
const highwayDir = mustDir(zonHash(path.join(vt, 'pkg/highway/build.zig.zon'), 'highway'), 'highway')
const uucodeDir = mustDir(zonHash(path.join(vt, 'build.zig.zon'), 'uucode'), 'uucode')
const zigDir = mustDir(path.join(tools, 'zig-aarch64-macos-0.15.2'), 'zig')
const rustDoc = mustDir(path.join(tools, 'rustup/toolchains/1.96.1-aarch64-apple-darwin/share/doc/rust'), 'Rust 1.96.1 문서')
const zonVersion = (file) => fs.readFileSync(file, 'utf8').match(/\.version = "([^"]+)"/)?.[1]
const native = [
  { kind: 'native', name: 'libghostty-vt (Ghostty)', version: `${zonVersion(path.join(vt, 'build.zig.zon'))} (${vendorJson.source_commit.slice(0, 9)})`, license: 'MIT', source: 'https://github.com/ghostty-org/ghostty', texts: licenseFiles(vt), textFrom: 'package' },
  { kind: 'native', name: 'simdutf', version: simdutfVersion, license: 'Apache-2.0 OR MIT', source: 'https://github.com/simdutf/simdutf', copyright: 'The simdutf authors — upstream LICENSE-MIT/LICENSE-APACHE are not in the vendored amalgamation (source line)', texts: [spdx('Apache-2.0'), spdx('MIT'), { file: 'simdutf.h (include/simdutf/internal/isadetection.h notice)', text: isaNotice.trim() }], textFrom: 'spdx' },
  { kind: 'native', name: 'highway', version: zonVersion(path.join(vt, 'pkg/highway/build.zig.zon')), license: 'Apache-2.0 OR BSD-3-Clause', source: 'https://github.com/google/highway', texts: licenseFiles(highwayDir), textFrom: 'package' },
  { kind: 'native', name: 'uucode (with Unicode Character Database)', version: path.basename(uucodeDir).split('-')[1], license: 'MIT AND Unicode-3.0', source: 'https://github.com/jacobsandlund/uucode', texts: licenseFiles(uucodeDir), textFrom: 'package' },
  { kind: 'native', name: 'Zig standard library and compiler-rt', version: '0.15.2', license: 'MIT', source: 'https://ziglang.org', texts: licenseFiles(zigDir), textFrom: 'package' },
  {
    kind: 'native',
    name: 'Rust standard library',
    version: '1.96.1',
    license: 'MIT OR Apache-2.0',
    source: 'https://github.com/rust-lang/rust',
    texts: [
      { file: 'COPYRIGHT-library.html', text: fs.readFileSync(path.join(rustDoc, 'COPYRIGHT-library.html'), 'utf8') },
      ...['Apache-2.0.txt', 'MIT.txt'].map((f) => ({ file: `licenses/${f}`, text: fs.readFileSync(path.join(rustDoc, 'licenses', f), 'utf8') })),
    ],
    textFrom: 'package',
  },
]
for (const c of native) if (!c.texts.length) fail(`${c.name} 의 라이선스 파일이 없다`)

// ── Electron·Chromium ──
const electronDist = path.join(app, 'node_modules/electron/dist')
const electronVersion = readJson(path.join(app, 'node_modules/electron/package.json')).version
const chromiumHtml = fs.readFileSync(path.join(electronDist, 'LICENSES.chromium.html'))
const electron = [
  { kind: 'electron', name: 'Electron', version: electronVersion, license: 'MIT', source: 'https://github.com/electron/electron', texts: [{ file: 'electron/LICENSE', text: fs.readFileSync(path.join(electronDist, 'LICENSE'), 'utf8') }], textFrom: 'package' },
  // 원문이 20MB HTML 이라 원문 파일을 그대로 싣고 TXT 에는 자리만 적는다 — third-party.json 의 sha256 은 그 파일 전체
  { kind: 'electron', name: 'Chromium and its third-party components (in Electron)', version: electronVersion, license: 'BSD-3-Clause AND others (see file)', source: 'https://github.com/electron/electron', texts: [{ file: 'electron/LICENSES.chromium.html', text: chromiumHtml.toString('utf8'), external: true }], textFrom: 'package' },
]

// ── npm ──
const npm = new Map()
const addNpm = (dir, via) => {
  const c = npmComponent('npm', dir)
  const k = key(c)
  if (!npm.has(k)) npm.set(k, { ...c, via: [] })
  if (!npm.get(k).via.includes(via)) npm.get(k).via.push(via)
}
const inputDir = path.join(app, 'build/notices-input')
for (const target of ['main', 'preload', 'renderer', 'renderer-worker', 'runtime']) {
  const file = path.join(inputDir, `${target}.json`)
  if (!fs.existsSync(file)) fail(`${path.relative(app, file)} 이 없다 — npm run build 가 쓴다(번들 모듈 목록)`)
  for (const id of readJson(file)) {
    const abs = path.resolve(app, id.replace(/^\0/, '').replace(/\?.*$/, ''))
    const dir = packageRootOf(abs)
    if (dir) addNpm(dir, `bundle:${target}`)
  }
}
const lock = readJson(path.join(app, 'package-lock.json'))
for (const [p, entry] of Object.entries(lock.packages)) {
  if (!p.startsWith('node_modules/') || entry.dev || entry.link) continue
  const dir = path.join(app, p)
  if (fs.existsSync(path.join(dir, 'package.json'))) addNpm(dir, 'asar')
}

// ── 앱에 파일로 반입한 자산 ──
const assets = path.join(app, 'src/renderer/src/assets')
const vendored = [
  { kind: 'asset', name: 'Seti file icons (VS Code theme-seti)', version: 'vscode 1.142.0 (959031245eb)', license: 'MIT', source: 'https://github.com/microsoft/vscode', texts: licenseFiles(path.join(assets, 'seti')).concat([{ file: 'VSCODE-LICENSE.txt', text: fs.readFileSync(path.join(assets, 'seti/VSCODE-LICENSE.txt'), 'utf8') }]), textFrom: 'package' },
  { kind: 'asset', name: '@vscode/codicons (font)', version: '0.0.46-44', license: 'CC-BY-4.0 AND MIT', source: 'https://github.com/microsoft/vscode-codicons', texts: licenseFiles(path.join(assets, 'codicons')), textFrom: 'package' },
  {
    kind: 'asset',
    name: 'VS Code TextMate grammars and theme',
    version: 'vscode 1.142.0 (959031245eb)',
    license: 'MIT AND others (see cgmanifest)',
    source: 'https://github.com/microsoft/vscode',
    texts: fs.readdirSync(path.join(assets, 'textmate/notices')).sort().map((f) => ({ file: `textmate/notices/${f}`, text: fs.readFileSync(path.join(assets, 'textmate/notices', f), 'utf8') })),
    textFrom: 'package',
  },
  { kind: 'asset', name: 'Geist (font)', version: 'Geist-Variable.woff2 sha256 e24cec10', license: 'OFL-1.1', source: 'https://github.com/vercel/geist-font', texts: [{ file: 'Geist-OFL.txt', text: fs.readFileSync(path.join(assets, 'fonts/Geist-OFL.txt'), 'utf8') }], textFrom: 'package' },
]

// ── 쓰기 ──
const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
const components = [...electron, ...native, ...crates.sort(byName), ...[...npm.values()].sort(byName), ...vendored]
const out = path.join(app, 'build/notices')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'electron'), { recursive: true })
fs.copyFileSync(path.join(electronDist, 'LICENSE'), path.join(out, 'electron/LICENSE'))
fs.writeFileSync(path.join(out, 'electron/LICENSES.chromium.html'), chromiumHtml)
const forText = components.map((c) => ({ ...c, texts: c.texts.map((t) => (t.external ? { file: t.file, text: `(full text: licenses/third-party/${t.file})` } : t)) }))
const appVersion = readJson(path.join(app, 'package.json')).version
fs.writeFileSync(path.join(out, 'THIRD-PARTY-NOTICES.txt'), renderText(`corral ${appVersion} (macOS) — third-party notices`, forText))
fs.writeFileSync(path.join(out, 'third-party.json'), renderJson({ target: 'dmg', appVersion, herdrBinarySHA256: receipt.binarySHA256, electronVersion }, components))
const missing = components.filter((c) => c.missingReason)
for (const c of missing) console.error(`build-notices: 원문 없음 ${key(c)} — ${c.missingReason}`)
const count = (k) => components.filter((c) => c.kind === k).length
console.log(`build-notices: build/notices — crate ${count('crate')} · native ${count('native')} · electron ${count('electron')} · npm ${count('npm')} · asset ${count('asset')} · 원문 없음 ${missing.length}`)
