import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { InspectorView } from '../src/web/client/inspector-view.js';

test('inspector distingue las decisiones y los prompts de los detalles técnicos sin ejecutar HTML', () => {
  const dom = new JSDOM('<div id="inspector"></div>');
  const container = dom.window.document.querySelector<HTMLElement>('#inspector')!;
  const view = new InspectorView(container);
  const common = {
    requestId: '11111111-1111-4111-8111-111111111111',
    timestamp: '2026-10-25T12:00:00.000Z',
    stage: 'input_moderation' as const,
    attempt: 1,
  };
  view.append({
    ...common,
    sequence: 1,
    kind: 'llm.request',
    data: {
      systemPrompt: 'Instrucción confiable',
      userContent: '<img src=x onerror=alert(1)>',
      responseSchema: { type: 'object' },
      maxOutputTokens: 128,
    },
  });
  view.append({
    ...common,
    sequence: 2,
    kind: 'llm.response',
    data: { status: 'ok', text: '{"decision":"review"}', usage: { inputTokens: 32 } },
  });
  assert.match(container.textContent!, /Instrucciones del sistema/);
  assert.match(container.textContent!, /Contenido enviado como usuario/);
  assert.match(container.textContent!, /Revisión requerida/);
  assert.match(container.textContent!, /Moderación de entrada/);
  assert.equal(container.querySelectorAll('img').length, 0);
  assert.equal(container.querySelectorAll('details[open]').length, 0);
  dom.window.close();
});
