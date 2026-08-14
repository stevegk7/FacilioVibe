/**
 * Ambient declarations for the vendored 3D runtime.
 *
 * `three` is typed as `any` on purpose rather than pulling in @types/three.
 * This app never calls a three API from TypeScript — loadEngine.ts does exactly
 * `window.THREE = await import('three')` and hands the namespace to
 * estate-engine.js, 1,355 lines of ES5 we vendor and do not own. A five-year-old
 * DefinitelyTyped package pinned against r128 would add a dependency and a
 * maintenance question in exchange for typing one assignment.
 *
 * The window surface that DOES matter — EstateEngine, the taxonomy globals,
 * __estate — is declared properly in ./types.ts.
 */
declare module 'three';
