import type { FlowEvent, FlowEventName } from '../../observability/events.js';
import type { StreamFrame } from './stream-reader.js';

const titles: Record<FlowEventName, string> = {
  'request.received': 'Consulta recibida',
  'input.validation.started': 'Validando entrada',
  'input.validation.completed': 'Entrada validada',
  'input.validation.failed': 'Entrada rechazada',
  'budget.reserved': 'Reserva preventiva de presupuesto',
  'llm.request.started': 'Request al LLM enviada',
  'llm.request.completed': 'Respuesta del LLM recibida',
  'llm.request.failed': 'Request al LLM fallida',
  'schema.validation.started': 'Validando JSON y esquema',
  'schema.validation.completed': 'JSON y esquema válidos',
  'schema.validation.failed': 'Respuesta fuera del contrato',
  'usage.recorded': 'Tokens y costo registrados',
  'attempt.completed': 'Intento finalizado',
  'retry.scheduled': 'Reintento programado',
  'human_review.suggested': 'Revisión humana sugerida',
  'run.completed': 'Procesamiento finalizado',
  'run.failed': 'Procesamiento fallido',
};
const stages = {
  input_moderation: 'Moderación de entrada',
  generation: 'Clasificación y respuesta',
  output_moderation: 'Moderación de salida',
};

/** Sólo presenta datos ya validados; textContent mantiene inerte cualquier HTML del modelo. */
export class TimelineView {
  private lastElapsed = 0;
  private requests = 0;
  private readonly inFlight = new Map<string, HTMLElement>();

  constructor(
    private readonly list: HTMLOListElement,
    private readonly result: HTMLElement,
    private readonly summary: HTMLElement,
  ) {}

  reset(): void {
    this.list.replaceChildren();
    this.result.replaceChildren();
    this.summary.replaceChildren();
    this.lastElapsed = 0;
    this.requests = 0;
    this.inFlight.clear();
  }

  append(event: FlowEvent): void {
    const document = this.list.ownerDocument;
    const row = document.createElement('li');
    const heading = document.createElement('div');
    const actor = document.createElement('span');
    const title = document.createElement('strong');
    const time = document.createElement('time');
    const metadata = document.createElement('p');
    const details = document.createElement('details');
    const caption = document.createElement('summary');
    const content = document.createElement('pre');
    const llm = event.event.startsWith('llm.request.');
    const failed = event.event.endsWith('.failed');
    row.className = `timeline-event ${llm ? 'actor-llm' : 'actor-code'}${failed ? ' event-failed' : ''}`;
    heading.className = 'event-heading';
    actor.className = `actor-badge ${llm ? 'badge-llm' : 'badge-code'}`;
    actor.textContent = llm ? 'LLM · REQUEST' : 'CÓDIGO';
    title.textContent = titles[event.event];
    time.dateTime = event.timestamp;
    time.textContent = event.timestamp.slice(11, 23) + ' UTC';
    time.title = event.timestamp;
    const delta = Math.max(0, event.elapsedMs - this.lastElapsed);
    const timing = [`+${event.elapsedMs.toFixed(1)} ms desde inicio`, `Δ ${delta.toFixed(1)} ms`];
    if (event.durationMs !== null) timing.push(`duración ${event.durationMs.toFixed(1)} ms`);
    if (event.stage) timing.unshift(`${stages[event.stage]} · intento ${event.attempt ?? 1}`);
    if (event.details.decision) timing.push(`veredicto del LLM: ${event.details.decision}`);
    metadata.className = 'event-metadata';
    metadata.textContent = timing.join(' · ');
    caption.textContent = 'Ver detalles';
    content.textContent = JSON.stringify(event, null, 2);
    details.append(caption, content);
    heading.append(actor, title, time);
    row.append(heading, metadata, details);
    if (event.event === 'human_review.suggested') {
      const note = document.createElement('p');
      note.className = 'human-note';
      note.textContent =
        'Intervención humana sugerida: ninguna persona revisó esta ejecución automáticamente.';
      row.append(note);
    }
    const key = `${event.stage}:${event.attempt}`;
    if (event.event === 'llm.request.started') {
      this.requests++;
      row.classList.add('event-running');
      row.setAttribute('aria-busy', 'true');
      this.inFlight.set(key, row);
    } else if (event.event === 'llm.request.completed' || event.event === 'llm.request.failed') {
      const started = this.inFlight.get(key);
      started?.classList.remove('event-running');
      started?.setAttribute('aria-busy', 'false');
      this.inFlight.delete(key);
    }
    this.list.append(row);
    this.lastElapsed = event.elapsedMs;
  }

  complete(frame: Extract<StreamFrame, { type: 'result' }>): void {
    this.stopPending();
    const document = this.result.ownerDocument;
    const title = document.createElement('h3');
    const answer = document.createElement('p');
    const tags = document.createElement('p');
    const actions = document.createElement('ul');
    title.textContent = frame.trace.abstained
      ? 'Respuesta de derivación segura'
      : 'Respuesta validada';
    answer.textContent = frame.response.answer;
    tags.className = 'response-tags';
    tags.textContent = `${frame.response.category} · confianza declarada ${(frame.response.confidence * 100).toFixed(0)} %`;
    for (const action of frame.response.actions) {
      const item = document.createElement('li');
      item.textContent = action;
      actions.append(item);
    }
    const raw = document.createElement('details');
    const caption = document.createElement('summary');
    const content = document.createElement('pre');
    caption.textContent = 'Ver contrato JSON final';
    content.textContent = JSON.stringify(frame.response, null, 2);
    raw.append(caption, content);
    this.result.replaceChildren(title, tags, answer, actions, raw);
    const cost = frame.trace.knownCostUsd;
    const qualifier = frame.mode === 'demo' ? 'Costo simulado' : 'Costo real estimado conocido';
    const requests =
      this.requests === 1 ? '1 request LLM observada' : `${this.requests} requests LLM observadas`;
    this.summary.textContent = `${frame.trace.latencyMs.toFixed(0)} ms de servicio · ${requests} · ${qualifier}: USD ${cost} · reserva de consumo desconocido: USD ${frame.trace.reservedUnknownUsd}`;
  }

  fail(message: string): void {
    this.stopPending();
    const note = this.result.ownerDocument.createElement('p');
    note.className = 'error-message';
    note.textContent = message;
    this.result.replaceChildren(note);
    this.summary.textContent =
      'La ejecución no entregó una respuesta final. Los eventos recibidos se conservan para inspección.';
  }

  private stopPending(): void {
    for (const row of this.inFlight.values()) {
      row.classList.remove('event-running');
      row.setAttribute('aria-busy', 'false');
    }
    this.inFlight.clear();
  }
}
