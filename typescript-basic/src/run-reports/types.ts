/**
 * Formato de los archivos de pruebas manuales: conserva entrada, salida y configuración completa
 * seleccionada explícitamente. La telemetría usa sólo metadatos; este reporte también contiene texto.
 * Separar los contratos del escritor permite tipar los consumidores sin cargar lógica de archivos.
 */
import type { PriceCatalog } from '../budget.js';
import type { ProviderSettings } from '../config.js';
import type { ErrorCode } from '../errors.js';
import type { PromptBundle } from '../prompts.js';
import type { RuntimeSettings } from '../runtime-settings.js';
import type { SupportResponse } from '../schemas.js';
import type { CapturedOutput, RunTrace } from '../telemetry.js';

/** Datos disponibles al iniciar una corrida; no recibe el objeto de configuración con su API key. */
export interface RunReportOptions {
  directory?: string;
  text: string;
  normalizedText: string;
  inputSource: 'text' | 'stdin';
  provider: ProviderSettings['provider'];
  model: string;
  prompts: PromptBundle;
  runtimeSettings: RuntimeSettings;
  prices: PriceCatalog;
}
/** Datos que se agregan al cerrar: la traza puede faltar si el servicio no llegó a iniciar. */
export interface RunReportResult {
  response: SupportResponse | null;
  trace: RunTrace | null;
  error: { code: ErrorCode; message: string } | null;
  rawOutputs: CapturedOutput[];
}
/**
 * Documento persistido. reportId identifica el archivo; runId enlaza con la traza del servicio.
 * state describe si se completó el guardado, mientras trace.status describe el resultado del flujo.
 */
export interface RunReport extends RunReportResult {
  formatVersion: 2;
  reportId: string;
  runId: string | null;
  startedAt: string;
  finishedAt: string | null;
  state: 'running' | 'finished';
  provenance: { source: 'cli'; omitted: string[] };
  application: {
    name: string;
    version: string;
    nodeVersion: string;
    sdkVersions: Record<string, string>;
  };
  ticket: { id: string; text: string; normalizedText: string };
  invocation: {
    workingDirectory: string;
    inputSource: 'text' | 'stdin';
    provider: ProviderSettings['provider'];
    model: string;
    promptVersion: string;
  };
  configuration: {
    runtimeSettings: RuntimeSettings;
    prompts: PromptBundle;
    schemas: { response: Record<string, unknown>; moderation: Record<string, unknown> };
    prices: { version: string; hash: string; source: string };
  };
  humanReview: { status: 'pending'; notes: string[] };
}
