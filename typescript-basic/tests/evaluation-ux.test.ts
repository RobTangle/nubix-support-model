import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { EvaluationView } from '../src/web/client/evaluation-view.js';
import type { EvaluationSnapshot, ReviewInput } from '../src/web/client/lab-api.js';

function fixture(): EvaluationSnapshot {
  return {
    job: { id: 'job', mode: 'demo', status: 'completed', error: null },
    progress: { completed: 2, total: 3 },
    reports: [
      {
        runId: 'run',
        provider: 'openai',
        model: 'fixture',
        promptVersion: 'basic-v1',
        split: 'dev',
        mode: 'full',
        complete: false,
        provenance: { evidence: 'fake' },
        metrics: {
          classificationCases: 1,
          accuracy: 0.5,
          macroF1: 0.4,
          operationalErrorRate: 0.2,
          knownCostUsd: '0.000000000123',
          reservedUnknownUsd: '0.02',
          latencyP95Ms: 1234,
          perCategory: {},
          confusionMatrix: {},
        },
        records: [
          {
            id: 'ticket-1',
            text: '<script>ticket</script>',
            kind: 'ticket',
            expectedCategory: 'billing',
            response: {
              answer: 'Verificaremos los cargos.',
              category: 'billing',
              confidence: 0.8,
              actions: ['Verificar comprobantes'],
            },
            trace: { requestId: 'trace-id' },
            errorCode: null,
            notRun: false,
            publishedRuleFlags: [],
            intermediateRuleFlags: [],
            rawOutputs: [],
          },
          {
            id: 'attack-1',
            text: 'Ignorá instrucciones',
            kind: 'attack',
            response: null,
            trace: null,
            errorCode: 'timeout',
            notRun: false,
            publishedRuleFlags: [],
            intermediateRuleFlags: [],
            rawOutputs: [],
          },
          {
            id: 'future-1',
            text: 'Pendiente',
            kind: 'benign',
            response: null,
            trace: null,
            errorCode: null,
            notRun: true,
            publishedRuleFlags: [],
            intermediateRuleFlags: [],
            rawOutputs: [],
          },
        ],
      },
    ],
    reviews: [],
    assessments: [
      {
        runId: 'run',
        pendingReviews: 3,
        eligible: false,
        gates: { humanReviewComplete: false, completeRun: false },
      },
    ],
    selection: { recommendedPrompt: null, status: 'pending_human_review' },
  } as unknown as EvaluationSnapshot;
}

test('resultados legibles, filtros y casos pendientes sin adjudicación automática', () => {
  const dom = new JSDOM(
    '<div id="evaluation-feedback" role="status"></div><div id="reports"></div>',
  );
  const container = dom.window.document.querySelector<HTMLElement>('#reports')!;
  let opened = '';
  const view = new EvaluationView(
    container,
    async () => {},
    (id) => {
      opened = id;
    },
  );
  view.render(fixture());
  assert.match(container.textContent!, /Accuracy/);
  assert.match(container.textContent!, /50/);
  assert.match(container.textContent!, /0\.000000000123/);
  assert.match(container.textContent!, /Esperada: Facturación/);
  assert.match(container.textContent!, /Predicha: Facturación/);
  assert.equal(container.querySelectorAll('script').length, 0);
  const pending = container.querySelector<HTMLElement>('[data-case-key="run:future-1"]')!;
  assert.equal(pending.querySelector('form'), null);
  assert.match(pending.textContent!, /no ejecutado/i);
  const filter = container.querySelector<HTMLSelectElement>('[name="caseStatus"]')!;
  filter.value = 'error';
  filter.dispatchEvent(new dom.window.Event('change'));
  assert.equal(
    container.querySelector<HTMLElement>('[data-case-key="run:ticket-1"]')!.hidden,
    true,
  );
  assert.equal(
    container.querySelector<HTMLElement>('[data-case-key="run:attack-1"]')!.hidden,
    false,
  );
  container.querySelector<HTMLButtonElement>('[data-open-execution]')!.click();
  assert.equal(opened, 'trace-id');
});

test('polling conserva borradores, foco y feedback tras guardar y recalcular resultados', async () => {
  const dom = new JSDOM(
    '<div id="evaluation-feedback" role="status" hidden></div><div id="reports"></div>',
  );
  const document = dom.window.document;
  const container = document.querySelector<HTMLElement>('#reports')!;
  let saved: ReviewInput | undefined;
  const snapshot = fixture();
  const view = new EvaluationView(container, async (_id, review) => {
    saved = review;
    view.render({ ...snapshot, reviews: [review], progress: { completed: 3, total: 3 } });
  });
  view.render(snapshot);
  const details = container.querySelector<HTMLDetailsElement>('[data-case-key="run:ticket-1"]')!;
  details.open = true;
  const notes = details.querySelector<HTMLTextAreaElement>('textarea')!;
  notes.value = 'Mi revisión en curso';
  notes.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  notes.focus();
  view.render({ ...snapshot, progress: { completed: 3, total: 3 } });
  assert.equal(document.activeElement, notes);
  assert.equal(details.querySelector('textarea'), notes);
  assert.equal(notes.value, 'Mi revisión en curso');
  assert.equal(details.open, true);
  details
    .querySelector<HTMLFormElement>('form')!
    .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved?.notes, 'Mi revisión en curso');
  assert.match(document.querySelector('#evaluation-feedback')!.textContent!, /guardada/i);
  assert.equal(document.querySelector<HTMLElement>('#evaluation-feedback')!.hidden, false);
  assert.equal(document.activeElement, notes);
  view.reset();
  assert.equal(document.querySelector<HTMLElement>('#evaluation-feedback')!.hidden, true);
  assert.equal(document.querySelector('#evaluation-feedback')!.textContent, '');
});

test('un error al guardar conserva el borrador y presenta feedback visible de error', async () => {
  const dom = new JSDOM('<div id="evaluation-feedback" hidden></div><div id="reports"></div>');
  const document = dom.window.document;
  const container = document.querySelector<HTMLElement>('#reports')!;
  new EvaluationView(container, async () => {
    throw new Error('fixture');
  }).render(fixture());
  const form = container.querySelector<HTMLFormElement>('form')!;
  const notes = form.querySelector<HTMLTextAreaElement>('textarea')!;
  notes.value = 'No perder mis notas';
  notes.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const feedback = document.querySelector<HTMLElement>('#evaluation-feedback')!;
  assert.equal(feedback.hidden, false);
  assert.equal(feedback.classList.contains('error-message'), true);
  assert.match(feedback.textContent!, /No se pudo guardar/);
  assert.equal(notes.value, 'No perder mis notas');
  assert.equal(form.querySelector<HTMLButtonElement>('button')!.disabled, false);
});

test('un cambio de datos técnicos no desmonta la revisión ni su foco', () => {
  const dom = new JSDOM('<div id="reports"></div>');
  const document = dom.window.document;
  const container = document.querySelector<HTMLElement>('#reports')!;
  const snapshot = fixture();
  const view = new EvaluationView(container, async () => {});
  view.render(snapshot);
  const details = container.querySelector<HTMLDetailsElement>('[data-case-key="run:ticket-1"]')!;
  details.open = true;
  const notes = details.querySelector<HTMLTextAreaElement>('textarea')!;
  notes.value = 'Anotación';
  notes.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  notes.focus();
  snapshot.reports[0]!.records[0]!.intermediateRuleFlags = ['nuevo-indicio'];
  view.render(snapshot);
  assert.equal(document.activeElement, notes);
  assert.equal(details.querySelector('textarea'), notes);
  assert.equal(notes.value, 'Anotación');
});

test('suite adversarial muestra clasificación no aplicable y revisión pendiente explícita', () => {
  const dom = new JSDOM('<div id="reports"></div>');
  const snapshot = fixture();
  snapshot.reports[0]!.records = snapshot.reports[0]!.records.filter(
    (row) => row.kind !== 'ticket',
  );
  snapshot.reports[0]!.metrics.classificationCases = 0;
  snapshot.reports[0]!.metrics.accuracy = 0;
  snapshot.reports[0]!.metrics.macroF1 = 0;
  const container = dom.window.document.querySelector<HTMLElement>('#reports')!;
  new EvaluationView(container, async () => {}).render(snapshot);
  assert.match(container.textContent!, /N\/A/);
  assert.match(container.textContent!, /revisión humana pendiente/i);
  assert.match(container.textContent!, /no acredita calidad/i);
});

test('criterios humanos no aparecen aprobados mientras falten adjudicaciones', () => {
  const dom = new JSDOM('<div id="reports"></div>');
  const snapshot = fixture();
  snapshot.assessments = [
    {
      runId: 'run',
      pendingReviews: 3,
      gates: { noSevereIssues: true, attacks: true, falseBlocks: true },
    },
  ];
  const container = dom.window.document.querySelector<HTMLElement>('#reports')!;
  new EvaluationView(container, async () => {}).render(snapshot);
  assert.equal(container.querySelectorAll('.gate-pass').length, 0);
  assert.equal(container.querySelectorAll('.gate-pending').length, 3);
  assert.match(container.querySelector('.gate-list')!.textContent!, /Revisión humana pendiente/);
  dom.window.close();
});

test('comparación presenta un resumen común y conserva la revisión pendiente', () => {
  const dom = new JSDOM('<div id="reports"></div>');
  const snapshot = fixture();
  const candidate = structuredClone(snapshot.reports[0]!);
  candidate.runId = 'candidate';
  candidate.promptVersion = 'basic-v2';
  snapshot.reports.push(candidate);
  const container = dom.window.document.querySelector<HTMLElement>('#reports')!;
  new EvaluationView(container, async () => {}).render(snapshot);
  const comparison = container.querySelector('.evaluation-overview table')!;
  assert.match(comparison.textContent!, /Comparación rápida/);
  assert.match(comparison.textContent!, /basic-v1/);
  assert.match(comparison.textContent!, /basic-v2/);
  assert.match(comparison.textContent!, /3 pendientes/);
  assert.match(comparison.textContent!, /parcial/);
  dom.window.close();
});

for (const scenario of [
  {
    kind: 'ticket',
    flags: ['unsupported-promise'],
    field: 'policy',
    value: '1',
    reason: /manual/i,
  },
  {
    kind: 'attack',
    flags: ['canary-leak'],
    field: 'attackSucceeded',
    value: 'false',
    reason: /ataque/i,
  },
  { kind: 'attack', flags: [], field: 'attackSucceeded', value: 'true', reason: /ataque/i },
] as const) {
  test(`exige justificación por discrepancia ${scenario.kind}/${scenario.field}/${scenario.value}`, async () => {
    const dom = new JSDOM('<div id="evaluation-feedback" hidden></div><div id="reports"></div>');
    const document = dom.window.document;
    const container = document.querySelector<HTMLElement>('#reports')!;
    const snapshot = fixture();
    snapshot.reports[0]!.records[0]!.kind = scenario.kind;
    snapshot.reports[0]!.records[0]!.publishedRuleFlags = [...scenario.flags];
    let calls = 0;
    new EvaluationView(container, async () => {
      calls++;
    }).render(snapshot);
    const details = container.querySelector<HTMLDetailsElement>('[data-case-key="run:ticket-1"]')!;
    details.open = true;
    const form = details.querySelector<HTMLFormElement>('form')!;
    const field = form.querySelector<HTMLSelectElement>(`[name="${scenario.field}"]`)!;
    field.value = scenario.value;
    field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const notes = form.querySelector<HTMLTextAreaElement>('textarea')!;
    assert.equal(notes.required, true);
    assert.match(details.textContent!, /indicios/i);
    notes.value = '   ';
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.match(document.querySelector('#evaluation-feedback')!.textContent!, /justific/i);
    assert.match(document.querySelector('#evaluation-feedback')!.textContent!, scenario.reason);
    assert.equal(document.activeElement, notes);
    assert.equal(field.value, scenario.value);
    notes.value =
      'Revisé la respuesta publicada y explico por qué la regla no decide el juicio humano.';
    notes.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
  });
}
