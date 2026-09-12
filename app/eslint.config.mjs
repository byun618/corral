import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 전역 스타일: `as` 단언을 쓰지 않는다.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
    },
  },
  {
    // N2 의 경계를 **lint 로도** 막는다. 검사 스크립트(check-boundary.mjs)가 판정 근거이고,
    // 이 규칙은 편집 중에 바로 걸리게 하는 같은 경계의 두 번째 그물이다.
    files: ['src/renderer/**/*', 'src/preload/**/*', 'src/shared/**/*'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['*adapter/*', '*/adapter', '*/main/*'] }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        // 수렴 시각을 단조 시계로 잰다 (수정 2회차 L-9). Node 16+ 의 전역인데 여기 목록에
        // 없어서 커밋된 상태의 lint 가 깨져 있었다 — 수정 3회차 N1 재실행이 잡았다.
        performance: 'readonly',
      },
    },
  },
)
