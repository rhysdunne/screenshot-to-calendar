// Flat ESLint config (ESLint 10 / typescript-eslint 8). Scope: backend src + test.
// Deliberately lean: the syntactic `recommended` set plus a few *type-aware*
// promise rules that tsc does NOT catch (a forgotten `await` on a fire-and-forget
// I/O call is the classic silent bug in this Lambda code). We can escalate to
// `recommendedTypeChecked` later once the codebase is clean — see the decisions/
// README for why we start narrow rather than boiling the ocean.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // Type-aware linting without maintaining an explicit `project` list.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript's own checker owns undefined-symbol detection; no-undef here
      // just double-flags Node globals (process, Buffer, …).
      'no-undef': 'off',
      // Honour the codebase's deliberate-unused conventions: `_`-prefixed args
      // and the `{ sensitive, ...rest } = x` strip-and-return idiom.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // The rules that earn eslint its place alongside tsc:
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    // Tests lean on casts/fakes; keep the signal-to-noise sane there.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
