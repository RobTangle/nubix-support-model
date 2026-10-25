/**
 * Obtiene la versión efectiva de una dependencia para registrar la procedencia de una prueba.
 * El rango declarado en package.json no alcanza: dos instalaciones pueden resolver versiones
 * distintas. Se separa esta búsqueda porque la usan evaluaciones y pruebas manuales.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../errors.js';

/**
 * Parte del módulo resuelto y busca su package.json hacia arriba. Funciona aunque npm haya
 * colocado la dependencia en un node_modules superior o el paquete no permita importar sus metadatos.
 */
export async function installedPackageVersion(
  name: string,
  resolve: (specifier: string) => string = (specifier) => import.meta.resolve(specifier),
): Promise<string> {
  try {
    let directory = dirname(fileURLToPath(resolve(name)));
    for (;;) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (metadata.name === name) {
          if (typeof metadata.version !== 'string' || !metadata.version.trim())
            throw new AppError('configuration_error');
          return metadata.version;
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) throw new AppError('configuration_error');
      directory = parent;
    }
  } catch {
    throw new AppError('configuration_error');
  }
}
