/**
 * Acceso a los archivos estáticos compartidos con Python: precios y datasets de evaluación.
 * El build los copia a dist/resources/shared; este módulo resuelve sus rutas para que fuente y
 * paquete compilado usen los mismos datos sin importar ni ejecutar módulos Python.
 */
import { readFile } from 'node:fs/promises';

// src/ y dist/ tienen el mismo padre: fuente y paquete compilado leen los mismos assets.
// El build copia datos estáticos, no importa ni ejecuta ningún módulo Python.
/** Lee un recurso distribuido con el proyecto, independientemente del directorio de la terminal. */
export async function readSharedResource(
  name: 'prices.yaml' | 'datasets/tickets.jsonl' | 'datasets/adversarial.jsonl',
): Promise<string> {
  return readFile(new URL(`../dist/resources/shared/${name}`, import.meta.url), 'utf8');
}
