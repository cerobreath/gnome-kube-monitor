// Type-only wiring for the @girs type packages. This is a .d.ts: it is never
// emitted and never imported at runtime, so the extension keeps its zero-build,
// plain-JS shape. It just tells TypeScript how to resolve the `gi://…` and
// `resource:///org/gnome/shell/…` module specifiers our .js files import.
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';

// GJS implements the WHATWG console API, but the strict pass runs with
// `types: []` and `lib: ES2022`, neither of which declares it (and pulling in
// "dom" would wrongly hand the logic layer a browser's worth of globals). Only
// the members lib/log.js actually uses are declared.
declare global {
    const console: {
        log(...args: unknown[]): void;
        debug(...args: unknown[]): void;
        info(...args: unknown[]): void;
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    };
}
