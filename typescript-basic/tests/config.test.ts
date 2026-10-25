/** Prueba selección de proveedor/modelo, claves propias y precedencia del entorno usando valores falsos. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, cp, mkdir, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { readEnvironment, readSettings } from '../src/config/environment.js';
import { AppError, publicError } from '../src/errors.js';

test('cada proveedor exige sólo su propia clave y permite configurar su modelo', () => {
  assert.deepEqual(readSettings('xai', { XAI_API_KEY: 'test', NUBBIX_XAI_MODEL: 'custom' }), {
    provider: 'xai',
    apiKey: 'test',
    model: 'custom',
  });
  assert.equal(readSettings('openai', { OPENAI_API_KEY: 'test' }).model, 'gpt-6-luna');
  assert.throws(
    () => readSettings('openai', { XAI_API_KEY: 'test' }),
    (e: unknown) => e instanceof AppError && e.code === 'missing_key',
  );
  assert.throws(
    () => readSettings('unknown', {}),
    (e: unknown) => e instanceof AppError && e.code === 'invalid_provider',
  );
  assert.throws(
    () => readSettings('xai', { XAI_API_KEY: 'test', NUBBIX_XAI_MODEL: ' ' }),
    AppError,
  );
});

test('google-ai: usa Gemini Flash-Lite por defecto y permite configurar el modelo', () => {
  assert.deepEqual(readSettings('google-ai', { GEMINI_API_KEY: ' test ' }), {
    provider: 'google-ai',
    apiKey: 'test',
    model: 'gemini-3.5-flash-lite',
  });
  const env = { GEMINI_API_KEY: 'test', NUBBIX_GOOGLE_AI_MODEL: ' custom-model ' };
  assert.deepEqual(readSettings('google-ai', env), {
    provider: 'google-ai',
    apiKey: 'test',
    model: 'custom-model',
  });
  assert.equal(env.NUBBIX_GOOGLE_AI_MODEL, ' custom-model ');
});

test('google-ai: exige su propia clave y rechaza claves vacías', () => {
  for (const env of [
    {},
    { OPENAI_API_KEY: 'test', XAI_API_KEY: 'test' },
    { GEMINI_API_KEY: '' },
    { GEMINI_API_KEY: ' ' },
  ]) {
    assert.throws(
      () => readSettings('google-ai', env),
      (error: unknown) => error instanceof AppError && error.code === 'missing_key',
    );
  }
  assert.throws(
    () => readSettings('openai', { GEMINI_API_KEY: 'test' }),
    (error: unknown) => error instanceof AppError && error.code === 'missing_key',
  );
});

test('google-ai: un modelo explícito vacío es un error de configuración', () => {
  for (const model of ['', ' ']) {
    assert.throws(
      () => readSettings('google-ai', { GEMINI_API_KEY: 'test', NUBBIX_GOOGLE_AI_MODEL: model }),
      (error: unknown) => error instanceof AppError && error.code === 'configuration_error',
    );
  }
});

test('archivo explícito y entorno se combinan sin mutar el entorno global', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nubbix-env-'));
  try {
    const path = join(directory, 'test.env');
    await writeFile(path, 'XAI_API_KEY="fake-file"\nNUBBIX_XAI_MODEL=from-file\n');
    const env = { XAI_API_KEY: 'fake-process' };
    assert.deepEqual(await readEnvironment(path, env), {
      XAI_API_KEY: 'fake-process',
      NUBBIX_XAI_MODEL: 'from-file',
    });
    assert.deepEqual(env, { XAI_API_KEY: 'fake-process' });
    await assert.rejects(
      readEnvironment(join(directory, 'missing'), {}),
      (e: unknown) => e instanceof AppError && e.code === 'configuration_error',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('errores inesperados no exponen credenciales ni texto del SDK', () => {
  const result = publicError(new Error('secret-key ticket privado'));
  assert.equal(result.error.code, 'internal_error');
  assert.doesNotMatch(JSON.stringify(result), /secret-key|privado/);
});

test('config compilada sigue leyendo .env de la raíz desde otro cwd y conserva precedencia', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nubbix-env-layout-'));
  const project = join(directory, 'typescript-basic');
  try {
    await mkdir(project);
    await cp(new URL('../dist/', import.meta.url), join(project, 'dist'), { recursive: true });
    await writeFile(join(project, 'package.json'), '{"type":"module"}');
    await writeFile(join(directory, '.env'), 'NUBBIX_LAYOUT_CHECK=fake-file\n');
    await symlink(
      fileURLToPath(new URL('../node_modules/', import.meta.url)),
      join(project, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const entry = pathToFileURL(join(project, 'dist/config/environment.js')).href;
    const script = `const {readEnvironment}=await import(${JSON.stringify(entry)}); const file=await readEnvironment(undefined,{}); const processValue=await readEnvironment(undefined,{NUBBIX_LAYOUT_CHECK:'fake-process'}); console.log(JSON.stringify([file.NUBBIX_LAYOUT_CHECK,processValue.NUBBIX_LAYOUT_CHECK]));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['fake-file', 'fake-process']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
