# Observabilidad en vivo de Nubbix TypeScript

**Objetivo:** implementar la propuesta aceptada: eventos de ejecución estructurados, Express y un frontend didáctico con línea de tiempo, timestamps, duraciones y detalles.

**Arquitectura:** conservar los eventos `llm_attempt` y `run_summary`; agregar un canal tipado de observación de ciclo de vida, independiente del transporte. `RunObserver` pertenece a una invocación. Un adaptador observado del proveedor y funciones de validación/registro mantienen la instrumentación fuera de la política de soporte. Express transmite JSONL; el frontend TypeScript lo valida y presenta. No se agregan herencia, contenedores DI ni una clase por evento.

**Decisiones:** usar TypeScript de navegador y esbuild, con HTML/CSS servidos por Express; no hace falta incorporar React para esta pantalla. Modo demo predeterminado, modo live explícito. Proveedor y prompt seleccionables entre opciones configuradas. Sin LLM juez, base de datos, colas ni captura de propuestas sin moderar. La propuesta previa del chat y la instrucción de implementación constituyen la aprobación del alcance.

## Restricciones

- Comentarios en español; no dejar líneas vacías dentro de funciones.
- Conservar contratos públicos, presupuestos, plazos, cancelación y las dos oportunidades por etapa.
- Nunca emitir tickets, prompts, propuestas sin moderar, claves ni errores SDK en eventos.
- Emisión opcional: CLI y HTTP pueden consumir los mismos eventos; aislamiento por requestId.
- Timestamps ISO UTC; duraciones y elapsedMs medidos con reloj monotónico.
- HTTP sólo loopback, mismo origen, cuerpo acotado, concurrencia acotada y cancelación por desconexión.
- Frontend con textContent, validación de frames, límite de eventos y detección de stream incompleto.
- No llamadas reales a modelos para verificar; los dobles deben identificarse como demo.
- No incluir `.vscode/` ni archivos generados en commits. El usuario autorizó commits y push previamente.

## Tareas verificables

- [x] 1. Contratos y RunObserver: tests RED/GREEN para orden, timestamps, duración, privacidad y aislamiento; reloj inyectable sólo como dependencia útil.
- [x] 2. Integrar proveedores observados, validación y resumen en el servicio; tests RED/GREEN de tres etapas, reparación, fallos y cancelación. Mantener compacto el servicio.
- [x] 3. Express y streaming JSONL: tests offline de recepción incremental antes de completar, validación, desconexión, límites, errores sanitizados y concurrencia.
- [x] 4. Frontend: formulario, proveedor/prompt, modo visible, timeline con actores, detalles, respuesta segura y cancelación; tests de parser y DOM más inspección visual.
- [x] 5. CLI, recursos del paquete, documentación y diagramas; verificar tests completos, tipos, formato, empaquetado, Python y revisión independiente del cambio.

## Contratos entre tareas

- `src/observability/events.ts`: exporta `flowEventSchema`, `FlowEvent`, `FlowSink` y `FlowEventName`; FlowEvent tiene schemaVersion 1, requestId UUID, sequence, timestamp ISO UTC, elapsedMs, durationMs nullable, provider/model/promptVersion, event, stage/attempt opcionales y details de metadatos con campos explícitos.
- `ProcessOptions`: añade `observe?: FlowSink` y `requestId?: string`; `AssistantOptions` añade `observe?: FlowSink`. `SupportAssistant.process` conserva respuesta/traza y llama al sink durante la ejecución.
- `POST /api/support/stream`: cuerpo estricto `{text, provider, promptVersion}`. Frames JSONL: `{type:'accepted', requestId, mode, receivedAt}`, `{type:'event', event:FlowEvent}`, `{type:'result', requestId, mode, response, trace}` o `{type:'error', requestId, error:{code,message}}`. Un único resultado/error terminal.
- `GET /api/config`: `{mode:'demo'|'live', providers:[{id,label,model,available}], promptVersions:['basic-v1','basic-v2'], maxConcurrent}`. Nunca incluye claves.
- `src/web/contracts.ts`: esquemas compartidos HTTP/browser, importa contratos Zod sin dependencias Node en runtime. Incluye `streamFrameSchema`, `webConfigurationSchema`.
- `src/web/app.ts`: `createApp(options)` recibe `configuration`, `createAssistant(provider,promptVersion)` async o sync y límites; no lee claves ni abre sockets.
- `src/web/server.ts`: composition root; carga recursos y dependencias una vez, arranca 127.0.0.1 con `--port`, `--live`, `--env-file`, `--help`.
- `src/web/public/{index.html,styles.css}` y `src/web/client/`: frontend. Build bundle `dist/web/public/app.js`; copia HTML/CSS. Express sirve ese directorio relativo al módulo compilado.

## Riesgos que deben probarse

1. Observer o navegador lento: no extender el deadline ni dejar conexiones pendientes.
2. Fallo después de recibir tokens: conservar consumo conocido, incluso si falla observar/validar.
3. HTML malicioso en un resultado: mostrar texto, nunca ejecutarlo; no publicar generación previa a moderación.
4. Requests concurrentes y cancelación: no mezclar IDs, contadores, eventos ni señales.
5. JSONL partido en fragmentos, error terminal o EOF inesperado: no marcar éxito por cerrar la conexión.

## Registro de ejecución

- Base: checkout activo limpio salvo `.vscode/`; se conserva para no mover el contexto del usuario.
- Paralelismo: backend HTTP y frontend son independientes una vez fijados estos contratos; raíz implementa observabilidad y coordina integración. Cada worker posee rutas separadas.
- Revisión independiente: dos P2 reproducidos y corregidos RED/GREEN: consumo tardío tras deadline y cancelación que envenenaba la cola del archivo compartido. Sin findings accionables pendientes tras volver a revisar las correcciones.
- Integración de navegador: flujo incremental visible antes de terminar; cierre con 25 eventos y tres requests; bloqueo corta en una request. Se corrigió con RED/GREEN el receptor de fetch nativo. Test de DOM comprueba cancelación del formulario.
- Compatibilidad: `llm_attempt` y `run_summary` conservan formato. CLI opt-in `--flow-events`. No cambia contrato de respuesta ni esquema de reportes de evals.
- Límites: frames y líneas de 256 KiB, 500 frames en el lector; cuatro requests concurrentes; HTTP128KiB; deadline hasta60s. Unicode extenso cubierto por regresión.
- Verificaciones: suite TypeScript completa, suite Python154, tipos, formato, Ruff/mypy, paquete instalado offline con HTTP/demo desde otro cwd y cinco diagramas Mermaid. Ninguna llamada real a modelos.
