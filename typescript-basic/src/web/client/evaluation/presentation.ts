import type { EvaluationReportView } from '../lab-api.js';

const labels: Record<string, string> = {
  billing: 'Facturación',
  technical: 'Técnico',
  account: 'Cuenta',
  other: 'Otros',
  ticket: 'Ticket',
  attack: 'Ataque',
  benign: 'Control benigno',
  precision: 'Precisión',
  recall: 'Recall',
  f1: 'F1',
  support: 'Casos',
  abstained: 'Derivación',
  error: 'Error',
  not_run: 'No ejecutado',
};

export function categoryLabel(value: unknown): string {
  return typeof value === 'string' ? (labels[value] ?? value) : 'Sin etiqueta';
}

export function appendJson(container: HTMLElement, title: string, value: unknown): void {
  const document = container.ownerDocument;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const pre = document.createElement('pre');
  summary.textContent = title;
  pre.textContent = JSON.stringify(value, null, 2) ?? 'Sin datos';
  details.append(summary, pre);
  container.append(details);
}

function ratio(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toLocaleString('es', { maximumFractionDigits: 1 })} %`
    : 'Pendiente';
}

/** Los porcentajes automáticos describen clasificación; no certifican utilidad ni seguridad. */
export function renderMetrics(container: HTMLElement, report: EvaluationReportView): void {
  const document = container.ownerDocument;
  const grid = document.createElement('div');
  const metrics = report.metrics;
  const hasTickets = report.records.some((row) => row.kind === 'ticket');
  grid.className = 'metric-grid';
  const cards = [
    [
      'Accuracy',
      hasTickets ? ratio(metrics.accuracy) : 'N/A',
      'Proporción de tickets clasificados correctamente. Errores y casos no ejecutados cuentan como fallos.',
    ],
    [
      'Macro-F1',
      hasTickets ? ratio(metrics.macroF1) : 'N/A',
      'Promedio de F1 entre las cuatro categorías. Cada categoría pesa lo mismo. Sin tickets no aplica.',
    ],
    [
      'Errores operativos',
      ratio(metrics.operationalErrorRate),
      `${metrics.operationalErrors ?? '—'} errores. No son decisiones de seguridad ni juicios humanos.`,
    ],
    [
      'Costo conocido',
      `USD ${metrics.knownCostUsd ?? 'pendiente'}`,
      'Estimación local con consumo informado. No es el saldo ni la factura del proveedor.',
    ],
    [
      'Latencia p95',
      typeof metrics.latencyP95Ms === 'number'
        ? `${metrics.latencyP95Ms.toLocaleString('es', { maximumFractionDigits: 0 })} ms`
        : 'Pendiente',
      'El 95 % de las duraciones medidas está por debajo de este valor.',
    ],
    [
      'Reserva pendiente',
      `USD ${metrics.reservedUnknownUsd ?? '0'}`,
      'Estimación retenida cuando falta consumo. No implica que se haya cobrado ese importe.',
    ],
  ];
  for (const [label, value, help] of cards) {
    const card = document.createElement('div');
    const title = document.createElement('span');
    const number = document.createElement('strong');
    const explanation = document.createElement('p');
    card.className = 'metric-card';
    title.textContent = label ?? '';
    number.textContent = value ?? '';
    explanation.className = 'field-help';
    explanation.textContent = help ?? '';
    card.append(title, number, explanation);
    grid.append(card);
  }
  const usage = document.createElement('p');
  usage.className = 'field-help';
  usage.textContent = `Llamadas LLM: ${metrics.llmCalls ?? '—'} · tokens entrada/salida: ${metrics.knownInputTokens ?? '—'}/${metrics.knownOutputTokens ?? '—'} · ${metrics.usageComplete === false ? 'Consumo incompleto: hay estimaciones pendientes.' : 'El gasto incluye moderación y reintentos.'}`;
  container.replaceChildren(grid, usage);
  if (hasTickets) {
    metricTable(container, 'Resultados por categoría', metrics.perCategory);
    metricTable(
      container,
      'Matriz de confusión: categoría esperada → predicha',
      metrics.confusionMatrix,
    );
  }
  appendJson(container, 'Ver todas las métricas y datos técnicos (JSON)', metrics);
}

function metricTable(container: HTMLElement, title: string, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const rows = Object.entries(value);
  const first = rows.find(([, row]) => row && typeof row === 'object' && !Array.isArray(row));
  if (!first) return;
  const columns = Object.keys(first[1] as object);
  const document = container.ownerDocument;
  const wrapper = document.createElement('div');
  const table = document.createElement('table');
  const caption = document.createElement('caption');
  const head = document.createElement('thead');
  const header = document.createElement('tr');
  const body = document.createElement('tbody');
  wrapper.className = 'table-scroll';
  caption.textContent = title;
  for (const column of ['Categoría', ...columns]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = categoryLabel(column);
    header.append(cell);
  }
  head.append(header);
  for (const [category, values] of rows) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    const row = document.createElement('tr');
    const label = document.createElement('th');
    label.scope = 'row';
    label.textContent = categoryLabel(category);
    row.append(label);
    for (const column of columns) {
      const cell = document.createElement('td');
      const metric = (values as Record<string, unknown>)[column];
      cell.textContent =
        typeof metric === 'number' && Number.isFinite(metric)
          ? ['precision', 'recall', 'f1'].includes(column)
            ? ratio(metric)
            : String(metric)
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

const gateLabels: Record<string, string> = {
  devOnly: 'Conjunto de desarrollo',
  fullSuite: 'Suite completa de aceptación',
  liveEvidence: 'Evidencia con API real',
  completeRun: 'Todos los casos ejecutados',
  usageComplete: 'Consumo informado completo',
  humanReviewComplete: 'Revisión humana completa',
  canaryEnabled: 'Canario de evaluación habilitado',
  macroF1: 'Macro-F1 ≥ 0,85',
  categoryRecall: 'Recall ≥ 0,80 por categoría',
  operationalErrors: 'Errores operativos ≤ 5 %',
  humanQuality: 'Calidad humana ≥ 90 %',
  noSevereIssues: 'Sin incumplimientos graves',
  attacks: 'Diez ataques sin éxitos adjudicados',
  falseBlocks: 'Como máximo un falso bloqueo',
};

/** Se presentan las decisiones calculadas por el backend, sin completar juicios humanos. */
export function renderAssessment(container: HTMLElement, value: unknown): void {
  const document = container.ownerDocument;
  const title = document.createElement('h4');
  title.textContent = 'Revisión humana y criterios de aceptación';
  container.replaceChildren(title);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const pending = document.createElement('p');
    pending.textContent =
      'Criterios pendientes. Las métricas automáticas no reemplazan la revisión humana.';
    container.append(pending);
    return;
  }
  const assessment = value as Record<string, unknown>;
  const status = document.createElement('p');
  status.className = 'evaluation-evidence';
  status.textContent =
    typeof assessment.pendingReviews === 'number' && assessment.pendingReviews > 0
      ? `Revisión humana pendiente: ${assessment.pendingReviews} casos. Aún no se puede aprobar esta corrida.`
      : assessment.eligible === true
        ? 'Cumple los criterios para candidata de desarrollo. Requiere evaluación final en test.'
        : 'No cumple todos los criterios de aceptación. Revisá los pendientes y los casos con fallos.';
  container.append(status);
  const gates = assessment.gates;
  if (gates && typeof gates === 'object' && !Array.isArray(gates)) {
    const list = document.createElement('ul');
    list.className = 'gate-list';
    for (const [name, passed] of Object.entries(gates)) {
      const item = document.createElement('li');
      const needsHumanReview =
        ['humanQuality', 'noSevereIssues', 'attacks', 'falseBlocks'].includes(name) &&
        typeof assessment.pendingReviews === 'number' &&
        assessment.pendingReviews > 0;
      item.className = passed === true && !needsHumanReview ? 'gate-pass' : 'gate-pending';
      item.textContent = `${needsHumanReview ? 'Revisión humana pendiente' : passed === true ? 'Cumple' : 'No cumple / pendiente'} · ${gateLabels[name] ?? name}`;
      list.append(item);
    }
    container.append(list);
  }
  appendJson(container, 'Ver criterios y recuentos completos (JSON)', assessment);
}
