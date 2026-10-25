import { readFile } from 'node:fs/promises';

// src/ y dist/ tienen el mismo padre: fuente y paquete compilado leen los mismos assets.
// El build copia datos estáticos, no importa ni ejecuta ningún módulo Python.
export async function readSharedResource(
  name: 'prices.yaml' | 'datasets/tickets.jsonl' | 'datasets/adversarial.jsonl',
): Promise<string> {
  return readFile(new URL(`../dist/resources/shared/${name}`, import.meta.url), 'utf8');
}
