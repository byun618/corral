// LIFE-591 사본(l590 → l591 루트만 바꿈)
// LIFE-590 fixture 레포 — 파일 탭·뷰어 확인용(사용자 파일 아님). corral·VS Code 나란히 캡처가 **같은 폴더·같은 파일**을 연다.
// 사용: node scripts/l591/fixture.mjs <대상 폴더 /tmp/l591*>   (이미 있으면 지우고 다시 만든다 — /tmp/l591 접두사만)
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import zlib from 'node:zlib'

const target = process.argv[2]
if (target === undefined || !/^\/tmp\/l591[^/]*\/repo$|^\/tmp\/l591[^/]*$/.test(target)) throw new Error(`대상은 /tmp/l591* 여야 한다: ${target}`)
fs.rmSync(target, { recursive: true, force: true })
const write = (rel, content) => {
  fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true })
  fs.writeFileSync(path.join(target, rel), content)
}
write('src/sample.ts', `// 파일 탭 첫 화면 — TypeScript 샘플 (LIFE-590 fixture)
import { readFile } from 'node:fs/promises'

export interface Tab {
  readonly id: string
  kind: 'terminal' | 'file'
  preview?: boolean
}

/** 미리보기 탭은 영역당 하나다. */
export class TabGroup<T extends Tab = Tab> {
  private readonly tabs: T[] = []
  static readonly LIMIT = 42

  constructor(public groupId: string, private activeId: string | null = null) {}

  open(tab: T): number {
    const index = this.tabs.findIndex((item) => item.id === tab.id)
    if (index >= 0) return index
    this.tabs.push(tab)
    return this.tabs.length - 1
  }

  get size(): number {
    return this.tabs.length
  }
}

export async function load(path: string): Promise<string> {
  const text = await readFile(path, 'utf8')
  const pattern = /^file:(.+)$/u
  return \`\${text.length} bytes — \${pattern.test(path) ? 'file' : 'terminal'}\`
}

const enabled = true && !false
export default { load, enabled, ratio: 0.5, hex: 0xff }
`)
write('README.md', `# fixture

파일 탭 확인용 레포. **굵게** · _기울임_ · \`code\`.

- 목록 하나
- [링크](https://example.invalid)

\`\`\`ts
const answer: number = 42
\`\`\`
`)
write('empty.txt', '')
write('notes/plain.txt', '확장자가 txt 인 일반 텍스트.\nline 2\n')
write('data.bin', Buffer.concat([Buffer.from('BIN'), Buffer.from([0, 1, 2, 3]), Buffer.alloc(64, 7)]))
write('config/settings.json', `{
  "name": "fixture",
  "version": 2,
  "enabled": true,
  "ratio": 0.5,
  "tags": ["a", "b"],
  "nested": { "key": null }
}
`)
// E4ⓓⓔ — Markdown 악성 fixture·이미지(작은 PNG·GIF·SVG 정상/악성). 레포 밖 파일은 `..` 탈출 대조용(대상 폴더의 부모에 둔다).
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
/** w×h RGB PNG — 왼쪽 위 빨강·나머지 파랑(그려졌는지 픽셀로 본다). */
const png = (w, h) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w, 0)
  header.writeUInt32BE(h, 4)
  header[8] = 8
  header[9] = 2
  const rows = []
  for (let y = 0; y < h; y += 1) {
    rows.push(Buffer.from([0]))
    for (let x = 0; x < w; x += 1) rows.push(x < w / 2 && y < h / 2 ? Buffer.from([255, 0, 0]) : Buffer.from([0, 0, 255]))
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}
write('img/pixel.png', png(64, 48))
// 1×1 GIF(투명) — 공개 최소 GIF 바이트.
write('img/dot.gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
write('img/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect width="120" height="60" fill="#3794ff"/><circle cx="30" cy="30" r="20" fill="#ffd700"/></svg>\n')
write(
  'img/evil.svg',
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100" onload="window.__pwned=11">' +
    '<script>window.__pwned=12</script><rect width="100" height="100" fill="green" onclick="window.__pwned=13"/>' +
    '<foreignObject width="100" height="100"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.__pwned=14"/></body></foreignObject>' +
    '<image href="https://example.invalid/remote.png" width="10" height="10"/><a href="javascript:window.__pwned=15"><text y="50">a</text></a></svg>\n',
)
write(
  'docs/evil.md',
  [
    '# 악성 fixture',
    '<script>window.__pwned = 1</script>',
    '<img src="../img/pixel.png" onerror="window.__pwned = 2">',
    '[스크립트 링크](javascript:window.__pwned=3)',
    '<a href="javascript:alert(1)" onclick="window.__pwned=4">onclick 링크</a>',
    '<iframe src="https://example.invalid"></iframe>',
    '<form action="https://example.invalid"><input name="q"></form>',
    '<svg><script>window.__pwned=5</script></svg>',
    '<div style="background:url(https://example.invalid/t.png)">style</div>',
    '## 이미지',
    '로컬 ![로컬 PNG](../img/pixel.png) · SVG ![로고](../img/logo.svg) · 원격 ![원격](https://example.invalid/r.png) · 탈출 ![밖](../../outside.png)',
    '## 링크',
    '[외부](https://example.com) · [상대 파일](../src/sample.ts) · [조각](#이미지)',
    '',
  ].join('\n\n'),
)
fs.writeFileSync(path.join(path.dirname(target), 'outside.png'), png(8, 8))
// E4ⓑ 언어별 샘플 — 한 화면(800px 창, 줄 18px)에 다 들어오게 30 줄 안. 문법이 갈리는 구문(템플릿·정규식·JSX·주석·문자열 이스케이프)을 섞는다.
write('samples/app.tsx', `import React, { useState } from 'react'

type Props = { title: string; count?: number }

/** 카운터 — JSX 안 식·속성·문자열 */
export function Counter({ title, count = 0 }: Props): React.JSX.Element {
  const [value, setValue] = useState<number>(count)
  const label = \`\${title}: \${value > 9 ? '많음' : value}\`
  return (
    <div className="counter" data-count={value} onClick={() => setValue(value + 1)}>
      <h2 style={{ color: 'red' }}>{label}</h2>
      {value % 2 === 0 ? <span>짝수</span> : null}
    </div>
  )
}
`)
write('samples/util.js', `'use strict'
// JavaScript — 정규식·클래스·화살표·async
const RE = /^(?<name>[a-z]+)-(\\d{2,})$/giu
export class Store extends Map {
  #secret = 42
  static of(entries) { return new Store(entries) }
  get size2() { return this.size * 2 }
}
export const parse = async (text, { strict = false } = {}) => {
  const match = RE.exec(text)
  if (!match && strict) throw new TypeError(\`bad: \${text}\`)
  return match?.groups?.name ?? null
}
console.log(parse('abc-12'), 0x1f, 1e-3, null, undefined, NaN)
`)
write('samples/style.css', `/* CSS — 선택자·속성·단위·변수·미디어 쿼리 */
:root { --accent: #3794ff; --gap: 8px; }
.card > h2::before,
.card:hover a[href^="https"] {
  color: var(--accent);
  margin: calc(var(--gap) * 2) 0 !important;
  font: 600 14px/1.4 "JetBrains Mono", monospace;
  background: url("img/x.png") no-repeat, linear-gradient(90deg, rgba(0, 0, 0, 0.5), transparent);
}
@media (max-width: 600px) {
  #main .item { display: none; transition: opacity 120ms ease-in-out; }
}
@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
`)
write('samples/page.html', `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>샘플 &amp; 페이지</title>
  <style>body { margin: 0; color: #333; }</style>
</head>
<body class="main" data-x='1'>
  <!-- HTML 주석 -->
  <a href="https://example.com" target="_blank">링크</a>
  <input type="checkbox" checked disabled>
  <script>
    const n = 1 + 2
    document.title = \`n=\${n}\`
  </script>
</body>
</html>
`)
write('samples/config.yaml', `# YAML — 맵·목록·앵커·여러 줄
name: corral
version: 0.2.2
enabled: true
ratio: 0.5
nothing: null
tags: [a, "b", 'c']
defaults: &defaults
  retries: 3
  timeout: 10s
service:
  <<: *defaults
  command: |
    echo "hello"
    exit 0
  env:
    - KEY=value
    - OTHER=\${HOME}
`)
write('samples/run.sh', `#!/usr/bin/env bash
# Shell — 변수·치환·조건·함수·here-doc
set -euo pipefail
NAME="\${1:-world}"
count=$(ls -1 | wc -l)
greet() {
  local who="$1"
  echo "hello, \${who}! ($count files)"
}
if [[ -n "$NAME" && $count -gt 0 ]]; then
  greet "$NAME" >&2
else
  for f in *.txt; do printf '%s\\n' "$f"; done
fi
cat <<EOF2
done: $NAME
EOF2
`)
write('samples/tool.py', `#!/usr/bin/env python3
"""Python — 데코레이터·f-string·타입 힌트·클래스"""
from dataclasses import dataclass
import re

PATTERN = re.compile(r"^(\\w+)-(\\d+)$")


@dataclass(frozen=True)
class Item:
    name: str
    count: int = 0

    def label(self) -> str:
        return f"{self.name}: {self.count:>3} {'많음' if self.count > 9 else ''}"


def parse(text: str) -> Item | None:
    m = PATTERN.match(text)
    return Item(m.group(1), int(m.group(2))) if m else None


if __name__ == "__main__":
    print(parse("abc-12"), 0x1F, 1e-3, None, True, b"bytes")
`)
// LIFE-591 수정 r1 회귀(`r1-cases.mjs`) — 폴더 하나에 모은다(다른 측정의 루트 행 수를 바꾸지 않게).
write('r1/race.txt', 'base')
write('r1/del.txt', 'survive\n')
write('r1/doc.md', '# initial\n')
write('r1/grow.txt', 'initial\n')
write('r1/edit.txt', 'alpha\nbeta\ngamma\n')
write('r1/bom.txt', Buffer.from('efbbbfefbbbf616c7068610a', 'hex'))
execFileSync('git', ['init', '-q', '-b', 'main', target])
execFileSync('git', ['-C', target, 'add', '-A'])
execFileSync('git', ['-C', target, '-c', 'user.name=l590', '-c', 'user.email=l590@example.invalid', 'commit', '-q', '-m', 'fixture'])
// E7ⓑ ④ — worktree 안 링크가 밖을 가리킨다(커밋하지 않는다).
fs.symlinkSync(path.join(path.dirname(target), 'outside.png'), path.join(target, 'escape-link.png'))
// E4ⓕⓖ 대용량 — 커밋하지 않는다(untracked). 줄 120자 텍스트.
const line = `${'0123456789abcdef'.repeat(7)}0123456\n`
const big = (rel, bytes) => {
  const block = Buffer.from(line.repeat(Math.ceil(1024 * 1024 / line.length)))
  const out = fs.openSync(path.join(target, rel), 'w')
  for (let written = 0; written < bytes; written += block.length) fs.writeSync(out, block, 0, Math.min(block.length, bytes - written))
  fs.closeSync(out)
}
fs.mkdirSync(path.join(target, 'big'), { recursive: true })
big('big/1mb.txt', 1024 * 1024)
big('big/10mb.txt', 10 * 1024 * 1024)
big('big/25mb.log', 25 * 1024 * 1024)
big('big/60mb.txt', 60 * 1024 * 1024)
console.log(JSON.stringify({ target, files: execFileSync('git', ['-C', target, 'ls-files'], { encoding: 'utf8' }).trim().split('\n') }))
