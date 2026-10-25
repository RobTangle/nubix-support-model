import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../errors.js';

/** Resuelve el módulo instalado, incluso hoisted y con package.json oculto por exports. */
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
