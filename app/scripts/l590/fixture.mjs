// LIFE-590 fixture 레포 — 파일 탭·뷰어 확인용(사용자 파일 아님). corral·VS Code 나란히 캡처가 **같은 폴더·같은 파일**을 연다.
// 사용: node scripts/l590/fixture.mjs <대상 폴더 /tmp/l590*>   (이미 있으면 지우고 다시 만든다 — /tmp/l590 접두사만)
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const target = process.argv[2]
if (target === undefined || !/^\/tmp\/l590[^/]*\/repo$|^\/tmp\/l590[^/]*$/.test(target)) throw new Error(`대상은 /tmp/l590* 여야 한다: ${target}`)
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
execFileSync('git', ['init', '-q', '-b', 'main', target])
execFileSync('git', ['-C', target, 'add', '-A'])
execFileSync('git', ['-C', target, '-c', 'user.name=l590', '-c', 'user.email=l590@example.invalid', 'commit', '-q', '-m', 'fixture'])
console.log(JSON.stringify({ target, files: execFileSync('git', ['-C', target, 'ls-files'], { encoding: 'utf8' }).trim().split('\n') }))
