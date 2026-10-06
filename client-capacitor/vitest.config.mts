import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/protocol/**/*.ts'],
      // Test-only support files, not production logic — counting them would inflate
      // the denominator with code that exists purely to make other code testable.
      exclude: ['src/protocol/**/*.test.ts', 'src/protocol/testing.ts', 'src/protocol/testMocks.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        // Phase 1 acceptance criterion (specs/IMPLEMENTATION-PLAN.md): >=90% line
        // coverage on src/protocol/. Enforced, not just reported — a coverage run
        // that quietly drops below this should fail loudly, not scroll past.
        lines: 90,
      },
    },
  },
});
