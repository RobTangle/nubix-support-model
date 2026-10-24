# Nubbix Support Implementation Plan

> **For agentic workers:** Implementar por responsabilidades independientes; leer interfaces compartidas y no modificar archivos ajenos.

**Goal:** Entregar la CLI de soporte, seguridad y evals aprobadas.

**Architecture:** Servicio con dependencias explícitas y adaptadores oficiales OpenAI/xAI. Recursos versionados y pruebas offline.

**Tech Stack:** Python 3.12, uv, Pydantic, Typer, SDK OpenAI y xAI, pytest, Ruff, mypy.

**Spec:** ../specs/2026-10-23-nubbix-design.md

## Global Constraints

- Sin llamadas pagas ni credenciales durante implementación.
- No líneas vacías dentro de funciones; una después de imports. Comentarios en español sobre decisiones relevantes.
- Fuente de verdad ficticia identificada; salida pública exacta con cuatro propiedades.
- OpenAI y xAI independientes; nunca fallback oculto.

## Review Focus

- Timeout o fallo de red sin usage: conservar reserva y no reportar consumo cero.
- Contenido inseguro en actions y no solo answer: verificar ambos.
- Error de moderación: no publicar la propuesta.
- Evals parciales o sin revisión humana: no promover un prompt.
- Paquete instalado desde otro directorio: encontrar recursos sin depender del cwd.

## Tareas

1. Contratos/configuración: pruebas de límites, precios y validación; luego implementación.
2. Adaptadores: tests con transporte simulado de ambos SDK; normalizar usage, errores y rechazo.
3. Servicio: tests del pipeline, presupuestos y retries; implementar con reloj y espera inyectables.
4. Evals/recursos: dataset y prompts; pruebas de métricas, denominadores y selección conservadora.
5. CLI/documentación: pruebas stdout/stderr, stdin, errores; CI, wheel y smoke fuera del proyecto.

Cada tarea sigue RED→GREEN. Verificación final: pytest, ruff check, mypy, uv build y smoke del wheel. Revisar el proyecto con un reviewer independiente antes de entregar. No crear commits automáticamente: la carpeta inicial no es un repositorio Git.
