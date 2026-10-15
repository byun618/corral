// LIFE-593 최종 관문 E9ⓑ 무회귀 합성용 사본 — LIFE-592 scripts/l592/ 그대로, 루트만 /tmp/l593g-*(G5) · 앞 앱 돌려주기 L593_RETURN_APP. 제품 판정 줄은 592 원본과 같다.
// LIFE-592 F4 파일 조작 fixture 레포 — 조작 시험은 여기서만(G5). 이름에 l592 가 든 항목만 휴지통에 보낸다.
// 사용: node scripts/l592/fixture.mjs <대상 폴더 /tmp/l592*/repo>   (이미 있으면 지우고 다시 만든다 — /tmp/l593 접두사만)
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const target = process.argv[2]
if (target === undefined || !/^\/tmp\/l593[^/]*\/repo$/.test(target)) throw new Error(`대상은 /tmp/l592*/repo 여야 한다: ${target}`)
fs.rmSync(target, { recursive: true, force: true })
const write = (rel, content) => {
  fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true })
  fs.writeFileSync(path.join(target, rel), content)
}
write('src/l592-a.ts', "export const a = 1\n")
write('src/l592-b.ts', "export const b = 2\n")
write('src/sub/l592-c.md', '# c\n\n본문\n')
write('docs/l592-readme.md', '# readme\n')
write('l592-top.txt', 'top\n')
execFileSync('git', ['init', '-q', '-b', 'main', target])
execFileSync('git', ['-C', target, 'add', '.'])
execFileSync('git', ['-C', target, '-c', 'user.name=l592', '-c', 'user.email=l592@example.invalid', 'commit', '-q', '-m', 'fixture'])
console.log(target)
