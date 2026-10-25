/**
 * Ensamblado de instrucciones: convierte recursos YAML versionados en un bundle reutilizable para
 * generación, moderación y reparación. Está separado del servicio para validar/configurar prompts
 * una vez por configuración y registrar su procedencia sin acoplarlos a un proveedor concreto.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { AppError } from './errors.js';
import { supportResponseSchema } from './schemas.js';

export type PromptVersion = 'basic-v1' | 'basic-v2';
/** Textos preparados para las etapas del flujo y procedencia de los recursos que los componen. */
export interface PromptBundle {
  version: PromptVersion;
  manualVersion: string;
  safetyVersion: string;
  system: string;
  inputModeration: string;
  outputModeration: string;
  repair: string;
  /** Huellas de contenido: permiten detectar cambios aunque alguien mantenga la misma versión. */
  hashes: Record<string, string>;
  canaryEnabled: boolean;
}
const text = z.string().min(1);
const contextSchema = z.strictObject({ version: text, manual: text });
const baseSchema = z.strictObject({ version: z.literal('basic-v1'), system: text });
const safetySchema = z.strictObject({
  version: text,
  repair: text,
  evaluation_marker: text,
  input: text,
  output: text,
});
const examplesSchema = z.strictObject({
  version: z.literal('basic-v2'),
  examples: z.array(z.strictObject({ ticket: text, response: supportResponseSchema })).length(4),
});

/**
 * Construye una configuración de prompts lista para reutilizar entre tickets.
 *
 * La complejidad viene de ensamblar un conjunto de recursos: plantilla de generación,
 * manual compartido, políticas de moderación/reparación y ejemplos de basic-v2. Además
 * valida su contrato y registra qué contenido se usó, para poder comparar evaluaciones.
 * Cargar un único archivo no cubriría esas responsabilidades.
 *
 * Conviene invocarla al iniciar la aplicación o cambiar de configuración. No tiene caché
 * interna: cada invocación vuelve a leer y validar los archivos; reutilizar el bundle
 * evita repetir ese trabajo en cada llamada al modelo.
 *
 * @param version basic-v1 conserva el prompt base; basic-v2 agrega ejemplos few-shot.
 * @param evaluation Agrega un marcador sintético para detectar filtraciones del prompt
 * en evaluaciones. No se agrega al flujo normal de tickets.
 * @returns Textos ensamblados, versiones declaradas, hashes y estado del marcador.
 * @throws AppError configuration_error si falla lectura, YAML, contrato o configuración.
 */
export async function loadPrompts(
  version: PromptVersion = 'basic-v1',
  evaluation = false,
): Promise<PromptBundle> {
  try {
    // La unión de TypeScript desaparece al ejecutar: un llamador JS también puede pasar otro valor.
    if (!['basic-v1', 'basic-v2'].includes(version)) throw new AppError('configuration_error');
    // Son lecturas independientes. import.meta.url resuelve desde este módulo, no desde la terminal;
    // el build conserva la misma distribución de recursos para que también funcione en dist/.
    const [contextSource, baseSource, safetySource, examplesSource] = await Promise.all([
      readFile(new URL('./resources/context.yaml', import.meta.url), 'utf8'),
      readFile(new URL('./prompt.yaml', import.meta.url), 'utf8'),
      readFile(new URL('./resources/safety.yaml', import.meta.url), 'utf8'),
      readFile(new URL('./resources/basic-v2.yaml', import.meta.url), 'utf8'),
    ]);
    // parse(YAML) sólo comprueba la sintaxis. Zod valida campos, versiones y tipos reales antes
    // de gastar API. Incluso basic-v1 valida los ejemplos de v2: un recurso inválido falla todo
    // el bundle, a cambio de detectar la configuración rota antes de cambiar de versión.
    const context = contextSchema.parse(parse(contextSource));
    const base = baseSchema.parse(parse(baseSource));
    const safety = safetySchema.parse(parse(safetySource));
    const examples = examplesSchema.parse(parse(examplesSource));
    // Con cuatro ejemplos ya validados, cuatro categorías distintas cubren el enum actual completo.
    if (new Set(examples.examples.map((item) => item.response.category)).size !== 4)
      throw new AppError('configuration_error');
    // El mismo manual se inserta en generación y moderación. trimEnd evita sumar saltos finales
    // del YAML y conserva la compatibilidad de basic-v1 con el prompt de la versión Python básica.
    const render = (source: string): string =>
      source.replaceAll('{{manual}}', context.manual.trimEnd());
    // El "canario" es texto sintético reconocible: encontrarlo en una salida puede señalar que
    // el modelo filtró instrucciones internas. No representa un secreto real ni prueba seguridad.
    const marker = evaluation ? `\n${safety.evaluation_marker}` : '';
    const system =
      render(base.system) +
      (version === 'basic-v2'
        ? `\nEJEMPLOS INDEPENDIENTES:\n${JSON.stringify(examples.examples)}`
        : '') +
      marker;
    const inputModeration = render(safety.input) + marker;
    const outputModeration = render(safety.output) + marker;
    // SHA-256 produce una huella determinista de 64 caracteres hexadecimales para cada texto.
    // Sirve para distinguir dos corridas etiquetadas basic-v1 cuyos archivos fueron editados
    // sin actualizar la versión. La telemetría puede comparar huellas sin incluir los prompts.
    // Hashes iguales no garantizan calidad, determinismo del modelo ni igualdad de todo el request:
    // el ticket, los parámetros y los esquemas se registran por separado en reportes/evaluaciones.
    // Tampoco es cifrado ni un mecanismo de anonimización.
    const hashes = Object.fromEntries(
      Object.entries({
        // Estos textos ya están renderizados; incluyen los ejemplos o el canario si corresponde.
        system,
        inputModeration,
        outputModeration,
        repair: safety.repair,
        // manual se toma del campo parseado; safety/examples conservan el YAML original completo.
        // Por eso un cambio de formato en esos YAML puede cambiar su hash aunque no su significado;
        // examples también queda registrado cuando basic-v1 no incorpora ejemplos al prompt.
        manual: context.manual,
        safety: safetySource,
        examples: examplesSource,
      }).map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]),
    );
    return {
      version,
      manualVersion: context.version,
      safetyVersion: safety.version,
      system,
      inputModeration,
      outputModeration,
      repair: safety.repair,
      hashes,
      canaryEnabled: evaluation,
    };
  } catch {
    // El borde de la aplicación recibe un código estable, sin volcar el contenido de los recursos.
    throw new AppError('configuration_error');
  }
}
