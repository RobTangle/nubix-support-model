import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { LabController } from '../src/web/client/lab-controller.js';
import { LabApi } from '../src/web/client/lab-api.js';
import { LabNavigation } from '../src/web/client/lab-navigation.js';

const id = '11111111-1111-4111-8111-111111111111';
const summary = {
  id,
  kind: 'support',
  mode: 'demo',
  provider: 'openai',
  model: 'fixture',
  promptVersion: 'basic-v1',
  status: 'completed',
  createdAt: '2026-10-25T12:00:00.000Z',
  finishedAt: '2026-10-25T12:01:00.000Z',
  parentId: null,
};
const configuration = {
  mode: 'demo',
  providers: [{ id: 'openai', label: 'OpenAI', model: 'fixture', available: true }],
  promptVersions: ['basic-v1', 'basic-v2', 'basic-v3'],
  defaultPromptVersion: 'basic-v1',
  baselinePromptVersion: 'basic-v1',
  maxConcurrent: 1,
} as const;

function fixture() {
  return new JSDOM(
    `<div id="evaluation-results"></div><form id="evaluation-form"><select id="evaluation-provider"></select><select id="evaluation-operation"><option value="run">run</option><option value="compare">compare</option><option value="adversarial">adversarial</option></select><div id="evaluation-single-prompt"><select id="evaluation-prompt"></select></div><div id="evaluation-versions-label"><fieldset id="evaluation-versions"></fieldset></div><div id="evaluation-baseline-label"><select id="evaluation-baseline"></select></div><select id="evaluation-split"><option value="dev">dev</option><option value="test">test</option></select><input type="checkbox" id="evaluation-moderation"><button id="evaluation-start">Iniciar</button></form><button id="evaluation-cancel">Cancelar</button><div id="evaluation-mode"></div><div id="evaluation-id"></div><div id="evaluation-status"></div><p id="evaluation-explanation"></p><p id="evaluation-plan"></p><p id="evaluation-comparison-help"></p><p id="evaluation-feedback"></p><section id="evaluation-panel"></section><h2 id="timeline-title"></h2><button id="history-refresh">Actualizar</button><select id="history-kind"><option value="support">support</option><option value="evaluation">evaluation</option></select><button id="history-previous">Anterior</button><button id="history-next">Siguiente</button><div id="history-status"></div><div id="history-origin"><input id="history-include-evaluations" type="checkbox"></div><p id="history-scope"></p><select id="history-provider"><option value=""></option></select><select id="history-prompt"><option value=""></option></select><select id="history-status-filter"><option value=""></option></select><select id="history-mode"><option value=""></option></select><button id="history-clear" type="button">Limpiar filtros</button><div id="history-list"></div>`,
    { url: 'http://localhost/' },
  );
}

test('comparación: checkboxes accesibles, conteo y baseline obligatorio antes de consumir API', async () => {
  const dom = fixture();
  let posts = 0;
  const controller = new LabController(
    dom.window.document,
    new LabApi(async (_input, init) => {
      if (init?.method === 'POST') posts++;
      return Response.json({ items: [], total: 0 });
    }),
    () => {},
  );
  controller.initialize(configuration as never);
  const document = dom.window.document;
  const operation = document.querySelector<HTMLSelectElement>('#evaluation-operation')!;
  operation.value = 'compare';
  operation.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.querySelectorAll('input[name=promptVersions]').length, 3);
  assert.match(document.querySelector('#evaluation-plan')!.textContent!, /180/);
  assert.match(document.querySelector('#evaluation-comparison-help')!.textContent!, /referencia/i);
  const baseline = document.querySelector<HTMLInputElement>(
    'input[name=promptVersions][value="basic-v1"]',
  )!;
  baseline.checked = false;
  baseline.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  document
    .querySelector('form')!
    .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await delay(1);
  assert.equal(posts, 0);
  assert.match(document.querySelector('#evaluation-status')!.textContent!, /referencia/);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

test('crear evaluación bloquea configuración y dobles envíos mientras espera al servidor', async () => {
  const dom = fixture();
  let resolveStart!: (response: Response) => void;
  let posts = 0;
  const controller = new LabController(
    dom.window.document,
    new LabApi(async (_input, init) => {
      if (init?.method !== 'POST') return Response.json({ items: [], total: 0 });
      posts++;
      return new Promise<Response>((resolve) => {
        resolveStart = resolve;
      });
    }),
    () => {},
  );
  controller.initialize(configuration as never);
  const form = dom.window.document.querySelector('form')!;
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.equal(posts, 1);
  assert.equal(
    dom.window.document.querySelector<HTMLSelectElement>('#evaluation-provider')!.disabled,
    true,
  );
  assert.equal(
    dom.window.document.querySelector<HTMLSelectElement>('#evaluation-operation')!.disabled,
    true,
  );
  resolveStart(Response.json({ error: 'fixture' }, { status: 400 }));
  await delay(5);
  assert.equal(
    dom.window.document.querySelector<HTMLSelectElement>('#evaluation-provider')!.disabled,
    false,
  );
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

test('historial: tarjetas legibles y navegación a ticket guardado sólo con GET', async () => {
  const dom = fixture();
  const views: string[] = [];
  let restored = false;
  const controller = new LabController(
    dom.window.document,
    new LabApi(async (input, init) => {
      assert.equal(init?.method ?? 'GET', 'GET');
      return String(input).startsWith('/api/history?')
        ? Response.json({ items: [summary], total: 1 })
        : Response.json({
            ...summary,
            input: {},
            result: null,
            error: null,
            events: [],
            inspections: [],
          });
    }),
    () => {
      restored = true;
    },
    (view) => {
      views.push(view);
    },
  );
  controller.initialize(configuration as never);
  await delay(5);
  assert.match(dom.window.document.querySelector('#history-list')!.textContent!, /Completada/);
  assert.equal(dom.window.document.querySelectorAll('#history-list time').length, 1);
  assert.match(
    dom.window.document.querySelector('#history-list details')!.textContent!,
    new RegExp(id),
  );
  dom.window.document.querySelector<HTMLButtonElement>('.history-entry')!.click();
  await delay(5);
  assert.equal(restored, true);
  assert.deepEqual(views, ['support']);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

test('historial: respuesta vieja no reemplaza la página más reciente aunque fetch ignore abort', async () => {
  const dom = fixture();
  const pending: ((response: Response) => void)[] = [];
  const controller = new LabController(
    dom.window.document,
    new LabApi(
      async () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    ),
    () => {},
  );
  controller.initialize(configuration as never);
  const refreshed = controller.refresh();
  pending[1]!(Response.json({ items: [], total: 0 }));
  await refreshed;
  pending[0]!(Response.json({ items: [summary], total: 1 }));
  await delay(5);
  assert.equal(dom.window.document.querySelectorAll('.history-entry').length, 0);
  assert.match(dom.window.document.querySelector('#history-list')!.textContent!, /Todavía no/);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

test('historial: ajusta una página que quedó fuera de rango y recupera errores sin consumo', async () => {
  const dom = fixture();
  const offsets: string[] = [];
  let unavailable = false;
  let total = 31;
  const controller = new LabController(
    dom.window.document,
    new LabApi(async (input) => {
      offsets.push(String(input));
      if (unavailable) return new Response('', { status: 500 });
      return Response.json({ items: [summary], total });
    }),
    () => {},
  );
  controller.initialize(configuration as never);
  await delay(5);
  total = 1;
  dom.window.document.querySelector<HTMLButtonElement>('#history-next')!.click();
  await delay(5);
  assert.deepEqual(offsets.slice(-2), [
    '/api/history?kind=support&limit=30&offset=30',
    '/api/history?kind=support&limit=30&offset=0',
  ]);
  assert.match(dom.window.document.querySelector('#history-status')!.textContent!, /1–1 de 1/);
  unavailable = true;
  await controller.refresh();
  assert.match(dom.window.document.querySelector('#history-status')!.textContent!, /No se pudo/);
  assert.equal(
    dom.window.document.querySelector('#history-list')!.getAttribute('aria-busy'),
    'false',
  );
  unavailable = false;
  await controller.refresh();
  assert.match(dom.window.document.querySelector('#history-status')!.textContent!, /1–1 de 1/);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

test('historial: sólo restaura el último ticket seleccionado aunque las lecturas resuelvan fuera de orden', async () => {
  const dom = fixture();
  const otherId = '22222222-2222-4222-8222-222222222222';
  const pending: ((response: Response) => void)[] = [];
  const restored: string[] = [];
  const controller = new LabController(
    dom.window.document,
    new LabApi(async (input) => {
      if (String(input).startsWith('/api/history?'))
        return Response.json({ items: [summary, { ...summary, id: otherId }], total: 2 });
      return new Promise<Response>((resolve) => {
        pending.push(resolve);
      });
    }),
    (detail) => {
      restored.push(detail.id);
    },
  );
  controller.initialize(configuration as never);
  await delay(5);
  const buttons = dom.window.document.querySelectorAll<HTMLButtonElement>('.history-entry');
  buttons[0]!.click();
  buttons[1]!.click();
  const detail = { ...summary, input: {}, result: null, error: null, events: [], inspections: [] };
  pending[1]!(Response.json({ ...detail, id: otherId }));
  await delay(5);
  pending[0]!(Response.json(detail));
  await delay(5);
  assert.deepEqual(restored, [otherId]);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

test('evaluación: al cambiar baseline la incluye y ablación explica sus 40 casos', () => {
  const dom = fixture();
  const controller = new LabController(
    dom.window.document,
    new LabApi(async () => Response.json({ items: [], total: 0 })),
    () => {},
  );
  controller.initialize(configuration as never);
  const document = dom.window.document;
  const selected = document.querySelector<HTMLInputElement>('input[value="basic-v3"]')!;
  selected.checked = false;
  const baseline = document.querySelector<HTMLSelectElement>('#evaluation-baseline')!;
  baseline.value = 'basic-v3';
  baseline.dispatchEvent(new dom.window.Event('change'));
  assert.equal(selected.checked, true);
  const operation = document.querySelector<HTMLSelectElement>('#evaluation-operation')!;
  operation.value = 'adversarial';
  operation.dispatchEvent(new dom.window.Event('change'));
  const moderation = document.querySelector<HTMLInputElement>('#evaluation-moderation')!;
  moderation.checked = true;
  moderation.dispatchEvent(new dom.window.Event('change'));
  assert.match(document.querySelector('#evaluation-plan')!.textContent!, /40 ejecuciones/);
  assert.match(document.querySelector('#evaluation-explanation')!.textContent!, /sin moderación/);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

test('abrir un ticket mientras llega una evaluación lenta no cambia luego la vista seleccionada', async () => {
  const dom = fixture();
  const views: string[] = [];
  let resolveEvaluation!: (response: Response) => void;
  const controller = new LabController(
    dom.window.document,
    new LabApi(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/history?'))
        return Response.json({ items: [{ ...summary, kind: 'evaluation' }, summary], total: 2 });
      if (url.startsWith('/api/evaluations/'))
        return new Promise<Response>((resolve) => {
          resolveEvaluation = resolve;
        });
      return Response.json({
        ...summary,
        input: {},
        result: null,
        error: null,
        events: [],
        inspections: [],
      });
    }),
    () => {},
    (view) => {
      views.push(view);
    },
  );
  controller.initialize(configuration as never);
  await delay(5);
  const buttons = dom.window.document.querySelectorAll<HTMLButtonElement>('.history-entry');
  buttons[0]!.click();
  buttons[1]!.click();
  await delay(5);
  resolveEvaluation(
    Response.json({
      job: {
        ...summary,
        kind: 'evaluation',
        input: {},
        result: null,
        error: null,
        events: [],
        inspections: [],
      },
      reports: [],
      progress: { completed: 0, total: 0 },
      assessments: [],
      selection: null,
    }),
  );
  await delay(5);
  assert.deepEqual(views, ['support']);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

test('fallo de lectura mantiene posibilidad de cancelar explícitamente sin iniciar otro trabajo', async () => {
  const dom = fixture();
  const posts: string[] = [];
  const controller = new LabController(
    dom.window.document,
    new LabApi(async (input, init) => {
      if (String(input).startsWith('/api/history?'))
        return Response.json({
          items: [{ ...summary, kind: 'evaluation', status: 'running' }],
          total: 1,
        });
      if (init?.method === 'POST') {
        posts.push(String(input));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 500 });
    }),
    () => {},
  );
  controller.initialize(configuration as never);
  await delay(5);
  dom.window.document.querySelector<HTMLButtonElement>('.history-entry')!.click();
  await delay(5);
  assert.equal(
    dom.window.document.querySelector<HTMLButtonElement>('#evaluation-start')!.disabled,
    true,
  );
  const cancel = dom.window.document.querySelector<HTMLButtonElement>('#evaluation-cancel')!;
  assert.equal(cancel.disabled, false);
  cancel.click();
  cancel.click();
  await delay(5);
  assert.deepEqual(posts, [`/api/evaluations/${id}/cancel`]);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

for (const kind of ['support', 'evaluation'] as const) {
  for (const action of ['click', 'hashchange', 'popstate'] as const) {
    test(`navegación manual ${action}: una apertura lenta de ${kind} no abandona la guía ni cancela trabajos`, async () => {
      const dom = fixture();
      const document = dom.window.document;
      document.body.insertAdjacentHTML(
        'afterbegin',
        '<nav><a data-lab-link href="#guide-panel">Guía</a></nav><section data-lab-view="support"><h2 id="ticket-title" tabindex="-1">Ticket</h2></section><section data-lab-view="history"><h2 id="history-panel" tabindex="-1">Historial</h2></section><section data-lab-view="guide"><h2 id="guide-panel" tabindex="-1">Guía</h2></section>',
      );
      document.querySelector('#evaluation-panel')!.setAttribute('data-lab-view', 'evaluations');
      let resolveOpening!: (response: Response) => void;
      let readingSignal: AbortSignal | null | undefined;
      let restored = false;
      const navigation = new LabNavigation(document);
      navigation.initialize();
      const controller = new LabController(
        document,
        new LabApi(async (input, init) => {
          assert.equal(init?.method ?? 'GET', 'GET');
          if (String(input).startsWith('/api/history?'))
            return Response.json({ items: [{ ...summary, kind }], total: 1 });
          readingSignal = init?.signal;
          return new Promise<Response>((resolve) => {
            resolveOpening = resolve;
          });
        }),
        () => {
          restored = true;
        },
        (view) => navigation.open(view),
      );
      controller.initialize(configuration as never);
      await delay(5);
      document.querySelector<HTMLButtonElement>('.history-entry')!.click();
      if (action === 'click') document.querySelector<HTMLAnchorElement>('[data-lab-link]')!.click();
      else {
        dom.window.history.pushState(null, '', '#guide-panel');
        dom.window.dispatchEvent(new dom.window.Event(action));
      }
      const detail = {
        ...summary,
        kind,
        input: {},
        result: null,
        error: null,
        events: [],
        inspections: [],
      };
      resolveOpening(
        Response.json(
          kind === 'support'
            ? detail
            : {
                job: detail,
                reports: [],
                progress: { completed: 0, total: 0 },
                assessments: [],
                selection: null,
              },
        ),
      );
      await delay(5);
      assert.equal(dom.window.location.hash, '#guide-panel');
      assert.equal(document.querySelector<HTMLElement>('[data-lab-view=guide]')!.hidden, false);
      assert.equal(restored, false);
      assert.equal(readingSignal?.aborted, kind === 'support');
      dom.window.dispatchEvent(new dom.window.Event('pagehide'));
      dom.window.close();
    });
  }
}
