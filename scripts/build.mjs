import * as esbuild from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const context = await esbuild.context({
  entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node20', outfile: 'dist/extension.js', external: ['vscode'],
  sourcemap: true, logLevel: 'info', write: false,
  plugins: [{
    name: 'write-bundle',
    setup(build) {
      build.onEnd(async result => {
        if (result.errors.length) return;
        // Keep writes in the Node process that invoked the build. This also
        // works when the native compiler cannot write to protected folders.
        for (const file of result.outputFiles ?? []) {
          await mkdir(dirname(file.path), { recursive: true });
          await writeFile(file.path, file.contents);
        }
      });
    },
  }],
});
if (process.argv.includes('--watch')) await context.watch();
else { await context.rebuild(); await context.dispose(); }
