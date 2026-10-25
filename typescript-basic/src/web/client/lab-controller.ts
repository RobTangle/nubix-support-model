import type { LabRunDetail } from '../../lab/contracts.js';
import type { WebConfiguration } from './api.js';
import { LabApi, type EvaluationInput } from './lab-api.js';
import { EvaluationView } from './evaluation-view.js';
import { populatePromptOptions } from './prompt-options.js';

/** Historial y trabajos persistentes: abortar una lectura nunca cancela el trabajo del servidor. */
export class LabController {
  private offset = 0;
  private total = 0;
  private historyRequest: AbortController | undefined;
  private polling: AbortController | undefined;
  private jobId: string | undefined;
  private readonly evaluations: EvaluationView;

  constructor(
    private readonly document: Document,
    private readonly api: LabApi,
    private readonly restore: (run: LabRunDetail) => void,
  ) {
    this.evaluations = new EvaluationView(
      this.element('#evaluation-results'),
      async (reportId, review) => {
        if (!this.jobId) throw new Error('No hay trabajo abierto.');
        const jobId = this.jobId;
        await this.api.review(jobId, reportId, review);
        const snapshot = await this.api.evaluation(jobId, new AbortController().signal);
        if (this.jobId === jobId) this.evaluations.render(snapshot);
      },
      (id) => {
        void this.open(id, 'support');
      },
    );
  }

  initialize(configuration: WebConfiguration): void {
    const provider = this.element<HTMLSelectElement>('#evaluation-provider');
    for (const item of configuration.providers) {
      const option = this.document.createElement('option');
      option.value = item.id;
      option.textContent = `${item.label} · ${item.model}${item.available ? '' : ' · sin configurar'}`;
      option.disabled = !item.available;
      provider.append(option);
    }
    provider.value = configuration.providers.find((item) => item.available)?.id ?? '';
    populatePromptOptions(this.element<HTMLSelectElement>('#evaluation-prompt'), configuration);
    populatePromptOptions(this.element<HTMLSelectElement>('#evaluation-versions'), configuration);
    populatePromptOptions(
      this.element<HTMLSelectElement>('#evaluation-baseline'),
      configuration,
      configuration.baselinePromptVersion ?? configuration.promptVersions[0],
    );
    this.element('#evaluation-operation').addEventListener('change', () =>
      this.configureEvaluationOptions(),
    );
    this.configureEvaluationOptions();
    this.element<HTMLButtonElement>('#evaluation-start').disabled = !provider.value;
    this.element('#evaluation-mode').textContent =
      configuration.mode === 'live'
        ? 'LIVE · consume API real'
        : 'DEMO · evidencia simulada, no acredita calidad';
    this.element('#history-refresh').addEventListener('click', () => {
      void this.refresh();
    });
    this.element('#history-kind').addEventListener('change', () => {
      this.offset = 0;
      void this.refresh();
    });
    this.element('#history-previous').addEventListener('click', () => {
      this.offset = Math.max(0, this.offset - 30);
      void this.refresh();
    });
    this.element('#history-next').addEventListener('click', () => {
      if (this.offset + 30 < this.total) this.offset += 30;
      void this.refresh();
    });
    this.element<HTMLFormElement>('#evaluation-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.start();
    });
    this.element('#evaluation-cancel').addEventListener('click', () => {
      void this.cancel();
    });
    this.document.defaultView?.addEventListener('pagehide', () => {
      this.polling?.abort();
      this.historyRequest?.abort();
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.historyRequest?.abort();
    const controller = new AbortController();
    this.historyRequest = controller;
    const status = this.element('#history-status');
    status.textContent = 'Cargando historial local…';
    try {
      const kind =
        this.element<HTMLSelectElement>('#history-kind').value === 'evaluation'
          ? 'evaluation'
          : 'support';
      const page = await this.api.history(kind, 30, this.offset, controller.signal);
      if (controller.signal.aborted) return;
      this.total = page.total;
      const list = this.element('#history-list');
      list.replaceChildren();
      for (const item of page.items) {
        const button = this.document.createElement('button');
        button.type = 'button';
        button.className = 'history-entry';
        button.textContent = `${item.mode.toUpperCase()} · ${item.status} · ${item.provider}/${item.model} · ${item.promptVersion} · ${item.createdAt.replace('T', ' ')} · ${item.id}`;
        button.addEventListener('click', () => {
          void this.open(item.id, item.kind);
        });
        list.append(button);
      }
      status.textContent = page.total
        ? `${this.offset + 1}–${Math.min(this.offset + page.items.length, page.total)} de ${page.total} ejecuciones`
        : 'Todavía no hay ejecuciones de este tipo.';
      this.element<HTMLButtonElement>('#history-previous').disabled = this.offset === 0;
      this.element<HTMLButtonElement>('#history-next').disabled = this.offset + 30 >= page.total;
    } catch {
      if (!controller.signal.aborted)
        status.textContent =
          'No se pudo cargar el historial. Podés volver a cargarlo sin consumir API.';
    }
  }

  private async open(id: string, kind: 'support' | 'evaluation'): Promise<void> {
    try {
      if (kind === 'evaluation') {
        this.element('#evaluation-panel').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        this.watch(id);
      } else {
        const detail = await this.api.detail(id);
        this.restore(detail);
        this.element('#timeline-title').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      }
      this.element('#history-status').textContent =
        `Ejecución guardada seleccionada: ${id}. Lectura sin consumo de API.`;
    } catch (error) {
      this.element('#history-status').textContent =
        error instanceof Error ? error.message : 'No se pudo abrir la ejecución.';
    }
  }

  private async start(): Promise<void> {
    const button = this.element<HTMLButtonElement>('#evaluation-start');
    button.disabled = true;
    this.element('#evaluation-status').textContent = 'Creando trabajo persistente…';
    const input: EvaluationInput = {
      provider: this.element<HTMLSelectElement>('#evaluation-provider').value,
      operation: this.element<HTMLSelectElement>('#evaluation-operation')
        .value as EvaluationInput['operation'],
      promptVersion: this.element<HTMLSelectElement>('#evaluation-prompt').value,
      split: this.element<HTMLSelectElement>('#evaluation-split').value as EvaluationInput['split'],
      compareModeration: this.element<HTMLInputElement>('#evaluation-moderation').checked,
    };
    if (input.operation === 'compare') {
      input.promptVersions = [
        ...this.element<HTMLSelectElement>('#evaluation-versions').selectedOptions,
      ].map((option) => option.value);
      input.baselinePromptVersion = this.element<HTMLSelectElement>('#evaluation-baseline').value;
      if (
        input.promptVersions.length < 2 ||
        !input.promptVersions.includes(input.baselinePromptVersion)
      ) {
        this.element('#evaluation-status').textContent =
          'Elegí al menos dos versiones e incluí el prompt de referencia.';
        button.disabled = false;
        return;
      }
    }
    try {
      const id = await this.api.start(input);
      this.watch(id);
      void this.refresh();
    } catch (error) {
      this.element('#evaluation-status').textContent =
        error instanceof Error ? error.message : 'No se pudo iniciar el trabajo.';
      button.disabled = false;
    }
  }

  private configureEvaluationOptions(): void {
    const operation = this.element<HTMLSelectElement>('#evaluation-operation').value;
    const compare = operation === 'compare';
    this.element('#evaluation-single-prompt').hidden = compare;
    this.element<HTMLSelectElement>('#evaluation-prompt').disabled = compare;
    this.element('#evaluation-versions-label').hidden = !compare;
    this.element('#evaluation-baseline-label').hidden = !compare;
    this.element<HTMLSelectElement>('#evaluation-versions').disabled = !compare;
    this.element<HTMLSelectElement>('#evaluation-baseline').disabled = !compare;
    const split = this.element<HTMLSelectElement>('#evaluation-split');
    if (compare) split.value = 'dev';
    split.disabled = compare;
    const moderation = this.element<HTMLInputElement>('#evaluation-moderation');
    moderation.disabled = operation !== 'adversarial';
    if (moderation.disabled) moderation.checked = false;
  }

  private watch(id: string): void {
    this.polling?.abort();
    const controller = new AbortController();
    this.polling = controller;
    this.jobId = id;
    this.evaluations.reset();
    this.element('#evaluation-id').textContent = id;
    this.element('#evaluation-status').textContent = 'Leyendo el trabajo persistido…';
    void this.poll(id, controller);
  }

  private async poll(id: string, controller: AbortController): Promise<void> {
    try {
      while (!controller.signal.aborted) {
        const snapshot = await this.api.evaluation(id, controller.signal);
        if (controller.signal.aborted) return;
        this.evaluations.render(snapshot);
        const running = snapshot.job.status === 'running';
        this.element('#evaluation-status').textContent =
          `${snapshot.job.mode.toUpperCase()} · ${snapshot.job.status} · ${snapshot.progress.completed}/${snapshot.progress.total} casos`;
        this.element<HTMLButtonElement>('#evaluation-cancel').disabled = !running;
        this.element<HTMLButtonElement>('#evaluation-start').disabled = running;
        if (!running) {
          void this.refresh();
          return;
        }
        await new Promise<void>((resolve) => {
          const abort = (): void => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', abort);
            resolve();
          }, 1000);
          controller.signal.addEventListener('abort', abort, { once: true });
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      this.element('#evaluation-status').textContent =
        error instanceof Error
          ? error.message
          : 'Lectura interrumpida; reabrí el trabajo desde el historial.';
      this.element<HTMLButtonElement>('#evaluation-start').disabled = false;
    }
  }

  private async cancel(): Promise<void> {
    if (!this.jobId) return;
    this.element<HTMLButtonElement>('#evaluation-cancel').disabled = true;
    try {
      await this.api.cancel(this.jobId);
      this.element('#evaluation-status').textContent =
        'Cancelación solicitada al servidor. Se conservarán los resultados parciales y el consumo conocido.';
    } catch (error) {
      this.element('#evaluation-status').textContent =
        error instanceof Error ? error.message : 'No se pudo solicitar la cancelación.';
      this.element<HTMLButtonElement>('#evaluation-cancel').disabled = false;
    }
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.document.querySelector<T>(selector);
    if (!element) throw new Error(`Falta un elemento del laboratorio: ${selector}`);
    return element;
  }
}
