import type { LabRunSummary } from '../../lab/contracts.js';

export const runStatusLabels: Record<LabRunSummary['status'], string> = {
  running: 'En curso',
  completed: 'Completada',
  failed: 'Fallida',
  cancelled: 'Cancelada',
  interrupted: 'Interrumpida',
};

/** Presentación del historial: abrir una tarjeta sólo consulta evidencia persistida. */
export class HistoryView {
  constructor(
    private readonly container: HTMLElement,
    private readonly open: (id: string, kind: LabRunSummary['kind']) => void,
  ) {}

  render(items: LabRunSummary[], filtered = false): void {
    const document = this.container.ownerDocument;
    this.container.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = filtered
        ? 'No hay ejecuciones que coincidan con estos filtros. Cambiá la selección o usá Limpiar filtros.'
        : 'Todavía no hay ejecuciones de este tipo. Probá un ticket o iniciá una evaluación para guardar evidencia aquí.';
      this.container.append(empty);
    }
    for (const item of items) {
      const card = document.createElement('article');
      card.className = 'history-card';
      const header = document.createElement('div');
      header.className = 'history-card-header';
      const title = document.createElement('strong');
      title.textContent =
        item.kind === 'evaluation'
          ? 'Evaluación'
          : item.parentId
            ? 'Caso de evaluación'
            : 'Ticket de soporte';
      const status = document.createElement('span');
      status.className = 'status-badge';
      status.dataset.status = item.status;
      status.textContent = runStatusLabels[item.status];
      header.append(title, status);
      const metadata = document.createElement('p');
      metadata.className = 'history-card-meta';
      metadata.textContent = `${item.mode === 'live' ? 'API real' : 'Demo'} · ${item.provider} / ${item.model} · ${item.promptVersion}${item.parentId ? ` · trabajo ${item.parentId.slice(0, 8)}` : ''}`;
      const time = document.createElement('time');
      time.dateTime = item.createdAt;
      time.title = item.createdAt;
      time.textContent = new Intl.DateTimeFormat('es-AR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(item.createdAt));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'history-entry secondary-button';
      button.textContent = `Abrir ${item.id.slice(0, 8)}`;
      button.setAttribute(
        'aria-label',
        `Abrir ${item.kind === 'support' ? 'ticket' : 'evaluación'} ${item.id.slice(0, 8)}, ${time.textContent}`,
      );
      button.addEventListener('click', () => this.open(item.id, item.kind));
      const details = document.createElement('details');
      details.className = 'history-id';
      const summary = document.createElement('summary');
      summary.textContent = 'Identificador completo';
      const code = document.createElement('code');
      code.textContent = item.id;
      details.append(summary, code);
      card.append(header, metadata, time, button, details);
      this.container.append(card);
    }
  }
}
