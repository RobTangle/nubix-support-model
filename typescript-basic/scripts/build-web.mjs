import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Un bundle permite compartir Zod y contratos con el navegador sin importar paquetes de Node.
const output = new URL('../dist/web/public/', import.meta.url);
await mkdir(output, { recursive: true });
await cp(new URL('../src/web/public/', import.meta.url), output, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('../src/web/client/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('app.js', output)),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  minify: false,
});
