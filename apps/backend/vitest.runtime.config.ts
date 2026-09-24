import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/runtime/**/*.test.ts'],
    setupFiles: ['./tests/runtime/sqlite-library.mjs'],
  },
})
