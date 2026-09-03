/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'esnext',
          moduleResolution: 'bundler',
          verbatimModuleSyntax: false,
          erasableSyntaxOnly: false,
        },
      },
    ],
  },
  testMatch: ['<rootDir>/tests/db/**/*.test.ts'],
  testTimeout: 180000,
  collectCoverageFrom: ['src/adapters/idempotency/MongoPurchaseInbox.ts'],
  coverageDirectory: 'coverage-db',
  coverageReporters: ['text-summary'],
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
}
