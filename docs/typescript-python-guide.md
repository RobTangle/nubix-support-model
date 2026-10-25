# Aprender Python comparando con TypeScript

Las implementaciones resuelven el mismo caso: clasificar un ticket y redactar una propuesta para soporte humano. Python básico lo enseña con una llamada; TypeScript evolucionó para incluir moderación, presupuesto, telemetría y evaluaciones, conservando el directorio `typescript-basic`. TypeScript usa Zod y Python usa Pydantic. Respetamos las convenciones de cada lenguaje: no convertimos cada modelo Python en una clase JavaScript.

## 1. Qué archivo corresponde a cada parte

| Responsabilidad | Python básico | TypeScript | Motivo |
|---|---|---|---|
| Entrada y salida | `src/nubbix_support_basic/models.py` | `typescript-basic/src/support/schemas.ts` | Contrato validado en ejecución |
| Caso de uso | `src/nubbix_support_basic/service.py` | `typescript-basic/src/support/service.ts` | Coordinar clasificación y respuesta |
| Configuración | `ProviderSettings` en `providers.py` | `config/environment.ts`, esquema y tipo `ProviderSettings` | Leer sólo la clave seleccionada |
| Construcción del proveedor | `create_provider()` | `createProvider()` | Elegir el adaptador en el arranque |
| Contrato del proveedor | `LLMProvider`, `LLMRequest`, `LLMResult` compartidos | Interfaces en `llm/provider-types.ts` | Aislar el servicio del SDK |
| SDK | Adaptadores compartidos con la completa | Adaptadores en `llm/providers.ts` | Encapsular formato, transporte y errores |
| Instrucciones de generación | `prompt.yaml` | `prompting/prompt-registry.yaml`, `prompting/versions/<id>/system.yaml` y `context.yaml` | Registro de versiones con recursos independientes en TS |
| Terminal | `argparse` en `cli.py` | `parseArgs` en `support/cli.ts`; entrada pública `cli.ts` | Adaptar argumentos al caso de uso |
| Entrada importable | `__init__.py`, `__main__.py` | `index.ts`; entradas CLI separadas | Importar la biblioteca sin ejecutar una consulta |
| Dependencias | `pyproject.toml` y `uv.lock` | `package.json` y `package-lock.json` | Instalación reproducible por ecosistema |
| Pruebas | pytest | `node:test` y `node:assert` | Probar sin red ni credenciales |

Python básico comparte adaptadores con la completa. TypeScript tiene sus propios adaptadores porque sus SDK y entorno son distintos. El SDK Python de xAI usa gRPC; el SDK TS elegido usa Responses sobre HTTP. No intentamos reproducir esos detalles de transporte línea por línea.

Las rutas cortas de la tabla son relativas a `typescript-basic/src`. Para los controles nuevos, leé `support/service.ts` junto con `support/service-run.ts` (orquestación y estado por ticket), `llm/execution.ts` (llamadas estructuradas e intentos), `costs/budget.ts` (reservas y precios), `observability/telemetry.ts`/`observability/event-sink.ts` (metadatos) y `evals/` (medición offline/live). TypeScript tiene un flujo de control equivalente al completo Python, pero no comparte todos sus prompts, manuales ni formatos de reporte. Los datasets y precios son recursos canónicos compartidos; los reportes TS tienen un esquema propio y rechazan un reporte Python como entrada incompatible.

Las carpetas TS agrupan responsabilidades: `support` contiene el caso de uso, `llm` contiene la integración externa, `prompting` gestiona instrucciones, `config` lee configuración y `costs` lleva presupuestos. `web` y las CLI adaptan entradas; `lab` persiste el trabajo del laboratorio. Mover archivos a esas carpetas no cambia el flujo ni agrega una llamada al modelo. En Python también conviene agrupar módulos cuando comparten un motivo de cambio; la convención `src/<paquete>` añade el nombre importable del paquete, mientras este proyecto TS publica su API desde `src/index.ts`.

## 2. Zod desde lo que ya conocés de TypeScript

Un `interface SupportResponse` ayuda al compilador, pero desaparece en JavaScript. Si escribís `JSON.parse(text) as SupportResponse`, sólo convencés al compilador: un JSON con `confidence: "alta"` sigue entrando. Zod ejecuta comprobaciones sobre el valor real.

```typescript
const schema = z.strictObject({
  answer: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
});
type Response = z.infer<typeof schema>;
const result = schema.safeParse(valueFromOutside);
if (!result.success) throw new AppError("invalid_output");
const response: Response = result.data;
```

- `z.string()` exige un string; no convierte números a texto.
- `.trim()` elimina espacios de los extremos; `.min(1)` después exige que quede contenido.
- `z.number()` rechaza strings, booleanos, NaN e infinitos. `.min(0).max(1)` fija el intervalo permitido.
- `z.enum([...])` valida un valor del conjunto; `z.array(schema).max(5)` valida cada elemento y la cantidad.
- `z.strictObject()` rechaza campos adicionales. `z.object()` por defecto los elimina: elegimos rechazo explícito para detectar una salida que se aparta del contrato.
- `.refine(predicate)` agrega una comprobación propia. Aquí permite contar puntos de código Unicode, como `len(str)` en Python, en vez de unidades UTF-16 como `.length` en JavaScript. Un emoji puede ocupar dos unidades UTF-16; tampoco un punto de código equivale siempre a un carácter visible.
- `.safeParse()` devuelve `{success: true, data}` o `{success: false, error}`. TypeScript estrecha el tipo al comprobar `success`.
- `.parse()` devuelve el dato validado o lanza `ZodError`. Lo usamos para el recurso de configuración y capturamos el error sin publicar su contenido.
- `z.infer<typeof schema>` extrae un tipo estático del esquema, sin duplicarlo manualmente.

La normalización tiene orden: el ticket se limita **antes** de trim para rechazar 8001 espacios aunque al recortarlos quede vacío. Los textos de salida se recortan antes de validar su tamaño y contenido. No usamos `z.coerce.number()` porque aceptar `"0.8"` como `0.8` escondería un incumplimiento del contrato.

En Python, una clase Pydantic reúne campos, validadores y métodos como `model_validate_json()` y `model_dump_json()`. En TS, el esquema es un objeto de Zod y el resultado es un objeto JavaScript común. `z.infer` cumple el papel del tipo para el compilador, no el de una instancia con métodos propios.

`z.toJSONSchema(supportResponseSchema)` produce el JSON Schema enviado al proveedor para solicitar Structured Outputs. Eso ayuda al modelo a respetar el formato. Las comprobaciones propias con `refine` no se convierten automáticamente en reglas portables del proveedor: validamos de nuevo con Zod. Ni Zod ni Pydantic demuestran que una explicación sea correcta o que el LLM haya respetado las políticas del producto.

## 3. Seguir un ticket de principio a fin

Ejemplo: `Me cobraron dos veces este mes`. Una respuesta mostrada aquí es ilustrativa; no proviene de una llamada real ni de una evaluación.

```mermaid
sequenceDiagram
    participant CLI
    participant Zod
    participant Assistant as SupportAssistant
    participant Adapter as Adaptador SDK
    participant LLM
    CLI->>Zod: {text: "Me cobraron dos veces este mes"}
    Zod-->>CLI: Ticket validado
    CLI->>Assistant: respond(ticket, signal)
    Assistant->>Zod: Validar entrada del caso de uso
    Assistant->>Adapter: Moderar entrada: esquema allow/review/block
    Adapter->>LLM: Solicitud estructurada + signal
    LLM-->>Adapter: Decisión y consumo
    Adapter-->>Assistant: {text, status, usage}
    Note over Assistant: Sólo allow continúa; otro veredicto deriva
    Assistant->>Adapter: Generar: prompt + ticket JSON + esquema
    Adapter->>LLM: Solicitud estructurada
    LLM-->>Assistant: Propuesta mediante el adaptador
    Assistant->>Zod: JSON.parse y safeParse
    Zod-->>Assistant: Propuesta validada
    Note over Assistant: Si confidence < 0.70, agregar revisión humana
    Assistant->>Adapter: Moderar propuesta completa, incluidas actions
    Adapter->>LLM: Solicitud estructurada
    LLM-->>Assistant: Decisión mediante el adaptador
    Note over Assistant: Sólo allow publica la propuesta
    Assistant-->>CLI: Objeto validado
    CLI-->>CLI: JSON en stdout
```

**La CLI prepara la aplicación.** `parseArgs()` interpreta `--text`, `--stdin`, `--provider`, `--env-file`, `--prompt-version` y `--telemetry-file`. Si falta texto o supera el límite, falla antes de construir el cliente. `readEnvironment()` lee `.env` una vez; `readSettings()` exige únicamente la clave seleccionada. `createProvider()` construye el adaptador, `loadPrompts()` carga el contexto, `loadPrices()` valida el catálogo y `createEventSink()` prepara la telemetría. Esta composición explícita cumple el papel que podrías dar a un módulo de Nest, con menos infraestructura para este tamaño de app.

**`SupportAssistant` ejecuta el caso de uso.** Recibe un objeto de dependencias y lo guarda en una propiedad `private readonly`. Equivale a recibirlas en `__init__` y guardarlas como atributos Python, aunque `readonly` es una restricción estática, no una congelación profunda del objeto. `respond(input: unknown)` delega en `process()` y vuelve a validar el ticket: la lógica también debe estar protegida cuando la invoque la ruta HTTP u otro programa sin pasar por la CLI. Esa segunda validación es barata y está puesta en un límite de confianza diferente. `respond()` entrega sólo los cuatro campos públicos; `process()` devuelve `{response, trace}` para evaluaciones u otros consumidores de metadatos.

**El contexto y los datos van separados.** El system prompt contiene taxonomía, manual ficticio y reglas. El mensaje de usuario contiene `{"ticket":"Me cobraron dos veces este mes"}`. Serializar como JSON evita construir delimitadores a mano; no elimina por sí mismo la posibilidad de prompt injection. El asistente no tiene herramientas ni acceso para ejecutar cambios.

**El ejecutor define la política y el adaptador habla con el SDK.** `StructuredExecutor` centraliza JSON.parse, Zod, reservas, plazos e intentos para las tres etapas. `LLMProvider` describe la operación común: recibe prompts, esquema, nombre de esquema, límite de tokens y señal. El adaptador transmite hasta 128 tokens para moderación o 1024 para generación, desactiva reintentos del SDK y solicita salida sin herramientas, sin streaming y con `store: false`. Normaliza consumo sin convertir campos ausentes en ceros; preserva consumo conocido aun ante un fallo del proveedor. Los errores de credenciales, límites y disponibilidad se convierten en códigos propios. Un proveedor simulado que implemente el mismo método permite probar el servicio sin red.

**El resultado se comprueba antes de publicarse.** `review`, `block` o una negativa del modelo llevan a una respuesta estática de derivación humana, con `category: "other"` y `confidence: 0`. Un error operativo en moderación impide publicar una propuesta. Si la salida completa tiene JSON inválido o incumple Zod, el ejecutor permite un intento de reparación si queda cupo; los errores transitorios usan ese mismo cupo de **dos intentos totales por etapa**, nunca dos por cada clase de error. Una salida incompleta termina como error. La moderación es otra decisión de un LLM: puede producir falsos positivos o no detectar un ataque, por lo que no demuestra inmunidad a prompt injection. Si el flujo permite publicar, se podría obtener:

```json
{
  "answer": "Indicanos fecha y referencia de los cargos para que soporte los verifique, ocultando datos sensibles.",
  "confidence": 0.85,
  "category": "billing",
  "actions": ["Verificar los cargos antes de gestionar un ajuste."]
}
```

**La CLI publica el contrato.** Escribe la respuesta en stdout y conecta un sink que recibe eventos de cada intento y un resumen final en stderr, opcionalmente también en un archivo JSONL. `--flow-events` agrega el ciclo de vida detallado. El servicio recibe el sink por inyección: no necesita acceder a la terminal. Los eventos normales contienen sólo metadatos, sin tickets, prompts, respuestas ni claves. `AppError` tiene códigos y mensajes estáticos: no adjunta el error crudo del SDK. Express consume el mismo servicio y comunica errores posteriores al inicio del stream mediante un frame terminal.

**Cada llamada compromete presupuesto.** `Budget` reserva una estimación antes de llamar y concilia después con los tokens recibidos. Si el uso o desglose de caché es desconocido, conserva la reserva; desconocido no significa gratis. `Price` calcula con `decimal.js`, evitando errores de representación monetaria binaria. El presupuesto predeterminado de USD `0.05` cubre todas las etapas e intentos del ticket, y el de USD `5` se comparte en la corrida de evals. Son controles locales estimados, no una garantía de la factura final. El catálogo de precios es una instantánea fechada 2026-10-23; no implica haber vuelto a verificar sus tarifas hoy.

## 4. Clases, interfaces y funciones

`SupportAssistant` es una clase porque reúne dependencias reutilizables y el comportamiento del caso de uso. Los adaptadores también necesitan conservar un cliente y su configuración. Crear un cliente por ticket agrega trabajo y dificulta reutilizar conexiones; se crea uno por instancia de aplicación. `Budget` sí tiene estado mutable: sus reservas pertenecen a un ticket o a una evaluación concreta, nunca a todos los tickets por accidente. `PriceCatalog` encapsula un catálogo validado y `StructuredExecutor` reúne una política común de llamadas; no son clases para representar cada JSON.

`Ticket`, `SupportResponse` y `ProviderSettings` son tipos inferidos de esquemas en TS; no necesitan clases vacías. En Python son clases Pydantic porque esa biblioteca organiza así la validación. Las interfaces TS `LLMProvider`/`CompletionRequest`/`CompletionResult` se parecen a `Protocol` y a los objetos de transporte Python: expresan qué necesita el consumidor. La compatibilidad es estructural, sin exigir una jerarquía de herencia.

`readSettings`, `createProvider` y `loadPrompts` son funciones porque no necesitan conservar estado propio entre consultas. No incorporamos contenedor de DI ni Nest. Express se agregó como adaptador HTTP local para el panel de observabilidad; sus responsabilidades quedan fuera del servicio. La separación entre transporte, servicio y proveedor permite reutilizar el flujo y sus tests.

## 5. Async, varias requests y HTTP

La CLI es un adaptador de entrada válido: el mismo caso de uso puede llamarse desde una terminal, una ruta HTTP o un consumidor de cola. Lo que impediría reutilizarlo sería que `respond()` leyera stdin, llamara a `process.exit()` o guardara un ticket mutable en `this`. No hace esas cosas.

`respond()` devuelve `Promise<SupportResponse>`. Cuando espera al proveedor mediante `await`, Node puede atender otras operaciones de I/O. Los datos del ticket, la respuesta y su señal son variables locales por invocación. Compartir una instancia no implica compartir esos datos. Hay un test con diez llamadas simultáneas y respuestas distinguibles, además de otro que cancela una sin interrumpir la otra.

```typescript
// Inicialización de una app: una vez por proceso.
const settings = readSettings("openai", environment);
const provider = createProvider(settings);
const assistant = new SupportAssistant({
  provider,
  providerName: settings.provider,
  model: settings.model,
  prompts: await loadPrompts("basic-v1"),
  prices: await loadPrices(),
});
// Dentro de una ruta: una vez por request.
const response = await assistant.respond(requestBody, requestAbortSignal);
```

`AbortSignal.timeout()` define hasta 15 segundos por llamada y 60 segundos por ticket. `AbortSignal.any()` combina ese plazo con una posible cancelación del llamador; la señal llega al SDK y aborta la red y la lectura del body. El plazo restante del ticket puede acortar el de una llamada. No usamos sólo `Promise.race()` para dejar de esperar mientras una generación sigue corriendo. La cancelación del cliente tampoco garantiza que el proveedor no facture trabajo ya realizado.

La básica Python tiene hoy un método síncrono. Si se usa tal cual en una futura API async, debe ejecutarse en un endpoint síncrono gestionado por threads o en un worker de threads; su adaptador OpenAI usa `asyncio.run()`, que no se puede anidar en un event loop activo. Otra opción es introducir una interfaz async de proveedor y servicio. La versión TS nace async por las convenciones de sus SDK; no sería útil copiar esa fachada síncrona sólo para hacerlas iguales.

Diez operaciones concurrentes contra un doble de test prueban aislamiento, **no** una capacidad de diez requests por segundo en producción. El throughput depende de latencia, cuotas, tokens y recursos. Por ejemplo, sostener 10 requests/s con 2 s de latencia promedio supone unas 20 consultas en vuelo, antes de considerar límites y picos. El panel Express local limita tamaño HTTP y cuatro ejecuciones concurrentes, rechaza saturación y cancela al desconectarse. No implementa autenticación multiusuario ni cuotas globales para un servicio público. Las pruebas de carga y costos reales requieren una configuración controlada; un `Promise.all()` ilimitado no resuelve la sobrecarga. La [guía de observabilidad](live-observability.md) explica sus eventos y frontend.

## 6. Qué verificamos y qué falta medir

Hay fixtures JSON compartidos en `tests/fixtures/basic-contract.json`: pytest y Zod deben aceptar o rechazar los mismos casos. Los tests también verifican Unicode, formato inválido, rechazos, plazos, cancelación, SDK con fetch simulado, separación de stdout/stderr e importación sin efectos. La CLI compilada se prueba desde otro directorio para comprobar que encuentra sus recursos.

El build limpia `dist` y copia prompts y recursos preservando la distribución de carpetas: el registro queda en `dist/prompting/prompt-registry.yaml` y los recursos de cada versión en `dist/prompting/versions/<id>/`. Los datasets y precios compartidos se copian desde sus archivos canónicos Python a `dist/resources/shared`; `resources/read-shared.ts` resuelve su ubicación. Las rutas se calculan desde el módulo, no desde el directorio de la terminal. El runtime TS no ejecuta Python. `predev` prepara esos archivos al usar `npm run dev`. Las extensiones `.js` en imports TS corresponden a los archivos emitidos en ESM con `module: NodeNext`. El compilador resuelve sus fuentes `.ts` durante el desarrollo.

TypeScript ya implementa esos controles del flujo completo. Cada versión conserva instrucciones, manual y seguridad en su propia carpeta; generación y moderación de un ticket usan el manual de la versión elegida. `basic-v2` parte del mismo contenido de v1 y agrega cuatro ejemplos independientes. El [registro de versiones](prompt-versions.md) permite copiar una carpeta, cambiar instrucciones o ejemplos y registrar el nuevo ID sin editar listas de CLI, UI o evals. Git conserva el historial; los hashes detectan ediciones, sin bloquear archivos. Python básico sigue siendo el recorrido más pequeño de una llamada. Python completo usa otro manual y otro esquema de reportes: no atribuyas sus resultados a TypeScript ni compares métricas como si el contexto fuera idéntico.

Los tests de software comprueban contratos, fallos y políticas con dobles de proveedor; las [evals TypeScript](typescript-evaluations.md) miden comportamiento real sobre datos sintéticos, con revisión humana. La validez del JSON, la clasificación, la calidad semántica y la seguridad son ejes distintos. Todavía no hay resultados live ni un prompt ganador demostrado. Antes de usarlo con clientes hay que sustituir el manual ficticio, evaluar cada proveedor/modelo y aplicar controles operativos.

Un orden útil de lectura es: `support/schemas.ts` → `llm/provider-types.ts` → `support/service.ts` → `support/service-run.ts` → `llm/execution.ts` → `llm/providers.ts` → `costs/budget.ts`/`observability/telemetry.ts` → `prompting/prompt-registry.ts`/`prompting/prompts.ts` → `support/cli.ts` → `evals/`. Así primero entendés qué promete el sistema, después cómo lo ejecuta y por último cómo se compone y se mide. Las entradas raíz `cli.ts` y `eval-cli.ts` conservan los comandos públicos y delegan en sus implementaciones.

Referencias de las bibliotecas: [fundamentos de Zod](https://zod.dev/basics), [conversión a JSON Schema](https://zod.dev/json-schema), [SDK oficial de OpenAI para TS](https://github.com/openai/openai-node) y [SDK oficial de xAI para TS](https://github.com/xai-org/xai-sdk-ts). Las versiones instaladas y su lockfile son la referencia para los detalles de esta implementación.
