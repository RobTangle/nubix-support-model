import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LabApi } from '../src/web/client/lab-api.js';
import { InspectorView } from '../src/web/client/inspector-view.js';
import { EvaluationView } from '../src/web/client/evaluation-view.js';
import { LabController } from '../src/web/client/lab-controller.js';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const id = '11111111-1111-4111-8111-111111111111';
const run = {
  id,
  kind: 'evaluation',
  mode: 'live',
  provider: 'openai',
  model: 'fixture',
  promptVersion: 'basic-v1',
  status: 'completed',
  createdAt: '2026-10-25T12:00:00.000Z',
  finishedAt: '2026-10-25T12:01:00.000Z',
  parentId: null,
  input: {},
  result: null,
  error: null,
  events: [],
  inspections: [],
};

test('laboratorio: consultar historial y reabrir evaluación sólo envía GET, sin consumir API', async () => {
  const requests: string[] = [];
  const api = new LabApi(async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    if (String(input).startsWith('/api/history?')) {
      const {
        input: _input,
        result: _result,
        error: _error,
        events: _events,
        inspections: _inspections,
        ...summary
      } = run;
      return Response.json({ items: [summary], total: 32 });
    }
    if (String(input) === `/api/history/${id}`) return Response.json(run);
    return Response.json({
      job: run,
      reports: [],
      progress: { completed: 0, total: 0 },
      assessments: [],
      selection: null,
    });
  });
  assert.equal((await api.history('evaluation', 30, 30)).total, 32);
  assert.equal((await api.detail(id)).mode, 'live');
  assert.equal((await api.evaluation(id, new AbortController().signal)).job.status, 'completed');
  assert.deepEqual(requests, [
    'GET /api/history?kind=evaluation&limit=30&offset=30',
    `GET /api/history/${id}`,
    `GET /api/evaluations/${id}`,
  ]);
});

test('laboratorio: errores HTTP y reportes inválidos no reflejan contenido privado', async () => {
  for (const response of [
    new Response('SECRET', { status: 500 }),
    Response.json({ job: run, reports: [{ records: 'SECRET' }] }),
  ]) {
    const api = new LabApi(async () => response);
    await assert.rejects(
      api.evaluation(id, new AbortController().signal),
      (error: unknown) => error instanceof Error && !error.message.includes('SECRET'),
    );
  }
});

test('inspector: separa depuración de la respuesta y presenta datos del modelo como texto inerte', () => {
  const dom = new JSDOM('<div id="inspections"></div>');
  const container = dom.window.document.querySelector<HTMLElement>('#inspections')!;
  const view = new InspectorView(container);
  view.append({
    requestId: id,
    sequence: 1,
    timestamp: run.createdAt,
    kind: 'llm.response',
    stage: 'generation',
    attempt: 1,
    data: { text: '<img src=x onerror=alert(1)>' },
  });
  assert.equal(container.querySelectorAll('img').length, 0);
  assert.match(container.textContent!, /<img src=x/);
  assert.match(container.textContent!, /sin moderar/i);
  view.reset();
  assert.equal(container.querySelectorAll('details').length, 0);
  dom.window.close();
});

test('evaluaciones: conserva decimales, restaura revisión y guarda juicios explícitos sin LLM juez', async () => {
  const dom = new JSDOM('<div id="reports"></div>');
  const container = dom.window.document.querySelector<HTMLElement>('#reports')!;
  let saved: unknown;
  const view = new EvaluationView(container, async (_reportId, review) => {
    saved = review;
  });
  view.render({
    job: run,
    reports: [
      {
        runId: id,
        provider: 'openai',
        model: 'fixture',
        promptVersion: 'basic-v1',
        split: 'dev',
        mode: 'full',
        complete: true,
        provenance: { evidence: 'live' },
        metrics: {
          knownCostUsd: '0.000000000123',
          reservedUnknownUsd: '0.2',
          confusionMatrix: {},
          perCategory: {},
        },
        records: [
          {
            id: 'case-1',
            text: '<script>bad()</script>',
            kind: 'ticket',
            response: { answer: 'Ayuda' },
            errorCode: null,
            publishedRuleFlags: [],
            intermediateRuleFlags: [],
            rawOutputs: [],
            trace: null,
            notRun: false,
          },
        ],
      },
    ],
    progress: { completed: 1, total: 1 },
    assessments: [],
    selection: null,
    reviews: [
      {
        runId: id,
        caseId: 'case-1',
        usefulness: 1,
        correctness: 0,
        policy: null,
        severeIssue: false,
        attackSucceeded: null,
        unjustifiedRefusal: null,
        notes: '<b>Revisado</b>',
      },
    ],
  } as never);
  assert.match(container.textContent!, /0.000000000123/);
  assert.match(container.textContent!, /case-1/);
  assert.match(container.textContent!, /sin moderar/i);
  assert.equal(container.querySelectorAll('script').length, 0);
  assert.equal(container.querySelectorAll('form').length, 1);
  assert.equal(container.querySelector<HTMLSelectElement>('[name=usefulness]')!.value, '1');
  assert.equal(container.querySelector<HTMLSelectElement>('[name=correctness]')!.value, '0');
  assert.equal(
    container.querySelector<HTMLTextAreaElement>('[name=notes]')!.value,
    '<b>Revisado</b>',
  );
  container.querySelector<HTMLSelectElement>('[name=policy]')!.value = '1';
  container
    .querySelector('form')!
    .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await delay(1);
  assert.deepEqual(saved, {
    runId: id,
    caseId: 'case-1',
    usefulness: 1,
    correctness: 0,
    policy: 1,
    severeIssue: false,
    attackSucceeded: null,
    unjustifiedRefusal: null,
    notes: '<b>Revisado</b>',
  });
  dom.window.close();
});

test('historial: pagina, selecciona y restaura datos guardados sin iniciar requests al proveedor', async () => {
  const html = await readFile(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  const urls: string[] = [];
  let restored: unknown;
  const {
    input: _input,
    result: _result,
    error: _error,
    events: _events,
    inspections: _inspections,
    ...summary
  } = run;
  const api = new LabApi(async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET');
    const url = String(input);
    urls.push(url);
    if (url.startsWith('/api/history?'))
      return Response.json({ items: [{ ...summary, kind: 'support' }], total: 31 });
    return Response.json({ ...run, kind: 'support', input: { text: 'Ticket anterior' } });
  });
  const controller = new LabController(dom.window.document, api, (value) => {
    restored = value;
  });
  controller.initialize({
    mode: 'live',
    providers: [{ id: 'openai', label: 'OpenAI', model: 'fixture', available: true }],
    promptVersions: ['basic-v1'],
    maxConcurrent: 1,
  });
  await delay(5);
  assert.match(
    dom.window.document.querySelector('#history-list')!.textContent!,
    /LIVE · completed/,
  );
  dom.window.document.querySelector<HTMLButtonElement>('#history-next')!.click();
  await delay(5);
  assert.equal(urls.at(-1), '/api/history?kind=support&limit=30&offset=30');
  dom.window.document.querySelector<HTMLButtonElement>('.history-entry')!.click();
  await delay(5);
  assert.equal((restored as { input: { text: string } }).input.text, 'Ticket anterior');
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

test('evaluaciones: desconectar la página aborta polling sin cancelar el trabajo persistente', async () => {
  const html = await readFile(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  let signal: AbortSignal | null | undefined;
  const requests: string[] = [];
  const {
    input: _input,
    result: _result,
    error: _error,
    events: _events,
    inspections: _inspections,
    ...summary
  } = run;
  const api = new LabApi(async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.startsWith('/api/history?')) return Response.json({ items: [summary], total: 1 });
    signal = init?.signal;
    return Response.json({
      job: { ...run, status: 'running', finishedAt: null },
      reports: [],
      progress: { completed: 2, total: 60 },
      assessments: [],
      selection: null,
    });
  });
  const controller = new LabController(dom.window.document, api, () => {});
  controller.initialize({
    mode: 'live',
    providers: [{ id: 'openai', label: 'OpenAI', model: 'fixture', available: true }],
    promptVersions: ['basic-v1'],
    maxConcurrent: 1,
  });
  const kind = dom.window.document.querySelector<HTMLSelectElement>('#history-kind')!;
  kind.value = 'evaluation';
  kind.dispatchEvent(new dom.window.Event('change'));
  await delay(5);
  dom.window.document.querySelector<HTMLButtonElement>('.history-entry')!.click();
  await delay(5);
  assert.match(
    dom.window.document.querySelector('#evaluation-status')!.textContent!,
    /LIVE · running · 2\/60/,
  );
  assert.equal(
    dom.window.document.querySelector<HTMLButtonElement>('#evaluation-cancel')!.disabled,
    false,
  );
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  assert.equal(signal?.aborted, true);
  assert.equal(
    requests.some((request) => request.startsWith('POST')),
    false,
  );
  dom.window.close();
});
