# Agregar y evaluar versiones de prompts

Las versiones disponibles se declaran una sola vez en `typescript-basic/src/prompting/prompt-registry.yaml`. CLI, servidor, UI y evaluaciones consumen ese registro. El navegador recibe IDs y etiquetas; nunca puede elegir rutas de archivos ni enviar instrucciones de sistema propias.

El módulo `prompting/` reúne el registro, su cargador, los contratos de IDs y los YAML. Los caminos escritos dentro del registro siguen siendo relativos a ese archivo: `resources/context.yaml` apunta a `src/prompting/resources/context.yaml`, no al directorio de recursos compartidos de datasets y tarifas.

## Cómo funciona el registro

```yaml
version: '1'
default: basic-v1
baseline: basic-v1
context: resources/context.yaml
safety: resources/safety.yaml
prompts:
  - id: basic-v1
    label: basic-v1 · contexto base
    system: prompt.yaml
  - id: basic-v2
    label: basic-v2 · contexto + cuatro ejemplos
    system: prompt.yaml
    examples: resources/basic-v2.yaml
```

- `default`: versión usada cuando no elegís una; también es la selección inicial de la UI.
- `baseline`: referencia inicial para comparar candidatas. Puede ser distinta del default y debe estar incluida entre las variantes comparadas.
- `context` y `safety`: manual, moderaciones y reparación compartidos para mantener constantes esas condiciones del experimento.
- `prompts`: ID público, etiqueta visual, plantilla de instrucciones y ejemplos opcionales de cada versión. El orden determina la presentación y el orden inicial de ejecución.
- `version`: identifica la revisión del registro; no selecciona un prompt ni modifica el formato de los reportes.

Los IDs admiten de 1 a 64 caracteres: empiezan con letra minúscula y continúan con letras minúsculas, dígitos o guiones. Las rutas son relativas al registro y deben apuntar a archivos `.yaml` dentro de ese directorio; se rechazan rutas absolutas, URLs, `..` y enlaces que salgan del árbol de recursos. No hay descarga remota de prompts.

`PromptRegistry.load()` valida todos los archivos al iniciar, incluidos los de versiones que todavía no elegiste. Una referencia rota impide arrancar antes de consumir API. `get()` entrega una copia del bundle ensamblado; una request no puede modificar el prompt compartido de otra. `loadPrompts()` conserva un atajo compatible para scripts y delega al mismo registro.

## Ejemplo: crear basic-v3

Desde `typescript-basic`, creá una plantilla independiente:

```powershell
New-Item -ItemType Directory -Path src/prompting/resources/prompts -Force
Copy-Item src/prompting/prompt.yaml src/prompting/resources/prompts/basic-v3.yaml
```

Editá la copia: cambiá `version: basic-v3` y probá una modificación concreta dentro de `system: |`. Por ejemplo, instrucciones más precisas para priorizar el problema principal de tickets con múltiples temas. Conservá `{{manual}}`, el contrato JSON, el tratamiento del ticket como dato no confiable y las restricciones de seguridad. No modifiques los recursos ya evaluados si querés comparar su versión histórica exacta.

Añadí esta entrada **dentro de la lista `prompts`** del registro:

```yaml
  - id: basic-v3
    label: basic-v3 · prioridad del problema principal
    system: resources/prompts/basic-v3.yaml
```

No hace falta modificar TypeScript, HTML, tests ni el script de build. La versión ya aparecerá en las opciones de soporte, evaluación, comparación y baseline después de reconstruir y reiniciar el servidor. El build copia los YAML de `src` preservando sus rutas: el registro compilado queda en `dist/prompting/prompt-registry.yaml` y la nueva plantilla en `dist/prompting/resources/prompts/basic-v3.yaml`. El paquete incluye esos recursos.

El ID del registro es la identidad pública. El campo `version` dentro de una plantilla identifica ese recurso: puede compartirse entre entradas, como hacen v1/v2 con `prompt.yaml`. Para experimentos independientes, preferí archivos separados. Cambiar el archivo compartido cambia todas las entradas que lo referencian.

### Ejemplos opcionales

Podés añadir `examples: resources/prompts/basic-v3-examples.yaml` a la entrada. Su archivo debe tener:

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

Se exige igualdad de proveedor/modelo, corpus, manual, seguridad, configuración, precios, SDK y contrato. El texto de generación y los ejemplos sí pueden variar: son las variables experimentales. Los hashes de cada bundle y del registro conservan la procedencia; un hash identifica contenido, no acredita su calidad ni vuelve determinista al proveedor.

Las revisiones humanas pendientes, regresiones de seguridad y demás gates siguen impidiendo recomendar un prompt. Registrar una versión o elegirla como default no demuestra que sea mejor. Usá desarrollo para elegir, reservá prueba para la evaluación final y mantené revisión supervisada mientras el manual siga siendo ficticio.
