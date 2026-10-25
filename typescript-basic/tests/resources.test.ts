import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readSharedResource } from '../src/resources.js';
import { hash } from '../src/evals/data.js';

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
