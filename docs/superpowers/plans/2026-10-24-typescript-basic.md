# TypeScript didáctico — Implementation Plan

> **For agentic workers:** implementar por responsabilidades independientes con pruebas primero. No realizar commits ni llamadas reales a proveedores.

**Goal:** agregar una CLI TypeScript con Zod como puente de aprendizaje hacia la básica Python, manteniendo un núcleo reutilizable desde HTTP.

**Architecture:** paquete npm privado en typescript-basic, ESM y Node24. Esquemas Zod e inferencia de tipos; servicio asíncrono sin I/O de terminal ni estado mutable por ticket; adaptadores SDK oficiales y configuración en el arranque. CLI como adaptador, Express se agrega en otra etapa.

**Tech Stack:** TypeScript, Zod4, SDK OpenAI y SDK oficial xAI, YAML, node:test y tsx.

## Global Constraints

- Mantener las versiones Python y el historial Git intactos. No commits ni API calls.
- JSON público answer/confidence/category/actions, mismo prompt básico y mismas categorías.
- Una llamada por ticket, sin reintentos, moderación adicional ni cuota monetaria.
- 8.000 caracteres de entrada, 1.024 tokens de salida y deadline15s con AbortSignal.
- Comentarios y guía en español, incluyendo z.infer/parse/safeParse/strictObject/refine y tipos borrados.
- El servicio no lee process.env, no usa process.exit y admite señales por llamada; el cliente y prompt pueden reutilizarse en HTTP.

## Review Focus

- Validación real de entrada/salida; no confiar en interfaces ni en un cast.
- Cancelación del cuerpo HTTP sin Promise.race que deje trabajo de red vivo.
- SDKs sin retries ni tools/store, errores sanitizados, sin otra credencial implícita.
- Solicitudes concurrentes aisladas y cancelación de una sin afectar las demás.
- Assets disponibles desde dist y pruebas comparativas Python/TS con fixtures compartidos.

## Tareas

- [x] Fixtures de contrato compartidas y pruebas RED de esquemas/servicio/config/CLI.
- [x] Implementar núcleo y adaptadores oficiales con transportes simulados.
- [x] Empaquetar CLI y prompt, documentar equivalencias Zod/Pydantic y preparación HTTP.
- [x] Ejecutar checks TS/Python, configurar CI, build/smoke externo y revisión independiente.

## Evidencia local

- `npm test`: 41 pruebas sin llamadas reales, con build previo y CLI desde otro directorio.
- `npm run check`: TypeScript estricto para fuentes y tests, sin errores.
- `npm pack --dry-run`: incluye JS, declaraciones y prompt YAML.
- `python -m pytest -q`: 154 pruebas Python; Ruff y mypy sin errores.
- Revisión independiente read-only: sin hallazgos accionables.
- Workflow agregado para Node24 en Linux/Windows; su ejecución remota queda a cargo de CI.
- Sin commits, llamadas reales ni resultados de calidad LLM atribuidos a mocks.
