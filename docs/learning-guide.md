# Guía de aprendizaje

El objetivo del proyecto es que puedas seguir una consulta desde la entrada hasta el JSON final y justificar cada decisión. Leé el código en este orden y ejecutá los tests junto con cada parte.

## 1. Un contrato antes que una llamada al modelo

Empezá por `Ticket`, `SupportResponse` y `SafetyAssessment` en el módulo de contratos. Una anotación como `str` sirve al editor y al analizador estático; no verifica por sí misma los datos que llegan desde una terminal o una API. Pydantic agrega esa validación en tiempo de ejecución.

Buscá los límites y `extra="forbid"`. El contrato no permite una categoría inventada ni una propiedad adicional que un consumidor podría interpretar accidentalmente. La confianza debe ser finita: `NaN` no es un número útil para comparar contra un umbral. Tampoco se acepta un booleano como confianza, aunque Python trate `bool` como subtipo de `int` en algunas operaciones.

El validador `mode="before"` de `Ticket` revisa la longitud del texto original antes de recortar espacios. Sin ese orden, una entrada excesiva compuesta en gran parte por espacios podría terminar pareciendo pequeña al validarla. En `SupportResponse`, comprobar el rango de `confidence` sólo verifica su formato: obtener `0.8` no demuestra que ocho de cada diez respuestas semejantes sean correctas. Eso exigiría datos y un análisis de calibración independiente.

`Annotated[str, Field(...)]` combina una anotación útil para mypy con restricciones que Pydantic interpreta en ejecución. Esa cooperación no hace que mypy pruebe la validez de un JSON remoto: cada herramienta opera sobre información distinta.

Ejercicio: agregá una prueba que intente construir una respuesta con seis acciones o una cadena vacía. Observá el error antes de leer la implementación. Después pensá qué ocurriría si el servicio devolviera ese objeto sin validarlo a una integración que guarda tickets.

## 2. Clases donde aportan; funciones donde alcanzan

Una clase es útil cuando agrupa estado y comportamiento relacionado. `SupportService` conserva sus dependencias; un adaptador conserva configuración de acceso; `Budget` mantiene un contador. Una función alcanza para una transformación sin estado o para escribir un evento.

`LLMRequest` y `LLMResult` son `dataclass`: expresan mensajes internos con campos claros y un constructor generado. Sus instancias congeladas evitan reasignaciones accidentales, pero no sustituyen la validación de datos remotos. Pydantic se reserva para los bordes donde esa validación sí es necesaria.

`frozen=True` es una protección superficial: impide reasignar un atributo, pero no vuelve inmutables todos los objetos que ese atributo pueda contener. Si una futura `dataclass` congelada incluye una lista, todavía se podría modificar el contenido de la lista. En las trazas, `Field(default_factory=list)` expresa además que cada ejecución necesita su propia colección, no estado mutable compartido entre tickets.

Python no exige convertir cada operación en un método ni crear una interfaz para todo. Un helper que sólo devuelve `objeto.campo` dificulta seguir el código sin encapsular una decisión. En cambio, normalizar usage de un proveedor sí merece una función porque hay reglas que comprobar y reutilizar.

## 3. Entender `Protocol` y la inyección de dependencias

Leé el protocolo del proveedor y después uno de los proveedores simulados en los tests. El doble no necesita heredar de la implementación real. Basta con ofrecer `name`, `model` y `complete` con el contrato requerido.

Eso es inyección de dependencias: quien construye el servicio elige qué objeto utilizar. No hace falta un framework ni un contenedor. El mismo servicio puede usar OpenAI en una ejecución real y una secuencia de respuestas predefinidas en una prueba.

La alternativa con `ABC` aporta herencia y validación de métodos abstractos al instanciar. Puede ser útil si hay comportamiento compartido; aquí el `Protocol` conserva una dependencia más pequeña. Mypy comprueba coherencia estática y los tests comprueban comportamiento: ninguna de esas herramientas reemplaza a la otra.

`response_model: type[BaseModel]` significa que se pasa una **clase de modelo**, por ejemplo `SupportResponse`, y no una respuesta ya construida. El adaptador puede pedir su JSON Schema; el servicio puede validar después el texto recibido con esa misma definición. El formato enviado al proveedor y la validación local parten así de un contrato común.

La inyección también aparece en el callback `emit`: el servicio sólo sabe emitir metadatos y quien lo construye decide su destino. La CLI administra la vida de los archivos con context managers; `write_event` escribe y vacía los streams, pero no los cierra porque no es su dueño. Este reparto evita que una utilidad cierre por accidente `stderr` o un archivo que otro componente todavía necesita.

Ejercicio: construí un proveedor local que devuelva tres respuestas predeterminadas válidas. Usalo con el servicio y verificá que la tercera solicitud contiene tanto `answer` como `actions`. No confundas ese ejercicio de integración con una evaluación de un LLM.

## 4. Leer el servicio como una política de publicación

Seguí `SupportService.process` de arriba abajo. No es sólo una secuencia de llamadas: determina cuándo es aceptable publicar un resultado. La salida tiene que pasar la validación y la revisión de seguridad; una moderación que falla no equivale a permiso.

La regla de baja confianza agrega revisión humana antes de la moderación de salida. Este orden importa: se verifica el objeto final que verá el consumidor, no una versión anterior. Una derivación estática evita reutilizar fragmentos de una salida que ya se consideró insegura.

Leé los tests de bloqueo, output inseguro y moderación inválida. Identificá cuál es el comportamiento observable que prueba cada caso. Contar llamadas puede verificar un límite, pero la afirmación más importante es que el texto inseguro no aparece en la respuesta publicada.

## 5. Separar errores, reintentos y consumo

Revisá los adaptadores después del servicio. Sus diferencias pertenecen a la infraestructura: OpenAI usa HTTP/Responses API y xAI utiliza gRPC. El caso de uso no necesita conocer las excepciones de esos transportes.

Los adaptadores traducen los errores a `ProviderError` y usan `raise ... from None` para no propagar el mensaje del SDK en un traceback habitual. En Python, una excepción puede encadenarse a otra automáticamente; controlar ese encadenamiento ayuda a no exponer información sensible. La CLI también debe sanitizar lo que publica: suprimir el encadenamiento no convierte un mensaje arbitrario en seguro.

Leé también `Settings`. `SecretStr` enmascara valores en representaciones y serializaciones habituales, pero **no cifra** la clave ni impide recuperarla con `get_secret_value()`. Se usa como defensa frente a exposiciones accidentales, junto con archivos ignorados por Git y diagnósticos sanitizados. Las variables del entorno prevalecen sobre `.env`; las opciones sin configurar usan los valores iniciales validados.

Un timeout no demuestra que el proveedor no consumió tokens. Por eso existe una reserva antes de la llamada y una conciliación después. Estudiá los tests de consumo desconocido: reportar cero en ese caso haría más cómodo el resultado, pero menos confiable la contabilidad.

`TokenUsage` normaliza diferencias entre APIs. Sus tokens de entrada y salida son totales; los tokens cacheados, de escritura de caché y de razonamiento son subtotales que el adaptador ya incluyó en ellos. Volver a sumarlos inflaría consumo y costo. `usage=None` expresa ausencia de información; una traza con `usage_complete=False` no debe presentarse como un total completo aunque tenga algunos tokens conocidos.

El límite de dos intentos es por etapa e incluye tanto fallos transitorios como parsing inválido. Si el SDK también reintentara por su cuenta, el número real de llamadas sería mayor que el que aparenta el servicio. La espera breve evita reintentar inmediatamente; el reloj monotónico y los deadlines ponen un límite temporal.

Ejercicio: dibujá una ejecución con entrada válida, generación inválida, generación corregida y salida válida. Calculá cuántas llamadas hay y qué consumos deben entrar en el costo. Después repetí el ejercicio con un timeout sin usage.

## 6. Prompts y contexto como datos versionados

Abrí el manual y los YAML de prompts. El manual es deliberadamente ficticio: permite practicar grounding sin fingir conocer políticas de una empresa real. Las instrucciones prohíben inventar hechos fuera de esa fuente.

`v1` es el baseline. `v2` agrega ejemplos *few-shot*: casos que muestran cómo clasificar y responder bajo el mismo contrato. Los ejemplos pueden mejorar un comportamiento y empeorar otro; no se eligen por lo convincente que parezca una demo.

El ticket se serializa como dato de usuario y no se interpola en instrucciones privilegiadas. Esto ayuda a mantener el límite entre instrucciones y contenido, pero no garantiza que un modelo ignore una injection. La evaluación adversarial y la moderación miden y reducen riesgos adicionales.

`safe_load` impide interpretar objetos Python arbitrarios al cargar YAML. Pydantic comprueba después que el recurso tiene la forma esperada: ambas herramientas resuelven problemas distintos. `importlib.resources` encuentra los recursos dentro del paquete; usar una ruta relativa al directorio actual fallaría al ejecutar la CLI desde otra carpeta.

Esos YAML son recursos versionados del proyecto, no documentos externos arbitrarios. `safe_load` no detecta instrucciones maliciosas ni confirma que una política sea correcta. El marcador sintético para investigar filtraciones se activa sólo en evals; no se utiliza como credencial ni sustituye el control de seguridad.

Una particularidad al documentar aplicaciones con Pydantic: el docstring de una clase de modelo puede aparecer como `description` en su JSON Schema. Si ese esquema se envía al LLM, cambiar el docstring también cambia su contexto. Por eso las notas pedagógicas sobre estos modelos están en comentarios de Python o en esta guía; no se modifica su descripción como si fuera documentación sin efecto sobre el comportamiento.

Ejercicio: ejecutá los tests de recursos desde un directorio externo o instalá el wheel en un entorno limpio. Una ejecución exitosa desde la raíz del proyecto no demuestra que el paquete se distribuye correctamente.

## 7. Distinguir tests de software y evals de IA

| Verificación | Qué demuestra | Qué no demuestra |
|---|---|---|
| Unit tests | Validación, presupuesto, clasificación de errores y políticas de publicación deterministas. | Calidad del modelo real. |
| Tests del adaptador con transporte o respuestas simuladas | Que el código envía parámetros y normaliza la respuesta esperada del SDK. | Disponibilidad del modelo, permisos de una cuenta ni compatibilidad efectiva del servidor. |
| Smoke del wheel | Que el paquete instalado incluye CLI y recursos y funciona fuera del repositorio. | Calidad ni seguridad de una respuesta generada. |
| Evals reales | Rendimiento observado de una combinación concreta sobre el dataset y configuración registrados. | Garantías para todos los tickets futuros. |
| Revisión humana | Utilidad, corrección semántica, respeto del manual y fallos que no capturan reglas simples. | Ausencia total de sesgo o error del revisor. |

Las evals necesitan credenciales y cuestan dinero. Los tests y la CI no necesitan claves. No se reemplaza una evaluación real con un proveedor falso para producir una cifra de calidad atractiva.

La accuracy mide la proporción de clasificaciones correctas; macro-F1 promedia el F1 de cada categoría y evita que una categoría frecuente domine el resultado global. Revisar recall por categoría permite detectar si el servicio deja escapar un tipo de consulta, aunque el promedio parezca aceptable.

Los errores y las abstenciones cuentan como fallos de clasificación. Si se eliminaran del denominador, un sistema que responde sólo a los casos fáciles parecería mejor. La matriz de confusión muestra qué categorías se mezclan. Las latencias p50 y p95 describen comportamientos diferentes; no hay que presentar la mediana como si representara todos los tickets.

Una regla que detecta "ya realizamos el reintegro" puede encontrar una afirmación prohibida concreta. No demuestra que cualquier otra respuesta sea correcta. Por eso el reporte separa comprobaciones automáticas de revisión semántica humana y conserva los casos para inspección.

## 8. Elegir el prompt con evidencia

Compará primero en `dev` manteniendo proveedor/modelo, manual, políticas, parámetros y dataset. Revisá errores, ataques, falsos bloqueos y calidad humana antes de priorizar macro-F1. Usá costo y latencia para resolver empates entre alternativas que ya cumplen los criterios de calidad y seguridad.

Después evaluá la configuración final en `test`. Si modificás el prompt al ver los fallos de ese conjunto, ya lo usaste para desarrollar: necesitás nuevos casos reservados para estimar generalización con honestidad.

No hay un ganador universal. Los modelos pueden aprovechar ejemplos de forma diferente. También pueden cambiar de comportamiento o disponibilidad, por lo que las versiones y los modelos devueltos deben acompañar a los resultados.

La rúbrica humana y los criterios del piloto están en la documentación del dataset y la arquitectura. Completalos antes de presentar una comparación como recomendación respaldada. Cada revisión identifica la corrida y el caso; los campos sin completar quedan pendientes. `eval summarize` recalcula la evaluación de un reporte con esas revisiones y `eval compare --reports ... --reports ...` compara evidencia ya guardada sin volver a pagar llamadas. Si las claves todavía no están configuradas, el estado correcto es **pendiente de evaluación real**.

## 9. Evolucionar desde necesidades observadas

Una API HTTP sería una nueva interfaz sobre el caso de uso; no debería copiar su lógica. Una base de datos tendría sentido cuando aparezca una necesidad concreta de trazabilidad persistente o integración. RAG requeriría diseñar recuperación, procedencia, permisos y evals adicionales: no se agrega sólo porque la aplicación usa IA.

Antes de optimizar paralelismo, medí latencia, límites de los proveedores y necesidad de throughput. Si se procesan tickets concurrentemente, el presupuesto compartido necesitará sincronización y límites persistentes si abarca varios procesos. La estructura actual permite ese crecimiento sin pagar hoy por toda esa infraestructura.

El paso hacia producción también es de producto: reemplazar el manual ficticio, aprobar políticas, probar con tickets reales anonimizados y mantener revisión humana durante el piloto. Una suite verde demuestra propiedades del software; la operación real requiere evidencia de la tarea y seguimiento continuo.
