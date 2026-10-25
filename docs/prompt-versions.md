# Agregar y evaluar versiones de prompts

Las versiones disponibles se declaran una sola vez en `typescript-basic/src/prompting/prompt-registry.yaml`. CLI, servidor, UI y evaluaciones consumen ese registro. El navegador recibe IDs y etiquetas; nunca puede elegir rutas de archivos ni enviar instrucciones de sistema propias.

El módulo `prompting/` reúne el registro, su cargador, los contratos de IDs y una carpeta independiente por versión. Cada carpeta conserva sus instrucciones, manual, seguridad y ejemplos opcionales. Los caminos escritos en el registro son relativos a ese archivo: `versions/basic-v1/context.yaml` apunta al manual de v1, no al directorio compartido de datasets y tarifas.

## Cómo funciona el registro

```yaml
version: '2'
default: basic-v1
baseline: basic-v1
prompts:
  - id: basic-v1
    label: basic-v1 · contexto base
    system: versions/basic-v1/system.yaml
    context: versions/basic-v1/context.yaml
    safety: versions/basic-v1/safety.yaml
  - id: basic-v2
    label: basic-v2 · contexto + cuatro ejemplos
    system: versions/basic-v2/system.yaml
    context: versions/basic-v2/context.yaml
    safety: versions/basic-v2/safety.yaml
    examples: versions/basic-v2/examples.yaml
```

- `default`: versión usada cuando no elegís una; también es la selección inicial de la UI.
- `baseline`: referencia inicial para comparar candidatas. Puede ser distinta del default y debe estar incluida entre las variantes comparadas.
- `prompts`: ID público, etiqueta visual y rutas de los recursos propios de cada versión. El orden determina la presentación y el orden inicial de ejecución.
- `system`, `context` y `safety`, dentro de cada entrada: instrucciones de generación, manual y políticas de moderación/reparación de esa versión. `examples` es opcional.
- `version`: identifica la revisión del registro; no selecciona un prompt ni modifica el formato de los reportes.

Los IDs admiten de 1 a 64 caracteres: empiezan con letra minúscula y continúan con letras minúsculas, dígitos o guiones. Las rutas son relativas al registro y deben apuntar a archivos `.yaml` dentro de `versions/<id>/`. El cargador rechaza referencias a otras carpetas de versión, rutas absolutas, URLs, `..`, enlaces que salgan del árbol y recursos físicos compartidos entre versiones. No hay descarga remota de prompts.

`PromptRegistry.load()` valida todos los archivos al iniciar, incluidos los de versiones que todavía no elegiste. Una referencia rota impide arrancar antes de consumir API. `get()` entrega una copia del bundle ensamblado; una request no puede modificar el bundle reutilizado por otra. `loadPrompts()` conserva un atajo compatible para scripts y delega al mismo registro.

## Ejemplo: crear basic-v3

Desde `typescript-basic`, copiá la carpeta de una versión existente. El destino nuevo no debe existir; así evitás sobrescribir un experimento anterior:

```powershell
Copy-Item -Recurse src/prompting/versions/basic-v2 src/prompting/versions/basic-v3
```

Editá la copia: cambiá `version: basic-v3` en `system.yaml` y `version: basic-v3-examples` en `examples.yaml`, si lo conservás. Los campos `version` del manual y de seguridad pueden mantenerse mientras su contenido no cambie. Probá una modificación concreta de instrucciones o ejemplos; conservá `{{manual}}`, el contrato JSON, el tratamiento del ticket como dato no confiable y las restricciones de seguridad.

Añadí esta entrada **dentro de la lista `prompts`** del registro:

```yaml
  - id: basic-v3
    label: basic-v3 · prioridad del problema principal
    system: versions/basic-v3/system.yaml
    context: versions/basic-v3/context.yaml
    safety: versions/basic-v3/safety.yaml
    examples: versions/basic-v3/examples.yaml
```

Si no querés ejemplos, quitá el campo `examples` y su archivo de la nueva carpeta. No hace falta modificar TypeScript, HTML, tests ni el script de build. La versión aparecerá en soporte, evaluación, comparación y baseline después de reconstruir y reiniciar el servidor. El build conserva las rutas: el registro compilado queda en `dist/prompting/prompt-registry.yaml` y los recursos en `dist/prompting/versions/<id>/`.

El ID del registro es la identidad pública. El campo `version` dentro de cada YAML identifica la revisión de ese recurso. En la migración inicial, v1 y v2 reciben copias de sus recursos efectivos: las instrucciones, manual y seguridad parten del mismo contenido, y v2 conserva sus cuatro ejemplos. Desde entonces editar los archivos de v2 no modifica v1.

### Historial sencillo con Git

Los archivos siguen siendo editables. La aplicación no impone inmutabilidad ni bloquea el sistema de archivos: **conservar una versión evaluada es una convención del equipo, respaldada por Git**. Para una candidata nueva, copiá una carpeta y usá otro ID. Guardá un commit que explique la hipótesis del cambio; los reportes e historial siguen identificando la versión y sus hashes aunque retires su entrada del registro.

Los hashes detectan que el contenido cambió, pero no reconstruyen un archivo anterior por sí solos. Git conserva ese contenido y permite revisar diferencias. Evitá reutilizar un ID para un experimento distinto o modificar reportes históricos para que parezcan compatibles. Elegir `default` cambia la selección inicial; `baseline` sigue siendo una referencia de comparación. No hay un sistema de promociones ni un flujo adicional de publicación.

Después de revisar los archivos y ejecutar las comprobaciones que correspondan, podés guardar la candidata con un commit enfocado. Revisá el diff preparado antes de confirmarlo:

```powershell
git add src/prompting/versions/basic-v3 src/prompting/prompt-registry.yaml
git diff --cached -- src/prompting/versions/basic-v3 src/prompting/prompt-registry.yaml
git commit -m "feat(prompts): add basic-v3 with clearer ticket prioritization"
git log --oneline -- src/prompting/versions/basic-v3
```

### Ejemplos opcionales

Podés añadir `examples: versions/basic-v3/examples.yaml` a la entrada. Su archivo debe tener:

```yaml
version: basic-v3-examples
examples:
  - ticket: Tengo dudas sobre un cargo de mi suscripción.
    response:
      answer: Indicanos la fecha y referencia del cargo, ocultando datos sensibles, para que facturación pueda revisarlo.
      confidence: 0.85
      category: billing
      actions:
        - Verificar el cargo antes de proponer un ajuste.
```

Se admiten entre 1 y 20 ejemplos, cada respuesta validada con el mismo Zod que usa soporte. No es obligatorio cubrir cuatro categorías; los cuatro ejemplos actuales de v2 son una decisión experimental. Mantenelos independientes del dataset y evitá variar instrucciones y ejemplos a la vez si querés identificar cuál cambio causó una mejora.

## Reconstruir y descubrir versiones

```powershell
npm run build
node dist/cli.js --list-prompts
node dist/eval-cli.js --list-prompts
```

Los dos comandos publican JSON con `defaultVersion`, `baselineVersion` y `versions` (`id`/`label`). No leen claves ni hacen requests al LLM. `--help` tampoco requiere un registro válido; sirve para diagnosticar configuración rota.

Detené y reiniciá el servidor para cargar los recursos nuevos, por ejemplo `node dist/web/server.js --port 3087`. No hay recarga automática: reiniciar evita que una evaluación mezcle archivos modificados mientras corre. `npm run web` reconstruye y arranca en el puerto predeterminado 3000; `npm run web:demo` conserva el modo simulado explícito.

## Probar en CLI y UI

Estos comandos **consumen API real** con las credenciales configuradas:

```powershell
node dist/cli.js --provider google-ai --prompt-version basic-v3 --text "No encuentro mi factura y tampoco puedo exportar un reporte."
node dist/eval-cli.js run --provider google-ai --prompt-version basic-v3 --split dev
node dist/eval-cli.js compare --provider google-ai --prompt-versions basic-v1 --prompt-versions basic-v3 --baseline-prompt basic-v1 --split dev
```

`compare` admite dos o más versiones, con `--prompt-versions` repetido o una lista separada por comas. Si omitís esa selección, ejecuta **todas las registradas**, usando el baseline del registro. Agregar una versión aumenta ese trabajo: son 60 casos por variante en la suite completa. El presupuesto USD 5 sigue siendo compartido y no aumenta automáticamente.

En la UI, elegí **Comparar versiones de prompt**, seleccioná las variantes y su referencia. El baseline debe estar entre las seleccionadas y la partición es desarrollo. El selector múltiple usa Ctrl/Cmd para alternar opciones. Un ID desconocido se rechaza antes de crear trabajo o consumir tokens, aunque tenga una sintaxis válida.

## Comparar evidencia guardada

```powershell
node dist/eval-cli.js compare --reports reports/ID_BASE.json --reports reports/ID_V3.json --reviews-dir reviews --baseline-prompt basic-v1
```

Esta operación es offline: puede leer versiones retiradas del registro. Los reportes comparativos nuevos guardan el baseline en su procedencia; no se permite sustituirlo al adjudicar. Los reportes individuales y antiguos permiten indicarlo explícitamente; si no está declarado, se usa el menor ID en orden lexicográfico como fallback estable. Para evitar ambigüedad, elegí siempre la referencia al comparar archivos individuales.

Se exige igualdad de proveedor/modelo, corpus, manual, seguridad, configuración, precios, SDK y contrato. Tener copias independientes no exige que su contenido sea diferente: las copias iniciales del manual y la seguridad son idénticas. Si cambiás esos recursos en una versión, podés ejecutar sus evals individuales, pero `compare` rechaza contextos distintos para evitar atribuir toda diferencia a las instrucciones o ejemplos. El texto de generación y los ejemplos sí pueden variar: son las variables de esa comparación. Los hashes de cada bundle y del registro conservan la procedencia; un hash identifica contenido, no acredita su calidad ni vuelve determinista al proveedor.

Las revisiones humanas pendientes, regresiones de seguridad y demás gates siguen impidiendo recomendar un prompt. Registrar una versión o elegirla como default no demuestra que sea mejor. Usá desarrollo para elegir, reservá prueba para la evaluación final y mantené revisión supervisada mientras el manual siga siendo ficticio.
