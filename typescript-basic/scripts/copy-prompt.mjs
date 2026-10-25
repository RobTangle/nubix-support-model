/**
 * Preparación de recursos para dev/build: copia YAML, tarifas y datasets junto al JS compilado.
 * tsc sólo transforma código; este paso permite ejecutar el paquete desde cualquier directorio
 * y reutilizar los datos canónicos de Python sin ejecutar esa implementación.
 */
import { copyFile, cp, mkdir, lstat } from 'node:fs/promises';

// tsc compila TypeScript, pero no copia YAML. El recurso debe viajar con dist/.
await mkdir(new URL('../dist/resources/shared/datasets/', import.meta.url), { recursive: true });
// Descubrimiento de recursos, no de versiones: el registro decide cuáles están habilitadas.
// Copiar todos los YAML de src conserva rutas nuevas sin editar el script por cada prompt.
await cp(new URL('../src/', import.meta.url), new URL('../dist/', import.meta.url), {
  recursive: true,
  filter: async (source) => (await lstat(source)).isDirectory() || source.endsWith('.yaml'),
});
for (const name of ['prices.yaml', 'datasets/tickets.jsonl', 'datasets/adversarial.jsonl']) {
  await copyFile(
    new URL(`../../src/nubbix_support/resources/${name}`, import.meta.url),
    new URL(`../dist/resources/shared/${name}`, import.meta.url),
  );
}
