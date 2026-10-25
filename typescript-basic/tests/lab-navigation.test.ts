import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LabNavigation } from '../src/web/client/lab-navigation.js';

test('navegación: hash histórico, back y foco muestran sólo una vista sin borrar formularios', () => {
  const dom = new JSDOM(
    '<nav><a data-lab-link href="#ticket-title">Soporte</a><a data-lab-link href="#evaluation-panel">Evaluaciones</a><a data-lab-link href="#history-panel">Historial</a><a data-lab-link href="#guide-panel">Guía</a></nav><section data-lab-view="support"><h1 id="ticket-title" tabindex="-1">Soporte</h1><input value="borrador"><div id="inspector-panel"></div></section><section data-lab-view="evaluations"><h1 id="evaluation-panel" tabindex="-1">Evaluaciones</h1></section><section data-lab-view="history"><h1 id="history-panel" tabindex="-1">Historial</h1></section><section data-lab-view="guide"><h1 id="guide-panel" tabindex="-1">Guía</h1></section>',
    { url: 'http://localhost/#evaluation-panel' },
  );
  const navigation = new LabNavigation(dom.window.document);
  navigation.initialize();
  assert.equal(dom.window.document.querySelectorAll('[data-lab-view]:not([hidden])').length, 1);
  assert.equal(
    dom.window.document.querySelector('[data-lab-view="evaluations"]')!.hasAttribute('hidden'),
    false,
  );
  navigation.open('support');
  assert.equal(dom.window.document.activeElement!.id, 'ticket-title');
  assert.equal(dom.window.document.querySelector('input')!.value, 'borrador');
  assert.equal(
    dom.window.document.querySelector('[href="#ticket-title"]')!.getAttribute('aria-current'),
    'page',
  );
  dom.window.history.replaceState(null, '', '#history-panel');
  dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
  assert.equal(
    dom.window.document.querySelector('[data-lab-view="history"]')!.hasAttribute('hidden'),
    false,
  );
  dom.window.history.replaceState(null, '', '#main-content');
  dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
  assert.equal(
    dom.window.document.querySelector('[data-lab-view="history"]')!.hasAttribute('hidden'),
    false,
  );
  dom.window.history.replaceState(null, '', '#inspector-panel');
  dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
  assert.equal(
    dom.window.document.querySelector('[data-lab-view="support"]')!.hasAttribute('hidden'),
    false,
  );
  dom.window.close();
});
