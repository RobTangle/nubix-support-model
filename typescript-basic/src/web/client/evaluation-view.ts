import type { EvaluationReportView, EvaluationSnapshot, ReviewInput } from './lab-api.js';

/** Evidencia automática y revisión humana se muestran juntas sin adjudicar calidad con otro LLM. */
export class EvaluationView {
  private signature = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly save: (reportId: string, review: ReviewInput) => Promise<void>,
    private readonly openExecution?: (id: string) => void,
  ) {}

  reset(): void {
    this.signature = '';
    this.container.replaceChildren();
  }

  render(snapshot: EvaluationSnapshot): void {
    const signature = JSON.stringify(snapshot);
    if (signature === this.signature) return;
    const expanded = new Set(
      [...this.container.querySelectorAll<HTMLDetailsElement>('details[data-case-key][open]')].map(
        (element) => element.dataset.caseKey,
      ),
    );
    this.signature = signature;
    const document = this.container.ownerDocument;
    const summary = document.createElement('p');
    const settings = snapshot.reports[0]?.provenance.settings;
    const budget =
      settings && typeof settings === 'object' && !Array.isArray(settings)
        ? settings.evalBudgetUsd
        : null;
    summary.className = 'evaluation-progress';
    summary.textContent = `${snapshot.job.mode.toUpperCase()} · ${snapshot.job.status} · ${snapshot.progress.completed}/${snapshot.progress.total} casos · presupuesto local por trabajo: ${budget ? `USD ${budget}` : 'cargando configuración'}`;
    const content = document.createDocumentFragment();
    content.append(summary);
    if (snapshot.job.error) {
      const error = document.createElement('p');
      error.className = 'error-message';
      error.textContent = `${snapshot.job.error.code}: ${snapshot.job.error.message}`;
      content.append(error);
    }
    for (const report of snapshot.reports)
      content.append(
        this.report(report, snapshot.job.status === 'running', snapshot.reviews ?? []),
      );
    this.appendJson(content, 'Política de aceptación y revisiones guardadas', snapshot.assessments);
    this.appendJson(content, 'Selección de prompt según las reglas existentes', snapshot.selection);
    this.container.replaceChildren(content);
    for (const details of this.container.querySelectorAll<HTMLDetailsElement>(
      'details[data-case-key]',
    ))
      details.open = expanded.has(details.dataset.caseKey);
  }

  private report(
    report: EvaluationReportView,
    running: boolean,
    reviews: ReviewInput[],
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const section = document.createElement('section');
    const title = document.createElement('h3');
    const budget = document.createElement('p');
    section.className = 'evaluation-report';
    title.textContent = `${report.promptVersion} · ${report.mode} · ${report.provider}/${report.model} · ${report.split} · ${report.provenance.evidence === 'live' ? 'API real' : 'evidencia simulada: no acredita calidad'}`;
    budget.textContent = `${report.provenance.evidence === 'live' ? 'Costo estimado conocido' : 'Costo simulado'}: USD ${report.metrics.knownCostUsd ?? 'pendiente'} · reserva de consumo desconocido: USD ${report.metrics.reservedUnknownUsd ?? '0'} · llamadas LLM: ${report.metrics.llmCalls ?? 'pendiente'} · tokens entrada/salida: ${report.metrics.knownInputTokens ?? '—'}/${report.metrics.knownOutputTokens ?? '—'}`;
    section.append(title, budget);
    this.appendJson(
      section,
      'Métricas del reporte: calidad, seguridad, latencia y gasto',
      report.metrics,
    );
    this.metricTable(section, 'Por categoría', report.metrics.perCategory);
    this.metricTable(
      section,
      'Matriz de confusión (esperada → predicha)',
      report.metrics.confusionMatrix,
    );
    for (const record of report.records) {
      const details = document.createElement('details');
      details.dataset.caseKey = `${report.runId}:${record.id}`;
      const summary = document.createElement('summary');
      const ticket = document.createElement('p');
      const published = document.createElement('p');
      summary.textContent = `${record.id} · ${record.kind} · ${record.notRun ? 'pendiente' : record.errorCode ? `error: ${record.errorCode}` : 'procesado'}`;
      ticket.textContent = `Entrada: ${record.text}`;
      published.textContent = `Respuesta publicada: ${record.response ? JSON.stringify(record.response, null, 2) : 'Sin respuesta'}`;
      published.className = 'published-case-response';
      details.append(summary, ticket, published);
      if (typeof record.trace?.requestId === 'string' && this.openExecution) {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'secondary-button';
        open.textContent = 'Abrir flujo e inspector de este caso';
        open.addEventListener('click', () =>
          this.openExecution!(record.trace!.requestId as string),
        );
        details.append(open);
      }
      this.appendJson(
        details,
        'Datos del caso: categoría esperada, reglas, error y consumo',
        record,
      );
      const warning = document.createElement('p');
      warning.className = 'debug-warning';
      warning.textContent =
        'Salidas intermedias de depuración local: pueden estar sin moderar. Los indicios de reglas no reemplazan la revisión humana.';
      details.append(warning);
      this.appendJson(details, 'Salidas crudas sin moderar', record.rawOutputs);
      details.append(
        this.reviewForm(
          report.runId,
          record.id,
          record.kind,
          running,
          reviews.find((review) => review.runId === report.runId && review.caseId === record.id),
        ),
      );
      section.append(details);
    }
    return section;
  }

  private metricTable(container: HTMLElement, title: string, value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const rows = Object.entries(value);
    const first = rows.find(([, row]) => row && typeof row === 'object' && !Array.isArray(row));
    if (!first) return;
    const columns = Object.keys(first[1] as object);
    const document = this.container.ownerDocument;
    const wrapper = document.createElement('div');
    const table = document.createElement('table');
    const caption = document.createElement('caption');
    const header = document.createElement('tr');
    wrapper.className = 'table-scroll';
    caption.textContent = title;
    for (const column of ['Categoría', ...columns]) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = column;
      header.append(cell);
    }
    const head = document.createElement('thead');
    const body = document.createElement('tbody');
    head.append(header);
    for (const [category, values] of rows) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      const row = document.createElement('tr');
      const label = document.createElement('th');
      label.scope = 'row';
      label.textContent = category;
      row.append(label);
      for (const column of columns) {
        const cell = document.createElement('td');
        const metric = (values as Record<string, unknown>)[column];
        cell.textContent =
          typeof metric === 'number' && Number.isFinite(metric)
            ? String(Number(metric.toFixed(4)))
            : typeof metric === 'string'
              ? metric
              : '—';
        row.append(cell);
      }
      body.append(row);
    }
    table.append(caption, head, body);
    wrapper.append(table);
    container.append(wrapper);
  }

  private appendJson(
    container: HTMLElement | DocumentFragment,
    title: string,
    value: unknown,
  ): void {
    const document = this.container.ownerDocument;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const pre = document.createElement('pre');
    summary.textContent = title;
    pre.textContent = JSON.stringify(value, null, 2) ?? 'Sin datos';
    details.append(summary, pre);
    container.append(details);
  }

  private reviewForm(
    runId: string,
    caseId: string,
    kind: string,
    running: boolean,
    saved?: ReviewInput,
  ): HTMLFormElement {
    const document = this.container.ownerDocument;
    const form = document.createElement('form');
    const legend = document.createElement('p');
    const fields = new Map<string, HTMLSelectElement>();
    legend.textContent =
      'Revisión humana explícita · sin LLM juez. Pendiente no equivale a aprobado.';
    form.className = 'review-form';
    form.append(legend);
    const definitions = [
      ['usefulness', 'Útil', 'score'],
      ['correctness', 'Correcta', 'score'],
      ['policy', 'Cumple política', 'score'],
      ['severeIssue', 'Problema grave', 'boolean'],
      ...(kind === 'attack' ? [['attackSucceeded', 'Ataque exitoso', 'boolean']] : []),
      ...(kind === 'benign' ? [['unjustifiedRefusal', 'Rechazo injustificado', 'boolean']] : []),
    ];
    for (const [name, text, type] of definitions) {
      if (!name) continue;
      const label = document.createElement('label');
      const select = document.createElement('select');
      select.name = name;
      select.disabled = running;
      label.append(document.createTextNode(text ?? name));
      for (const [value, caption] of [
        ['', 'Pendiente'],
        [type === 'score' ? '1' : 'true', 'Sí'],
        [type === 'score' ? '0' : 'false', 'No'],
      ]) {
        const option = document.createElement('option');
        option.value = value ?? '';
        option.textContent = caption ?? '';
        select.append(option);
      }
      fields.set(name, select);
      const savedValue = saved?.[name as keyof ReviewInput];
      if (savedValue !== undefined && savedValue !== null) select.value = String(savedValue);
      label.append(select);
      form.append(label);
    }
    const label = document.createElement('label');
    const notes = document.createElement('textarea');
    const button = document.createElement('button');
    const status = document.createElement('p');
    label.textContent = 'Notas (explicá discrepancias con reglas automáticas)';
    notes.name = 'notes';
    notes.maxLength = 8000;
    notes.disabled = running;
    notes.value = saved?.notes ?? '';
    label.append(notes);
    button.type = 'submit';
    button.className = 'secondary-button';
    button.textContent = running ? 'Esperá a que termine el trabajo' : 'Guardar revisión humana';
    button.disabled = running;
    status.setAttribute('role', 'status');
    form.append(label, button, status);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const score = (name: string): 0 | 1 | null =>
        fields.get(name)?.value === '1' ? 1 : fields.get(name)?.value === '0' ? 0 : null;
      const flag = (name: string): boolean | null =>
        fields.get(name)?.value === 'true'
          ? true
          : fields.get(name)?.value === 'false'
            ? false
            : null;
      button.disabled = true;
      status.textContent = 'Guardando revisión…';
      void this.save(runId, {
        runId,
        caseId,
        usefulness: score('usefulness'),
        correctness: score('correctness'),
        policy: score('policy'),
        severeIssue: flag('severeIssue'),
        attackSucceeded: flag('attackSucceeded'),
        unjustifiedRefusal: flag('unjustifiedRefusal'),
        notes: notes.value,
      })
        .then(() => {
          status.textContent = 'Revisión guardada. Las reglas de aceptación fueron recalculadas.';
        })
        .catch(() => {
          status.textContent =
            'No se pudo guardar. Revisá las notas y los campos; no se modificó la política.';
        })
        .finally(() => {
          button.disabled = false;
        });
    });
    return form;
  }
}
