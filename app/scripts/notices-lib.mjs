// LIFE-729 C9 — 제3자 고지 공용 함수. dmg 쪽(`build-notices.mjs`·`verify-notices.mjs`)과 APK 쪽(`mobile/scripts/*-notices.mjs`)이 같이 쓴다.
// 고지 한 건 = { kind, name, version, license, source, texts: [{ file, text }], textFrom: 'package' | 'spdx', copyright? }
//   textFrom 'package' = 패키지 안 LICENSE·COPYING·NOTICE 파일 원문. 'spdx' = 패키지에 파일이 없어 `spdx/<id>.txt` 표준 원문 + copyright(메타데이터의 저작권자 출처).
//   원문을 어느 쪽으로도 못 만든 건은 texts 가 비고 missingReason 이 붙는다 — 생성기는 그 목록을 따로 내고, 대조기는 빈 원문을 실패로 센다.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const here = path.dirname(new URL(import.meta.url).pathname)
export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// 패키지 폴더 맨 위의 라이선스 파일 — LICENSE·LICENCE·COPYING·NOTICE·UNLICENSE·COPYRIGHT 로 시작하는 파일(대소문자 무시, 폴더 제외)
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright|thirdpartynotices)/i
export function licenseFiles(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => LICENSE_FILE.test(name) && fs.statSync(path.join(dir, name)).isFile())
    .sort()
    .map((file) => ({ file, text: fs.readFileSync(path.join(dir, file), 'utf8') }))
}

// SPDX 식 안의 id — 괄호·AND·OR·WITH 를 걷어낸다. 옛 cargo 꼴 「MIT/Apache-2.0」 도 나눈다
export function spdxIds(expr) {
  return [...new Set(String(expr ?? '').split(/[\s()/]+/).filter((t) => t && !/^(AND|OR|WITH)$/i.test(t)))]
}

export function spdxText(id) {
  const file = path.join(here, 'spdx', `${id}.txt`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

// 패키지 파일이 있으면 그 원문, 없으면 SPDX 표준 원문 + 저작권 줄 출처. 둘 다 안 되면 missingReason
export function resolveTexts({ dir, license, copyright }) {
  const own = licenseFiles(dir)
  if (own.length) return { texts: own, textFrom: 'package' }
  const ids = spdxIds(license)
  const texts = ids.map((id) => ({ file: `SPDX:${id}`, text: spdxText(id) }))
  const lacking = texts.filter((t) => t.text === null).map((t) => t.file.slice(5))
  if (!ids.length) return { texts: [], textFrom: 'spdx', copyright, missingReason: '패키지에 라이선스 파일도 라이선스 식도 없다' }
  if (lacking.length) return { texts: [], textFrom: 'spdx', copyright, missingReason: `패키지에 라이선스 파일이 없고 SPDX 원문이 레포에 없다: ${lacking.join(', ')}` }
  return { texts, textFrom: 'spdx', copyright: copyright || '저작권자 표기 없음 — 패키지 메타데이터(author·authors)가 비었다. 출처는 source 줄' }
}

export const key = (c) => `${c.kind}:${c.name}@${c.version}`

// 고지 원문 — 사람이 읽는 한 파일. 건마다 머리줄(이름·버전·라이선스·출처) 뒤에 원문
export function renderText(title, components) {
  const out = [title, '', `${components.length} components. Each entry: name, version, license, source, then the license text.`, '']
  for (const c of components) {
    out.push('='.repeat(78), `${c.name} ${c.version}`, `License: ${c.license ?? 'UNKNOWN'}`, `Source: ${c.source ?? '-'}`)
    if (c.copyright) out.push(`Copyright: ${c.copyright}`)
    if (c.textFrom === 'spdx' && c.texts.length) out.push('(No license file in the package — SPDX standard text below.)')
    if (c.missingReason) out.push(`(License text not found: ${c.missingReason})`)
    out.push('')
    for (const t of c.texts) out.push(`--- ${t.file} ---`, t.text.trimEnd(), '')
  }
  return out.join('\n') + '\n'
}

// 기계용 목록 — 원문 대신 sha256. 대조기가 읽는다
export function renderJson(meta, components) {
  return (
    JSON.stringify(
      {
        ...meta,
        components: components.map(({ texts, ...c }) => ({ ...c, texts: texts.map((t) => ({ file: t.file, sha256: sha256(t.text) })) })),
      },
      null,
      1,
    ) + '\n'
  )
}

// npm 패키지 한 건 — 폴더의 package.json 에서
export function npmComponent(kind, dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : null)
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const source = repo ?? pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`
  return { kind, name: pkg.name, version: pkg.version, license, source, ...resolveTexts({ dir, license, copyright: author ? `${author} (package.json author)` : '' }) }
}

// 모듈 파일 경로 → 그 파일이 든 npm 패키지 폴더(마지막 node_modules/<이름> 또는 node_modules/@범위/<이름>). node_modules 밖이면 null
export function packageDirOf(file) {
  const m = file.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/)
  return m ? m[1] : null
}

// 패키지 폴더 안에서 가장 가까운 package.json 이 name 을 가진 곳 — 하위 폴더 package.json({ "type": "module" } 따위)은 건너뛴다
export function packageRootOf(file) {
  const dir = packageDirOf(file)
  return dir && fs.existsSync(path.join(dir, 'package.json')) ? dir : null
}

// asar 읽기 — 형식: [4 크기][4 헤더 크기][4][4 JSON 길이][JSON] 뒤가 파일 본문. 의존 패키지 없이 목록·본문만 꺼낸다
export function readAsar(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonSize)
  fs.readSync(fd, json, 0, jsonSize, 16)
  const header = JSON.parse(json.toString('utf8'))
  const base = 8 + headerSize
  const entries = new Map()
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, p)
      else entries.set(p, child)
    }
  }
  walk(header, '')
  const read = (p) => {
    const e = entries.get(p)
    if (!e) return null
    if (e.unpacked) return fs.readFileSync(path.join(`${file}.unpacked`, p))
    const buf = Buffer.alloc(Number(e.size))
    fs.readSync(fd, buf, 0, buf.length, base + Number(e.offset))
    return buf
  }
  return { entries, read, close: () => fs.closeSync(fd) }
}
