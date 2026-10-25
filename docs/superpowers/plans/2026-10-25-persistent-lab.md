# Historial, inspector de datos y evaluaciones en el laboratorio

**Objetivo:** implementar la solicitud del usuario de persistencia local, evaluaciones en UI, datos por etapa y APIs reales usando las claves existentes de OpenAI/Google AI (reutilización confirmada explícitamente).

**Arquitectura:** SQLite mediante `node:sqlite` de Node24, repositorio local con migración e índices. Datos de inspección en un canal separado de FlowEvent. Un servicio de evaluaciones invoca EvalRunner y persiste checkpoints sin depender de la conexión del navegador. El frontend incorpora historial y evaluación/revisión sobre los mismos contratos y reglas. La política central de soporte no conoce SQLite ni HTTP.

**Decisiones:** `npm run web` live por defecto; demo sólo `--demo`/`npm run web:demo`, sin cambio automático ante falta de clave. SQLite sin ORM ni addon nativo; operaciones breves y síncronas, justificadas por el alcance local, con WAL y consultas parametrizadas. No LLM juez. Datos de depuración claramente identificados como no moderados cuando corresponda, renderizados como texto, sin headers de autenticación ni claves de configuración. El histórico conserva entradas admitidas, eventos, inspecciones, resultados y errores sanitizados. El archivo local contiene contenido: se excluye de Git y se documenta que no está cifrado.

## Restricciones

- Sin llamadas reales para los tests; arrancar live no debe generar llamadas. Las credenciales no se imprimen ni se reescriben.
- Comentarios español, sin líneas vacías dentro de funciones; clases pequeñas con responsabilidades reales y directorios por módulo.
- Conservar límites y seguridad existentes; cuerpo/request local128KiB; presupuesto ticket0.05USD, evaljob5USD; comparaciones comparten saldo.
- Historial paginado, inspecciones acotadas, orden y aislamiento por UUID, consultas parametrizadas y validación Zod.
- Persistir antes de consumir API; si falla almacenamiento, fallo sanitizado. Conservar consumo conocido y estados parciales.
- Job de eval continúa al desconectar UI; cancelación explícita; registrar interrupciones tras reinicio sin declarar éxito.
- Mantener formato de reportes CLI y reglas de revisión/promoción; fake/demo nunca acredita calidad. No alterar stdout CLI.
- Preservar .vscode y cambios locales; commits lógicos y push autorizados previamente.

## Contratos compartidos

- `src/inspection/contracts.ts`: `inspectionEntrySchema`, `InspectionEntry`, `InspectionSink`; entrada contiene requestId, sequence, timestamp, kind ('http.request'|'input.received'|'input.validated'|'llm.request'|'llm.response'|'schema.validation'), stage/attempt opcionales, `data` JSON. Canal sólo inspector, nunca FlowEvent.
- `ProcessOptions.inspect?: InspectionSink`: captura explícita; la implementación enruta entradas normalizadas, schema JSON, solicitudes neutrales y salidas crudas/validadas. Nunca objetos SDK/headers/env.
- `src/lab/contracts.ts`: esquemas browser-safe `labRunSummarySchema`, `labRunDetailSchema`, tipos `LabRunSummary`, `LabRunDetail`. Summary: id UUID, kind support/evaluation, mode demo/live, provider/model/promptVersion, status running/completed/failed/cancelled/interrupted, createdAt, finishedAt|null, parentId|null. Detail añade input JSON, result JSON|null, error {code,message}|null, events FlowEvent[], inspections InspectionEntry[].
- `LabStore(path)`: `createRun({id,kind,mode,provider,model,promptVersion,input,parentId?})`, `appendEvent(id,event)`, `appendInspection(id,entry)`, `finishRun(id,{status,result,error?})`, `listRuns({kind?,limit?,offset?}) -> {items,total}`, `getRun(id)->LabRunDetail|null`, `saveReport(jobId, report)`, `getReports(jobId)->EvaluationReport[]`, `saveReview(reportId,review)`, `getReviews(reportId)->HumanReview[]`, `close()`. Validar entradas y resultados. Métodos síncronos para pequeñas transacciones SQLite. Recuperar corridas abandonadas sin invalidar procesos aún vivos (registrar owner_pid y verificar existencia; cierre marca propias corridas activas como interrupted).
- `WebApplicationOptions.store?:LabStore`: soporte persiste cuando hay store (servidor siempre lo crea; tests previos compatibles sin store).
- GET `/api/history?kind=support|evaluation&limit=30&offset=0` -> `{items,total}`; GET `/api/history/:id` -> LabRunDetail. No exponer ruta de archivo arbitraria.
- Stream añade `{type:'inspection', inspection:InspectionEntry}`; lector valida identidad, orden separado y límites. Se presenta en un inspector distinto del timeline de metadatos. No se confunde con respuesta final.
- `src/lab/evaluations.ts`: `LabEvaluationService` con start(input), get(jobId), cancel(jobId), saveReview(jobId,reportId,review), close(). Input estricto {provider,operation:run|compare|adversarial,promptVersion,basic-v1/v2,split:dev|test,compareModeration:boolean}. start retorna {jobId}; get retorna {job:LabRunDetail,reports:EvaluationReport[],progress:{completed,total},assessments,selection}. Una evaluación activa por servidor (y límites de presupuesto existentes).
- Endpoints eval: POST `/api/evaluations` ->202{jobId}; GET `/api/evaluations/:id`; POST `/:id/cancel`; PUT `/:id/reports/:reportId/reviews` recibe HumanReview. Validación, límites y errores sanitizados; no shell/subprocess para ejecutar evals.
- EvalRunnerOptions añade `checkpoint?:(report)=>void|Promise<void>`; después de reserve/casecheckpoint/finish persiste snapshot. CLI sin callback conserva comportamiento.

## Tareas y evidencia

- [x] 1. Contratos de inspección y pruebas RED/GREEN; instrumentación sin contenido en eventos de operación.
- [x] 2. SQLite, historial y persistencia del flujo HTTP; pruebas de reapertura, aislamiento, fallos y consulta.
- [x] 3. Jobs de eval, checkpoints, cancelación, revisión humana y rutas; tests offline sobre runner real con proveedores falsos.
- [x] 4. UI de histórico, inspector, evals y revisión, manteniendo flujo en vivo; tests DOM/parser y QA visual.
- [x] 5. Live por defecto, demo explícito, documentación, empaquetado, revisión independiente y suite integral.

## Resultado de verificación

- Suite TypeScript completa, tipos y formato: pasan. Suite Python existente: 154 pruebas pasan.
- Paquete instalado desde otro directorio: CLI, prompts, evals, assets HTTP, SQLite, historia e inspecciones pasan con proveedores falsos. Se usó `npm --cache .npm-cache run smoke:package`; la caché global no contenía todos los tarballs.
- QA navegador en servidor demo aislado: ticket de tres llamadas, historial tras recarga, suite adversarial de 20 casos, nota de revisión persistida y apertura del flujo de un caso. No se calificó semánticamente el modelo falso.
- Revisión independiente: se corrigió drenaje de tickets antes de cerrar SQLite, rechazo de revisiones anticipadas y conservación de usage informado por un error posterior al aborto. Pruebas de regresión pasan.
- Se inició el servidor LIVE en puerto 3087 con OpenAI y Google AI disponibles, sin enviar tickets ni evaluaciones reales. La validación de credenciales contra el proveedor queda para la primera llamada del usuario.
- Inspección HTTP inicial agregada al canal renumerado en el adaptador; eventos del servicio mantienen su secuencia independiente. La política central no importa HTTP ni SQLite.

## Coordinación

- Raíz: inspección/core, servicio eval/rutas, server bootstrap, package/scripts/docs y verificación.
- Worker persistencia: lab/contracts.ts, lab/storage.ts, web/app.ts (persistencia+historial+frameinspection), web/contracts.ts (nuevaframe), tests propios.
- Worker UI: web/client/** y web/public/**, tests cliente. Coordinar contratos sin modificar core ni SQLite.
- Cada worker respeta cambios ajenos y no hace commits ni subagentes.
