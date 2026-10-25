import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Ejecutar con npm run smoke:package para resolver npm de forma portable.');
const environment = { ...process.env };
for (const key of Object.keys(environment))
  if (/^(OPENAI_|XAI_|GEMINI_|NUBBIX_)/u.test(key)) delete environment[key];
environment.OPENAI_API_KEY = 'fake-smoke';
environment.XAI_API_KEY = 'fake-smoke';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? 'Proceso fallido'));
  return result;
}

const cache = run(process.execPath, [npmCli, 'config', 'get', 'cache'], source).stdout.trim();
const temporary = await mkdtemp(join(tmpdir(), 'nubbix-package-'));
try {
  const packed = JSON.parse(
    run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', temporary], source)
      .stdout,
  )[0];
  for (const resource of [
    'dist/resources/shared/prices.yaml',
    'dist/resources/shared/datasets/tickets.jsonl',
    'dist/resources/shared/datasets/adversarial.jsonl',
    'dist/resources/safety.yaml',
  ])
    assert.ok(packed.files.some((file) => file.path === resource));
  await writeFile(join(temporary, 'package.json'), '{"private":true,"type":"module"}\n');
  // Reutilizar las resoluciones del lockfile evita pedir metadatos de rangos a npm sin red.
  // El consumidor sólo declara el tarball; npm conserva las dependencias que éste requiere.
  await copyFile(join(source, 'package-lock.json'), join(temporary, 'package-lock.json'));
  run(
    process.execPath,
    [
      npmCli,
      'install',
      join(temporary, packed.filename),
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      cache,
    ],
    temporary,
  );
  const installed = join(temporary, 'node_modules', packed.name);
  const hook = join(temporary, 'mock-fetch.mjs');
  const emptyEnv = join(temporary, 'empty-env.txt');
  await copyFile(join(source, 'tests', 'fixtures', 'mock-fetch.mjs'), hook);
  await writeFile(emptyEnv, '# Sólo claves falsas del proceso de prueba.\n');
  const response = run(
    process.execPath,
    [
      '--import',
      pathToFileURL(hook).href,
      join(installed, 'dist', 'cli.js'),
      '--env-file',
      emptyEnv,
      '--text',
      'Factura sintética',
    ],
    temporary,
  );
  assert.equal(JSON.parse(response.stdout).category, 'billing');
  assert.equal(response.stderr.trim().split('\n').map(JSON.parse).at(-1).event, 'run_summary');
  const archiveRoot = join(installed, 'reports', 'manual-tests');
  const archivedTickets = await readdir(archiveRoot);
  assert.equal(archivedTickets.length, 1);
  const archiveFiles = await readdir(join(archiveRoot, archivedTickets[0]));
  assert.equal(archiveFiles.length, 1);
  const archived = JSON.parse(
    await readFile(join(archiveRoot, archivedTickets[0], archiveFiles[0]), 'utf8'),
  );
  assert.equal(archived.state, 'finished');
  assert.equal(archived.invocation.workingDirectory, temporary);
  assert.deepEqual(archived.response, JSON.parse(response.stdout));
  // Una factory falsa prueba el paquete instalado y su procedencia sin atribuir calidad al modelo.
  const fixture = `
    import assert from 'node:assert/strict';
    const {SupportAssistant,loadPrompts,loadPrices,readRuntimeSettings}=await import(${JSON.stringify(pathToFileURL(join(installed, 'dist', 'index.js')).href)});
    const {EvalRunner}=await import(${JSON.stringify(pathToFileURL(join(installed, 'dist', 'evals', 'runner.js')).href)});
    const prices=await loadPrices();
    const settings=readRuntimeSettings({});
    assert.match((await loadPrompts('basic-v2')).system,/EJEMPLOS INDEPENDIENTES/);
    const provider={async complete(request){return {status:'completed',usage:{inputTokens:20,outputTokens:10,cachedInputTokens:0,cacheWriteInputTokens:0},text:JSON.stringify(request.schemaName==='safety_assessment'?{decision:'allow'}:{answer:'Propuesta sintética',confidence:0.8,category:'other',actions:[]})};}};
    const runner=new EvalRunner({provider:'google-ai',model:'gemini-3.5-flash-lite',settings,prices,evidence:'fake',outputDir:${JSON.stringify(join(temporary, 'reports'))},factory:({prompts})=>new SupportAssistant({provider,providerName:'google-ai',model:'gemini-3.5-flash-lite',settings,prices,prompts})});
    const [report]=await runner.run({promptVersions:['basic-v1'],split:'dev',suite:'adversarial'});
    assert.equal(report.complete,true);
    assert.equal(report.records.length,20);
    assert.equal(report.provenance.evidence,'fake');
    assert.ok(report.provenance.sdkVersions.xai);
    assert.ok(report.provenance.sdkVersions['google-ai']);
    assert.equal(report.provider,'google-ai');
  `;
  const fixturePath = join(temporary, 'eval-smoke.mjs');
  await writeFile(fixturePath, fixture);
  run(process.execPath, [fixturePath], temporary);
  console.log('Package smoke OK: CLI, YAML, corpus, SDK hoisting y evals offline.');
} finally {
  // Verificar el destino antes de borrar recursivamente, también en Windows.
  const insideTemp = relative(resolve(tmpdir()), resolve(temporary));
  assert.ok(
    insideTemp &&
      !insideTemp.startsWith('..') &&
      !isAbsolute(insideTemp) &&
      basename(temporary).startsWith('nubbix-package-'),
  );
  await rm(temporary, { recursive: true, force: true });
}
