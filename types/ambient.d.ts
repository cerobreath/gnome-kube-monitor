// Type-only wiring for the @girs type packages. This is a .d.ts: it is never
// emitted and never imported at runtime, so the extension keeps its zero-build,
// plain-JS shape. It just tells TypeScript how to resolve the `gi://…` and
// `resource:///org/gnome/shell/…` module specifiers our .js files import.
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';
