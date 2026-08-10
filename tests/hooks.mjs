// Redirects the GJS-only gi:// and resource:/// specifiers at tests/stubs/, so
// the gi-dependent sources run under plain node. Loaded via --import, which runs
// before the test files so their static imports are intercepted.

import * as nodeModule from 'node:module';
import {pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// The deprecated module.register() cannot intercept these specifiers the same way.
const {registerHooks} = nodeModule;
if (typeof registerHooks !== 'function') {
    throw new Error(
        `This test harness needs node:module registerHooks(), which ${process.version} ` +
        'does not provide. Use a Node that has it (see "engines" in package.json).');
}

const here = dirname(fileURLToPath(import.meta.url));
const giDir = join(here, 'stubs', 'gi');
const shellDir = join(here, 'stubs', 'shell');

// resource:/// path tail -> stub file. Extend as more shell modules get used.
const SHELL_STUBS = {
    'ui/main.js': 'main.js',
    'ui/panelMenu.js': 'panelMenu.js',
    'ui/popupMenu.js': 'popupMenu.js',
    'ui/messageTray.js': 'messageTray.js',
    'extensions/extension.js': 'extension.js',
    'js/extensions/prefs.js': 'prefs.js',
};

/** @param {string} specifier */
function mapSpecifier(specifier) {
    if (specifier.startsWith('gi://')) {
        // gi://St?version=16 -> St
        const name = specifier.slice(5).split('?')[0];
        return pathToFileURL(join(giDir, `${name}.js`)).href;
    }
    if (specifier.startsWith('resource:///')) {
        for (const [tail, file] of Object.entries(SHELL_STUBS)) {
            if (specifier.endsWith(tail))
                return pathToFileURL(join(shellDir, file)).href;
        }
        throw new Error(`No shell stub for ${specifier}: add one to tests/stubs/shell/`);
    }
    return null;
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        const url = mapSpecifier(specifier);
        if (url)
            return {url, format: 'module', shortCircuit: true};
        return nextResolve(specifier, context);
    },
});
