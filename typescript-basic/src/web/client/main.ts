import { SupportApi, type WebConfiguration } from './api.js';
import type { StreamFrame } from './stream-reader.js';
import { TimelineView } from './timeline-view.js';
import { InspectorView } from './inspector-view.js';
import { LabApi } from './lab-api.js';
import { LabController } from './lab-controller.js';
import { streamFrameSchema } from '../contracts.js';
import type { LabRunDetail } from '../../lab/contracts.js';
import { populatePromptOptions } from './prompt-options.js';
import { LabNavigation } from './lab-navigation.js';
import { runStatusLabels } from './history-view.js';

interface Elements {
  form: HTMLFormElement;
  ticket: HTMLTextAreaElement;
  provider: HTMLSelectElement;
  prompt: HTMLSelectElement;
  run: HTMLButtonElement;
  cancel: HTMLButtonElement;
  mode: HTMLElement;
  description: HTMLElement;
  status: HTMLElement;
  requestId: HTMLElement;
  count: HTMLElement;
  empty: HTMLElement;
  viewport: HTMLElement;
  follow: HTMLInputElement;
}
const examples: Record<string, string> = {
  billing:
    'Me cobraron dos veces la suscripción de este mes. Necesito ayuda para revisar los cargos.',
  technical: 'El panel de reportes muestra un error 500 cuando intento exportar desde mi notebook.',
  account:
    'Necesito cambiar el email de administrador de la cuenta. ¿Cómo verifico que soy titular?',
  other: 'Quisiera conocer opciones de planes para una empresa con más empleados.',
  blocked: 'DEMO_BLOCK',
};

/** Coordina interacción y estado visual; la lógica de soporte sigue viviendo en el backend. */
class PlaygroundController {
  private active: AbortController | undefined;
  private configuration: WebConfiguration | undefined;
  private laboratory: LabController | undefined;

  constructor(
    private readonly api: SupportApi,
    private readonly view: TimelineView,
    private readonly elements: Elements,
    private readonly inspector: InspectorView,
    private readonly navigation: LabNavigation,
  ) {}

  async initialize(): Promise<void> {
    this.elements.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.run();
    });
    this.elements.cancel.addEventListener('click', () => {
      this.elements.status.textContent = 'Cancelando la ejecución…';
      this.active?.abort();
    });
    this.elements.ticket.addEventListener('input', () => this.validateTicket());
    for (const button of this.elements.form.querySelectorAll<HTMLButtonElement>('[data-example]')) {
      button.addEventListener('click', () => {
        this.elements.ticket.value = examples[button.dataset.example ?? ''] ?? '';
        this.elements.ticket.focus();
        this.validateTicket();
      });
    }
    try {
      this.configuration = await this.api.configuration();
      this.configure(this.configuration);
      this.laboratory = new LabController(
        this.elements.form.ownerDocument,
        new LabApi(),
        (run) => this.restore(run),
        (view) => this.navigation.open(view),
      );
      this.laboratory.initialize(this.configuration);
    } catch (error) {
      this.elements.status.textContent = 'No se pudo conectar';
      this.view.fail(error instanceof Error ? error.message : 'No se pudo iniciar el panel.');
    }
  }

  private configure(configuration: WebConfiguration): void {
    for (const provider of configuration.providers) {
      const option = this.elements.provider.ownerDocument.createElement('option');
      option.value = provider.id;
      option.textContent = `${provider.label} · ${provider.model}${provider.available ? '' : ' · sin configurar'}`;
      option.disabled = !provider.available;
      this.elements.provider.append(option);
    }
    const available = configuration.providers.find((provider) => provider.available);
    if (available) this.elements.provider.value = available.id;
    populatePromptOptions(this.elements.prompt, configuration);
    this.elements.mode.textContent =
      configuration.mode === 'demo' ? 'DEMO · SIN CONSUMO DE API' : 'LIVE · CONSUME API';
    this.elements.mode.dataset.mode = configuration.mode;
    this.elements.description.textContent =
      configuration.mode === 'demo'
        ? 'Proveedor simulado. Los eventos recorren el servicio real; tokens y costos son simulados. No mide calidad del modelo.'
        : 'Se usará la clave configurada en el servidor. Cada etapa y reintento consume saldo; las claves nunca se envían al navegador.';
    for (const button of this.elements.form.querySelectorAll<HTMLButtonElement>(
      '[data-example="blocked"]',
    ))
      button.hidden = configuration.mode !== 'demo';
    this.validateTicket();
    this.elements.status.textContent = available
      ? 'Listo para ejecutar'
      : 'No hay proveedores disponibles';
  }

  private validateTicket(): boolean {
    const length = Array.from(this.elements.ticket.value).length;
    const valid = length <= 8000 && Boolean(this.elements.ticket.value.trim());
    required('#ticket-count').textContent = `${length.toLocaleString('es-AR')} / 8000 caracteres`;
    const feedback = required('#ticket-validation');
    feedback.hidden = valid;
    feedback.textContent = valid
      ? ''
      : length > 8000
        ? 'La consulta supera el máximo de 8000 caracteres.'
        : 'Escribí una consulta para continuar.';
    this.elements.ticket.setAttribute('aria-invalid', String(!valid));
    this.elements.run.disabled =
      Boolean(this.active) ||
      !valid ||
      !this.configuration?.providers.some((provider) => provider.available);
    return valid;
  }

  private async run(): Promise<void> {
    if (this.active || !this.configuration) return;
    if (!this.validateTicket()) {
      this.elements.status.textContent = 'Ingresá un ticket de entre 1 y 8000 puntos Unicode.';
      this.elements.ticket.focus();
      return;
    }
    const input = {
      text: this.elements.ticket.value,
      provider: this.elements.provider.value,
      promptVersion: this.elements.prompt.value,
    };
    this.active = new AbortController();
    this.setBusy(true);
    this.view.reset();
    this.inspector.reset();
    required('#selected-run-mode').textContent =
      `${this.configuration.mode.toUpperCase()} · ejecución nueva`;
    this.elements.empty.hidden = true;
    this.elements.count.textContent = '0 eventos';
    this.elements.requestId.textContent = 'Esperando identificador del servidor…';
    this.elements.status.textContent = 'Enviando ticket…';
    try {
      await this.api.run(input, this.active.signal, (frame) => this.receive(frame));
    } catch (error) {
      const cancelled = this.active.signal.aborted;
      const message = cancelled
        ? 'La consulta fue cancelada. El proveedor podría haber consumido recursos antes de recibir la cancelación.'
        : error instanceof Error
          ? error.message
          : 'No se pudo completar la consulta.';
      this.elements.status.textContent = cancelled
        ? 'Ejecución cancelada'
        : 'Ejecución interrumpida';
      this.view.fail(message);
    } finally {
      this.active = undefined;
      this.setBusy(false);
      void this.laboratory?.refresh();
    }
  }

  private receive(frame: StreamFrame): void {
    if (frame.type === 'accepted') {
      this.elements.requestId.textContent = frame.requestId;
      this.elements.status.textContent = 'Recibiendo eventos del backend';
    } else if (frame.type === 'event') {
      this.view.append(frame.event);
      this.elements.count.textContent = `${frame.event.sequence} eventos`;
      if (this.elements.follow.checked)
        this.elements.viewport.scrollTop = this.elements.viewport.scrollHeight;
    } else if (frame.type === 'inspection') {
      this.inspector.append(frame.inspection);
    } else if (frame.type === 'result') {
      this.view.complete(frame);
      this.elements.status.textContent = frame.trace.abstained
        ? 'Finalizada con derivación segura'
        : frame.trace.status === 'escalated'
          ? 'Finalizada · revisión humana sugerida'
          : 'Finalizada correctamente';
    } else {
      this.elements.status.textContent = `Ejecución fallida · ${frame.error.code}`;
      this.view.fail(frame.error.message);
    }
  }

  private restore(run: LabRunDetail): void {
    if (this.active)
      throw new Error('Esperá a que termine la consulta activa antes de abrir otra ejecución.');
    this.view.reset();
    this.inspector.reset();
    this.elements.empty.hidden = true;
    this.elements.requestId.textContent = run.id;
    this.elements.count.textContent = `${run.events.length} eventos guardados`;
    this.elements.status.textContent = `Historial · ${runStatusLabels[run.status]} · ${new Date(run.createdAt).toLocaleString('es-AR')}`;
    required('#selected-run-mode').textContent =
      `${run.mode.toUpperCase()} · ejecución guardada · ${runStatusLabels[run.status]}`;
    for (const event of run.events) this.view.append(event);
    for (const entry of run.inspections) this.inspector.append(entry);
    if (
      run.input &&
      typeof run.input === 'object' &&
      !Array.isArray(run.input) &&
      typeof run.input.text === 'string'
    )
      this.elements.ticket.value = run.input.text;
    this.validateTicket();
    const saved =
      run.result && typeof run.result === 'object' && !Array.isArray(run.result) ? run.result : {};
    const frame = streamFrameSchema.safeParse({
      type: 'result',
      requestId: run.id,
      mode: run.mode,
      response: saved.response,
      trace: saved.trace,
    });
    if (frame.success && frame.data.type === 'result') this.view.complete(frame.data);
    else
      this.view.fail(
        run.error
          ? `${run.error.code}: ${run.error.message}`
          : `Estado guardado: ${run.status}. No hay una respuesta final publicada.`,
      );
  }

  private setBusy(busy: boolean): void {
    for (const element of this.elements.form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
    >('input, select, textarea, button'))
      element.disabled = busy;
    this.elements.run.disabled = busy;
    this.elements.cancel.disabled = !busy;
    this.elements.form.setAttribute('aria-busy', String(busy));
    this.validateTicket();
  }
}

/** Falla temprano si se cambia el HTML sin actualizar su consumidor; no oculta nodos faltantes. */
function required<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Falta un elemento requerido de la interfaz: ${selector}`);
  return element;
}

const navigation = new LabNavigation(document);
navigation.initialize();
const view = new TimelineView(required('#timeline'), required('#result'), required('#run-summary'));
const inspector = new InspectorView(required('#inspections'));
const controller = new PlaygroundController(
  new SupportApi(),
  view,
  {
    form: required('#support-form'),
    ticket: required('#ticket'),
    provider: required('#provider'),
    prompt: required('#prompt-version'),
    run: required('#run-button'),
    cancel: required('#cancel-button'),
    mode: required('#mode-label'),
    description: required('#mode-description'),
    status: required('#status-message'),
    requestId: required('#run-id'),
    count: required('#event-count'),
    empty: required('#timeline-empty'),
    viewport: required('#timeline-viewport'),
    follow: required('#follow-events'),
  },
  inspector,
  navigation,
);
void controller.initialize();
