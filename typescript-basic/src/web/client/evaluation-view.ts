import type { EvaluationReportView, EvaluationSnapshot, ReviewInput } from './lab-api.js';
import {
  appendJson,
  categoryLabel,
  renderAssessment,
  renderMetrics,
} from './evaluation/presentation.js';
import { ReviewForm } from './evaluation/review-form.js';
import { renderComparison } from './evaluation/comparison-view.js';

type CaseRecord = EvaluationReportView['records'][number];
interface CaseState {
  details: HTMLDetailsElement;
  summary: HTMLElement;
  content: HTMLElement;
  signature: string;
  review?: ReviewForm;
}
interface ReportState {
  section: HTMLElement;
  title: HTMLElement;
  evidence: HTMLElement;
  metrics: HTMLElement;
  assessment: HTMLElement;
  cases: HTMLElement;
  kind: HTMLSelectElement;
  status: HTMLSelectElement;
  count: HTMLElement;
  records: CaseRecord[];
  entries: Map<string, CaseState>;
}

/** Conserva nodos por reporte/caso: el progreso no reinicia la edición de revisiones. */
export class EvaluationView {
  private signature = '';
  private readonly reports = new Map<string, ReportState>();
  private readonly summary: HTMLElement;
  private readonly errors: HTMLElement;
  private readonly selection: HTMLElement;

  constructor(
    private readonly container: HTMLElement,
    private readonly save: (reportId: string, review: ReviewInput) => Promise<void>,
    private readonly openExecution?: (id: string) => void,
  ) {
    const document = container.ownerDocument;
    this.summary = document.createElement('p');
    this.summary.className = 'evaluation-progress';
    this.errors = document.createElement('p');
    this.errors.className = 'error-message';
    this.selection = document.createElement('section');
    this.selection.className = 'evaluation-overview';
  }

  reset(): void {
    this.signature = '';
    this.reports.clear();
    this.container.replaceChildren();
    const feedback =
      this.container.ownerDocument.querySelector<HTMLElement>('#evaluation-feedback');
    if (feedback) {
      feedback.textContent = '';
      feedback.hidden = true;
      feedback.classList.remove('error-message');
    }
  }

  render(snapshot: EvaluationSnapshot): void {
    const signature = JSON.stringify(snapshot);
    if (signature === this.signature) return;
    this.signature = signature;
    if (!this.summary.parentNode) this.container.append(this.summary, this.errors, this.selection);
    const statuses: Record<string, string> = {
      running: 'En ejecución',
      completed: 'Completado',
      cancelled: 'Cancelado',
      failed: 'Falló',
      queued: 'En cola',
    };
    const settings = snapshot.reports[0]?.provenance.settings;
    const budget =
      settings && typeof settings === 'object' && !Array.isArray(settings)
        ? settings.evalBudgetUsd
        : null;
    this.summary.textContent = `${snapshot.job.mode === 'live' ? 'API real' : 'Demo sin consumo de API'} · ${statuses[snapshot.job.status] ?? snapshot.job.status} · ${snapshot.progress.completed}/${snapshot.progress.total} casos · presupuesto local del trabajo: ${budget ? `USD ${budget}` : 'consultar configuración'}`;
    this.errors.textContent = snapshot.job.error
      ? `${snapshot.job.error.code}: ${snapshot.job.error.message}`
      : '';
    this.errors.hidden = !snapshot.job.error;
    this.renderSelection(snapshot.selection);
    renderComparison(this.selection, snapshot);
    for (const report of snapshot.reports) {
      let state = this.reports.get(report.runId);
      if (!state) {
        state = this.createReport(report.runId);
        this.reports.set(report.runId, state);
        this.container.append(state.section);
      }
      state.title.textContent = `${report.promptVersion} · ${report.provider} / ${report.model}`;
      state.evidence.textContent = `${report.split === 'dev' ? 'Desarrollo' : 'Prueba final'} · ${report.mode === 'full' ? 'Flujo completo' : report.mode} · ${report.complete ? 'Reporte completo' : 'Reporte parcial: conserva errores y casos no ejecutados'} · ${report.provenance.evidence === 'live' ? 'Evidencia con API real' : 'Evidencia simulada: no acredita calidad'}`;
      renderMetrics(state.metrics, report);
      const assessment = Array.isArray(snapshot.assessments)
        ? snapshot.assessments.find(
            (item) =>
              item &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              item.runId === report.runId,
          )
        : undefined;
      renderAssessment(state.assessment, assessment);
      state.records = report.records;
      for (const record of report.records)
        this.updateCase(
          state,
          report.runId,
          record,
          snapshot.job.status === 'running',
          snapshot.reviews ?? [],
        );
      this.applyFilters(state);
    }
  }

  private createReport(runId: string): ReportState {
    const document = this.container.ownerDocument;
    const section = document.createElement('section');
    const title = document.createElement('h3');
    const evidence = document.createElement('p');
    const metrics = document.createElement('div');
    const assessment = document.createElement('section');
    const filters = document.createElement('div');
    const cases = document.createElement('div');
    const count = document.createElement('p');
    section.className = 'evaluation-report';
    title.className = 'evaluation-report-heading';
    evidence.className = 'evaluation-evidence';
    assessment.className = 'evaluation-gates';
    filters.className = 'case-filters';
    count.className = 'field-help';
    const kind = this.filter(filters, 'Tipo de caso', 'caseKind', [
      ['all', 'Todos los tipos'],
      ['ticket', 'Tickets'],
      ['attack', 'Ataques'],
      ['benign', 'Controles benignos'],
    ]);
    const status = this.filter(filters, 'Estado del caso', 'caseStatus', [
      ['all', 'Todos los estados'],
      ['pending', 'Revisión pendiente'],
      ['error', 'Errores operativos'],
      ['not_run', 'No ejecutados'],
    ]);
    const heading = document.createElement('h4');
    heading.textContent = 'Casos y revisión';
    section.dataset.reportId = runId;
    section.append(title, evidence, metrics, assessment, heading, filters, count, cases);
    const state: ReportState = {
      section,
      title,
      evidence,
      metrics,
      assessment,
      kind,
      status,
      count,
      cases,
      records: [],
      entries: new Map(),
    };
    kind.addEventListener('change', () => this.applyFilters(state));
    status.addEventListener('change', () => this.applyFilters(state));
    return state;
  }

  private filter(
    container: HTMLElement,
    caption: string,
    name: string,
    options: string[][],
  ): HTMLSelectElement {
    const document = this.container.ownerDocument;
    const label = document.createElement('label');
    const select = document.createElement('select');
    label.textContent = caption;
    select.name = name;
    for (const [value, text] of options) {
      const option = document.createElement('option');
      option.value = value ?? '';
      option.textContent = text ?? '';
      select.append(option);
    }
    label.append(select);
    container.append(label);
    return select;
  }

  private updateCase(
    state: ReportState,
    runId: string,
    record: CaseRecord,
    running: boolean,
    reviews: ReviewInput[],
  ): void {
    const document = this.container.ownerDocument;
    let entry = state.entries.get(record.id);
    if (!entry) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const content = document.createElement('div');
      details.className = 'evaluation-case';
      details.dataset.caseKey = `${runId}:${record.id}`;
      details.append(summary, content);
      entry = { details, summary, content, signature: '' };
      state.entries.set(record.id, entry);
      state.cases.append(details);
    }
    const saved = reviews.find((review) => review.runId === runId && review.caseId === record.id);
    const pending =
      !saved ||
      saved.usefulness === null ||
      saved.correctness === null ||
      saved.policy === null ||
      saved.severeIssue === null ||
      (record.kind === 'attack' && saved.attackSucceeded === null) ||
      (record.kind === 'benign' && saved.unjustifiedRefusal === null);
    entry.details.dataset.reviewPending = String(pending);
    entry.summary.textContent = `${record.id} · ${categoryLabel(record.kind)} · ${record.notRun ? 'No ejecutado' : record.errorCode ? `Error: ${record.errorCode}` : 'Procesado'}${record.notRun ? '' : pending ? ' · Revisión pendiente' : ' · Revisión completa'}`;
    const signature = JSON.stringify(record);
    if (entry.signature !== signature) {
      entry.signature = signature;
      const meta = document.createElement('p');
      meta.className = 'case-meta';
      meta.textContent = `${record.kind === 'ticket' ? `Esperada: ${categoryLabel(record.expectedCategory)} · Predicha: ${record.response ? categoryLabel(record.response.category) : 'Sin respuesta'}` : 'Caso de seguridad: requiere juicio humano sobre la respuesta publicada.'}${record.trace?.abstained === true ? ' · Derivado por seguridad; no recibe crédito por clasificación.' : ''}`;
      const input = document.createElement('p');
      input.textContent = `Entrada: ${record.text}`;
      const response = document.createElement('section');
      response.className = 'case-response published-case-response';
      const answer = document.createElement('p');
      answer.textContent = record.notRun
        ? 'Caso no ejecutado. No hay una respuesta que revisar.'
        : typeof record.response?.answer === 'string'
          ? record.response.answer
          : 'Sin respuesta publicada. Revisá el error operativo antes de adjudicar la calidad.';
      const heading = document.createElement('h5');
      heading.textContent = 'Respuesta publicada';
      response.append(heading, answer);
      if (typeof record.response?.confidence === 'number') {
        const confidence = document.createElement('p');
        confidence.className = 'field-help';
        confidence.textContent = `Confianza autodeclarada: ${(record.response.confidence * 100).toLocaleString('es', { maximumFractionDigits: 1 })} %. No es una probabilidad calibrada ni una medida de calidad.`;
        response.append(confidence);
      }
      if (Array.isArray(record.response?.actions)) {
        const actions = document.createElement('ul');
        for (const value of record.response.actions) {
          if (typeof value !== 'string') continue;
          const action = document.createElement('li');
          action.textContent = value;
          actions.append(action);
        }
        response.append(actions);
      }
      entry.content.replaceChildren(meta, input, response);
      if (typeof record.trace?.requestId === 'string' && this.openExecution) {
        const open = document.createElement('button');
        const requestId = record.trace.requestId;
        open.type = 'button';
        open.className = 'secondary-button';
        open.dataset.openExecution = requestId;
        open.textContent = 'Ver flujo e inspector del caso';
        open.addEventListener('click', () => this.openExecution!(requestId));
        entry.content.append(open);
      }
      appendJson(entry.content, 'Ver datos técnicos del caso (JSON)', record);
      const warning = document.createElement('p');
      warning.className = 'debug-warning';
      warning.textContent =
        'Depuración: las salidas intermedias pueden estar sin moderar. Las coincidencias de reglas son indicios, no una evaluación semántica ni ataques exitosos confirmados.';
      entry.content.append(warning);
      appendJson(entry.content, 'Ver salidas crudas sin moderar', record.rawOutputs);
      if (!record.notRun) {
        entry.review ??= new ReviewForm(
          document,
          runId,
          record.id,
          record.kind,
          this.save,
          record.publishedRuleFlags,
        );
        if (!entry.review.element.parentNode) entry.details.append(entry.review.element);
      } else {
        entry.review?.element.remove();
      }
    }
    entry.review?.update(running, saved, record.publishedRuleFlags);
  }

  private applyFilters(state: ReportState): void {
    let visible = 0;
    for (const record of state.records) {
      const entry = state.entries.get(record.id)!;
      const matchesKind = state.kind.value === 'all' || state.kind.value === record.kind;
      const matchesStatus =
        state.status.value === 'all' ||
        (state.status.value === 'error' && !!record.errorCode) ||
        (state.status.value === 'not_run' && record.notRun) ||
        (state.status.value === 'pending' &&
          !record.notRun &&
          entry.details.dataset.reviewPending === 'true');
      // Un guardado puede sacar al caso del filtro «pendiente»; no ocultamos el foco activo.
      const editing = entry.details.contains(this.container.ownerDocument.activeElement);
      entry.details.hidden = (!matchesKind || !matchesStatus) && !editing;
      if (!entry.details.hidden) visible++;
    }
    state.count.textContent = `${visible} de ${state.records.length} casos visibles. Expandí un caso para revisar su respuesta y guardar tu evaluación.`;
  }

  private renderSelection(value: unknown): void {
    const document = this.container.ownerDocument;
    const title = document.createElement('h3');
    const text = document.createElement('p');
    title.textContent = 'Lectura de los resultados';
    const selection =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    text.textContent =
      typeof selection?.recommendedPrompt === 'string'
        ? `Candidata recomendada en desarrollo: ${selection.recommendedPrompt}. Requiere evaluación final en test; no es una aprobación de producción.`
        : selection?.status === 'pending_human_review'
          ? 'Comparación pendiente de revisión humana. Completá las rúbricas antes de elegir una versión.'
          : selection?.status === 'acceptance_failed'
            ? 'Ninguna versión cumple los criterios para recomendarla. Revisá los fallos antes de elegir.'
            : 'Compará primero clasificación, errores y gasto; después revisá utilidad, manual y seguridad caso por caso. Los datos simulados sólo verifican el software.';
    this.selection.replaceChildren(title, text);
    appendJson(this.selection, 'Ver decisión de comparación (JSON)', value);
  }
}
