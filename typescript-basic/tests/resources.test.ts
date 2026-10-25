/** Comprueba que el build distribuya los mismos precios y datasets que los recursos canónicos Python. */
import assert from 'node:assert/strict';
import { readFile, stat, mkdtemp, mkdir, copyFile, writeFile, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSharedResource } from '../src/resources/read-shared.js';
import { hash } from '../src/evals/data.js';

test('build limpio: distribuye módulos y prompts por responsabilidad sin módulos raíz obsoletos', async () => {
  for (const path of [
    'support/service.js',
    'llm/execution.js',
    'llm/providers.js',
    'costs/budget.js',
    'config/environment.js',
    'prompting/prompt-registry.yaml',
    'prompting/versions/basic-v1/context.yaml',
    'prompting/versions/basic-v2/context.yaml',
    'observability/telemetry.js',
    'resources/read-shared.js',
    'cli.js',
    'eval-cli.js',
    'index.js',
  ])
    assert.ok((await stat(new URL(`../dist/${path}`, import.meta.url))).isFile(), path);
  for (const path of [
    'service.js',
    'providers.js',
    'budget.js',
    'prompt-registry.yaml',
    'config.js',
    'telemetry.js',
    'prompting/prompt.yaml',
    'prompting/resources/context.yaml',
  ])
    await assert.rejects(stat(new URL(`../dist/${path}`, import.meta.url)), { code: 'ENOENT' });
});

test('el build conserva exactamente datasets y tarifas canónicos compartidos con Python', async () => {
  for (const name of [
    'prices.yaml',
    'datasets/tickets.jsonl',
    'datasets/adversarial.jsonl',
  ] as const) {
    const canonical = await readFile(
      new URL(`../../src/nubbix_support/resources/${name}`, import.meta.url),
      'utf8',
    );
    assert.equal(hash(await readSharedResource(name)), hash(canonical));
  }
});

test('limpieza: rechaza dist enlazado y preserva archivos fuera del directorio generado', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nubbix-clean-safety-'));
  const project = join(directory, 'project');
  const outside = join(directory, 'outside');
  try {
    await mkdir(join(project, 'scripts'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'preserve.txt'), 'No borrar');
    await copyFile(
      new URL('../scripts/clean.mjs', import.meta.url),
      join(project, 'scripts/clean.mjs'),
    );
    await symlink(
      outside,
      join(project, 'dist'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const result = spawnSync(process.execPath, [join(project, 'scripts/clean.mjs')], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no puede ser un enlace/);
    assert.equal(await readFile(join(outside, 'preserve.txt'), 'utf8'), 'No borrar');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
