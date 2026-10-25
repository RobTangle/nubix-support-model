# Nubbix Support didáctico en TypeScript

Implementación didáctica de Nubbix en TypeScript con Zod y los SDK oficiales de OpenAI, xAI y Google AI. Nació como espejo de `nubbix_support_basic` y conserva el directorio y nombre npm, pero ahora incluye moderación de entrada y salida, reintentos acotados, presupuesto, telemetría y evaluaciones. El resultado público sigue siendo `{answer, confidence, category, actions}`.

Requiere **Node.js 24+** y npm. Este directorio es un proyecto npm independiente dentro del mismo repositorio. No requiere instalar Python ni ejecutar la versión completa.

```powershell
cd typescript-basic
npm ci
npm run dev -- --help
npm run check
npm run format:check
npm test
npm run smoke:package
```

Para llamadas reales, configurá sólo la clave elegida en el `.env` de la **raíz del repositorio**, compartido con Python. Las variables del proceso tienen prioridad. También podés pasar `--env-file ruta/al/archivo`. El help y los tests no requieren claves; los tests interceptan la red.

| Proveedor | Clave | Modelo configurable | Valor predeterminado |
|---|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `NUBBIX_OPENAI_MODEL` | `gpt-6-luna` |
| xAI | `XAI_API_KEY` | `NUBBIX_XAI_MODEL` | `grok-4.20-0309-non-reasoning` |
| Google AI | `GEMINI_API_KEY` | `NUBBIX_GOOGLE_AI_MODEL` | `gemini-3.5-flash-lite` |

```powershell
# Estos comandos requieren una clave y consumen saldo del proveedor.
npm run dev -- --text "Me cobraron dos veces este mes" --provider openai
"No puedo acceder a mi cuenta" | npm run dev -- --stdin --provider xai
npm run dev -- --text "Necesito una factura" --provider openai --prompt-version basic-v2 --telemetry-file reports/telemetry.jsonl
```

Para consumir el JSON desde otro proceso, ejecutá la CLI directamente: npm puede agregar sus propios mensajes a stdout.

```powershell
npm run build
node dist/cli.js --text "Necesito una factura" --provider openai
```

La CLI directa publica sólo la respuesta de cuatro campos en stdout. Los eventos JSONL y errores sanitizados van a stderr; un error operativo termina con código 2. `--telemetry-file` agrega un destino JSONL asíncrono. Los eventos contienen metadatos, tokens, costo, latencia y estados; excluyen tickets, prompts, respuestas y claves. Hay un evento por intento y un resumen final incluso ante fallo. npm puede agregar mensajes propios a stdout: para integrar procesos usá `node dist/cli.js`.

`actions` contiene sugerencias; no ejecuta cambios. `confidence` es autodeclarada, no calibrada. No hay servidor HTTP ni selección automática de proveedor o prompt. No hay resultados live ni un ganador de calidad demostrado todavía.

## Archivo de pruebas manuales

La CLI guarda automáticamente un JSON por ejecución en `typescript-basic/reports/manual-tests/<hash-del-ticket>/<proveedor>--<reportId>.json`. El directorio predeterminado se resuelve desde el proyecto, independientemente de dónde abras la terminal. El hash se calcula sobre el ticket normalizado: repetirlo con otro proveedor agrupa los resultados en la misma carpeta y cada ejecución conserva su propio archivo.

Podés seguir usando los mismos comandos o elegir otro destino:

```powershell
npm run dev -- --provider openai --text "Me cobraron dos veces este mes. Necesito ayuda."
npm run dev -- --provider google-ai --text "Me cobraron dos veces este mes. Necesito ayuda."
npm run dev -- --provider openai --text "Necesito una factura" --reports-dir reports/mi-experimento
```

Cada reporte de formato `2` contiene el ticket original y normalizado, fechas UTC, proveedor/modelo, versiones de aplicación/Node/SDK, prompts completos y sus hashes, esquemas JSON, límites efectivos, catálogo de precios exacto y su hash, respuesta pública o error sanitizado, traza de intentos, tokens, costos, latencias y salidas de texto intermedias. `rawOutputs` puede incluir respuestas rechazadas o JSON inválido útiles para diagnosticar reintentos. `humanReview` empieza pendiente para que agregues tus observaciones.

El archivo se reserva con estado `running` antes de llamar al proveedor y pasa a `finished` al concluir, incluso ante un fallo operativo o cancelación controlada. Si el proceso termina abruptamente puede quedar `running`, lo que indica una corrida sin cierre confirmado; ese archivo inicial no contiene las salidas de las etapas que hayan ocurrido antes de la interrupción. Los errores de argumentos o configuración anteriores a la inicialización del reporte no producen archivos.

Estos reportes contienen texto del ticket y del modelo; quedan en `reports/`, excluido de Git. No guardan credenciales, el entorno completo, clientes ni objetos crudos del SDK. La telemetría de stderr y `--telemetry-file` sigue incluyendo sólo metadatos. Si no se puede reservar el reporte, la CLI falla con `report_error` antes de consumir API; si falla al finalizarlo, no publica la respuesta. Si además existía un fallo operativo, conserva ese error principal e informa el fallo de archivado por separado.

Los dos resultados importados desde el chat conservan su formato `1`, su carpeta `cobro-duplicado` y la identificación explícita de los datos que no estaban disponibles.

## Flujo y límites

Una entrada válida contiene hasta 8000 puntos Unicode. El flujo habitual realiza tres llamadas: moderación de entrada → generación → moderación de salida. Los moderadores comparten el manual con generación y devuelven `allow`, `review` o `block`. Sólo `allow` continúa; una decisión diferente o una negativa del modelo produce una respuesta estática de derivación humana (`category: "other"`, `confidence: 0`). Un fallo operativo de moderación devuelve error y evita publicar la propuesta.

Si la generación tiene `confidence < 0.70`, el servicio agrega la acción de revisión humana, manteniendo hasta cinco acciones, **antes** de moderar la salida. La moderación analiza también `actions`. JSON Schema nativo y Zod comprueban estructura; la corrección semántica y la seguridad requieren evaluación. Moderar con otro llamado LLM reduce algunos riesgos y también puede equivocarse.

Cada etapa admite **dos intentos totales**, compartidos entre errores transitorios y reparación de JSON/Zod. Los SDK tienen reintentos desactivados. Moderación permite hasta 128 tokens y generación hasta 1024; cada llamada dispone de hasta 15 segundos y el ticket completo de 60 segundos. La señal de cancelación alcanza la red y la lectura del body. No se abre una segunda cuota de dos intentos al cambiar de tipo de error.

El presupuesto estimado predeterminado es USD `0.05` por ticket completo y USD `5` por ejecución de evals, configurables con `NUBBIX_TICKET_BUDGET_USD` y `NUBBIX_EVAL_BUDGET_USD`. `decimal.js` evita sumas monetarias con punto flotante binario. Se reserva antes de llamar y se concilia con el consumo informado; si falta consumo o su desglose, se conserva una reserva desconocida. Estos controles locales no garantizan la factura final del proveedor. El catálogo compartido está fechado **2026-10-23**: la fecha identifica la instantánea del repositorio, no una verificación actual de precios.

`basic-v1` renderiza exactamente el texto original del prompt Python básico, extrayendo su manual a `src/resources/context.yaml`. `basic-v2` mantiene ese contexto y agrega cuatro ejemplos independientes, uno por categoría. Las políticas de moderación y reparación están en `safety.yaml`. El marcador sintético de filtración se incorpora sólo en evaluaciones, nunca al flujo normal. Python completo usa otro manual: igualdad de controles no implica igualdad de prompts ni resultados entre implementaciones.

Leé la [guía Python ↔ TypeScript](../docs/typescript-python-guide.md) para seguir un ticket, entender Zod y comparar los archivos, las clases, los errores y la concurrencia.

## Diagramas del procesamiento de tickets

Los diagramas usan Mermaid: GitHub los renderiza dentro del README. Los nombres de clases y archivos corresponden a esta implementación TypeScript.

### Recorrido resumido

```mermaid
flowchart TD
  A["Ticket desde CLI"] --> B["Validar entrada con Zod"]
  B --> C["Moderar entrada"]
  C -->|allow| D["Clasificar y proponer respuesta"]
  D --> E["Validar contrato y agregar revisión si confidence menor a 0.70"]
  E --> F["Moderar answer y actions"]
  F -->|allow| G["Archivar reporte y publicar JSON"]
  C -->|review, block o refusal| H["Respuesta estática para derivación humana"]
  F -->|review, block o refusal| H
  D -->|refusal| H
  H --> G
  B -->|entrada inválida| I["Error sanitizado; sin respuesta en stdout"]
  C & D & F -->|fallo operativo tras intentos permitidos| I
```

Hay normalmente tres llamadas al LLM. Cada una pasa por el mismo ejecutor, que aplica presupuesto, plazos, validación y hasta dos intentos. Una negativa de seguridad produce una respuesta estática; un fallo técnico produce un error. Las acciones son sugerencias para una persona.

### Recorrido detallado y responsabilidades

```mermaid
flowchart TD
  A["cli.ts: leer argumentos o stdin"] --> B{"ticketSchema: entrada válida?"}
  B -->|no| ERR["AppError sanitizado; exit 2"]
  B -->|sí| C["Cargar configuración, tarifa, YAML y hashes"]
  C --> D["RunReportWriter: reservar archivo running antes de consumir API"]
  D --> E["Crear adaptador SDK y SupportAssistant"]
  E --> F["runSession: presupuesto y traza locales; deadline de 60 s"]
  F --> IN["StructuredExecutor: input_moderation"]
  IN --> IV{"Decisión allow?"}
  IV -->|no o refusal| SAFE["safeResponse: other, confidence 0, derivación humana"]
  IV -->|sí| GEN["StructuredExecutor: generation; contrato SupportResponse"]
  GEN -->|refusal| SAFE
  GEN --> CF{"confidence menor a 0.70?"}
  CF -->|sí| HR["Agregar revisión humana; conservar hasta cinco acciones"]
  CF -->|no| OUT["StructuredExecutor: output_moderation sobre el objeto final"]
  HR --> OUT
  OUT --> OV{"Decisión allow?"}
  OV -->|no o refusal| SAFE
  OV -->|sí| OK["Conservar propuesta validada"]
  SAFE & OK --> FIN["Cerrar traza y telemetría; finalizar reporte"]
  FIN --> PUB["stdout: answer, confidence, category, actions"]
  C & D & E & F & IN & GEN & OUT -->|error| ERR
  ERR --> ARCH["Si se reservó reporte, registrar el fallo y la traza disponible"]
  ARCH --> STOP["stderr: error JSONL; stdout vacío"]

  subgraph EXEC["Dentro de cada llamada de StructuredExecutor"]
    X1["Comprobar cancelación, plazo y presupuestos"] --> X2["Reservar costo estimado antes de llamar"]
    X2 --> X3["Adaptador del proveedor: JSON Schema; timeout hasta 15 s"]
    X3 --> X4["Normalizar estado y tokens; validar JSON con Zod"]
    X4 --> X5["Conciliar costo o conservar reserva desconocida; emitir evento"]
    X5 --> X6{"Error transitorio o JSON inválido, y queda un intento?"}
    X6 -->|sí| X7["Espera acotada o instrucción YAML de reparación"]
    X7 --> X1
    X6 -->|no| X8["Devolver valor, refusal o error al servicio"]
  end
  IN -.-> X1
  GEN -.-> X1
  OUT -.-> X1
```

El bloque del ejecutor explica las tres cajas de llamadas; sus flechas punteadas representan reutilización, no llamadas adicionales. La telemetría de intentos y cierre contiene sólo metadatos. El reporte manual separado conserva contenido para inspección. Si falla el archivado o el cierre de telemetría, la CLI devuelve error en lugar de publicar la propuesta; los fallos de configuración anteriores a la reserva no crean un reporte.

## Organización

```text
src/
  schemas.ts         Contratos Zod y tipos inferidos
  provider-types.ts  Interfaz que necesita el servicio
  service.ts         SupportAssistant: seguridad y respuesta pública
  service-run.ts     Estado y cierre por ticket; derivación por confianza
  execution.ts       StructuredExecutor: llamadas, validación, intentos y reservas
  prompts.ts         Carga, render y hashes de prompts versionados
  prompt.yaml        Plantilla original básica, con manual compartido
  resources/         Manual, seguridad y ejemplos few-shot
  budget.ts          Budget, Price y PriceCatalog con decimales
  telemetry.ts       Contratos de eventos y trazas sin contenido
  event-sink.ts      stderr y archivo JSONL opcional
  config.ts          Configuración explícita y lectura de .env
  runtime-settings.ts Límites de tiempo, tokens y dinero
  providers.ts       Adaptadores de los tres SDK
  errors.ts          Códigos y diagnósticos públicos seguros
  cli.ts             Entrada por terminal; composition root
  eval-cli.ts        Comandos live y offline de evaluación
  evals/             Dataset, métricas, revisión, comparación y reportes
  index.ts           API importable sin ejecutar la CLI
tests/               Contratos, políticas, SDK simulados, CLI, evals y concurrencia
```

`npm test` construye primero `dist`, incluidos los recursos, y ejecuta pruebas offline. `npm run check` revisa tipos del código y tests. `predev` prepara los recursos antes de `npm run dev`. El build copia también los datasets y precios canónicos de Python a `dist/resources/shared`; la ejecución TS compilada no invoca Python. El lockfile fija dependencias: usá `npm ci`. OpenAI está fijado a `7.43.0`, xAI a `0.2.5` y `decimal.js` a `10.6.0`; este SDK de xAI es experimental. El adaptador rechaza `XAI_DEBUG=1` porque habilitarlo podría registrar datos privados; OpenAI fuerza logging desactivado.

Podés importar `SupportAssistant`, `createProvider`, `readSettings`, `loadPrompts` y `loadPrices` desde `dist/index.js`. El constructor recibe `{provider, providerName, model, prompts, prices, settings?, emit?}`. `respond(input, signal?)` devuelve la respuesta pública; `process(input, options?)` devuelve `{response, trace}` para un consumidor que necesita metadatos. `loadPrompt()` se conserva como alias para inspeccionar el texto de generación. El cliente y los prompts se construyen al iniciar una aplicación; el estado de cada ticket queda local a su invocación.

## Evaluaciones

Después de `npm run build`, `node dist/eval-cli.js --help` muestra los comandos disponibles. Por ejemplo, `node dist/eval-cli.js compare --provider openai --output-dir reports` ejecuta `basic-v1` y `basic-v2` sobre desarrollo con un presupuesto compartido y **consume saldo real**. Los reportes requieren revisión humana; el programa no cambia el prompt de la aplicación.

Las CLI de tickets y evaluaciones admiten OpenAI, xAI y Google AI. Para evaluar Gemini, usá `--provider google-ai`, configurá `GEMINI_API_KEY` y, si necesitás cambiar el modelo, `NUBBIX_GOOGLE_AI_MODEL`. El modelo debe tener una tarifa configurada. Por ejemplo:

```powershell
node dist/eval-cli.js run --provider google-ai --prompt-version basic-v1 --split dev --output-dir reports
node dist/eval-cli.js compare --provider google-ai --split dev --output-dir reports
```

Estos comandos consumen saldo real y conservan los mismos límites y controles que los otros proveedores. Los reportes registran la versión instalada de `@google/genai` en `provenance.sdkVersions["google-ai"]`. Los reportes de pruebas manuales no reemplazan una corrida del dataset ni su revisión humana.

La [guía de evaluaciones TypeScript](../docs/typescript-evaluations.md) explica comandos, métricas, revisión JSONL, criterios de promoción y la comparación de moderación reservada al dataset sintético. Los tests offline prueban el software; no miden la calidad del modelo real.

### Evaluaciones: recorrido resumido

```mermaid
flowchart TD
  A["compare: Google AI, basic-v1 y basic-v2, split dev"] --> B["40 tickets y 20 casos de seguridad por versión"]
  B --> C["EvalRunner: alternar versiones por caso; mismo SupportAssistant"]
  C --> D["Dos reportes JSON, resúmenes Markdown y plantillas JSONL"]
  D --> E["Persona: revisar respuestas contra ticket y manual"]
  E --> F["compare --reports: validar contexto y revisión, offline"]
  F --> G{"Ambas revisiones completas y alguna candidata elegible?"}
  G -->|no| H["Revisión pendiente o metas no alcanzadas"]
  G -->|sí| I["Recomendar por macro-F1, costo y p95"]
  I --> J["Evaluar la configuración elegida en test"]
```

`basic-v2` agrega cuatro ejemplos al contexto de `basic-v1`; mantiene manual y políticas. Una comparación completa procesa 120 combinaciones de caso y versión. Habitualmente necesita hasta 360 llamadas iniciales, antes de considerar bloqueos o reintentos. Los USD 5 predeterminados se comparten entre las dos variantes; alcanzar ese límite deja reportes parciales y no acredita una recomendación.

### Evaluaciones: recorrido detallado

```mermaid
flowchart TD
  A["eval-cli.ts"] --> MODE{"Comando live u offline?"}
  MODE -->|run, compare, adversarial| INIT["Validar proveedor, modelo, tarifa y límites"]
  INIT --> DATA["Validar dataset, splits, IDs y regex; cargar YAML y hashes"]
  DATA --> PLAN["Crear variantes y presupuesto compartido; reservar reportes con casos notRun"]
  PLAN --> NEXT["Elegir siguiente caso y variante; alternar orden en compare"]
  NEXT --> CALL["SupportAssistant.process: mismo flujo que la app"]
  CALL --> RECORD["Guardar response, trace, error y rawOutputs sintéticos"]
  RECORD --> RULES["Indicadores sobre salida publicada e intermedia por separado"]
  RULES --> CHECK["Recalcular métricas y guardar checkpoint"]
  CHECK --> HALT{"Error fatal, presupuesto agotado o cancelación?"}
  HALT -->|sí| PART["Registrar stopReason y conservar casos restantes notRun"]
  HALT -->|no| MORE{"Quedan combinaciones?"}
  MORE -->|sí| NEXT
  MORE -->|no| FINISH["Finalizar JSON, Markdown y plantilla reviews.jsonl por variante"]
  PART --> FINISH
  FINISH --> HUMAN["Revisión humana: utilidad, corrección, manual, ataques y controles"]
  HUMAN --> OFF["Cargar reportes y revisiones con Zod"]
  MODE -->|summarize o compare --reports| OFF
  OFF --> OP{"Resumir o comparar?"}
  OP -->|summarize| SUM["Métricas, evaluación humana y gates por corrida"]
  OP -->|compare --reports| COMPAT{"Dos prompts de dev y mismo contexto?"}
  COMPAT -->|no| BAD["invalid_report: no comparar experimentos incompatibles"]
  COMPAT -->|sí| REVIEW{"Faltan campos de revisión aplicables?"}
  REVIEW -->|sí| PEND["pending_human_review; sin recomendación"]
  REVIEW -->|no| GATES["Exigir evidencia live, corrida completa, consumo conocido y metas"]
  GATES --> RANK["Descartar regresiones humanas y de seguridad; ordenar candidatas elegibles"]
  RANK --> RESULT["Recomendación de dev o acceptance_failed"]
  RESULT --> TEST["Si hubo recomendación: run del prompt elegido sobre test"]
```

Las regex son señales, no un juez semántico. La revisión humana decide si un ataque tuvo éxito en la respuesta publicada y si un control benigno fue rechazado injustificadamente. La comparación de prompts sólo recomienda sobre desarrollo; el resultado de prueba requiere su propia revisión y no cambia automáticamente el prompt de la app.

`adversarial --compare-moderation` usa sólo los 20 casos de seguridad y compara `full` contra `generation_only` de un único prompt. Esa ablación omite moderación exclusivamente dentro del arnés; no existe un interruptor para desactivarla en la CLI de tickets.
