/**
 * Errores propios de la aplicación: códigos estables para control de flujo y mensajes públicos.
 * El borde de cada SDK traduce sus errores a AppError para evitar filtrar mensajes, claves o
 * contenido del ticket. El ejecutor usa retryable y usage para decidir reintentos y costos.
 */
import type { TokenUsage } from './provider-types.js';
import type { RunTrace } from './telemetry.js';

/** Códigos estables: una futura API HTTP podrá mapearlos a estados sin leer mensajes. */
export type ErrorCode =
  | 'invalid_input'
  | 'invalid_output'
  | 'invalid_arguments'
  | 'missing_key'
  | 'invalid_provider'
  | 'configuration_error'
  | 'model_refusal'
  | 'incomplete_output'
  | 'timeout'
  | 'cancelled'
  | 'authentication'
  | 'permission'
  | 'rate_limit'
  | 'provider_unavailable'
  | 'invalid_request'
  | 'provider_error'
  | 'internal_error'
  | 'budget_exceeded'
  | 'eval_budget_exceeded'
  | 'unknown_model'
  | 'invalid_dataset'
  | 'invalid_report'
  | 'invalid_review'
  | 'telemetry_error'
  | 'report_error'
  | 'deadline_exceeded';

const messages: Record<ErrorCode, string> = {
  budget_exceeded: 'Se agotó el presupuesto estimado del ticket.',
  eval_budget_exceeded: 'Se agotó el presupuesto estimado de la evaluación.',
  unknown_model: 'El modelo no tiene una tarifa configurada.',
  invalid_dataset: 'El dataset no tiene un formato válido.',
  invalid_report: 'El reporte no es válido o no es comparable.',
  invalid_review: 'La revisión humana no es válida para esta corrida.',
  telemetry_error: 'No se pudo registrar la telemetría.',
  report_error: 'No se pudo guardar el reporte de la prueba.',
  deadline_exceeded: 'Se agotó el plazo total del ticket.',
  invalid_input:
    'El ticket debe contener texto no vacío de hasta 8000 caracteres, sin campos extra.',
  invalid_output: 'El modelo no devolvió una respuesta válida para el contrato.',
  invalid_arguments: 'Los argumentos no son válidos para este comando. Consultá --help.',
  missing_key: 'Falta la clave del proveedor seleccionado en el entorno.',
  invalid_provider: 'El proveedor debe ser openai, xai o google-ai.',
  configuration_error: 'No se pudo cargar una configuración válida.',
  model_refusal: 'El modelo rechazó la solicitud; requiere revisión humana.',
  incomplete_output: 'La respuesta quedó incompleta; requiere revisión humana.',
  timeout: 'Se agotó el tiempo disponible para la consulta.',
  cancelled: 'La consulta fue cancelada.',
  authentication: 'El proveedor rechazó las credenciales.',
  permission: 'La cuenta no tiene permiso para esta operación.',
  rate_limit: 'Se alcanzó un límite del proveedor. Intentá más tarde.',
  provider_unavailable: 'El proveedor no está disponible en este momento.',
  invalid_request: 'El proveedor rechazó la configuración de la solicitud.',
  provider_error: 'Ocurrió un error al consultar al proveedor.',
  internal_error: 'Ocurrió un error interno.',
};

/** Nunca transporta mensajes crudos de SDK: podrían contener tickets o secretos. */
export class AppError extends Error {
  readonly usage: TokenUsage | null;
  readonly retryable: boolean;
  trace?: RunTrace;

  constructor(
    readonly code: ErrorCode,
    details: { usage?: TokenUsage | null; retryable?: boolean; trace?: RunTrace } = {},
  ) {
    super(messages[code]);
    this.name = 'AppError';
    this.usage = details.usage ?? null;
    this.retryable =
      details.retryable ?? ['timeout', 'rate_limit', 'provider_unavailable'].includes(code);
    if (details.trace) this.trace = details.trace;
  }
}

/** Expone sólo código/mensaje; un error desconocido se vuelve internal_error sin revelar su detalle. */
export function publicError(error: unknown): { error: { code: ErrorCode; message: string } } {
  const safe = error instanceof AppError ? error : new AppError('internal_error');
  return { error: { code: safe.code, message: safe.message } };
}
