// @ts-check
import { defineConfig, globalIgnores } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * ESLint 10 con reglas con informacion de tipos.
 *
 * typescript-eslint usa la API JS de TypeScript 6, que es la version instalada
 * como `typescript`. La verificacion de tipos del producto la realiza
 * TypeScript 7 mediante el alias `typescript7`. Vease docs/adr/ADR-003.
 */
export default defineConfig([
  globalIgnores(['dist/**', 'coverage/**', 'node_modules/**']),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  prettier,

  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: false, allowTypedFunctionExpressions: true },
      ],
      'no-console': 'error',
    },
  },

  // El dominio no puede depender de frameworks, SDK, ORM, HTTP ni drivers.
  // Esta regla convierte la restriccion arquitectonica en algo verificable por CI.
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'nodemailer',
                '@aws-sdk/*',
                'aws-sdk',
                'node:http',
                'node:https',
                'node:fs',
                'node:net',
                'pg',
                'mongodb',
                'mongoose',
                'typeorm',
                '@prisma/*',
                '**/adapters/**',
                '**/infrastructure/**',
              ],
              message:
                'El dominio no puede importar frameworks, SDK, ORM, HTTP, drivers ni adaptadores. Se define un puerto en application/ports y se inyecta la implementacion.',
            },
          ],
        },
      ],
    },
  },

  // La capa de aplicacion depende de sus puertos, nunca de adaptadores concretos.
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters/**', '**/infrastructure/**', 'nodemailer', '@aws-sdk/*'],
              message:
                'La capa de aplicacion solo depende de sus puertos y del dominio. La composicion ocurre en infrastructure/bootstrap.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  {
    files: ['src/infrastructure/observability/**/*.ts'],
    rules: {
      // El registro estructurado es el unico punto autorizado para escribir a stdout.
      'no-console': 'off',
    },
  },
])
