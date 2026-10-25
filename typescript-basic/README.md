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

`actions` contiene sugerencias; no ejecuta cambios. `confidence` es autodeclarada, no calibrada. El panel HTTP local permite seleccionar proveedor y prompt explícitamente. No hay selección automática ni un ganador de calidad demostrado todavía.

## Panel en vivo: Nubbix Flow Lab

```powershell
# Modo LIVE predeterminado: lee las claves actuales del servidor.
npm run web
```

Abrí **http://127.0.0.1:3000**. Elegí un ticket, proveedor y versión de prompt, y ejecutalo. Los eventos aparecen mientras el backend procesa la consulta, con actor **LLM / CÓDIGO**, timestamp UTC, tiempo desde inicio, diferencia con el evento anterior, duración cuando corresponde y detalles desplegables. La animación de una request se mantiene hasta recibir su finalización o fallo. No se simula un porcentaje de progreso.

El servidor arranca en **LIVE** y enviar un ticket o iniciar una evaluación consume APIs reales. Abrir la página, consultar historial y revisar resultados no consume tokens. No cambia a demo automáticamente si falta una clave: el proveedor aparece deshabilitado, o falla el inicio si no hay ninguno disponible.

```powershell
# Modo DEMO explícito para estudiar la interfaz sin gastar saldo.
npm run web:demo

# Después del build: elegir puerto, archivo de entorno o destino de logs.
node dist/web/server.js --port 3001 --live --env-file ../.env --telemetry-file reports/web-events.jsonl
```

El modo demo recorre `SupportAssistant` con un doble de proveedor. Sus tokens y costos son simulados; no acreditan calidad ni latencia real. **Bloqueo demo** usa `DEMO_BLOCK` únicamente con ese doble. `npm run web:live` sigue disponible como alias explícito del modo real.

Para inspeccionar los mismos eventos finos desde la CLI, agregá `--flow-events`. El JSON público de stdout conserva sus cuatro campos; los eventos van a stderr y al archivo opcional:

```powershell
node dist/cli.js --provider google-ai --text "Necesito una factura" --flow-events --telemetry-file reports/flow.jsonl
```

El panel sirve como herramienta local de aprendizaje. Se vincula sólo a loopback, valida Host/Origin y limita el cuerpo HTTP a 128 KiB y el ticket a 8000 puntos Unicode. Admite cuatro tickets simultáneos y una evaluación activa por proceso; si está ocupado responde 429. Cancelar o cerrar el stream de un ticket propaga la señal al servicio. Las evaluaciones continúan al cerrar la pestaña: tienen cancelación explícita. No tiene autenticación multiusuario ni está diseñado para exponerse directamente en Internet.

El **historial** conserva entradas, eventos, inspecciones y resultados en SQLite local (`typescript-basic/data/lab.sqlite`, configurable con `--database`). Reabrir una ejecución restaura el flujo sin llamar al proveedor. Un cierre controlado o la detección de un proceso anterior muerto identifica corridas interrumpidas; no se reanudan automáticamente ni se inventa consumo desconocido.

El **inspector de datos** muestra body original, ticket normalizado, esquemas/reglas Zod, requests neutrales al SDK, prompts, outputs de moderación y propuestas intermedias. Es un canal de depuración separado de los eventos/logs, que siguen conteniendo sólo metadatos. Puede mostrar contenido sin moderar, identificado como tal; la respuesta publicada sigue pasando por el flujo completo. No captura claves del servidor, headers de autenticación, entorno ni objetos SDK. La base contiene texto en claro y queda excluida de Git: usá tickets ficticios para aprender y protegé el acceso al archivo.

En **Evaluaciones**, elegí proveedor y operación: `run` (60 casos), `compare` (60 por versión elegida, intercaladas) o `adversarial` (20; 40 si comparás moderación). La comparación permite dos o más versiones y un baseline incluido entre ellas. Usan el mismo `EvalRunner` que la CLI, checkpoints, presupuesto compartido y gates. Podés ver métricas, respuestas y salidas intermedias, abrir el flujo de cada caso y guardar la revisión humana. Los juicios pendientes impiden aprobar o recomendar un prompt. No se añadió un LLM juez. También quedan archivos compatibles con la CLI en `typescript-basic/reports/lab-evals/`; las revisiones editadas en UI se guardan en SQLite.

**¿Qué es `reservation`?** Antes de cada llamada, el presupuesto compromete una estimación conservadora de tokens de entrada y salida máxima. Cuando llega el consumo, lo concilia y libera el excedente. Si una llamada falla sin informar uso, mantiene una reserva desconocida para no asumir costo cero. Es contabilidad local, no una retención o cobro del proveedor; el límite no garantiza la factura final.

La navegación separa **Probar ticket**, **Evaluaciones**, **Historial** y **Guía de uso**. Las vistas conservan el estado mientras están montadas. Los resultados muestran métricas, categorías y criterios legibles; los casos tienen filtros y rúbricas de revisión humana, con JSON como detalle técnico. Las anotaciones no se pierden durante el polling, pero hay que guardarlas antes de abrir otro trabajo o recargar.

Consultá la [guía de uso del laboratorio](../docs/lab-user-guide.md) para seguir un ticket, comparar prompts y revisar resultados.

Leé el [recorrido de observabilidad y HTTP](../docs/live-observability.md) para entender las clases, los contratos y los límites de esta primera versión.

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

`src/prompting/prompt-registry.yaml` es la única lista de versiones, etiquetas, default, baseline y rutas de recursos. `PromptRegistry` valida y precarga los archivos; CLI, UI y evals consumen la misma configuración. Cada versión tiene una carpeta propia en `src/prompting/versions/<id>/`, con `system.yaml`, `context.yaml`, `safety.yaml` y `examples.yaml` opcional. Las instrucciones, manual y seguridad de v1/v2 parten de copias iguales; v2 además conserva cuatro ejemplos, uno por categoría. Desde ahora editar una versión no cambia la otra. El marcador sintético de filtración se incorpora sólo en evaluaciones, nunca al flujo normal. Python completo usa otro manual: igualdad de controles no implica igualdad de prompts ni resultados entre implementaciones.

Para agregar una versión, copiá una carpeta, cambiá sus instrucciones o ejemplos y agregá una entrada con sus rutas en el registro; luego reconstruí y reiniciá. No requiere editar enums ni selectores. Conservá las versiones evaluadas mediante Git y nuevos IDs: la aplicación detecta cambios con hashes, pero no bloquea la edición de archivos. Consultá la [guía para agregar y comparar prompts](../docs/prompt-versions.md), que incluye `basic-v3`, historial sencillo y compatibilidad de reportes antiguos. Si cambiás manual o seguridad, podés evaluar esa versión individualmente; la comparación estándar de instrucciones/ejemplos exige que esas condiciones sean iguales.

```powershell
# Descubrimiento offline: sin claves ni consumo.
node dist/cli.js --list-prompts
node dist/eval-cli.js --list-prompts

# Después de registrar basic-v3: estas llamadas sí consumen API.
node dist/cli.js --provider google-ai --prompt-version basic-v3 --text "Necesito una factura"
node dist/eval-cli.js compare --provider google-ai --prompt-versions basic-v1 --prompt-versions basic-v3 --baseline-prompt basic-v1
```

Leé la [guía Python ↔ TypeScript](../docs/typescript-python-guide.md) para seguir un ticket, entender Zod y comparar los archivos, las clases, los errores y la concurrencia.

## Diagramas del procesamiento de tickets

Los diagramas usan Mermaid: GitHub los renderiza dentro del README. Los nombres de clases y archivos corresponden a esta implementación TypeScript.

**Cómo leer los actores:** los nodos azules rotulados **LLM / REQUEST** hacen una llamada de red al modelo configurado; los grises rotulados **CÓDIGO** ejecutan lógica local, sin consultar al modelo; los naranjas rotulados **HUMANO** requieren que una persona lea y califique. El texto identifica al actor aunque no se vean los colores.

**La moderación sí usa el LLM:** hay una request para juzgar la entrada, otra para clasificar y responder, y otra para juzgar la propuesta completa. Las tres usan el proveedor/modelo seleccionado y prompts distintos. No hay una persona revisando dentro de ese flujo automático. Agregar una acción de derivación sólo sugiere una intervención posterior: no asigna el caso ni espera una aprobación humana.

### Recorrido resumido

```mermaid
flowchart TD
  A["CÓDIGO: leer ticket desde CLI"] --> B["CÓDIGO: validar entrada con Zod"]
  B --> C["LLM / REQUEST 1<br/>Juzgar seguridad del ticket; devolver decision"]
  C -->|allow| D["LLM / REQUEST 2<br/>Clasificar y proponer answer y actions"]
  D --> E["CÓDIGO: validar JSON; agregar sugerencia de revisión si confidence menor a 0.70"]
  E --> F["LLM / REQUEST 3<br/>Juzgar seguridad y respaldo de answer y actions"]
  F -->|allow| G["CÓDIGO: archivar reporte y publicar JSON"]
  C -->|review, block o refusal| H["CÓDIGO: respuesta estática con sugerencia de derivación humana"]
  F -->|review, block o refusal| H
  D -->|refusal| H
  H --> G
  B -->|entrada inválida| I["CÓDIGO: error sanitizado; sin respuesta en stdout"]
  C & D & F -->|fallo operativo tras intentos permitidos| I
  classDef default fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef llm fill:#dbeafe,stroke:#1d4ed8,color:#0f172a
  class C,D,F llm
```

Hay normalmente tres llamadas al LLM. Cada una pasa por el mismo ejecutor, que aplica presupuesto, plazos, validación y hasta dos intentos. Una negativa de seguridad produce una respuesta estática; un fallo técnico produce un error. Las acciones son sugerencias para una persona.

### Recorrido detallado y responsabilidades

```mermaid
flowchart TD
  A["CÓDIGO / support/cli.ts: leer argumentos o stdin"] --> B{"CÓDIGO / Zod: entrada válida?"}
  B -->|no| ERR["CÓDIGO: AppError sanitizado; exit 2"]
  B -->|sí| C["CÓDIGO: cargar configuración, tarifa, YAML y hashes"]
  C --> D["CÓDIGO / RunReportWriter: reservar archivo running"]
  D --> E["CÓDIGO: crear cliente SDK y SupportAssistant; todavía sin request"]
  E --> F["CÓDIGO / runSession: presupuesto y traza locales; deadline de 60 s"]
  F --> IN["LLM / REQUEST 1 / input_moderation<br/>Enviar prompt de seguridad y ticket; recibir decision"]
  IN --> IV{"CÓDIGO: decision validada es allow?"}
  IV -->|no o refusal| SAFE["CÓDIGO / safeResponse: other, confidence 0, sugerir derivación humana"]
  IV -->|sí| GEN["LLM / REQUEST 2 / generation<br/>Enviar prompt de soporte y ticket; recibir SupportResponse"]
  GEN -->|refusal| SAFE
  GEN --> CF{"CÓDIGO: confidence validada menor a 0.70?"}
  CF -->|sí| HR["CÓDIGO: agregar sugerencia de revisión; ninguna persona interviene aquí"]
  CF -->|no| OUT["LLM / REQUEST 3 / output_moderation<br/>Enviar prompt de seguridad y propuesta final; recibir decision"]
  HR --> OUT
  OUT --> OV{"CÓDIGO: decision validada es allow?"}
  OV -->|no o refusal| SAFE
  OV -->|sí| OK["CÓDIGO: conservar propuesta validada"]
  SAFE & OK --> FIN["CÓDIGO: cerrar traza y telemetría; finalizar reporte"]
  FIN --> PUB["CÓDIGO / stdout: answer, confidence, category, actions"]
  C & D & E & F & IN & GEN & OUT -->|error| ERR
  ERR --> ARCH["CÓDIGO: si se reservó reporte, guardar fallo y traza disponible"]
  ARCH --> STOP["CÓDIGO / stderr: error JSONL; stdout vacío"]
  CTRL["CÓDIGO / StructuredExecutor<br/>Antes: presupuesto y timeout; después: JSON, Zod, costo y evento<br/>Hasta dos intentos por etapa"]
  CTRL -.-> IN
  CTRL -.-> GEN
  CTRL -.-> OUT
  classDef default fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef llm fill:#dbeafe,stroke:#1d4ed8,color:#0f172a
  class IN,GEN,OUT llm
```

Las tres cajas azules son las tres requests al proveedor. Internamente, cada una recorre `StructuredExecutor.call()` → `provider.complete()` → SDK → API del proveedor. La caja gris del ejecutor y sus flechas punteadas describen controles locales compartidos: no agregan otra request. Un reintento sí repite la request de su etapa y consume presupuesto; un bloqueo temprano omite las etapas posteriores. Zod valida la estructura localmente: no pide al LLM que valide JSON.

La telemetría de intentos y cierre contiene sólo metadatos. El reporte manual separado conserva contenido para inspección. Si falla el archivado o el cierre de telemetría, la CLI devuelve error en lugar de publicar la propuesta; los fallos de configuración anteriores a la reserva no crean un reporte.

## Organización

```text
src/
  support/           Contratos Zod, SupportAssistant, ciclo por ticket y composición CLI
    schemas.ts       Entrada y respuesta pública
    service.ts       Orden de moderación, generación y publicación
    service-run.ts   Estado y cierre de una ejecución
    cli.ts           Argumentos/stdin y construcción del servicio
  llm/               Puerto común, adaptadores SDK y ejecución estructurada
    provider-types.ts Contrato neutral del proveedor
    providers.ts     Adaptadores OpenAI, xAI y Google AI
    execution.ts     Intentos, validación, plazos y uso de presupuestos
  prompting/         Registro, cargador, contratos y recursos de prompts
    prompt-registry.yaml Versiones, etiquetas, default y baseline
    prompt-registry.ts Validación, precarga, render y hashes
    versions/        Recursos independientes por ID de prompt
      basic-v1/      system.yaml, context.yaml y safety.yaml
      basic-v2/      Los mismos recursos propios más examples.yaml
  costs/             Budget, Price y PriceCatalog con decimales
  config/            environment.ts y runtime-settings.ts
  observability/     Eventos, instrumentación, telemetry.ts y event-sink.ts
  resources/         read-shared.ts: acceso a datasets y tarifas distribuidos
  evals/             CLI de evals, dataset, métricas, revisión y reportes
  inspection/        Canal explícito de depuración, separado de logs de metadatos
  lab/               SQLite, historial, trabajos de evaluación y revisiones
  web/               Express, contratos HTTP y frontend TypeScript
  errors.ts          Códigos y diagnósticos públicos compartidos
  cli.ts             Entrada compatible: delega en support/cli.ts
  eval-cli.ts        Entrada compatible: delega en evals/cli.ts
  index.ts           API importable sin ejecutar la CLI
tests/               Contratos, políticas, SDK simulados, CLI, evals y concurrencia
```

La organización agrupa archivos que cambian por el mismo motivo. `support` conserva el caso de uso; `llm` adapta llamadas externas; `prompting` reúne instrucciones y recursos; `costs` y `config` contienen sus políticas específicas. Los observadores, el almacenamiento y los transportes se mantienen fuera de las decisiones de soporte. No se agregaron capas de herencia, contenedores de DI ni archivos de reexportación por carpeta.

Los comandos siguen siendo `node dist/cli.js`, `node dist/eval-cli.js` y `node dist/web/server.js`. Las dos entradas pequeñas de la raíz mantienen esas rutas; las implementaciones de terminal están junto a sus módulos de soporte y evaluaciones. Para consumir la biblioteca, preferí las exportaciones de `dist/index.js` frente a depender de rutas internas.

`npm test` construye primero `dist`, incluidos los recursos, y ejecuta pruebas offline. `npm run check` revisa tipos del código y tests. `predev` prepara los recursos antes de `npm run dev`. El build limpia los artefactos anteriores de `dist` para no ocultar imports rotos con archivos de la estructura vieja. También copia los datasets y precios canónicos de Python a `dist/resources/shared`; la ejecución TS compilada no invoca Python. El lockfile fija dependencias: usá `npm ci`. OpenAI está fijado a `7.43.0`, xAI a `0.2.5` y `decimal.js` a `10.6.0`; este SDK de xAI es experimental. El adaptador rechaza `XAI_DEBUG=1` porque habilitarlo podría registrar datos privados; OpenAI fuerza logging desactivado.

El build también usa esbuild para generar el módulo de navegador y copia HTML/CSS a `dist/web/public`. Express sirve esos recursos relativos al módulo compilado, por lo que el panel empaquetado funciona desde otro directorio. El frontend no importa configuración de entorno ni clientes SDK.

Podés importar `SupportAssistant`, `createProvider`, `readSettings`, `loadPrompts` y `loadPrices` desde `dist/index.js`. El constructor recibe `{provider, providerName, model, prompts, prices, settings?, emit?}`. `respond(input, signal?)` devuelve la respuesta pública; `process(input, options?)` devuelve `{response, trace}` para un consumidor que necesita metadatos. `loadPrompt()` se conserva como alias para inspeccionar el texto de generación. El cliente y los prompts se construyen al iniciar una aplicación; el estado de cada ticket queda local a su invocación.

## Evaluaciones

Después de `npm run build`, `node dist/eval-cli.js --help` muestra los comandos disponibles. Por ejemplo, `node dist/eval-cli.js compare --provider openai --output-dir reports` ejecuta todas las versiones registradas sobre desarrollo con un presupuesto compartido y **consume saldo real**. Para elegir un subconjunto, usá `--prompt-versions` y `--baseline-prompt`. Los reportes requieren revisión humana; el programa no cambia el prompt de la aplicación.

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
  A["CÓDIGO / compare: preparar 60 casos por versión elegida del registro"] --> B["CÓDIGO / EvalRunner: elegir caso y versión"]
  B --> L1["LLM / REQUEST 1<br/>Revisar seguridad de entrada"]
  L1 -->|allow| L2["LLM / REQUEST 2<br/>Clasificar y responder"]
  L2 -->|propuesta válida| L3["LLM / REQUEST 3<br/>Revisar seguridad y respaldo de la propuesta"]
  L3 -->|allow| D["CÓDIGO: calcular métricas y guardar respuestas en reportes"]
  L1 & L2 & L3 -->|bloqueo, refusal o fallo| EARLY["CÓDIGO: registrar respuesta estática o error; omitir etapas restantes"]
  EARLY --> D
  D --> E["HUMANO: leer ticket, respuesta y manual; editar reviews.jsonl"]
  E --> F["CÓDIGO / compare --reports: leer calificaciones y aplicar reglas, offline"]
  F --> G{"CÓDIGO: revisiones completas y alguna candidata elegible?"}
  G -->|no| H["CÓDIGO: revisión pendiente o metas no alcanzadas"]
  G -->|sí| I["CÓDIGO: recomendar por macro-F1, costo y p95"]
  I --> J["Repetir ejecución con LLM y revisión HUMANA sobre test"]
  classDef default fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef llm fill:#dbeafe,stroke:#1d4ed8,color:#0f172a
  classDef human fill:#ffedd5,stroke:#c2410c,color:#0f172a
  class L1,L2,L3 llm
  class E human
```

`basic-v2` conserva inicialmente el contenido de instrucciones, manual y políticas de `basic-v1` en archivos independientes, y agrega cuatro ejemplos. Comparar esas dos versiones procesa 120 combinaciones de caso y versión, habitualmente hasta 360 llamadas iniciales antes de bloqueos o reintentos. Cada versión adicional suma 60 casos; el presupuesto USD 5 se comparte entre todas las variantes. Alcanzarlo deja reportes parciales y no acredita una recomendación.

**No hay un LLM juez adicional en las evals.** Las requests 1 y 3 son los moderadores del servicio que estamos evaluando; sus decisiones también pueden estar equivocadas. El código calcula accuracy, F1, costos y reglas regex sin llamar al modelo. Una persona revisa utilidad, corrección, respeto del manual, ataques y falsos bloqueos. Después `summarize` y `compare --reports` sólo leen esas calificaciones y calculan resultados: no solicitan nuevas revisiones a un LLM ni a una persona automáticamente.

### Evaluaciones: recorrido detallado

```mermaid
flowchart TD
  A["CÓDIGO / evals/cli.ts"] --> MODE{"CÓDIGO: comando live u offline?"}
  MODE -->|run, compare, adversarial| INIT["CÓDIGO: validar configuración, dataset y regex; cargar YAML y hashes"]
  INIT --> PLAN["CÓDIGO: reservar reportes notRun y presupuesto compartido"]
  PLAN --> NEXT["CÓDIGO: elegir caso y variante; alternar orden en compare"]
  NEXT --> L1["LLM / REQUEST 1 / input_moderation<br/>Modelo seleccionado juzga el ticket"]
  L1 -->|allow validado con Zod| L2["LLM / REQUEST 2 / generation<br/>Modelo seleccionado clasifica y responde"]
  L2 --> VALID["CÓDIGO: validar respuesta con Zod y agregar sugerencia si confidence baja"]
  VALID --> L3["LLM / REQUEST 3 / output_moderation<br/>Modelo seleccionado juzga answer y actions"]
  L3 -->|allow validado con Zod| RECORD["CÓDIGO: guardar response, trace, error y rawOutputs"]
  L1 & L3 -->|review, block o refusal| SAFE["CÓDIGO: reemplazar propuesta por respuesta estática"]
  L2 -->|refusal| SAFE
  SAFE --> RECORD
  L1 & L2 & L3 & VALID -->|fallo operativo tras intentos permitidos| ERROR["CÓDIGO: registrar error; no publicar propuesta"]
  ERROR --> RECORD
  RECORD --> RULES["CÓDIGO: regex, clasificación vs etiqueta, costos y latencias; sin LLM juez"]
  RULES --> CHECK["CÓDIGO: recalcular métricas y guardar checkpoint"]
  CHECK --> HALT{"CÓDIGO: error fatal, presupuesto agotado o cancelación?"}
  HALT -->|sí| PART["CÓDIGO: guardar stopReason y conservar pendientes notRun"]
  HALT -->|no| MORE{"CÓDIGO: quedan combinaciones?"}
  MORE -->|sí| NEXT
  MORE -->|no| FINISH["CÓDIGO: finalizar JSON, Markdown y plantilla reviews.jsonl"]
  PART --> FINISH
  FINISH --> HUMAN["HUMANO / fuera de la CLI<br/>Leer casos y respuestas; contrastar manual; calificar en reviews.jsonl"]
  HUMAN --> OFF["CÓDIGO: cargar reportes y calificaciones humanas con Zod"]
  MODE -->|summarize o compare --reports| OFF
  OFF --> OP{"CÓDIGO: resumir o comparar?"}
  OP -->|summarize| SUM["CÓDIGO: mostrar métricas, calificaciones agregadas y gates"]
  OP -->|compare --reports| COMPAT{"CÓDIGO: 2+ prompts de dev, baseline y mismo contexto?"}
  COMPAT -->|no| BAD["CÓDIGO: invalid_report"]
  COMPAT -->|sí| REVIEW{"CÓDIGO: faltan calificaciones humanas aplicables?"}
  REVIEW -->|sí| PEND["CÓDIGO: pending_human_review; sin recomendación"]
  REVIEW -->|no| GATES["CÓDIGO: aplicar metas, descartar regresiones y ordenar candidatas"]
  GATES --> RESULT["CÓDIGO: recomendación de dev o acceptance_failed"]
  RESULT --> TEST["Si hubo recomendación: repetir requests LLM y revisión HUMANA en test"]
  classDef default fill:#f1f5f9,stroke:#475569,color:#0f172a
  classDef llm fill:#dbeafe,stroke:#1d4ed8,color:#0f172a
  classDef human fill:#ffedd5,stroke:#c2410c,color:#0f172a
  class L1,L2,L3 llm
  class HUMAN human
```

Las regex son señales, no un juez semántico. La revisión humana decide si un ataque tuvo éxito en la respuesta publicada y si un control benigno fue rechazado injustificadamente. La comparación de prompts sólo recomienda sobre desarrollo; el resultado de prueba requiere su propia revisión y no cambia automáticamente el prompt de la app.

La CLI live termina después de escribir los reportes y plantillas: no queda esperando a un revisor. La flecha hacia **HUMANO** representa el siguiente paso del trabajo, que hacés editando los archivos. Luego ejecutás los comandos offline. Un estado `pending_human_review` indica que faltan esas calificaciones; no dispara una request a otro modelo.

`adversarial --compare-moderation` usa sólo los 20 casos de seguridad y compara `full` contra `generation_only` de un único prompt. Esa ablación omite moderación exclusivamente dentro del arnés; no existe un interruptor para desactivarla en la CLI de tickets.
