import type { LabRunDetail } from '../../lab/contracts.js';
import type { WebConfiguration } from './api.js';
import { LabApi, type EvaluationInput } from './lab-api.js';
import { EvaluationView } from './evaluation-view.js';
import { populatePromptChoices, populatePromptOptions } from './prompt-options.js';
import { HistoryView, runStatusLabels } from './history-view.js';
import { HistoryFilters } from './history-filters.js';

/** Historial y trabajos persistentes: abortar una lectura nunca cancela el trabajo del servidor. */
export class LabController {
  private offset = 0;
  private total = 0;
  private historyRequest: AbortController | undefined;
  private polling: AbortController | undefined;
  private opening: AbortController | undefined;
  private jobId: string | undefined;
  private starting = false;
  private jobRunning = false;
  private cancellationRequested = false;
  private readonly evaluations: EvaluationView;
  private readonly history: HistoryView;
  private readonly historyFilters: HistoryFilters;

  constructor(
    private readonly document: Document,
    private readonly api: LabApi,
    private readonly restore: (run: LabRunDetail) => void,
    private readonly navigate?: (view: 'support' | 'evaluations' | 'history' | 'guide') => void,
  ) {
    this.historyFilters = new HistoryFilters(document);
    this.history = new HistoryView(this.element('#history-list'), (id, kind) => {
      void this.open(id, kind);
    });
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
    populatePromptChoices(this.element<HTMLFieldSetElement>('#evaluation-versions'), configuration);
    populatePromptOptions(
      this.element<HTMLSelectElement>('#evaluation-baseline'),
      configuration,
      configuration.baselinePromptVersion ?? configuration.promptVersions[0],
    );
    this.element('#evaluation-operation').addEventListener('change', () =>
      this.configureEvaluationOptions(),
    );
    for (const selector of [
      '#evaluation-split',
      '#evaluation-versions',
      '#evaluation-moderation',
      '#evaluation-provider',
    ]) {
      this.element(selector).addEventListener('change', () => this.configureEvaluationOptions());
    }
    this.element('#evaluation-baseline').addEventListener('change', () => {
      const baseline = this.element<HTMLSelectElement>('#evaluation-baseline').value;
      for (const input of this.document.querySelectorAll<HTMLInputElement>(
        'input[name=promptVersions]',
      )) {
        if (input.value === baseline) input.checked = true;
      }
      this.configureEvaluationOptions();
    });
    this.configureEvaluationOptions();
    this.element<HTMLButtonElement>('#evaluation-start').disabled = !provider.value;
    this.element('#evaluation-mode').textContent =
      configuration.mode === 'live'
        ? 'LIVE · consume API real'
        : 'DEMO · evidencia simulada, no acredita calidad';
    this.element('#history-refresh').addEventListener('click', () => {
      void this.refresh();
    });
    this.historyFilters.initialize(() => {
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
    // Abandonar una apertura pendiente cancela su intención de navegar, no el trabajo ni su polling.
    // LabNavigation.open usa pushState: completar nuestra propia apertura no dispara estos eventos.
    this.document.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (target?.closest?.('a[data-lab-link]')) this.opening?.abort();
    });
    this.document.defaultView?.addEventListener('hashchange', () => this.opening?.abort());
    this.document.defaultView?.addEventListener('popstate', () => this.opening?.abort());
    this.document.defaultView?.addEventListener('pagehide', () => {
      this.polling?.abort();
      this.historyRequest?.abort();
      this.opening?.abort();
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.historyRequest?.abort();
    const controller = new AbortController();
    this.historyRequest = controller;
    const status = this.element('#history-status');
    status.textContent = 'Cargando historial local…';
    this.element('#history-list').setAttribute('aria-busy', 'true');
    this.element<HTMLButtonElement>('#history-previous').disabled = true;
    this.element<HTMLButtonElement>('#history-next').disabled = true;
    try {
      const kind =
        this.element<HTMLSelectElement>('#history-kind').value === 'evaluation'
          ? 'evaluation'
          : 'support';
      const filters = this.historyFilters.read();
      const filtered = Object.values(filters).some(
        (value) => value !== undefined && value !== false,
      );
      const page = await this.api.history(
        { kind, limit: 30, offset: this.offset, ...filters },
        controller.signal,
      );
      if (controller.signal.aborted || this.historyRequest !== controller) return;
      this.total = page.total;
      if (this.offset > 0 && this.offset >= page.total) {
        this.offset = page.total ? Math.floor((page.total - 1) / 30) * 30 : 0;
        await this.refresh();
        return;
      }
      this.historyFilters.populate(page.filterOptions);
      this.history.render(page.items, filtered);
      status.textContent = page.total
        ? `${this.offset + 1}–${Math.min(this.offset + page.items.length, page.total)} de ${page.total} ejecuciones`
        : filtered
          ? 'No hay resultados con estos filtros. Podés limpiarlos para volver al listado predeterminado.'
          : 'Todavía no hay ejecuciones de este tipo.';
      this.element<HTMLButtonElement>('#history-previous').disabled = this.offset === 0;
      this.element<HTMLButtonElement>('#history-next').disabled = this.offset + 30 >= page.total;
    } catch {
      if (!controller.signal.aborted)
        status.textContent =
          'No se pudo cargar el historial. Podés volver a cargarlo sin consumir API.';
    } finally {
      if (this.historyRequest === controller)
        this.element('#history-list').setAttribute('aria-busy', 'false');
    }
  }

  private async open(id: string, kind: 'support' | 'evaluation'): Promise<void> {
    this.opening?.abort();
    const controller = new AbortController();
    this.opening = controller;
    try {
      if (kind === 'evaluation') {
        this.watch(id, true);
      } else {
        const detail = await this.api.detail(id, controller.signal);
        if (controller.signal.aborted || this.opening !== controller) return;
        this.restore(detail);
        this.navigate?.('support');
        if (!this.navigate) this.element('#timeline-title').scrollIntoView?.({ block: 'start' });
      }
      this.element('#history-status').textContent =
        `Ejecución guardada seleccionada: ${id}. Lectura sin consumo de API.`;
    } catch (error) {
      if (controller.signal.aborted) return;
      this.element('#history-status').textContent =
        error instanceof Error ? error.message : 'No se pudo abrir la ejecución.';
    }
  }

  private async start(): Promise<void> {
    if (this.starting || this.jobRunning) return;
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
        ...this.document.querySelectorAll<HTMLInputElement>('input[name=promptVersions]:checked'),
      ].map((option) => option.value);
      input.baselinePromptVersion = this.element<HTMLSelectElement>('#evaluation-baseline').value;
      if (
        input.promptVersions.length < 2 ||
        !input.promptVersions.includes(input.baselinePromptVersion)
      ) {
        this.element('#evaluation-status').textContent =
          'Elegí al menos dos versiones e incluí el prompt de referencia.';
        return;
      }
    }
    if (!input.provider) {
      this.element('#evaluation-status').textContent =
        'No hay un proveedor disponible para ejecutar evaluaciones.';
      return;
    }
    this.starting = true;
    this.configureEvaluationOptions();
    this.element('#evaluation-status').textContent = 'Creando trabajo persistente…';
    try {
      const id = await this.api.start(input);
      this.watch(id);
      void this.refresh();
    } catch (error) {
      this.element('#evaluation-status').textContent =
        error instanceof Error ? error.message : 'No se pudo iniciar el trabajo.';
    } finally {
      this.starting = false;
      this.configureEvaluationOptions();
    }
  }

  private configureEvaluationOptions(): void {
    const operation = this.element<HTMLSelectElement>('#evaluation-operation').value;
    const compare = operation === 'compare';
    const busy = this.starting || this.jobRunning;
    this.element<HTMLSelectElement>('#evaluation-provider').disabled = busy;
    this.element<HTMLSelectElement>('#evaluation-operation').disabled = busy;
    this.element('#evaluation-single-prompt').hidden = compare;
    this.element<HTMLSelectElement>('#evaluation-prompt').disabled = compare || busy;
    this.element('#evaluation-versions-label').hidden = !compare;
    this.element('#evaluation-baseline-label').hidden = !compare;
    this.element('#evaluation-comparison-help').hidden = !compare;
    this.element<HTMLFieldSetElement>('#evaluation-versions').disabled = !compare || busy;
    this.element<HTMLSelectElement>('#evaluation-baseline').disabled = !compare || busy;
    const split = this.element<HTMLSelectElement>('#evaluation-split');
    if (compare) split.value = 'dev';
    split.disabled = compare || busy || operation === 'adversarial';
    const moderation = this.element<HTMLInputElement>('#evaluation-moderation');
    moderation.disabled = operation !== 'adversarial' || busy;
    if (operation !== 'adversarial') moderation.checked = false;
    const versions = this.document.querySelectorAll('input[name=promptVersions]:checked').length;
    const cases =
      operation === 'adversarial' ? (moderation.checked ? 40 : 20) : compare ? versions * 60 : 60;
    this.element('#evaluation-explanation').textContent =
      operation === 'adversarial'
        ? 'Sólo seguridad: 10 ataques y 10 controles benignos. Comparar moderación añade la variante sin moderación, exclusiva de este arnés.'
        : compare
          ? 'Comparación intercalada sobre desarrollo: cada versión procesa los mismos 40 tickets y 20 casos de seguridad. La revisión humana permite interpretar las diferencias.'
          : split.value === 'test'
            ? 'Prueba final: usá estos 40 tickets después de elegir el prompt con desarrollo. Incluye también 20 casos de seguridad. No uses prueba para ajustar el prompt.'
            : 'Desarrollo: 40 tickets para experimentar y elegir candidatos, más 10 ataques y 10 controles benignos. La clasificación automática se complementa con revisión humana.';
    this.element('#evaluation-plan').textContent =
      `${cases} ejecuciones de casos${compare ? ` · ${versions} versiones × 60 casos` : ''}. El flujo completo realiza hasta 3 llamadas iniciales al LLM por caso; los bloqueos y reintentos modifican el total. Revisar historial y respuestas guardadas no consume API.`;
    this.element('#evaluation-comparison-help').textContent =
      'La referencia (baseline) es la versión contra la que se comparan las candidatas. Elegí al menos dos versiones e incluí la referencia entre los checkboxes. Al cambiar la referencia se incluye automáticamente.';
    this.element<HTMLButtonElement>('#evaluation-start').disabled =
      busy || !this.element<HTMLSelectElement>('#evaluation-provider').value;
    this.element<HTMLButtonElement>('#evaluation-start').textContent = this.starting
      ? 'Creando evaluación…'
      : this.jobRunning
        ? 'Evaluación en curso'
        : 'Iniciar evaluación';
  }

  private watch(id: string, navigate = false): void {
    this.polling?.abort();
    const controller = new AbortController();
    this.polling = controller;
    this.jobId = id;
    this.jobRunning = true;
    this.cancellationRequested = false;
    this.configureEvaluationOptions();
    this.element<HTMLButtonElement>('#evaluation-cancel').disabled = false;
    this.evaluations.reset();
    this.element('#evaluation-id').textContent = id;
    this.element('#evaluation-status').textContent = 'Leyendo el trabajo persistido…';
    void this.poll(id, controller, navigate ? this.opening : undefined);
  }

  private async poll(
    id: string,
    controller: AbortController,
    navigation?: AbortController,
  ): Promise<void> {
    try {
      while (!controller.signal.aborted) {
        const snapshot = await this.api.evaluation(id, controller.signal);
        if (controller.signal.aborted) return;
        this.evaluations.render(snapshot);
        if (navigation) {
          // Una lectura lenta no debe devolver al usuario a una selección que ya abandonó.
          if (!navigation.signal.aborted && navigation === this.opening) {
            this.navigate?.('evaluations');
            if (!this.navigate)
              this.element('#evaluation-panel').scrollIntoView?.({ block: 'start' });
          }
          navigation = undefined;
        }
        const running = snapshot.job.status === 'running';
        this.jobRunning = running;
        this.element('#evaluation-status').textContent =
          `${snapshot.job.mode === 'live' ? 'API real' : 'Demo'} · ${runStatusLabels[snapshot.job.status]} · ${snapshot.progress.completed}/${snapshot.progress.total} casos`;
        this.element<HTMLButtonElement>('#evaluation-cancel').disabled =
          !running || this.cancellationRequested;
        this.configureEvaluationOptions();
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
      this.element('#evaluation-status').textContent +=
        ' Reabrí este trabajo desde el historial para continuar su lectura; navegar no lo cancela.';
    }
  }

  private async cancel(): Promise<void> {
    if (!this.jobId || !this.jobRunning || this.cancellationRequested) return;
    const id = this.jobId;
    this.cancellationRequested = true;
    this.element<HTMLButtonElement>('#evaluation-cancel').disabled = true;
    try {
      await this.api.cancel(id);
      if (id !== this.jobId) return;
      this.element('#evaluation-status').textContent =
        'Cancelación solicitada al servidor. Se conservarán los resultados parciales y el consumo conocido.';
    } catch (error) {
      if (id !== this.jobId) return;
      this.cancellationRequested = false;
      this.element('#evaluation-status').textContent =
        error instanceof Error ? error.message : 'No se pudo solicitar la cancelación.';
      this.element<HTMLButtonElement>('#evaluation-cancel').disabled = !this.jobRunning;
    }
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.document.querySelector<T>(selector);
    if (!element) throw new Error(`Falta un elemento del laboratorio: ${selector}`);
    return element;
  }
}
