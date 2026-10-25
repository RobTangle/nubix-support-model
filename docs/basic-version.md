# Versión didáctica: empezar por clasificar y responder

`nubbix_support_basic` es otro paquete dentro de este proyecto, con un flujo propio. Su objetivo es que puedas seguir qué sucede desde que entra un ticket hasta que sale un JSON válido, antes de estudiar los controles operativos de la versión completa.

## Ejecutarla

Después de instalar el proyecto, el help funciona sin claves:

```powershell
uv sync --locked
uv run nubbix-support-basic --help
```

Para llamar al modelo, configurá localmente sólo la clave del proveedor elegido en `.env` o en el entorno. Se usan `OPENAI_API_KEY`/`NUBBIX_OPENAI_MODEL` para OpenAI y `XAI_API_KEY`/`NUBBIX_XAI_MODEL` para xAI, igual que en la versión completa. No hace falta configurar ambas claves. Nunca incluyas `.env` en Git.

```powershell
uv run nubbix-support-basic --text "Me cobraron dos veces este mes" --provider openai
"No puedo ingresar a mi cuenta" | uv run nubbix-support-basic --stdin --provider xai
python -m nubbix_support_basic --help
```

El comando básico no tiene subcomando `respond`: sólo procesa un ticket. Las llamadas reales consumen saldo. Los límites de entrada, salida y tiempo no son un tope monetario; las variables de presupuesto de la versión completa no se aplican aquí.

## Orden de lectura sugerido

1. **`models.py`:** dos modelos Pydantic, `Ticket` y `SupportResponse`. Primero aprendé qué puede entrar y qué debe salir. Los nombres de los campos públicos coinciden con la versión completa.
2. **`prompt.yaml`:** instrucciones y manual ficticio breve. La política del producto queda fuera del código. `basic-v1` identifica este recurso didáctico; no es una versión elegida mediante evals.
3. **`service.py`:** `SupportAssistant` prepara el contexto, llama una vez y valida el resultado. Es el núcleo para estudiar primero.
4. **`providers.py`:** `ProviderSettings` lee las opciones y `create_provider()` selecciona la credencial y el adaptador. Los imports del SDK y sus particularidades quedan en los adaptadores compartidos.
5. **`cli.py`:** `argparse`, de la biblioteca estándar, convierte argumentos en un `Ticket` y publica el resultado. `try/finally` garantiza el cierre del proveedor incluso si hay un error.

Son cuatro clases locales: `Ticket`, `SupportResponse`, `ProviderSettings` y `SupportAssistant`. Las funciones simples se mantienen como funciones; no hay un repositorio de prompts, un objeto por etapa ni una traza por ticket.

## Cómo se procesa el ticket

```mermaid
flowchart LR
    A[Texto en CLI] --> B[Validar Ticket]
    B --> C[Cargar prompt YAML]
    C --> D[Una llamada al proveedor]
    D --> E[Validar SupportResponse]
    E --> F[JSON en stdout]
```

La clasificación y la redacción ocurren en la misma llamada. El ticket se envía como contenido de usuario separado del system prompt. Un resultado ilustrativo del contrato es:

```json
{
  "answer": "Indicanos fecha y referencia de los cargos para que soporte pueda verificarlos, ocultando datos sensibles.",
  "confidence": 0.85,
  "category": "billing",
  "actions": ["Verificar los cargos antes de gestionar un ajuste."]
}
```

Este ejemplo no proviene de una evaluación real. Las acciones son sugerencias para una persona; ningún pago ni cambio de cuenta se ejecuta. `confidence` es autodeclarada y no demuestra una probabilidad calibrada de acierto.

Se solicitan salidas estructuradas nativas y se valida localmente el JSON. Esas comprobaciones pueden detectar un campo faltante, una categoría inválida o una confianza fuera de rango. No demuestran que la respuesta sea correcta, segura o útil.

Si el proveedor rechaza la consulta, la respuesta queda incompleta o el JSON no respeta el contrato, la CLI termina con código 2 y un diagnóstico sanitizado en `stderr`. No imprime un objeto de éxito. Tampoco reintenta automáticamente: así se puede observar con claridad una solicitud y un resultado. Los errores de argumentos los muestra `argparse` en `stderr`; los errores durante el procesamiento se muestran como JSON.

## Qué se comparte y por qué

El flujo básico **no llama a `SupportService`** ni envuelve a la aplicación completa. Su lógica de clasificación y respuesta se puede leer en `SupportAssistant.respond()`.

Comparte los adaptadores oficiales de OpenAI/xAI, los mensajes de transporte `LLMRequest`/`LLMResult` y los errores sanitizados. `LLMProvider` sólo describe el método que necesita el asistente; no exige heredar de ninguna clase.

Esta reutilización evita duplicar código de HTTP, gRPC, cancelación y privacidad ya probado. Esas particularidades no son el objetivo de la primera lectura. Cuando quieras entender la integración de cada proveedor, podés seguir el import hasta sus adaptadores en el paquete completo. La básica depende de esos módulos: no es una distribución independiente, ambos paquetes se instalan juntos mediante el mismo `pyproject.toml` y lockfile.

La duplicación pequeña de modelos y prompt es deliberada: permite leer y modificar el ejemplo sin recorrer los contratos y políticas del flujo completo.

## Diferencias con la completa

| Aspecto | Didáctica | Completa |
|---|---|---|
| Clasificar y proponer respuesta | Una llamada | Una generación, rodeada por moderación |
| Proveedores | OpenAI y xAI, adaptadores compartidos | OpenAI y xAI |
| JSON estructurado y validación local | Sí | Sí |
| Prompt | Un YAML propio, `basic-v1` | Manual, políticas y versiones v1/v2 con ejemplos |
| Moderación independiente de entrada/salida | No | Sí |
| Reintentos automáticos | No | Hasta dos intentos totales por etapa |
| Límites básicos | 8.000 caracteres, 1.024 tokens de salida y timeout de 15 s | Límites configurables y plazo total por ticket |
| Presupuesto monetario | No | Reservas y conciliación por ticket/corrida |
| Consumo, costos y trazas | No se registran | Telemetría de metadatos por intento y ejecución |
| Confianza baja | No agrega acciones mediante una regla automática | Agrega derivación por debajo de 0,70 |
| Evals y selección de prompt | No tiene suite de calidad LLM propia | Dataset, métricas, ataques y revisión humana |
| Uso previsto | Aprendizaje y experimentación controlada | Base para evaluar un piloto supervisado |

El prompt básico contiene instrucciones para no inventar hechos ni pedir secretos, pero no hay una revisión independiente de su salida. Por eso no cumple toda la consigna original ni reemplaza los controles de la completa para uso con clientes. La completa también tiene pendientes sus evals reales y la sustitución del manual ficticio.

## Comparar y aprender

Podés pasar el mismo ticket a ambas versiones para observar su contrato y recorrido. La completa puede bloquear o derivar una consulta que la básica intente responder, y normalmente hace más llamadas. Eso no constituye por sí solo un benchmark de calidad: sus prompts y controles son diferentes y los resultados requieren revisión humana.

```powershell
uv run nubbix-support-basic --text "Me cobraron dos veces este mes" --provider openai
uv run nubbix-support respond --text "Me cobraron dos veces este mes" --provider openai
```

Los tests de la básica están en `tests/test_basic.py`. Usan proveedores simulados para verificar contratos, cantidad de llamadas, selección de credenciales y errores sin gastar saldo. Una suite verde no demuestra que un modelo real clasifique bien.

```powershell
uv run pytest tests/test_basic.py
```

Como ejercicios, agregá un caso de test antes de cambiar una política, modificá el YAML y observá qué entradas controla Pydantic. Después compará con el servicio completo: qué problema resuelve cada control adicional y cuánto aumenta el costo conceptual y operativo.
