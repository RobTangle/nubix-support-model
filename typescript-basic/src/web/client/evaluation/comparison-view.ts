import type { EvaluationSnapshot } from '../lab-api.js';

/** Una vista común permite comparar versiones sin recorrer todos los casos de cada reporte. */
export function renderComparison(container: HTMLElement, snapshot: EvaluationSnapshot): void {
  if (snapshot.reports.length < 2) return;
  const document = container.ownerDocument;
  const wrapper = document.createElement('div');
  const table = document.createElement('table');
  const caption = document.createElement('caption');
  const head = document.createElement('thead');
  const header = document.createElement('tr');
  const body = document.createElement('tbody');
  wrapper.className = 'table-scroll';
  caption.textContent = 'Comparación rápida de los reportes';
  for (const label of [
    'Prompt / variante',
    'Casos procesados',
    'Macro-F1',
    'Costo conocido',
    'p95',
    'Revisión humana',
  ]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    header.append(cell);
  }
  head.append(header);
  for (const report of snapshot.reports) {
    const row = document.createElement('tr');
    const name = document.createElement('th');
    const hasTickets = report.records.some((record) => record.kind === 'ticket');
    const assessment = Array.isArray(snapshot.assessments)
      ? snapshot.assessments.find(
          (item) =>
            item && typeof item === 'object' && !Array.isArray(item) && item.runId === report.runId,
        )
      : null;
    const pending =
      assessment && typeof assessment === 'object' && !Array.isArray(assessment)
        ? assessment.pendingReviews
        : null;
    name.scope = 'row';
    name.textContent = `${report.promptVersion}${report.provenance.baselinePromptVersion === report.promptVersion ? ' · referencia' : ''} · ${report.mode === 'full' ? 'completo' : 'sin moderación'}`;
    row.append(name);
    const values = [
      `${report.records.filter((record) => !record.notRun).length}/${report.records.length}${report.complete ? '' : ' · parcial'}`,
      hasTickets && typeof report.metrics.macroF1 === 'number'
        ? `${(report.metrics.macroF1 * 100).toFixed(1)} %`
        : 'N/A',
      `USD ${report.metrics.knownCostUsd ?? 'pendiente'}`,
      typeof report.metrics.latencyP95Ms === 'number'
        ? `${Math.round(report.metrics.latencyP95Ms)} ms`
        : 'Pendiente',
      typeof pending === 'number'
        ? pending > 0
          ? `${pending} pendientes`
          : 'Completa'
        : 'Pendiente',
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
  table.append(caption, head, body);
  wrapper.append(table);
  container.append(wrapper);
}
