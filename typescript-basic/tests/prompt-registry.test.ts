import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { stringify } from 'yaml';
import { PromptRegistry } from '../src/prompting/prompt-registry.js';
import { AppError } from '../src/errors.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nubbix-prompts-'));
  const manifest = {
    version: '2',
    default: 'basic-v3',
    baseline: 'basic-v1',
    prompts: [
      {
        id: 'basic-v1',
        label: 'Base',
        system: 'versions/basic-v1/system.yaml',
        context: 'versions/basic-v1/context.yaml',
        safety: 'versions/basic-v1/safety.yaml',
      },
      {
        id: 'basic-v2',
        label: 'Ejemplos',
        system: 'versions/basic-v2/system.yaml',
        context: 'versions/basic-v2/context.yaml',
        safety: 'versions/basic-v2/safety.yaml',
        examples: 'versions/basic-v2/examples.yaml',
      },
      {
        id: 'basic-v3',
        label: 'Instrucciones nuevas',
        system: 'versions/basic-v3/system.yaml',
        context: 'versions/basic-v3/context.yaml',
        safety: 'versions/basic-v3/safety.yaml',
      },
    ],
  };
  for (const entry of manifest.prompts) {
    await mkdir(join(directory, 'versions', entry.id), { recursive: true });
    await Promise.all([
      writeFile(
        join(directory, entry.system),
        stringify({
          version: entry.id,
          system: entry.id === 'basic-v3' ? 'NUEVO {{manual}}' : 'BASE {{manual}}',
        }),
      ),
      writeFile(
        join(directory, entry.context),
        stringify({ version: 'manual-v1', manual: 'MANUAL FICTICIO' }),
      ),
      writeFile(
        join(directory, entry.safety),
        stringify({
          version: 'safety-v1',
          repair: 'Corregí el JSON.',
          evaluation_marker: 'CANARIO',
          input_moderation: 'ENTRADA {{manual}}',
          output_moderation: 'SALIDA {{manual}}',
        }),
      ),
      ...(entry.examples
        ? [
            writeFile(
              join(directory, entry.examples),
              stringify({
                version: 'examples-v1',
                examples: [
                  {
                    ticket: 'Consulta',
                    response: {
                      answer: 'Solicitar contexto.',
                      category: 'other',
                      confidence: 0.5,
                      actions: [],
                    },
                  },
                ],
              }),
            ),
          ]
        : []),
    ]);
  }
  const url = pathToFileURL(join(directory, 'prompt-registry.yaml'));
  return {
    directory,
    manifest,
    url,
    async save() {
      await writeFile(url, stringify(manifest));
    },
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('registro: descubre nueva versión con defaults, instrucciones propias y ejemplos opcionales', async () => {
  const files = await fixture();
  try {
    await files.save();
    const registry = await PromptRegistry.load(files.url);
    assert.equal(registry.defaultVersion, 'basic-v3');
    assert.equal(registry.baselineVersion, 'basic-v1');
    assert.deepEqual(
      registry.versions.map((entry) => entry.id),
      ['basic-v1', 'basic-v2', 'basic-v3'],
    );
    assert.equal(registry.get().system, 'NUEVO MANUAL FICTICIO');
    assert.match(registry.get('basic-v2').system, /EJEMPLOS INDEPENDIENTES/);
    assert.doesNotMatch(registry.get('basic-v1').system, /EJEMPLOS/);
    assert.equal(registry.get('basic-v3', true).canaryEnabled, true);
    assert.match(registry.get('basic-v3', true).system, /CANARIO/);
    assert.equal(registry.has('unregistered'), false);
    assert.throws(() => registry.get('unregistered'), AppError);
    assert.ok(Object.values(registry.get().hashes).every((hash) => /^[a-f0-9]{64}$/u.test(hash)));
    const original = registry.get().hashes.system;
    const returned = registry.get();
    returned.hashes.system = 'changed by consumer';
    assert.equal(registry.get().hashes.system, original);
  } finally {
    await files.close();
  }
});

test('registro: rechaza IDs duplicados, defaults huérfanos y rutas fuera de recursos antes de API', async () => {
  for (const change of [
    'duplicate',
    'default',
    'baseline',
    '../outside.yaml',
    '/absolute.yaml',
    'https://example.com/prompt.yaml',
    'resources\\secret.yaml',
    'resources/%2e%2e/secret.yaml',
    'missing.yaml',
  ]) {
    const files = await fixture();
    try {
      if (change === 'duplicate') files.manifest.prompts.push({ ...files.manifest.prompts[0]! });
      else if (change === 'default') files.manifest.default = 'unknown';
      else if (change === 'baseline') files.manifest.baseline = 'unknown';
      else files.manifest.prompts[2]!.system = change;
      await files.save();
      await assert.rejects(
        PromptRegistry.load(files.url),
        (error: unknown) => error instanceof AppError && error.code === 'configuration_error',
      );
    } finally {
      await files.close();
    }
  }
});

test('registro: huellas detectan ediciones y toda referencia inválida impide cargar el conjunto', async () => {
  const files = await fixture();
  try {
    await files.save();
    const before = await PromptRegistry.load(files.url);
    await writeFile(
      join(files.directory, 'versions/basic-v3/system.yaml'),
      stringify({ version: 'template-v3', system: 'EDITADO {{manual}}' }),
    );
    const after = await PromptRegistry.load(files.url);
    assert.notEqual(before.get().hashes.system, after.get().hashes.system);
    assert.equal(before.get('basic-v1').hashes.system, after.get('basic-v1').hashes.system);
    await writeFile(
      join(files.directory, 'versions/basic-v2/examples.yaml'),
      'version: broken\nexamples: []\n',
    );
    await assert.rejects(PromptRegistry.load(files.url), AppError);
  } finally {
    await files.close();
  }
});

test('registro: una ruta aparentemente local no puede escapar mediante un enlace de directorio', async () => {
  const files = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'nubbix-outside-prompts-'));
  try {
    await writeFile(join(outside, 'escape.yaml'), 'version: external\nsystem: No debe cargarse\n');
    await symlink(
      outside,
      join(files.directory, 'versions/basic-v3/linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    files.manifest.prompts[2]!.system = 'versions/basic-v3/linked/escape.yaml';
    await files.save();
    await assert.rejects(PromptRegistry.load(files.url), AppError);
  } finally {
    await files.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test('versiones independientes: editar instrucciones, manual, seguridad y ejemplos de v2 no cambia v1/v3', async () => {
  const files = await fixture();
  try {
    await files.save();
    const initial = await PromptRegistry.load(files.url);
    const untouched = [initial.get('basic-v1', true), initial.get('basic-v3', true)];
    await writeFile(
      join(files.directory, 'versions/basic-v2/system.yaml'),
      stringify({ version: 'basic-v2', system: 'CAMBIO V2 {{manual}}' }),
    );
    await writeFile(
      join(files.directory, 'versions/basic-v2/context.yaml'),
      stringify({ version: 'manual-v2', manual: 'MANUAL V2' }),
    );
    await writeFile(
      join(files.directory, 'versions/basic-v2/safety.yaml'),
      stringify({
        version: 'safety-v2',
        repair: 'Reparación V2',
        evaluation_marker: 'CANARIO V2',
        input_moderation: 'ENTRADA V2 {{manual}}',
        output_moderation: 'SALIDA V2 {{manual}}',
      }),
    );
    await writeFile(
      join(files.directory, 'versions/basic-v2/examples.yaml'),
      stringify({
        version: 'examples-v2',
        examples: [
          {
            ticket: 'Nuevo ejemplo',
            response: {
              answer: 'Pedir contexto.',
              confidence: 0.7,
              category: 'other',
              actions: [],
            },
          },
        ],
      }),
    );
    const changed = await PromptRegistry.load(files.url);
    assert.deepEqual([changed.get('basic-v1', true), changed.get('basic-v3', true)], untouched);
    const v2 = changed.get('basic-v2', true);
    assert.match(v2.system, /CAMBIO V2 MANUAL V2/);
    assert.match(v2.inputModeration, /ENTRADA V2 MANUAL V2/);
    assert.equal(v2.manualVersion, 'manual-v2');
    assert.equal(v2.safetyVersion, 'safety-v2');
    for (const key of ['system', 'manual', 'safety', 'examples'])
      assert.notEqual(v2.hashes[key], initial.get('basic-v2', true).hashes[key]);
  } finally {
    await files.close();
  }
});

test('versiones independientes: no pueden referenciar recursos de otra versión', async () => {
  for (const field of ['system', 'context', 'safety', 'examples'] as const) {
    const files = await fixture();
    try {
      files.manifest.prompts[1]![field] = `versions/basic-v1/${field}.yaml`;
      await files.save();
      await assert.rejects(PromptRegistry.load(files.url), AppError);
    } finally {
      await files.close();
    }
  }
});

test('versiones independientes: un enlace interno tampoco puede compartir el manual físico', async () => {
  const files = await fixture();
  try {
    await symlink(
      join(files.directory, 'versions/basic-v1'),
      join(files.directory, 'versions/basic-v2/shared'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    files.manifest.prompts[1]!.context = 'versions/basic-v2/shared/context.yaml';
    await files.save();
    await assert.rejects(PromptRegistry.load(files.url), AppError);
  } finally {
    await files.close();
  }
});

test('seguridad: claves explícitas se traducen al bundle y nombres antiguos se rechazan', async () => {
  const files = await fixture();
  try {
    await files.save();
    const bundle = (await PromptRegistry.load(files.url)).get('basic-v1');
    assert.equal(bundle.inputModeration, 'ENTRADA MANUAL FICTICIO');
    assert.equal(bundle.outputModeration, 'SALIDA MANUAL FICTICIO');
    await writeFile(
      join(files.directory, 'versions/basic-v1/safety.yaml'),
      stringify({
        version: 'legacy',
        repair: 'Corregí JSON',
        evaluation_marker: 'CANARIO',
        input: 'Viejo input',
        output: 'Viejo output',
      }),
    );
    await assert.rejects(
      PromptRegistry.load(files.url),
      (error: unknown) => error instanceof AppError && error.code === 'configuration_error',
    );
  } finally {
    await files.close();
  }
});
