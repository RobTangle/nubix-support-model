# Flujo de soporte simplificado

Esta alternativa está en `service.ts`, al lado de este documento. No reemplaza
`support/service.ts` ni cambia la CLI, el lab o las evaluaciones actuales.

El punto de entrada es `SimpleSupportAssistant.process`. No necesita `runSession`,
`StructuredExecutor`, observadores ni un contexto de ejecución compartido entre métodos.
Reutiliza los contratos Zod, los prompts ensamblados y los adaptadores existentes para
concentrar el ejemplo en la coordinación del ticket.

## Seguir un ticket

Para `{ text: "Me cobraron dos veces este mes" }`:

1. `ticketSchema.safeParse(input)` valida el objeto externo: texto no vacío,
   hasta 8000 puntos Unicode antes de trim y sin propiedades adicionales.
2. Crea una señal con plazo total de 60 segundos. La señal del llamador, si existe,
   puede cancelar este ticket sin afectar otros.
3. `call` hace una **request al LLM de moderación de entrada**. Envía
   `inputModeration` como instrucciones y el ticket como JSON en el contenido de usuario.
   El esquema exige únicamente `{ decision: "allow" | "review" | "block" }`.
4. Sólo `allow` continúa. `review`, `block` o un rechazo explícito devuelven
   `safeResponse()`: una derivación estática, sin copiar texto inseguro.
5. `call` hace una **request al LLM de generación** con `system`, que ya contiene
   el contexto/manual y los ejemplos de la versión elegida. El ticket sigue separado.
   El esquema ahora exige `{ answer, confidence, category, actions }`.
6. Si la confianza es menor que 0.70, agrega revisión humana conservando como máximo
   cinco acciones. La aplicación no ejecuta ninguna de esas acciones.
7. `call` hace una **request al LLM de moderación de salida** con `outputModeration`
   y la propuesta final completa, incluidas las acciones. Exige el esquema de decisión.
8. Si obtiene `allow`, devuelve la propuesta; en caso contrario, la derivación estática.

Normalmente son tres requests. Un reintento puede aumentar esa cantidad hasta seis.
El moderador aporta una señal de seguridad; no garantiza que el contenido sea correcto.

## Qué hace el método privado `call`

`call<T>` recibe un `z.ZodType<T>`. El genérico conecta el esquema con el tipo devuelto:
cuando recibe `supportResponseSchema`, TypeScript sabe que devuelve una propuesta o null;
cuando recibe `safetyAssessmentSchema`, una decisión o null.

`z.toJSONSchema(schema)` comunica el formato al proveedor. Después, `JSON.parse`
interpreta su texto y `schema.safeParse` comprueba los valores en ejecución. Es necesario
porque los tipos de TypeScript desaparecen al compilar y ciertas reglas locales de Zod
no se expresan en JSON Schema.

Permite dos intentos totales por etapa: formato inválido y fallos transitorios comparten
ese límite. Sólo agrega las instrucciones de reparación ante JSON/esquema inválido;
nunca inserta la salida rechazada como instrucciones. Los errores permanentes no se
reintentan. Cada llamada tiene hasta 15 segundos, dentro del plazo total del ticket.
Los adaptadores existentes desactivan los reintentos internos del SDK.

Un rechazo de seguridad lleva a derivación. Una moderación técnicamente fallida lanza
un error sanitizado y no publica la propuesta. La cancelación requiere que el proveedor
respete la señal; los adaptadores actuales la propagan a sus SDK.

## Cómo usarla desde otro código

```typescript
import { SimpleSupportAssistant } from './support/simple/service.js';
import { loadPrompts } from './prompting/prompts.js';

// provider es una instancia de un adaptador existente que implementa LLMProvider.
const assistant = new SimpleSupportAssistant({
  provider,
  prompts: await loadPrompts('basic-v1'),
});
const response = await assistant.process({ text: 'Me cobraron dos veces este mes' });
```

El ejemplo es un fragmento para integrar en tu código, no un comando nuevo.
También se puede inyectar un proveedor falso, como hacen los tests, sin consumir API.
No hay dependencia de CLI o HTTP: cualquiera de esos bordes puede llamar `process`.

## Comparación con la completa

| Responsabilidad                   | Alternativa simple     | Implementación completa                   |
| --------------------------------- | ---------------------- | ----------------------------------------- |
| Secuencia del ticket              | `process` en una clase | `SupportAssistant.process` y `runSession` |
| Requests, validación y reintentos | Método privado `call`  | `StructuredExecutor`                      |
| Contratos y prompts               | Reutilizados           | Mismos recursos                           |
| Moderación de entrada/salida      | Sí                     | Sí                                        |
| Estado del ticket                 | Variables locales      | Contexto, traza y presupuesto por corrida |
| Cancelación y plazos              | Sí, límites fijos      | Sí, configurables                         |
| Telemetría e inspección en vivo   | No                     | Sí                                        |
| Tokens, costos y límite de gasto  | No se contabilizan     | Reservas y conciliación                   |
| Reportes/evals/lab                | No integrada           | Integrados                                |

Tener la coordinación y la mecánica de llamadas en una clase reduce la indirección y
facilita aprender. Si se agregan costos, eventos y reportes aquí, volvería a crecer: la
separación actual de la completa responde a esas necesidades reales. Esta alternativa
no es un reemplazo con todas las garantías operativas de la completa. Las llamadas
reales siguen consumiendo tokens aunque no exista registro ni presupuesto local.

Hay duplicación intencional de las reglas del flujo para poder compararlas sin alterar
el código actual. Si cambian esas reglas, habrá que revisar ambas implementaciones.

Las pruebas están en `tests/simple-service.test.ts`. Se ejecutan sin claves ni red:

```powershell
node --import tsx --test tests/simple-service.test.ts
```
