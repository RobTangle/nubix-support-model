# Registro de implementación

- Diseño y ejecución autorizados por el usuario. Claves se configuran después.
- Decisión: xAI reemplaza Anthropic; modelo API documentado grok-4.20-0309-non-reasoning corresponde a la familia solicitada, sin sustituirla por una más nueva.
- Entorno: Python 3.12.14 del runtime de Codex; aliases Windows py/python no ejecutables; uv instalado dentro de .tools.
- Carpeta inicialmente vacía y sin Git; trabajar aquí sin worktree ni commits artificiales.
- Interfaces comunes se definen primero; adaptadores y dataset podrán desarrollarse independientemente.
- Contratos, servicio, SDK oficiales OpenAI/xAI, moderación, presupuestos, CLI, prompts y evals implementados. Dataset verificado:80tickets+10ataques+10controles.
- RTK pytest dio resumen incorrecto 'No tests collected'; ejecución directa confirmó15tests iniciales. Verificación posterior usa pytest directo, sin hooks instalados.
- Pruebas CLI expusieron directorio temporal inaccesible en sandbox; ejecución local usa --basetemp=.pytest_cache/tmp. CI utiliza temporales normales del runner.
- Revisión independiente sol-code-reviewer detectó timeout HTTP por operación insuficiente; adaptador corregido a AsyncOpenAI+asyncio.timeout, con test offline de fragmentos lentos que verifica cancelación/cierre.35tests proveedores pasan.
- Sockets internos de asyncio Windows están restringidos en sandbox; pruebas finales requieren permisos ampliados, con transportes simulados y sin llamadas a proveedores.
- Regresiones adicionales reproducidas y corregidas: entrada con espacios demasiado larga y JSONcp1252. Punto de entrada UTF-8 y validación antes de strip.
- Prompts de reparación y ablación también son YAML; hashes de reportes representan el prompt usado y una simulación nunca habilita un piloto.
- Verificación final de software:95tests offline pasan (7.23s), cobertura90%; Ruffcheck y mypy21archivos sin errores; uv.lock consistente. No se ejecutaron modelos reales.
- Wheel instalado en entorno aislado fuera del repositorio: CLI y recursos cargan correctamente. Distribuciones reconstruidas con la corrección de deadline, entrada UTF-8 y todos los recursos YAML.
- La revisión independiente tuvo un único finding importante (deadline HTTP), corregido y cubierto por regresión. Sin findings importantes pendientes.
- Pendiente por decisión del usuario: configurar claves, ejecutar evals reales, completar rúbricas humanas y seleccionar prompt por proveedor/modelo. El manual continúa siendo ficticio.

## Revisión del 24 de octubre

- El usuario inicializó Git y pidió conservar documentación/comentarios en español para colaborar con compañeros de LATAM.
- Se agregaron explicaciones pedagógicas sin modificar los docstrings de modelos Pydantic que participan del JSON Schema.
- Revisión independiente de runtime y revisión de contratos, presupuesto y evals: correcciones documentadas en review-2026-10-24.md.
- Verificación actual:111tests offline pasan; cobertura92%; Ruff y mypy21módulos limpios. No se ejecutaron modelos reales.
- El usuario configuró su identidad Git; se verificó su disponibilidad para crear commits por responsabilidad.
