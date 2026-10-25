import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { PromptRegistry } from '../../src/prompting/prompt-registry.js';

/** Registro aislado con una tercera variante; nunca cambia recursos reales ni llama al modelo. */
export async function extendedRegistry(directory: string): Promise<PromptRegistry> {
  const source = new URL('../../src/prompting/prompt-registry.yaml', import.meta.url);
  const manifest = parse(await readFile(source, 'utf8')) as {
    version: string;
    default: string;
    baseline: string;
    prompts: {
      id: string;
      label: string;
      system: string;
      context: string;
      safety: string;
      examples?: string;
    }[];
  };
  const paths = new Set([
    ...manifest.prompts.flatMap((entry) => [
      entry.system,
      entry.context,
      entry.safety,
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
    system: 'versions/experiment-v3/system.yaml',
    context: 'versions/experiment-v3/context.yaml',
    safety: 'versions/experiment-v3/safety.yaml',
  });
  await mkdir(join(directory, 'versions/experiment-v3'), { recursive: true });
  await copyFile(
    join(directory, manifest.prompts[0]!.context),
    join(directory, 'versions/experiment-v3/context.yaml'),
  );
  await copyFile(
    join(directory, manifest.prompts[0]!.safety),
    join(directory, 'versions/experiment-v3/safety.yaml'),
  );
  await writeFile(
    join(directory, 'versions/experiment-v3/system.yaml'),
    stringify({
      version: 'experiment-v3',
      system: 'Clasificá con prudencia y respondé con el manual. {{manual}}',
    }),
  );
  await writeFile(join(directory, 'registry.yaml'), stringify(manifest));
  return PromptRegistry.load(pathToFileURL(join(directory, 'registry.yaml')));
}
