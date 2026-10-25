# Registro único de prompts

**Objetivo:** agregar versiones mediante YAML sin editar allowlists distribuidas; CLI, HTTP/UI y evals consumen el mismo registro. La petición del usuario aprueba implementar este enfoque ya propuesto.

**Diseño:** `src/prompt-registry.yaml` declara version del registro, default, baseline, context, safety y prompts `{id,label,system,examples?}`. Paths YAML locales relativos al registro, sin rutas absolutas, URLs ni segmentos `..`. `PromptRegistry.load(url?)` valida y precarga todo antes de consumir API. `registry.versions` expone `{id,label}[]`, `defaultVersion`, `baselineVersion`, `has(id)`, `get(id?,evaluation?)` entrega PromptBundle. `loadPrompts` conserva API y delega al registro. Los bundles registran hashes efectivos y del registro. Template system/examples admiten versiones de recurso distintas del ID público para compartir archivos. `basic-v1`/`basic-v2` conservan sus recursos actuales; no modificar el prompt local del usuario.

**Contratos:** `src/prompt-contracts.ts` browser-safe exporta `promptVersionSchema` (ID `[a-z][a-z0-9-]{0,63}`), tipo PromptVersion y `promptMetadataSchema` `{id,label}`. Validar forma no demuestra pertenencia: fronteras de ejecución consultan registry.has. Lectura offline de reportes acepta IDs retirados del registro para preservar historia.

**Evaluación:** Runner recibe `registry?:PromptRegistry`, carga el predeterminado si falta; RunOptions incorpora `baselinePromptVersion?:string`. Provenance agrega campo opcional `baselinePromptVersion` (compatibilidad reportes viejos). compareReports acepta 2+ versiones y baseline explícito opcional; usa baseline en provenance si existe, o menor ID lexicográfico para reportes antiguos. Rechaza ausencia/conflicto de baseline; desempata por baseline y luego ID estable. Hash de ejemplos deja de ser condición de igualdad (es variable experimental), manteniendo manual/moderación/esquemas/modelo/config constantes. `compare --prompt-versions id1 --prompt-versions id2 --baseline-prompt id1`; sin selección compara todo registro con su baseline.

**Lab/UI:** WebConfiguration conserva promptVersions:string[] y agrega opcional prompts:{id,label}[],defaultPromptVersion,baselinePromptVersion. Server siempre los emite desde registro. LabEvaluationService recibe registry explícito; input admite promptVersions? y baselinePromptVersion? para compare; los persiste resueltos y valida pertenencia antes de crear el job. Registros antiguos sin campos usan sus reportes/IDs almacenados al leer, nunca disparan llamadas. UI genera todos los selectores desde config; compare permite seleccionar 2+ variantes y baseline. No elegir ganador con fake ni omitir revisión humana.

**Alcance:** conservar interfaz pública de soporte, seguridad y presupuestos; sin nuevas dependencias ni llamadas reales; recursos copiados por build y paquete portátil. Comentarios español, sin líneas vacías dentro de funciones. No editar `.vscode` ni incluir cambios previos de prompt.yaml en commits.

## Tareas

- [x] Tests RED de registro con versión adicional, defaults, paths inválidos, recursos faltantes/duplicados y hashes; implementar cargador y copia de recursos.
- [x] Generalizar runner, reportes, comparación, CLI eval y lab; pruebas de versión nueva, baseline y compatibilidad offline.
- [x] Generalizar contratos HTTP/UI y formularios de evaluación; pruebas de selector dinámico e IDs no registrados rechazados.
- [x] Integrar CLI de soporte/server, documentación de cómo agregar basic-v3, empaquetado, suite offline y revisión.

## Evidencia y decisiones finales

- Tipos, formato, suite TypeScript completa y 154 pruebas Python pasan, con dobles de proveedores y sin llamadas reales iniciadas por la verificación.
- Paquete instalado fuera del repositorio: registro y tercer prompt agregados sólo en fixture YAML, eval adversarial y soporte HTTP para esa versión pasan. La CLI también descubre un default nuevo en instalación temporal.
- Registro rechaza paths fuera del árbol, recursos faltantes, duplicados y escapes por junction/symlink. get devuelve copias; las huellas cambian al editar recursos.
- Comparar reportes individuales debe seguir funcionando: provenance.baselinePromptVersion sólo se agrega a comparaciones de varias versiones, no a runs individuales. Los reportes comparativos conservan la referencia elegida.
- La prueba que exigía igualdad literal con el prompt Python se cambió por igualdad con la plantilla TypeScript local renderizada: el usuario ya había editado prompt.yaml antes de este turno. Ese archivo se preservó y se excluye de los commits del cambio.
- Revisión independiente sin findings accionables; se agregó la cobertura de symlink aconsejada.
- Servidor LIVE reiniciado en 3087 luego de comprobar que no había corridas activas; SQLite conservado. QA navegador verifica selector múltiple, etiquetas y baseline sin iniciar evaluación. Cinco diagramas Mermaid válidos.
- La consulta posterior sobre ordenar el repositorio se respondió con una propuesta; no se mezcló un movimiento masivo de carpetas con esta funcionalidad.

## Ownership

- Raíz: prompt-contracts.ts, prompts.ts, prompt-registry.ts/yaml, CLI soporte, server, scripts, tests del registro, documentación.
- Worker eval: eval-cli.ts, evals/**, lab/evaluations.ts y tests relacionados.
- Worker UI: web/contracts.ts, web/app.ts, web/client/**, web/public/** y tests de web/UI.
- Los workers no modifican archivos ajenos, no hacen commits ni llamadas reales.
