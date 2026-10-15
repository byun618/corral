// LIFE-593 수정 r2 — 질의의 맨 위 행(제품 검색 함수 그대로)을 계산한다. enter-race.mjs 의 기대값(앱 화면의 최근 기록 오염 없이).
// 사용(app/ 에서): npx tsx scripts/l593/top-of.mjs <REPO> <질의> [최근 연 파일(최근이 앞)...]
import { execFileSync } from 'node:child_process'
// 렌더러 모듈이라 node 타입 검사 프로젝트에 끌려 들어가지 않게 계산된 경로로 불러온다(tsx 가 .ts 를 푼다).
const { buildFileIndex, searchFiles } = await import(new URL('../../src/renderer/src/quick-open-search.ts', import.meta.url).href)

const [repo, query, ...recent] = process.argv.slice(2)
const files = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter((rel) => rel !== '')
console.log(searchFiles({ index: buildFileIndex(files), query, recent }).rows[0]?.rel ?? '')
