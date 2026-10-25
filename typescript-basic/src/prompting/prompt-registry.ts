import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { AppError } from '../errors.js';
import {
  promptMetadataSchema,
  promptVersionSchema,
  type PromptMetadata,
} from './prompt-contracts.js';
import { supportResponseSchema } from '../support/schemas.js';
import type { PromptBundle } from './prompts.js';

const text = z.string().min(1);
// Rutas de recursos confiables, no configurables por tickets ni parámetros HTTP.
const resourcePath = z.string().regex(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.yaml$/u);
const manifestSchema = z.strictObject({
  version: text,
  default: promptVersionSchema,
  baseline: promptVersionSchema,
  context: resourcePath,
  safety: resourcePath,
  prompts: z
    .array(promptMetadataSchema.extend({ system: resourcePath, examples: resourcePath.optional() }))
    .min(1)
    .max(100),
});
const contextSchema = z.strictObject({ version: text, manual: text });
const systemSchema = z.strictObject({ version: text, system: text });
const safetySchema = z.strictObject({
  version: text,
  repair: text,
  evaluation_marker: text,
  input: text,
  output: text,
});
const examplesSchema = z.strictObject({
  version: text,
  examples: z
    .array(z.strictObject({ ticket: text, response: supportResponseSchema }))
    .min(1)
    .max(20),
});
type PreparedPrompt = { bundle: PromptBundle; marker: string };

/**
 * Registro local validado y precargado: todas las referencias fallan antes de consumir API.
 * Cada versión elige instrucciones y ejemplos; manual y seguridad siguen compartidos.
 * El servicio recibe bundles listos y no necesita conocer archivos ni listas de versiones.
 */
export class PromptRegistry {
  readonly defaultVersion: string;
  readonly baselineVersion: string;
  readonly versions: readonly PromptMetadata[];

  private constructor(
    manifest: z.infer<typeof manifestSchema>,
    private readonly prepared: ReadonlyMap<string, PreparedPrompt>,
  ) {
    this.defaultVersion = manifest.default;
    this.baselineVersion = manifest.baseline;
    this.versions = Object.freeze(
      manifest.prompts.map(({ id, label }) => Object.freeze({ id, label })),
    );
  }

  static async load(
    url = new URL('./prompt-registry.yaml', import.meta.url),
  ): Promise<PromptRegistry> {
    try {
      if (url.protocol !== 'file:') throw new AppError('configuration_error');
      const source = await readFile(url, 'utf8');
      if (Buffer.byteLength(source) > 262144) throw new AppError('configuration_error');
      const manifest = manifestSchema.parse(parse(source));
      const ids = new Set(manifest.prompts.map((entry) => entry.id));
      if (
        ids.size !== manifest.prompts.length ||
        !ids.has(manifest.default) ||
        !ids.has(manifest.baseline)
      )
        throw new AppError('configuration_error');
      const root = await realpath(fileURLToPath(new URL('./', url)));
      const sources = new Map<string, string>();
      const paths = new Set([
        manifest.context,
        manifest.safety,
        ...manifest.prompts.flatMap((entry) => [
          entry.system,
          ...(entry.examples ? [entry.examples] : []),
        ]),
      ]);
      for (const path of paths) {
        const resolved = await realpath(fileURLToPath(new URL(path, url)));
        const inside = relative(root, resolved);
        if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`))
          throw new AppError('configuration_error');
        const content = await readFile(resolved, 'utf8');
        if (Buffer.byteLength(content) > 262144) throw new AppError('configuration_error');
        sources.set(path, content);
      }
      const context = contextSchema.parse(parse(sources.get(manifest.context)!));
      const safetySource = sources.get(manifest.safety)!;
      const safety = safetySchema.parse(parse(safetySource));
      const render = (template: string): string =>
        template.replaceAll('{{manual}}', context.manual.trimEnd());
      const inputModeration = render(safety.input);
      const outputModeration = render(safety.output);
      const prepared = new Map<string, PreparedPrompt>();
      for (const entry of manifest.prompts) {
        const template = systemSchema.parse(parse(sources.get(entry.system)!));
        const examplesSource = entry.examples ? sources.get(entry.examples)! : '';
        const examples = entry.examples
          ? examplesSchema.parse(parse(examplesSource)).examples
          : null;
        const system =
          render(template.system) +
          (examples ? `\nEJEMPLOS INDEPENDIENTES:\n${JSON.stringify(examples)}` : '');
        const hashes = Object.fromEntries(
          Object.entries({
            system,
            inputModeration,
            outputModeration,
            repair: safety.repair,
            manual: context.manual,
            safety: safetySource,
            examples: examplesSource,
            registry: source,
          }).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]),
        );
        prepared.set(entry.id, {
          bundle: {
            version: entry.id,
            manualVersion: context.version,
            safetyVersion: safety.version,
            system,
            inputModeration,
            outputModeration,
            repair: safety.repair,
            hashes,
            canaryEnabled: false,
          },
          marker: safety.evaluation_marker,
        });
      }
      return new PromptRegistry(manifest, prepared);
    } catch {
      // Ni contenido de prompts ni rutas del servidor deben aparecer en errores públicos.
      throw new AppError('configuration_error');
    }
  }

  has(version: string): boolean {
    return this.prepared.has(version);
  }

  /** Copia por consumidor: evita que una request modifique recursos compartidos por las demás. */
  get(version = this.defaultVersion, evaluation = false): PromptBundle {
    const selected = this.prepared.get(version);
    if (!selected) throw new AppError('configuration_error');
    const bundle = { ...selected.bundle, hashes: { ...selected.bundle.hashes } };
    if (!evaluation) return bundle;
    for (const key of ['system', 'inputModeration', 'outputModeration'] as const) {
      bundle[key] += `\n${selected.marker}`;
      bundle.hashes[key] = createHash('sha256').update(bundle[key]).digest('hex');
    }
    bundle.canaryEnabled = true;
    return bundle;
  }
}
