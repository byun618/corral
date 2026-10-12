// 이미지 import 타입 (LIFE-594 에이전트 로고) — Metro 는 `import x from './a.png'` 를 자산 id(숫자)로 바꾼다.
// expo 가 만드는 expo-env.d.ts 는 .gitignore 라 typecheck 가 보지 못해 여기 둔다.
declare module '*.png' {
  const source: number
  export default source
}
