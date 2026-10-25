import { lstat, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = resolve(root, 'dist');
// El destino es fijo y se verifica antes de borrar recursivamente. Un enlace podría apuntar
// fuera del proyecto: en ese caso fallamos y dejamos la decisión a quien mantiene el repo.
if (relative(root, output) !== 'dist') throw new Error('Destino de build inválido.');
const entry = await lstat(output).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (entry?.isSymbolicLink()) throw new Error('El directorio de build no puede ser un enlace.');
await rm(output, { recursive: true, force: true });
