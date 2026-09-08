import { build } from 'esbuild';
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist/extension.cjs', external: ['vscode'], sourcemap: true });
await build({ entryPoints: ['webview/timeline.ts', 'webview/preview.ts'], bundle: true, platform: 'browser', target: 'es2022', outdir: 'dist', sourcemap: true });
