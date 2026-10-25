# Nubbix Support

CLI en Python que clasifica consultas de soporte y propone una respuesta para un agente humano. Integra los SDK oficiales de **OpenAI y xAI**, valida las salidas con Pydantic y registra consumo, latencia y costo estimado.

**Estado:** proyecto educativo con un manual ficticio de Nubbix. Las pruebas de software funcionan sin claves. La calidad de los modelos y la elección del mejor prompt requieren ejecutar las evals reales y revisar sus resultados; todavía no hay un ganador demostrado.

## Tres versiones para aprender y comparar

El proyecto Python instala dos paquetes; el espejo TypeScript tiene su propio proyecto npm:

| Versión | Paquete importable | Comando | Objetivo |
|---|---|---|---|
| Didáctica | `nubbix_support_basic` | `nubbix-support-basic` | Entender clasificación y respuesta con una llamada y cuatro clases pequeñas. |
| Completa | `nubbix_support` | `nubbix-support` | Estudiar moderación, presupuestos, telemetría y evaluaciones. |
| TypeScript con controles completos | `typescript-basic/` | `node dist/cli.js`, `node dist/eval-cli.js` | Estudiar Zod, moderación, presupuestos, telemetría y evals en un servicio async. |

Si recién empezás con Python o AI Engineering, comenzá por la [guía de la versión didáctica y comparación](docs/basic-version.md). Tiene su propio flujo y prompt; comparte únicamente adaptadores e interfaces de transporte con la completa. Ambas utilizan el mismo entorno y las mismas variables de claves/modelos. La básica no aplica los presupuestos monetarios de la completa y no reemplaza sus controles para un piloto con clientes.

Si ya conocés TypeScript, tenés la [implementación con CLI y Zod](typescript-basic/README.md), una [guía comparando cada parte con Python](docs/typescript-python-guide.md) y la [guía de evals TypeScript](docs/typescript-evaluations.md). Conserva el directorio `typescript-basic`, pero ahora incluye los controles del flujo completo: tres etapas, intentos acotados, presupuesto, telemetría y evaluación. Usa Node.js 24+ y un lockfile propio. También tiene un [panel Express de observabilidad en vivo](docs/live-observability.md), con modo demo sin claves. `basic-v1` conserva el prompt Python básico y `basic-v2` agrega ejemplos; el manual de Python completo es diferente. No hay un ganador de prompt medido todavía.

```powershell
uv sync --locked
uv run nubbix-support-basic --help
# El siguiente comando requiere una clave configurada y consume saldo del proveedor.
uv run nubbix-support-basic --text "Me cobraron dos veces este mes" --provider openai
```

Las instrucciones que siguen describen la versión completa.

## Empezar

Necesitás Python 3.12 o superior y [uv](https://docs.astral.sh/uv/getting-started/installation/). En Windows podés instalar Python desde [python.org](https://www.python.org/downloads/windows/) y uv con `winget install --id=astral-sh.uv -e`. Cerrá y abrí la terminal después de instalarlos.

```powershell
python --version
uv --version
uv sync --locked
uv run nubbix-support --help
uv run pytest
```

`uv run` utiliza el entorno del proyecto sin activarlo; no requiere cambiar la política de ejecución de PowerShell. Si `python` abre Microsoft Store, comprobá la instalación y los alias de ejecución de Windows. También podés indicar un intérprete a uv: `uv sync --locked --python 3.12`.

Para realizar llamadas reales, copiá `.env.example` a `.env` y completá localmente **sólo la clave del proveedor que usarás**. No hace falta una clave de OpenAI para usar xAI, ni viceversa. `.env` está excluido de Git. Cada llamada puede consumir saldo de la cuenta del proveedor.

```powershell
Copy-Item .env.example .env
uv run nubbix-support respond --text "El cargo de este mes aparece dos veces" --provider openai
"No puedo cambiar el administrador de mi empresa" | uv run nubbix-support respond --stdin --provider xai
```

En otras terminales, copiá el archivo con el comando equivalente y pasá el texto a través de la entrada estándar. `--text` y `--stdin` son alternativas: elegí una por ejecución.

## Resultado y registros

Una respuesta publicada tiene exactamente cuatro campos:

```json
{
  "answer": "Indicanos la fecha y referencia del cargo para que el equipo de facturación pueda verificarlo, ocultando cualquier dato sensible.",
  "confidence": 0.82,
  "category": "billing",
  "actions": ["Verificar los cargos antes de gestionar un ajuste."]
}
```

Este objeto es un **ejemplo del contrato**, no un resultado medido. Las categorías son `billing`, `technical`, `account` y `other`. `actions` contiene sugerencias para una persona: la aplicación no ejecuta pagos ni cambios de cuenta. `confidence` es una estimación autodeclarada del modelo, no una probabilidad calibrada; por debajo de `0.70` se añade una derivación humana.

`stdout` contiene únicamente el JSON de respuesta. La telemetría JSONL y los errores van a `stderr`; podés conservar también los metadatos en un archivo:

```powershell
uv run nubbix-support respond --text "No encuentro una factura" --provider xai --telemetry-file reports/telemetry.jsonl
```

Los registros de ejecución no incluyen el ticket, los prompts ni la respuesta. Un error operativo termina con un código de salida no exitoso y un diagnóstico sanitizado, sin presentar una respuesta de éxito. Un bloqueo de seguridad devuelve una propuesta estática de derivación que respeta el contrato.

## Configuración y costos

| Variable | Valor inicial | Propósito |
|---|---|---|
| `OPENAI_API_KEY` | Sin clave | Credencial exclusiva de OpenAI. |
| `XAI_API_KEY` | Sin clave | Credencial exclusiva de xAI. |
| `NUBBIX_OPENAI_MODEL` | `gpt-6-luna` | Modelo del adaptador OpenAI. |
| `NUBBIX_XAI_MODEL` | `grok-4.20-0309-non-reasoning` | Identificador de API de la familia Grok 4.2 solicitada. |
| `NUBBIX_TICKET_BUDGET_USD` | `0.05` | Presupuesto local estimado por ticket. |
| `NUBBIX_EVAL_BUDGET_USD` | `5` | Presupuesto local estimado por corrida de evals. |

El flujo normal realiza tres llamadas: moderación de entrada, generación y moderación de salida. Cada etapa admite como máximo dos intentos en total, compartidos entre errores transitorios y errores de formato. Los SDK no agregan reintentos propios. Cada llamada tiene un timeout de hasta 15 segundos y cada ticket un plazo total de 60 segundos.

Antes de llamar se reserva un costo estimado. Después se concilia con los tokens informados. Si el consumo queda desconocido, se conserva la reserva y se marca la información incompleta. **Estos límites locales no garantizan el importe final facturado por el proveedor.** Las tarifas están versionadas; cambiar de modelo requiere una tarifa verificada en el catálogo, además de acceso a ese modelo.

Las variables de entorno tienen prioridad sobre `.env`. Las demás opciones validadas se documentan en `Settings`, como `NUBBIX_PRICES_FILE` para un catálogo propio de tarifas. Verificá precios, disponibilidad y compatibilidad de parámetros al cambiar modelos; no hay un cambio automático al otro proveedor.

Al integrar xAI en un proceso que ya usa su SDK, configurá `XAI_SDK_DISABLE_TRACING=1` antes del primer `import xai_sdk` y reiniciá el proceso. La CLI lo configura antes de cargarlo. Si detecta un SDK ya instrumentado, rechaza la configuración para impedir que sus trazas exporten contenido sensible de errores; los metadatos propios de Nubbix se siguen registrando.

## Ejecutar las evals

Los recursos incluyen 80 tickets sintéticos balanceados, separados en 40 de desarrollo y 40 de prueba, más diez ataques y diez controles benignos. Su construcción y límites están en [la documentación del dataset](docs/dataset.md).

```powershell
uv run nubbix-support eval --provider openai --prompt-version v1 --split dev --output-dir reports
uv run nubbix-support eval compare --provider xai --split dev --output-dir reports --max-cost-usd 5
uv run nubbix-support eval --provider xai --prompt-version v2 --split test --output-dir reports
uv run nubbix-support eval adversarial --provider openai --prompt-version v1 --output-dir reports
```

Estos comandos llaman al proveedor y requieren credenciales. El comando informa las rutas de los reportes y del material para la revisión humana. Trabajá primero con `dev`; reservá `test` para evaluar la configuración final sin ajustar los prompts sobre sus respuestas.

La comparación de `v1` contra `v2` mide el aporte de ejemplos *few-shot* manteniendo el manual y las políticas de seguridad. Las métricas se calculan por proveedor y modelo: no se asume que un mismo prompt gane en ambos.

```powershell
# Reemplazá las rutas por los archivos de la corrida que estés revisando.
uv run nubbix-support eval summarize --report reports/RUTA_DEL_REPORTE.json --reviews reviews/ID_DE_CORRIDA.jsonl
uv run nubbix-support eval compare --reports reports/REPORTE_V1.json --reports reports/REPORTE_V2.json --reviews-dir reviews
```

`summarize` y la comparación con `--reports` trabajan con archivos existentes, sin llamadas al modelo. El resumen actualizado se imprime en `stdout`; no modifica el reporte original. Guardá las revisiones de cada corrida como `reviews/<run_id>.jsonl`, usando su identificador real. Cada registro contiene `run_id`, `case_id`, `quality_pass`, `severe_issue`, `attack_succeeded` y `notes`. Los valores `null` de una plantilla indican trabajo pendiente; no equivalen a aprobación.

La revisión humana debe evaluar utilidad, corrección, respeto del manual y éxito de los ataques según la rúbrica. Las reglas automáticas detectan fallos concretos; no prueban toda la calidad semántica ni toda la seguridad. Una comparación sin evidencia humana completa queda pendiente, aunque las métricas de clasificación sean buenas. Los reportes de evals conservan casos y respuestas **sintéticos** para inspección; no introduzcas datos de clientes en ese conjunto sin un proceso de anonimización y revisión apropiado.

La opción `eval adversarial --ablation` compara las defensas con una ejecución deliberadamente reducida, limitada al dataset sintético de evaluación. Es una herramienta de medición, no una configuración de uso con clientes.

## Verificar el software

```powershell
uv run pytest
uv run ruff check .
uv run mypy
uv build
```

La CI ejecuta estas verificaciones sin credenciales en Linux y Windows e instala el wheel en un entorno temporal, desde un directorio externo, para comprobar la CLI y sus recursos. Los tests con respuestas simuladas comprueban contratos, errores y políticas del software; no demuestran el rendimiento de un modelo real.

## Entender las decisiones

- [Arquitectura y alternativas](docs/architecture.md): responsabilidades, seguridad, presupuestos y cómo agregar un proveedor.
- [Guía de aprendizaje](docs/learning-guide.md): recorrido por Python, contratos, pruebas y context engineering.
- [Dataset y rúbrica](docs/dataset.md): etiquetado, ataques y revisión humana.

La base está preparada para un piloto **con revisión humana**. Antes de usarla con clientes hay que reemplazar el manual ficticio por políticas aprobadas, ejecutar las evals con cada proveedor/modelo y contrastar los resultados con tickets reales anonimizados. Las metas del piloto se detallan en la documentación de arquitectura; los datos sintéticos no permiten afirmar que ya se cumplen.
