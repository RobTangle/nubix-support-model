/**
 * Entrada pública de la biblioteca: reúne las clases, funciones y tipos pensados para sus consumidores.
 * Permite integrar el asistente en otro programa sin importar las CLI ni ejecutar sus comandos.
 * Importar estos símbolos no lee claves ni inicia una consulta; el llamador construye sus dependencias.
 */
export { SupportAssistant, loadPrompt } from './service.js';
export { ticketSchema, supportResponseSchema } from './schemas.js';
export type { Ticket, SupportResponse } from './schemas.js';
export type { LLMProvider, CompletionRequest, CompletionResult } from './provider-types.js';
export { createProvider } from './providers.js';
export { readSettings, readEnvironment } from './config.js';
export type { ProviderSettings } from './config.js';
export { AppError, publicError } from './errors.js';
export { loadPrompts } from './prompts.js';
export { PromptRegistry } from './prompt-registry.js';
export type { PromptBundle, PromptVersion } from './prompts.js';
export type { AssistantOptions, ProcessOptions, SupportRun } from './service.js';
export type { RunTrace, EventSink } from './telemetry.js';
export { Budget, PriceCatalog, loadPrices } from './budget.js';
export { flowEventSchema } from './observability/events.js';
export type { FlowEvent, FlowSink } from './observability/events.js';
export { readRuntimeSettings } from './runtime-settings.js';
