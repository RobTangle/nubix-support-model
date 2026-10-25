import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { PromptRegistry } from '../../src/prompt-registry.js';

/** Registro aislado con una tercera variante; nunca cambia recursos reales ni llama al modelo. */
export async function extendedRegistry(directory: string): Promise<PromptRegistry> {
  const source = new URL('../../src/prompt-registry.yaml', import.meta.url);
  const manifest = parse(await readFile(source, 'utf8')) as {
    version: string;
    default: string;
    baseline: string;
    context: string;
    safety: string;
    prompts: { id: string; label: string; system: string; examples?: string }[];
  };
  const paths = new Set([
    manifest.context,
    manifest.safety,
    ...manifest.prompts.flatMap((entry) => [
      entry.system,
      ...(entry.examples ? [entry.examples] : []),
    ]),
  ]);
  for (const path of paths) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await copyFile(new URL(path, source), join(directory, path));
  }
  manifest.prompts.push({
    id: 'experiment-v3',
    label: 'Tercera variante de prueba',
    system: 'third.yaml',
  });
  await writeFile(
    join(directory, 'third.yaml'),
    stringify({
      version: 'experiment-v3',
      system: 'Clasificá con prudencia y respondé con el manual. {{manual}}',
    }),
  );
  await writeFile(join(directory, 'registry.yaml'), stringify(manifest));
  return PromptRegistry.load(pathToFileURL(join(directory, 'registry.yaml')));
}
