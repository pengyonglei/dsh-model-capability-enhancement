import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

/**
 * Transpile the two plugin halves without type checking and without bundling
 * the `@deepseek-ai/*` peers: the profile's node_modules fallback resolves
 * them at load time (dsh-vision precedent).
 *
 * First config: the Host half (`src/index.ts` -> `lib/index.mjs`), plain
 * Node ESM.
 *
 * Second config: the browser half (`src/client/index.ts` -> `lib/client.js`),
 * a CJS bundle wrapped in `window.__ModuleLoader__.load({ id, factory })`.
 */

/**
 * The module specifiers the shell shares into the frozen browser module
 * table (mirror of PLATFORM_MODULES in packages/client/web/src/platform.ts).
 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/** The documented module-table exemption (runtime's snapshot-store engine). */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-store'

/** Externals resolved from the loader module table. */
const CLIENT_EXTERNALS = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/** Plugin id == package name, stamped into the __ModuleLoader__ handoff. */
const ID = 'dsh-model-capability-enhancement'

export default defineConfig([
  {
    name: `${ID} (node half)`,
    entry: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
    outDir: fileURLToPath(new URL('./lib', import.meta.url)),
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: true,
    fixedExtension: true,
    deps: {
      neverBundle: [/^@deepseek-ai\//],
    },
  },
  {
    name: `${ID}/client (browser half)`,
    entry: { client: fileURLToPath(new URL('./src/client/index.ts', import.meta.url)) },
    outDir: fileURLToPath(new URL('./lib', import.meta.url)),
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      // antd and friends are NOT in the frozen module table, so they are
      // bundled (tree-shaken to the components actually used).
      neverBundle: [/^@deepseek-ai\//],
      alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
