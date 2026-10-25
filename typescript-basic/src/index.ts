/**
 * Entrada pública de la biblioteca: reúne las clases, funciones y tipos pensados para sus consumidores.
 * Permite integrar el asistente en otro programa sin importar las CLI ni ejecutar sus comandos.
 * Importar estos símbolos no lee claves ni inicia una consulta; el llamador construye sus dependencias.
 */
export { SupportAssistant, loadPrompt } from './support/service.js';
export { ticketSchema, supportResponseSchema } from './support/schemas.js';
export type { Ticket, SupportResponse } from './support/schemas.js';
export type { LLMProvider, CompletionRequest, CompletionResult } from './llm/provider-types.js';
export { createProvider } from './llm/providers.js';
export { readSettings, readEnvironment } from './config/environment.js';
export type { ProviderSettings } from './config/environment.js';
export { AppError, publicError } from './errors.js';
export { loadPrompts } from './prompting/prompts.js';
export { PromptRegistry } from './prompting/prompt-registry.js';
export type { PromptBundle, PromptVersion } from './prompting/prompts.js';
export type { AssistantOptions, ProcessOptions, SupportRun } from './support/service.js';
export type { RunTrace, EventSink } from './observability/telemetry.js';
export { Budget, PriceCatalog, loadPrices } from './costs/budget.js';
export { flowEventSchema } from './observability/events.js';
export type { FlowEvent, FlowSink } from './observability/events.js';
export { readRuntimeSettings } from './config/runtime-settings.js';
