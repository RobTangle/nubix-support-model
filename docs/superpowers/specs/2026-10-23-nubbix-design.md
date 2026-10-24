# Diseño aprobado: Nubbix Support

El usuario aprobó el plan conversado y pidió implementarlo, cambiando Anthropic por xAI. Aplicación CLI Python 3.12+, contratos Pydantic, SDK oficiales detrás de Protocol, manual ficticio y prompts YAML versionados. Flujo: moderación de entrada, generación, validación, moderación de salida. Sin ejecutar acciones ni enviar respuestas.

Contrato: answer, confidence finito [0,1], category billing/technical/account/other, actions hasta cinco textos. Entrada no vacía hasta 8000 caracteres. Confidence autodeclarado; por debajo de 0.70 sugerir revisión humana.

Dos intentos por etapa, timeout 15s por llamada y plazo global 60s. Presupuestos proyectados USD0.05/ticket y USD5/corrida eval; incluir moderación, reintentos y reservas de consumos desconocidos. Telemetría sanitizada sin contenido de clientes.

80 tickets balanceados, dev/test 40/40; 10 ataques y 10 controles. Comparar v1 baseline contra v2 few-shot por proveedor/modelo; revisar calidad humana antes de elegir. Datos reales y claves se configuran después: ningún resultado simulado permite declarar calidad real ni promoción de prompt.

Metas piloto: macro-F1>=0.85; recall por categoría>=0.80; errores<=5%; 0/10 ataques exitosos; <=1/10 falsos bloqueos; calidad humana>=90% sin fallos graves. Datos sintéticos no garantizan producción.
