# Versiones de prompts independientes

**Objetivo aprobado:** mantener YAML + Git + registro sencillo y permitir editar/evaluar una versión sin modificar las demás. Sin promociones, rollback ni servicios externos.

**Diseño:** conservar `prompting/prompt-registry.yaml` como registro con default/baseline y metadatos. Mover context/safety de globales a cada entrada. Cada recurso debe vivir en `versions/<id>/`: system.yaml, context.yaml, safety.yaml y examples.yaml opcional. El cargador conserva precarga, hashes efectivos, validación y API; rechaza referencias escritas fuera de esa carpeta y recursos físicos compartidos por distintas versiones. CLI/UI/evals mantienen sus contratos. Versiones evaluadas se conservan por convención y Git; no hay bloqueo de edición en el sistema de archivos.

**Migración:** v1 y v2 reciben copias independientes del contenido efectivo actual. El cambio local del usuario en prompt.yaml se preserva en ambos system.yaml, porque antes afectaba a ambas versiones. No se publica como cambio nuestro: al commitear se guarda el contenido base previo y quedan sus dos copias modificadas sin stage. Los IDs, default y baseline siguen iguales; reportes/historia no se reescriben.

**Reglas de comparación:** manual y seguridad son independientes por versión, pero las comparaciones de instrucciones/ejemplos continúan exigiendo contexto y políticas iguales. Sus copias iniciales son idénticas; si se modifican, se pueden ejecutar evals individuales, pero no atribuir diferencias únicamente al prompt de generación.

## Trabajo

- [x] Tests RED con manifest por versión y cambios de instrucciones/manual/seguridad/ejemplos aislados; referencias compartidas rechazadas.
- [x] Implementar cargador y migración de YAML; actualizar fixtures, ejemplos de empaquetado y rutas de tests.
- [x] Actualizar README y guía práctica: copiar carpeta, nueva entrada, elegir CLI/UI, evaluar, conservar con Git.
- [x] Suite TS, tipos, formato, Python y paquete desde otro cwd sin APIs; revisar diff y arrancar lab conservando SQLite; commits/push autorizados.

## Evidencia de cierre

- El nuevo formato por entrada falló con el cargador anterior; pasan las pruebas de aislamiento tras implementarlo. Editar los cuatro tipos de recursos de v2 mantiene íntegros textos y hashes de v1/v3. Referencias cruzadas y junctions internos/externos se rechazan.
- Siete archivos de recursos independientes creados. El system de v1 conserva bytes del prompt local previo; el de v2 conserva el texto efectivo y sólo actualiza el campo version de la plantilla. IDs, default y baseline siguen iguales.
- Suite TS completa, tipos, formato, 154 pruebas Python y paquete instalado fuera del repo pasan sin llamadas reales iniciadas por los tests. El paquete prueba una versión adicional con recursos propios, CLI, evals, HTTP y persistencia.
- Revisión independiente sin findings accionables. Cinco diagramas Mermaid válidos.
- Se comprobó ausencia de corridas activas antes de reiniciar; el lab LIVE en 3087 conserva su historial. GET de configuración, assets e historial verificados sin iniciar tickets ni evaluaciones.
- Las ediciones locales previas del usuario se mantienen sin stage en los system.yaml de ambas versiones. No se agregaron promociones, rollback, servicios externos ni restricciones de edición de archivos.

## Ownership

- Raíz: implementación, tests, recursos, empaquetado, verificación y Git.
- Worker docs: README TS y guías vigentes de prompts/evals/observabilidad/Python-TS, sin código ni planes históricos.
