import CodemagicPatch from './nativeCodemagicPatch';

export * from './definitions';
// './protocol/index', not './protocol': real ESM (which Rollup enforces, unlike
// Node's older CJS directory-index convention) doesn't resolve a bare directory
// specifier — it needs the file. Everywhere else in this package imports a concrete
// sibling file directly, so this is the one place that comes up.
export * from './protocol/index';
export { CodemagicPatch };
