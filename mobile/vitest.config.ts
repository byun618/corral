import { defineConfig } from 'vitest/config'

// 단위 시험은 RN 을 모르는 `src/core/` 만 — 연결 층·페이로드·기록.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})
