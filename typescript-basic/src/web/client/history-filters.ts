import {
  labHistoryFiltersSchema,
  type LabHistoryFilters,
  type LabHistoryOptions,
} from '../../lab/contracts.js';

/** Controles de lectura del historial; las opciones históricas no habilitan modelos ni prompts. */
export class HistoryFilters {
  constructor(private readonly document: Document) {}

  initialize(changed: () => void): void {
    for (const id of [
      'history-kind',
      'history-provider',
      'history-prompt',
      'history-status-filter',
      'history-mode',
      'history-include-evaluations',
    ])
      this.element(id).addEventListener('change', () => {
        this.updateScope();
        changed();
      });
    this.element('history-clear').addEventListener('click', () => {
      for (const id of [
        'history-provider',
        'history-prompt',
        'history-status-filter',
        'history-mode',
      ])
        this.element<HTMLSelectElement>(id).value = '';
      this.element<HTMLInputElement>('history-include-evaluations').checked = false;
      this.updateScope();
      changed();
    });
    this.updateScope();
  }

  read(): LabHistoryFilters {
    return labHistoryFiltersSchema.parse({
      provider: this.element<HTMLSelectElement>('history-provider').value || undefined,
      promptVersion: this.element<HTMLSelectElement>('history-prompt').value || undefined,
      status: this.element<HTMLSelectElement>('history-status-filter').value || undefined,
      mode: this.element<HTMLSelectElement>('history-mode').value || undefined,
      includeEvaluationCases:
        this.element<HTMLSelectElement>('history-kind').value === 'support' &&
        this.element<HTMLInputElement>('history-include-evaluations').checked,
    });
  }

  populate(options: LabHistoryOptions): void {
    this.populateSelect('history-provider', options.providers, 'Todos los proveedores');
    this.populateSelect('history-prompt', options.promptVersions, 'Todas las versiones');
  }

  private populateSelect(id: string, values: string[], caption: string): void {
    const select = this.element<HTMLSelectElement>(id);
    const selected = select.value;
    const entries = ['', ...new Set([...values, ...(selected ? [selected] : [])])];
    if (
      JSON.stringify([...select.options].map((option) => option.value)) === JSON.stringify(entries)
    )
      return;
    select.replaceChildren();
    for (const value of entries) {
      const option = this.document.createElement('option');
      option.value = value;
      option.textContent = value || caption;
      select.append(option);
    }
    select.value = selected;
  }

  private updateScope(): void {
    const support = this.element<HTMLSelectElement>('history-kind').value === 'support';
    const include = this.element<HTMLInputElement>('history-include-evaluations');
    include.disabled = !support;
    this.element('history-origin').hidden = !support;
    this.element('history-scope').textContent = !support
      ? 'Trabajos de evaluación. Abrí un reporte para acceder al flujo de cada caso.'
      : include.checked
        ? 'Tickets independientes y casos de evaluación; estos últimos identifican su trabajo de origen.'
        : 'Sólo tickets independientes. Los casos siguen accesibles desde sus reportes o al incluirlos aquí.';
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.document.getElementById(id);
    if (!element) throw new Error(`Falta un control del historial: ${id}`);
    return element as T;
  }
}
