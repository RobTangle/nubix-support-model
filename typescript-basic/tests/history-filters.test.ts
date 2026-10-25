import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { LabController } from '../src/web/client/lab-controller.js';
import { LabApi } from '../src/web/client/lab-api.js';
import { HistoryFilters } from '../src/web/client/history-filters.js';

test('UI historial: vacío filtrado ofrece limpiar y opciones históricas son texto inerte', async () => {
  const html = await readFile(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  const document = dom.window.document;
  const controller = new LabController(
    document,
    new LabApi(async () => Response.json({ items: [], total: 0 })),
    () => {},
  );
  try {
    controller.initialize({
      mode: 'demo',
      providers: [],
      promptVersions: ['basic-v1'],
      maxConcurrent: 1,
    });
    await delay(5);
    const filters = new HistoryFilters(document);
    filters.populate({ providers: ['openai'], promptVersions: ['<img src=x onerror=alert(1)>'] });
    const prompt = document.querySelector<HTMLSelectElement>('#history-prompt')!;
    prompt.value = '<img src=x onerror=alert(1)>';
    prompt.dispatchEvent(new dom.window.Event('change'));
    await delay(5);
    assert.equal(document.querySelectorAll('img').length, 0);
    assert.equal(prompt.value, '<img src=x onerror=alert(1)>');
    assert.match(document.querySelector('#history-list')!.textContent!, /Limpiar filtros/);
    assert.match(document.querySelector('#history-status')!.textContent!, /No hay resultados/);
  } finally {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close();
  }
});

test('UI historial: filtros combinados reinician paginación, se limpian y no llaman al modelo', async () => {
  const html = await readFile(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  const document = dom.window.document;
  const requests: URL[] = [];
  const api = new LabApi(async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET');
    requests.push(new URL(String(input), 'http://localhost'));
    return Response.json({
      items: [],
      total: 35,
      filterOptions: {
        providers: ['openai', 'google-ai'],
        promptVersions: ['basic-v1', 'retired-v0'],
      },
    });
  });
  const controller = new LabController(document, api, () => {});
  try {
    controller.initialize({
      mode: 'demo',
      providers: [],
      promptVersions: ['basic-v1'],
      maxConcurrent: 1,
    });
    await delay(5);
    const include = document.querySelector<HTMLInputElement>('#history-include-evaluations')!;
    assert.equal(include.checked, false);
    assert.ok(document.querySelector('#history-prompt option[value="retired-v0"]'));
    document.querySelector<HTMLButtonElement>('#history-next')!.click();
    await delay(5);
    assert.equal(requests.at(-1)!.searchParams.get('offset'), '30');
    for (const [id, value] of [
      ['history-provider', 'google-ai'],
      ['history-prompt', 'retired-v0'],
      ['history-status-filter', 'failed'],
      ['history-mode', 'live'],
    ]) {
      const select = document.getElementById(id!) as HTMLSelectElement;
      select.value = value!;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await delay(5);
    }
    include.checked = true;
    include.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await delay(5);
    const query = requests.at(-1)!.searchParams;
    assert.equal(query.get('offset'), '0');
    assert.equal(query.get('provider'), 'google-ai');
    assert.equal(query.get('promptVersion'), 'retired-v0');
    assert.equal(query.get('status'), 'failed');
    assert.equal(query.get('mode'), 'live');
    assert.equal(query.get('includeEvaluationCases'), 'true');
    const kind = document.querySelector<HTMLSelectElement>('#history-kind')!;
    kind.value = 'evaluation';
    kind.dispatchEvent(new dom.window.Event('change'));
    await delay(5);
    assert.equal(include.disabled, true);
    assert.equal(requests.at(-1)!.searchParams.has('includeEvaluationCases'), false);
    document.querySelector<HTMLButtonElement>('#history-clear')!.click();
    await delay(5);
    assert.equal(requests.at(-1)!.searchParams.get('kind'), 'evaluation');
    for (const field of ['provider', 'promptVersion', 'status', 'mode', 'includeEvaluationCases'])
      assert.equal(requests.at(-1)!.searchParams.has(field), false, field);
  } finally {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close();
  }
});
