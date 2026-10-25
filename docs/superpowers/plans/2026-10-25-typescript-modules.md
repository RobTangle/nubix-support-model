# Reorganizar TypeScript por responsabilidades

**Objetivo:** aplicar la estructura aprobada por el usuario preservando contratos, comandos, historial y comportamiento. Refactor mecánico, sin nuevas funciones de producto ni APIs reales.

## Mapa de movimientos

- `service.ts`, `service-run.ts`, `schemas.ts` → `support/` con sus mismos nombres.
- Implementación `cli.ts` → `support/cli.ts`; `cli.ts` raíz queda como entrada pequeña compatible.
- `providers.ts`, `provider-types.ts`, `execution.ts` → `llm/`.
- `prompt-contracts.ts`, `prompt-registry.ts`, `prompts.ts`, `prompt-registry.yaml`, `prompt.yaml` → `prompting/`.
- `resources/context.yaml`, `resources/safety.yaml`, `resources/basic-v2.yaml` → `prompting/resources/`; rutas declaradas del registro permanecen válidas.
- `budget.ts` → `costs/budget.ts`.
- `config.ts` → `config/environment.ts`; `runtime-settings.ts` → `config/runtime-settings.ts`.
- `telemetry.ts`, `event-sink.ts` → `observability/`.
- Implementación `eval-cli.ts` → `evals/cli.ts`; entrada raíz mantiene comando y tratamiento de errores.
- `resources.ts` → `resources/read-shared.ts`; recursos compartidos compilados siguen en `dist/resources/shared`.
- Mantener `errors.ts` e `index.ts` raíz; mantener carpetas `evals`, `inspection`, `lab`, `observability`, `run-reports`, `web`.

## Invariantes y riesgos

- `dist/cli.js`, `dist/eval-cli.js`, `dist/web/server.js`, exports npm y comandos actuales compatibles.
- Recalcular imports estáticos/dinámicos por identidad del archivo, conservando extensión `.js`; sin barrel files nuevos ni alias que dependan del runtime.
- `.env` raíz se resuelve desde `config/environment.ts`, también compilado. Tarifas/datasets fuente y dist deben funcionar desde otro cwd sin Python.
- Conservar contenido exacto del prompt local modificado por el usuario. Su movimiento se commitea con contenido HEAD anterior; los cambios del usuario quedan sin stage en el nuevo destino.
- Build limpio y acotado a `typescript-basic/dist` para no esconder imports incorrectos con artefactos viejos. No borrar SQLite, reports, .vscode, entornos ni archivos Python.
- Tests siguen en su organización actual; actualizar imports y fixtures que simulan paquete instalado. Agregar chequeos de paquete que detecten archivos viejos y resolución de recursos.
- Documentación vigente actualizada; planes históricos conservan rutas originales como registro de decisiones anteriores.

## Verificación

- [x] Prueba de artefactos movidos/ausentes y comandos públicos; constatar RED sobre build anterior.
- [x] Mover fuentes y recursos, ajustar imports/rutas, entradas compatibles y limpieza segura del build.
- [x] Tipos y suite TypeScript completa offline; paquete instalado desde cwd distinto, CLI/evals/HTTP/registro nuevo.
- [x] Suite Python existente, formato, documentación y diagramas; revisión independiente del diff.
- [x] Reiniciar lab sólo sin trabajos activos; commits lógicos y push autorizados, excluyendo cambios locales del usuario.

## Evidencia

- Verificados 22 movimientos de archivos y actualización de imports estáticos, dinámicos y URLs relativas a módulos.
- La prueba de artefactos nuevos falló sobre dist anterior; pasa tras build limpio. No quedan módulos raíz viejos que puedan ocultar errores.
- Suite TS completa, tipos y formato pasan. Suite Python: 154 pruebas pasan. Paquete instalado en cwd temporal: CLI, YAML, SDK, evals, HTTP, SQLite, historial y versión adicional desde registro pasan.
- Prueba aislada de .env confirma la raíz compartida y precedencia del entorno; prueba de junction/symlink confirma que clean.mjs no borra archivos externos.
- Revisión independiente sin findings; cinco diagramas Mermaid válidos.
- Se comprobó que no había corridas activas antes de detener el servidor; lab reiniciado en 3087 y verificado mediante GET de configuración, assets e historial. Sin llamadas reales a modelos para la verificación.
- Los bytes del prompt local se conservaron al moverlo; la edición previa del usuario queda en src/prompting/prompt.yaml sin stage. .vscode, bases, reportes y Python permanecen fuera de los commits del refactor.
