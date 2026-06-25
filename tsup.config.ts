import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

// Injected into the widget build so it can report its package version at runtime
// (logged on BunnyQuery.init). Single source of truth = package.json.
const PKG_VERSION = JSON.parse(readFileSync('./package.json', 'utf8')).version;

// This package produces TWO outputs from one source tree:
//
//   1) The framework-agnostic chat ENGINE (src/engine) → dist/engine.{mjs,cjs}
//      + engine.d.ts. Imported by www.skapi.com (the admin agent.vue chatbox)
//      via `bunnyquery/engine`. The engine is DOM-free / framework-free; the
//      skapi transport + MCP base URL + poll are injected via
//      configureChatEngine(), and `marked` is injected — so it has no bundled
//      runtime deps and nothing is external.
//
//   2) The standalone widget IIFE (src/index.js) → ./bunnyquery.js, a single
//      drop-in <script> that sets window.BunnyQuery. It imports the local
//      engine (./engine), which esbuild bundles inline. skapi + marked are
//      runtime globals (host-provided / CDN), never imported.
//
// IMPORTANT: the IIFE's outDir is the repo root, so its `clean` MUST stay false
// (a true clean would wipe the directory). Only the engine build (outDir dist)
// cleans.
export default defineConfig([
    {
        entry: { engine: 'src/engine/index.ts' },
        format: ['esm', 'cjs'],
        dts: true,
        sourcemap: true,
        clean: true,
        splitting: false,
        target: 'es2020',
        outDir: 'dist',
        treeshake: true,
        outExtension({ format }) {
            return { js: format === 'esm' ? '.mjs' : '.cjs' };
        },
    },
    {
        entry: { bunnyquery: 'src/index.js' },
        define: { __BQ_VERSION__: JSON.stringify(PKG_VERSION) },
        format: ['iife'],
        platform: 'browser',
        target: 'es2020',
        outDir: '.',
        clean: false,
        dts: false,
        sourcemap: false,
        minify: false,
        splitting: false,
        treeshake: true,
        outExtension() {
            return { js: '.js' };
        },
    },
]);
