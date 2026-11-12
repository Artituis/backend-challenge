import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import imports from 'eslint-plugin-simple-import-sort';
import unused from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.tools/**',
      'coverage/**',
      'dist/**',
      'reports/**',
      '.husky/_/**',
      '.scannerwork/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'simple-import-sort': imports, 'unused-imports': unused },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'unused-imports/no-unused-imports': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
    },
  },
  {
    // Bun 1.3 matcher types return void even for .resolves/.rejects; keep awaiting them.
    // Test doubles intentionally implement asynchronous ports with immediate results.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/await-thenable': 'off',
    },
  },
  {
    // MikroORM migrations enqueue SQL synchronously through an asynchronous interface.
    files: ['src/infrastructure/persistence/migrations/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  prettier,
);
