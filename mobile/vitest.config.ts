import { defineConfig } from 'vitest/config'

// 단위 시험은 RN 을 모르는 `src/core/`(node). 화면 시험(`*.test.tsx`)은 파일 머리에서 happy-dom 을 고르고 RN·expo 를 가짜로 바꾼다.
export default defineConfig({
  test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], environment: 'node' },
  esbuild: { jsx: 'automatic' },
})
