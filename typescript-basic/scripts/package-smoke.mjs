/**
 * Prueba de humo del artefacto distribuible: empaqueta, instala en un directorio temporal y ejecuta
 * CLI/evals con respuestas falsas. Detecta recursos ausentes o dependencias mal resueltas que un
 * test desde el repositorio podría ocultar. La instalación usa caché npm; los SDK no llaman a la API.
 */
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

/** Ejecuta una etapa del smoke en otro proceso y falla con su diagnóstico si no termina con éxito. */
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
    'dist/prompting/prompt-registry.yaml',
    'dist/resources/shared/prices.yaml',
    'dist/resources/shared/datasets/tickets.jsonl',
    'dist/resources/shared/datasets/adversarial.jsonl',
    'dist/prompting/versions/basic-v1/system.yaml',
    'dist/prompting/versions/basic-v1/context.yaml',
    'dist/prompting/versions/basic-v1/safety.yaml',
    'dist/prompting/versions/basic-v2/system.yaml',
    'dist/prompting/versions/basic-v2/context.yaml',
    'dist/prompting/versions/basic-v2/safety.yaml',
    'dist/prompting/versions/basic-v2/examples.yaml',
    'dist/web/public/index.html',
    'dist/web/public/app.js',
    'dist/web/public/styles.css',
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
  const fixture = String.raw`
    import assert from 'node:assert/strict';
    const {SupportAssistant,loadPrompts,loadPrices,readRuntimeSettings,PromptRegistry}=await import(${JSON.stringify(pathToFileURL(join(installed, 'dist', 'index.js')).href)});
    const {readFile,writeFile,mkdir,copyFile}=await import('node:fs/promises');
    const {createRequire}=await import('node:module');
    const {parse,stringify}=createRequire(${JSON.stringify(join(installed, 'package.json'))})('yaml');
    const registryPath=${JSON.stringify(join(installed, 'dist', 'prompting', 'prompt-registry.yaml'))};
    const manifest=parse(await readFile(registryPath,'utf8'));
    const sourcePrompt=manifest.prompts[0];
    manifest.prompts.push({id:'smoke-v3',label:'Variante de empaquetado',system:'versions/smoke-v3/system.yaml',context:'versions/smoke-v3/context.yaml',safety:'versions/smoke-v3/safety.yaml'});
    const prompting=${JSON.stringify(join(installed, 'dist', 'prompting'))};
    const {join}=await import('node:path');
    await mkdir(join(prompting,'versions/smoke-v3'),{recursive:true});
    await copyFile(join(prompting,sourcePrompt.context),join(prompting,'versions/smoke-v3/context.yaml'));
    await copyFile(join(prompting,sourcePrompt.safety),join(prompting,'versions/smoke-v3/safety.yaml'));
    await writeFile(join(prompting,'versions/smoke-v3/system.yaml'),stringify({version:'smoke-v3',system:'Clasificá la consulta y respetá el manual. {{manual}}'}));
    await writeFile(registryPath,stringify(manifest));
    const {pathToFileURL}=await import('node:url');
    const registry=await PromptRegistry.load(pathToFileURL(registryPath));
    assert.ok(registry.has('smoke-v3'));
    const {EvalRunner}=await import(${JSON.stringify(pathToFileURL(join(installed, 'dist', 'evals', 'runner.js')).href)});
    const prices=await loadPrices();
    const settings=readRuntimeSettings({});
    assert.match((await loadPrompts('basic-v2')).system,/EJEMPLOS INDEPENDIENTES/);
    const provider={async complete(request){return {status:'completed',usage:{inputTokens:20,outputTokens:10,cachedInputTokens:0,cacheWriteInputTokens:0},text:JSON.stringify(request.schemaName==='safety_assessment'?{decision:'allow'}:{answer:'Propuesta sintética',confidence:0.8,category:'other',actions:[]})};}};
    const runner=new EvalRunner({registry,provider:'google-ai',model:'gemini-3.5-flash-lite',settings,prices,evidence:'fake',outputDir:${JSON.stringify(join(temporary, 'reports'))},factory:({prompts})=>new SupportAssistant({provider,providerName:'google-ai',model:'gemini-3.5-flash-lite',settings,prices,prompts})});
    const [report]=await runner.run({promptVersions:['smoke-v3'],split:'dev',suite:'adversarial'});
    assert.equal(report.complete,true);
    assert.equal(report.records.length,20);
    assert.equal(report.provenance.evidence,'fake');
    assert.ok(report.provenance.sdkVersions.xai);
    assert.ok(report.provenance.sdkVersions['google-ai']);
    assert.equal(report.provider,'google-ai');
    assert.equal(report.promptVersion,'smoke-v3');
    const {createApp}=await import(${JSON.stringify(pathToFileURL(join(installed, 'dist', 'web', 'app.js')).href)});
    const {DemoProvider}=await import(${JSON.stringify(pathToFileURL(join(installed, 'dist', 'web', 'demo-provider.js')).href)});
    const {LabStore}=await import(${JSON.stringify(pathToFileURL(join(installed, 'dist', 'lab', 'storage.js')).href)});
    const store=new LabStore(${JSON.stringify(join(temporary, 'smoke.sqlite'))});
    const app=createApp({store,configuration:{mode:'demo',providers:[{id:'google-ai',label:'Google AI',model:'gemini-3.5-flash-lite',available:true}],promptVersions:registry.versions.map(entry=>entry.id),prompts:[...registry.versions],defaultPromptVersion:registry.defaultVersion,baselinePromptVersion:registry.baselineVersion,maxConcurrent:2},createAssistant:(_provider,version)=>new SupportAssistant({provider:new DemoProvider(),providerName:'google-ai',model:'gemini-3.5-flash-lite',prompts:registry.get(version),prices,settings})});
    const server=app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    try {
      const origin='http://127.0.0.1:'+server.address().port;
      assert.equal((await fetch(origin+'/')).status,200);
      assert.equal((await fetch(origin+'/app.js')).status,200);
      const config=await (await fetch(origin+'/api/config')).json();
      assert.ok(config.promptVersions.includes('smoke-v3'));
      const stream=await fetch(origin+'/api/support/stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Necesito una factura',provider:'google-ai',promptVersion:'smoke-v3'})});
      const frames=(await stream.text()).trim().split('\n').map(line=>JSON.parse(line));
      assert.equal(frames[0].type,'accepted');
      assert.equal(frames.at(-1).type,'result');
      assert.equal(frames.at(-1).mode,'demo');
      assert.equal(frames.at(-1).trace.promptVersion,'smoke-v3');
      assert.equal(frames.filter(frame=>frame.type==='event'&&frame.event.event==='llm.request.started').length,3);
      assert.equal(frames.filter(frame=>frame.type==='inspection'&&frame.inspection.kind==='llm.response').length,3);
      const history=await (await fetch(origin+'/api/history')).json();
      assert.equal(history.total,1);
      const detail=await (await fetch(origin+'/api/history/'+history.items[0].id)).json();
      assert.equal(detail.status,'completed');
      assert.equal(detail.result.response.category,'billing');
      assert.ok(detail.inspections.some(entry=>entry.kind==='input.validated'));
    } finally {
      await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
      await app.drain();
      store.close();
    }
  `;
  const fixturePath = join(temporary, 'eval-smoke.mjs');
  await writeFile(fixturePath, fixture);
  run(process.execPath, [fixturePath], temporary);
  console.log(
    'Package smoke OK: CLI, YAML, corpus, SDK hoisting, evals y panel HTTP demo offline.',
  );
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
