// Flat ESLint config (ESLint 9+). Offline dev tool: run `npm install` first.
// GJS runs modern ESM; the globals below are the gnome-shell / GObject runtime
// surface plus the browser-ish primitives GJS provides.
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
        ignores: ['node_modules/**', 'schemas/**', 'icons/**', '.codegraph/**'],
    },
];
