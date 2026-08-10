// Flat ESLint config (ESLint 9+), dev-only: run npm install first. The globals
// below are the GJS runtime surface, which no globals preset covers.
import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.es2021,
                // GJS runtime
                imports: 'readonly',
                globalThis: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                console: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'prefer-const': 'warn',
            eqeqeq: ['warn', 'smart'],
        },
    },
    {
        // The test suite and its gi/shell stubs run under node, not GJS.
        files: ['tests/**/*.js', 'tests/**/*.mjs'],
        languageOptions: {
            globals: {...globals.node},
        },
    },
    {
        ignores: ['node_modules/**', 'schemas/**', 'icons/**', '.codegraph/**'],
    },
];
