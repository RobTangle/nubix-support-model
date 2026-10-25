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
  await mkdir(join(directory, 'resources'));
  const manifest = {
    version: '1',
    default: 'basic-v3',
    baseline: 'basic-v1',
    context: 'resources/context.yaml',
    safety: 'resources/safety.yaml',
    prompts: [
      { id: 'basic-v1', label: 'Base', system: 'base.yaml' },
      {
        id: 'basic-v2',
        label: 'Ejemplos',
        system: 'base.yaml',
        examples: 'resources/examples.yaml',
      },
      { id: 'basic-v3', label: 'Instrucciones nuevas', system: 'new.yaml' },
    ],
  };
  await Promise.all([
    writeFile(
      join(directory, 'base.yaml'),
      stringify({ version: 'template-v1', system: 'BASE {{manual}}' }),
    ),
    writeFile(
      join(directory, 'new.yaml'),
      stringify({ version: 'template-v3', system: 'NUEVO {{manual}}' }),
    ),
    writeFile(
      join(directory, 'resources/context.yaml'),
      stringify({ version: 'manual-v1', manual: 'MANUAL FICTICIO' }),
    ),
    writeFile(
      join(directory, 'resources/safety.yaml'),
      stringify({
        version: 'safety-v1',
        repair: 'Corregí el JSON.',
        evaluation_marker: 'CANARIO',
        input: 'ENTRADA {{manual}}',
        output: 'SALIDA {{manual}}',
      }),
    ),
    writeFile(
      join(directory, 'resources/examples.yaml'),
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
  ]);
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
      join(files.directory, 'new.yaml'),
      stringify({ version: 'template-v3', system: 'EDITADO {{manual}}' }),
    );
    const after = await PromptRegistry.load(files.url);
    assert.notEqual(before.get().hashes.system, after.get().hashes.system);
    assert.equal(before.get('basic-v1').hashes.system, after.get('basic-v1').hashes.system);
    await writeFile(
      join(files.directory, 'resources/examples.yaml'),
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
      join(files.directory, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    files.manifest.prompts[2]!.system = 'linked/escape.yaml';
    await files.save();
    await assert.rejects(PromptRegistry.load(files.url), AppError);
  } finally {
    await files.close();
    await rm(outside, { recursive: true, force: true });
  }
});
