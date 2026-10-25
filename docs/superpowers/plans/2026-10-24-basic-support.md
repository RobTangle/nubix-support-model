# Versión didáctica de Nubbix Support — Implementation Plan

> **For agentic workers:** implementar en esta sesión con superpowers:executing-plans; no crear commits ni realizar llamadas reales.

**Goal:** agregar otro paquete que permita aprender clasificación y respuesta estructurada sin la complejidad operativa de la versión completa.

**Architecture:** el usuario eligió un paquete adicional dentro del mismo proyecto. Cuatro clases pequeñas (Ticket, SupportResponse, ProviderSettings y SupportAssistant), prompt YAML propio y CLI argparse; el flujo usa directamente el proveedor y no delega en SupportService. Se comparten los adaptadores oficiales y sus mensajes de transporte para conservar timeouts, sanitización y privacidad ya probados.

**Tech Stack:** Python 3.12, Pydantic, pydantic-settings, PyYAML y argparse; dependencias existentes.

**Spec:** alcance didáctico aprobado en la conversación: clasificar y responder, comentarios en español, comparación con la versión completa y ningún commit.

## Global Constraints

- No modificar la lógica de la versión completa ni leer/imprimir credenciales.
- Una llamada por ticket; sin reintentos, moderación independiente, cuotas monetarias ni evals reales.
- Mantener el JSON público con answer, confidence, category y actions; no ejecutar acciones.
- Usar src/nubbix_support_basic y un comando nubbix-support-basic.
- No líneas vacías dentro de funciones; mantener comentarios/docstrings en español.

## Review Focus

- Entrada inválida rechazada antes de construir un proveedor o llamar a una API.
- Respuestas inválidas, truncadas o rechazadas nunca se presentan como éxito.
- El proveedor seleccionado usa únicamente su clave y los errores no imprimen secretos.
- El prompt básico es propio y se instala dentro del wheel, sin depender del cwd.
- La documentación distingue una demo didáctica de una app validada para clientes.

## Tareas

- [x] Escribir y ejecutar pruebas de contratos, flujo simple, errores, configuración y CLI (RED).
- [x] Implementar models.py, providers.py, service.py, cli.py, __main__.py y prompt.yaml (GREEN).
- [x] Agregar entrypoint y segundo paquete al wheel/mypy; verificar recursos en CI.
- [x] Documentar recorrido de lectura, alcance y tabla de diferencias en español.
- [x] Ejecutar suite completa, lint, tipos, build y smoke externo; revisión independiente de cambios.

## Evidencia

- 139 tests offline pasan, incluidos 28 básicos; cobertura del paquete básico:95%.
- Ruff limpio; mypy sin errores en 27 módulos; lockfile consistente y sin dependencias nuevas.
- Wheel construido e instalado fuera del repositorio; se verificaron prompt, flujo simulado y comando básico.
- Revisión independiente sin findings P1/P2; la calidad real del prompt permanece pendiente.
- No se hicieron llamadas a proveedores ni commits; el paquete completo conserva su implementación.
