# Separación y filtros del historial

Objetivo autorizado: soporte muestra tickets independientes por defecto; incluir casos de evaluación mediante checkbox. Mantener acceso directo por ID desde reportes, sin modificar ni borrar registros.

Decisión: filtrar con SQL parametrizado antes de LIMIT/OFFSET y usar el mismo predicado para COUNT. Filtrar sólo la página en el navegador rompería conteos y ocultaría coincidencias de otras páginas. Agregar proveedor, prompt, estado y LIVE/DEMO; sin fechas/buscador todavía para mantener controles acotados. Las opciones de proveedor/prompt provienen de los registros históricos, incluso versiones retiradas.

- [x] Contratos Zod compartidos para filtros, query normalizada y opciones históricas en la respuesta de listado; pruebas SQLite y HTTP primero.
- [x] Query HTTP estricta (booleano explícito true/false), SQL parametrizado y mismo WHERE en filas/total. Separación afecta listados; GET por ID sigue accesible.
- [x] HistoryFilters concentra lectura/controles/opciones; LabController conserva paginación, abort y apertura de reportes. Cambiar/limpiar filtros vuelve a primera página. Vacío filtrado explica cómo recuperar resultados.
- [x] HTML/CSS responsive, checkbox sólo para soporte, filtros aplicables a ambos tipos; docs y pruebas de combinación, paginación, reset y acceso de casos desde reportes.
- [x] Suite TS, tipos, formato, paquete offline y QA UI sin API. Reiniciar LIVE sólo sin trabajos activos; conservar SQLite y .vscode ajeno. Commits lógicos/push autorizados previamente.

Verificación: tests TypeScript completos, tipos, formato y smoke del paquete correctos. UI real: 2 tickets independientes / 22 al incluir casos, filtro sin coincidencias, limpiar, apertura de reporte y acceso al flujo de un caso por ID. Navegador 450 px y 1265 px sin overflow; ninguna llamada real ni registro nuevo. LIVE restaurado en 3087 y base preservada. Captura local: reports/lab-ux/history-filters.png.
