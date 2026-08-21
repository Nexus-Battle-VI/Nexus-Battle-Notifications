/**
 * Jest se ejecuta en modo ESM sobre Node 24. La transformacion la realiza
 * ts-jest usando la API de TypeScript 6, mientras que la verificacion de tipos
 * autoritativa la realiza TypeScript 7 en el script `typecheck`.
 * La razon de esta separacion esta documentada en docs/adr/ADR-003.
 */

/** @type {import('ts-jest').TsJestTransformerOptions} */
const tsJestOptions = {
  useESM: true,
  tsconfig: {
    module: 'esnext',
    moduleResolution: 'bundler',
    verbatimModuleSyntax: false,
    erasableSyntaxOnly: false,
  },
}

const shared = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  // Los imports de TypeScript en NodeNext apuntan a `.js`; se remapean al fuente.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: { '^.+\\.ts$': ['ts-jest', tsJestOptions] },
}

/** @type {import('jest').Config} */
export default {
  projects: [
    { ...shared, displayName: 'unit', testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] },
    {
      ...shared,
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
    },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/index.ts',
    '!src/worker.ts',
    '!src/infrastructure/bootstrap/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
}
