// Fake GObject. registerClass reproduces the one behaviour the view depends on:
// construction runs _init(...) rather than a constructor, which is why this
// codebase assigns all instance state there (class fields would be clobbered).
export const TYPE_STRING = 'gchararray';
export const TYPE_BOOLEAN = 'gboolean';
export const TYPE_INT = 'gint';
export const TYPE_DOUBLE = 'gdouble';

export const ParamFlags = {READABLE: 1, WRITABLE: 2, READWRITE: 3, CONSTRUCT: 4};

export const ParamSpec = {
    string: (name) => ({name, type: 'string'}),
    boolean: (name) => ({name, type: 'boolean'}),
    int: (name) => ({name, type: 'int'}),
    object: (name) => ({name, type: 'object'}),
    boxed: (name) => ({name, type: 'boxed'}),
};

// NB: named GObjectBase, not Object -- exporting `Object` would shadow the global
// inside this module.
export class GObjectBase {}
export {GObjectBase as Object};

/**
 * @param {any} metaOrClass
 * @param {any} [maybeClass]
 */
export function registerClass(metaOrClass, maybeClass) {
    const cls = maybeClass ?? metaOrClass;
    const meta = maybeClass ? metaOrClass : {};
    const declared = meta.Signals ?? {};
    return class Registered extends cls {
        /** @param {any[]} args */
        constructor(...args) {
            super();
            this.__declaredSignals = declared;
            this._init?.(...args);
        }
    };
}

export default {
    TYPE_STRING, TYPE_BOOLEAN, TYPE_INT, TYPE_DOUBLE,
    ParamFlags, ParamSpec, Object: GObjectBase, registerClass,
};
