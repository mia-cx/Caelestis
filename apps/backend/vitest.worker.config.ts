import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'tests/worker/alarms.test.ts',
      'tests/worker/host-config.test.ts',
      'tests/worker/object-identity.test.ts',
      'tests/worker/worker.test.ts',
    ],
  },
})
