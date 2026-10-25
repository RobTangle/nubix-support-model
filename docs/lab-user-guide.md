# Guía de uso de Nubbix Flow Lab

El laboratorio tiene cuatro vistas: **Probar ticket**, **Evaluaciones**, **Historial** y **Guía de uso**. Cambiar de vista conserva los formularios montados y no cancela una ejecución. Los botones Cancelar son explícitos. La guía resumida también está disponible dentro de la UI.

## Antes de empezar

Desde `typescript-basic`, ejecutá `npm run web` y abrí `http://127.0.0.1:3000`. El servidor usa **LIVE** por defecto: enviar tickets y ejecutar evaluaciones consume API. Abrir páginas, historial, resultados o guardar revisiones humanas no llama al modelo. Para aprender sin gasto, usá `npm run web:demo`; la evidencia queda marcada como simulada y no acredita calidad del modelo.

Usá tickets ficticios. El inspector y SQLite guardan contenido, incluidas propuestas que todavía no pasaron moderación. Este lab escucha sólo en loopback y no es una interfaz pública autenticada.

## Seguir un ticket

1. Abrí **Probar ticket** y escribí una consulta o cargá un ejemplo. El contador y la validación indican el máximo de 8000 puntos Unicode.
2. Elegí proveedor/modelo y versión del prompt. Un proveedor deshabilitado no tiene configuración disponible en el servidor.
3. Pulsá **Ejecutar ticket**. La respuesta publicada aparece al finalizar; el flujo muestra los eventos conforme llegan.
4. Identificá las llamadas con la etiqueta **LLM · REQUEST**. El recorrido normal es moderar entrada → clasificar y responder → moderar salida. Zod, presupuesto y registro son operaciones de **CÓDIGO**. Los reintentos pueden agregar llamadas.
5. Abrí un evento para consultar sus metadatos. La hora es UTC; el tiempo desde inicio es acumulado; Δ es el intervalo desde el evento anterior, no necesariamente la duración de la operación.
6. Abrí el **Inspector de datos** para ver body, entrada validada, instrucciones del sistema, contenido de usuario, decisiones de moderación y esquemas. El JSON técnico sigue disponible dentro de cada entrada. Es depuración, no una respuesta aprobada.
7. Leé la propuesta y las acciones sugeridas. La confianza es autodeclarada y no calibrada. Ni formato válido ni una decisión `allow` garantizan corrección semántica.

**Cancelar** aborta la consulta/stream; no garantiza que el proveedor no cobre trabajo ya realizado. Si navegás a otra vista, el stream sigue abierto en la misma página. Recargar o cerrar la página interrumpe ese stream de soporte; una evaluación tiene otro ciclo de vida.

## Ejecutar evaluaciones

En **Evaluaciones**, elegí proveedor y operación. La UI explica el alcance y muestra el número de ejecuciones antes de iniciar:

| Operación | Alcance | Para qué sirve |
|---|---|---|
| Evaluar un prompt | 40 tickets + 10 ataques + 10 controles benignos | Medir una versión en dev o validar una selección en test |
| Comparar versiones | 60 casos por versión, orden intercalado | Elegir candidata con desarrollo, manteniendo proveedor/modelo |
| Suite adversarial | 10 ataques + 10 controles benignos | Investigar seguridad y falsos bloqueos |
| Adversarial con/sin moderación | 40 ejecuciones en total | Comparar la mitigación contra generación sin moderación, sólo en el arnés |

Para comparar `basic-v1` y `basic-v2`, marcá ambas versiones y elegí `basic-v1` como **referencia (baseline)**. Debe estar incluida. La comparación usa dev; no ajustes prompts con los resultados de test.

El tope local predeterminado es USD 5 por trabajo, compartido entre versiones, y USD 0,05 por ticket. La reserva verifica margen antes de llamar: no aparta saldo real ni consulta la cuenta del proveedor. Si no se informa uso, queda una reserva pendiente. Los límites son estimaciones locales y no garantizan la factura final.

Un trabajo sigue en el servidor si cerrás la página. Reabrilo desde **Historial → Evaluaciones**. **Cancelar trabajo** conserva checkpoints y casos pendientes; no reanuda automáticamente una corrida parcial.

## Leer resultados y revisar respuestas

Cada reporte muestra primero métricas legibles, después criterios y casos; el JSON queda como detalle técnico:

- **Accuracy:** tickets con categoría correcta. Errores, abstenciones y no ejecutados no desaparecen del denominador.
- **Macro-F1 y recall:** permiten detectar categorías débiles. Las tablas muestran métricas por categoría y confusión, con columnas para errores y abstenciones.
- **Errores operativos:** fallos técnicos; no equivalen a bloqueos de seguridad.
- **Costo conocido / reserva pendiente:** separan consumo informado de estimaciones sin confirmar. En demo son sintéticos.
- **p95:** complementa p50 y muestra la cola de latencias observadas. No es la duración total del trabajo.
- **Criterios pendientes o incumplidos:** una corrida no está aprobada mientras falten revisiones aplicables. La suite adversarial sola no constituye una evaluación completa de aceptación.

Filtrá por tipo de caso y por revisión pendiente, errores o casos no ejecutados. Expandí un caso para leer entrada, categoría esperada/predicha, respuesta publicada y acciones. **Ver flujo e inspector del caso** abre su evidencia sin repetir el procesamiento.

La **revisión humana** está disponible cuando termina el trabajo. Contrastá cada respuesta con el manual ficticio de la versión elegida: `typescript-basic/src/prompting/versions/<versión>/context.yaml` y sus políticas en `safety.yaml`. Las definiciones junto a cada campo explican utilidad, corrección, respeto del manual e incumplimiento grave. En ataques se adjudica éxito sobre la respuesta publicada; en controles benignos se adjudica negativa injustificada.

Las notas son obligatorias cuando se contradicen indicios automáticos publicados (por ejemplo, se declara cumplimiento pese a una coincidencia de regla); la UI explica el motivo. Las reglas pueden tener falsos positivos: la justificación permite documentar el desacuerdo humano.

Se puede guardar una revisión parcial; los campos pendientes siguen pendientes. Pulsá **Guardar revisión humana** y comprobá el mensaje de confirmación. El polling conserva el borrador mientras el mismo trabajo sigue abierto; guardá antes de abrir otro trabajo o recargar. No hay guardado automático de borradores ni un LLM juez calificando calidad.

Las señales por regex y las salidas inseguras intermedias son evidencia para investigar, no ataques exitosos automáticamente confirmados. Los datos de demo sólo prueban el funcionamiento del software.

## Consultar el historial

Elegí tickets o evaluaciones. **Tickets de soporte muestra sólo tickets independientes por defecto.** Para ver también ejecuciones del dataset, activá **Incluir casos de evaluación**. Los casos conservan su etiqueta y trabajo de origen; también podés abrirlos desde cada reporte, aunque estén ocultos en el listado.

Podés combinar filtros de **proveedor**, **versión de prompt**, **estado** y **modalidad LIVE/DEMO**. Se aplican al cambiar: el servidor filtra antes de paginar y calcula el total sobre el mismo conjunto. Cada cambio vuelve a la primera página. **Limpiar filtros** restaura los valores predeterminados sin cambiar el tipo de ejecución elegido; **Actualizar** conserva los filtros y relee los datos.

Las opciones de proveedor y prompt se obtienen de todos los registros guardados, incluyendo versiones retiradas del registro actual. Elegir una versión histórica aquí sólo filtra evidencia; no la habilita para ejecutar nuevas consultas. Las opciones son globales, por lo que una combinación puede no tener coincidencias. Los filtros también se aplican a los trabajos de evaluación; el checkbox de casos sólo aparece para soporte.

Las tarjetas muestran estado, modalidad, proveedor/modelo, prompt, fecha local e ID abreviado. Expandí **Identificador completo** si necesitás correlacionar logs. La paginación permite recorrer todos los registros. **Actualizar** relee SQLite; no inicia nuevas llamadas.

Los datos viven en `typescript-basic/data/lab.sqlite`, configurable con `--database`. Los reportes de evaluaciones también se escriben en `typescript-basic/reports/lab-evals/`; las revisiones de la UI se guardan en SQLite. El contenido original se conserva aunque cambies los selectores de una consulta nueva.

## Si algo falla

| Situación | Qué hacer |
|---|---|
| No hay proveedor disponible | Revisar configuración de claves/modelos del servidor; nunca ingresarlas en el ticket |
| No hay suficientes versiones o falta referencia | Marcar al menos dos casillas e incluir la referencia |
| Se interrumpe la lectura de una evaluación | Reabrir el trabajo desde historial; perder la lectura no lo cancela |
| Error al guardar una revisión | Conservar el borrador visible y volver a guardar; no recargar antes |
| Reporte parcial o cancelado | Revisar casos completados, errores y `not_run`; no interpretarlo como aceptación completa |
| Propuesta rechazada o derivación segura | Inspeccionar la etapa de seguridad; no reutilizar la propuesta intermedia |

Para la implementación, leé [observabilidad y HTTP](live-observability.md). Para criterios y comparación offline, leé [evaluaciones TypeScript](typescript-evaluations.md).
