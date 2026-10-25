/**
 * Control monetario local: PriceCatalog obtiene tarifas, Price estima/calcula una llamada y
 * Budget limita el dinero comprometido. Mantenerlo separado de los SDK permite aplicar el mismo
 * presupuesto a cualquier proveedor y compartir un límite entre varias corridas de evaluación.
 * Son controles y cálculos de la aplicación; la factura definitiva pertenece al proveedor.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { parse } from 'yaml';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { CompletionRequest, TokenUsage } from '../llm/provider-types.js';
import { readSharedResource } from '../resources/read-shared.js';

const decimalText = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((text) => new Decimal(text).isFinite());
const rateSchema = z.strictObject({
  input_per_million: decimalText,
  output_per_million: decimalText,
  cached_input_per_million: decimalText.optional(),
  cache_write_input_per_million: decimalText.optional(),
});
const catalogSchema = z.strictObject({
  version: z.string(),
  checked_on: z.string(),
  currency: z.literal('USD'),
  sources: z.array(z.string()),
  models: z.record(z.string(), rateSchema),
});

/**
 * Libro de presupuesto: reserva una estimación antes de llamar y la concilia con consumo conocido.
 * Una llamada de costo desconocido conserva su reserva para evitar asumir que fue gratis.
 * Usa dinero decimal para no acumular redondeos binarios al sumar importes pequeños.
 */
export class Budget {
  private known = new Decimal(0);
  private readonly reservations = new Map<string, Decimal>();
  private readonly pending = new Set<string>();
  private readonly limit: Decimal;

  constructor(
    limitUsd: string,
    private readonly code: 'budget_exceeded' | 'eval_budget_exceeded' = 'budget_exceeded',
  ) {
    if (!/^\d+(\.\d+)?$/.test(limitUsd) || !new Decimal(limitUsd).isPositive())
      throw new AppError('configuration_error');
    this.limit = new Decimal(limitUsd);
  }

  get knownUsd(): string {
    return this.known.toFixed();
  }
  get unknownUsd(): string {
    return Decimal.sum(0, ...this.reservations.values()).toFixed();
  }
  /** Comprometido = costo conocido + reservas pendientes/desconocidas; es lo que limita el gasto. */
  get committedUsd(): string {
    return this.known.plus(this.unknownUsd).toFixed();
  }

  /** Comprueba un importe adicional sin reservarlo; check('0') revisa el total ya comprometido. */
  check(amount: string): void {
    const value = new Decimal(amount);
    if (!value.isFinite() || value.isNegative()) throw new AppError('configuration_error');
    if (new Decimal(this.committedUsd).plus(value).gt(this.limit)) throw new AppError(this.code);
  }

  /** Compromete una estimación y devuelve el ID que settle usará para cerrar ese intento. */
  reserve(amount: string): string {
    this.check(amount);
    const id = randomUUID();
    this.reservations.set(id, new Decimal(amount));
    this.pending.add(id);
    return id;
  }

  /** Cierra una reserva una sola vez: sustituye por costo conocido o mantiene el monto si falta uso. */
  settle(id: string, actualUsd: string | null): void {
    if (!this.pending.delete(id)) throw new AppError('internal_error');
    if (actualUsd !== null) {
      this.reservations.delete(id);
      this.known = this.known.plus(actualUsd);
    }
    // Si no sabemos consumo, la reserva permanece comprometida; no fingimos una llamada gratis.
  }
}

/** Aplica las tarifas de un modelo; mantiene separado el cálculo del seguimiento del presupuesto. */
export class Price {
  constructor(private readonly rates: z.infer<typeof rateSchema>) {}

  /** Calcula USD a partir del uso reportado; complete indica si también conoce el desglose de caché. */
  cost(usage: TokenUsage): { usd: string; complete: boolean } {
    const cached = usage.cachedInputTokens;
    const written = usage.cacheWriteInputTokens;
    const complete = cached !== null && written !== null;
    const input = new Decimal(this.rates.input_per_million);
    const write = new Decimal(
      this.rates.cache_write_input_per_million ?? this.rates.input_per_million,
    );
    const read = new Decimal(this.rates.cached_input_per_million ?? this.rates.input_per_million);
    const cost = complete
      ? input
          .mul(usage.inputTokens - cached - written)
          .plus(read.mul(cached))
          .plus(write.mul(written))
      : Decimal.max(input, write, read).mul(usage.inputTokens);
    return {
      usd: cost
        .plus(new Decimal(this.rates.output_per_million).mul(usage.outputTokens))
        .div(1_000_000)
        .toFixed(),
      complete,
    };
  }

  /** Estimación previa para reservar presupuesto; no necesita llamar al proveedor para calcularla. */
  estimate(request: Omit<CompletionRequest, 'signal'>): string {
    // Bytes UTF-8 + margen: cota local conservadora, no un tokenizer ni garantía de factura.
    const inputTokens = Buffer.byteLength(JSON.stringify(request), 'utf8') + 1024;
    const inputRate = Decimal.max(
      this.rates.input_per_million,
      this.rates.cache_write_input_per_million ?? this.rates.input_per_million,
      this.rates.cached_input_per_million ?? this.rates.input_per_million,
    );
    return inputRate
      .mul(inputTokens)
      .plus(new Decimal(this.rates.output_per_million).mul(request.maxOutputTokens))
      .div(1_000_000)
      .toFixed();
  }
}

/** Instantánea validada del YAML de tarifas, consultada por combinación de proveedor y modelo. */
export class PriceCatalog {
  readonly version: string;
  /** Huella del YAML exacto; detecta cambios de tarifas o formato aunque version no se actualice. */
  readonly hash: string;
  private readonly data: z.infer<typeof catalogSchema>;

  constructor(readonly source: string) {
    try {
      this.data = catalogSchema.parse(parse(source));
    } catch {
      throw new AppError('configuration_error');
    }
    this.version = this.data.version;
    // Identifica la instantánea usada para calcular costos; no verifica su vigencia con el proveedor.
    // source se conserva para que el reporte pueda archivar el mismo contenido que produjo este hash.
    this.hash = createHash('sha256').update(source).digest('hex');
  }

  /** Falla si falta una tarifa: evita iniciar llamadas cuyo costo local no sabemos presupuestar. */
  get(provider: string, model: string): Price {
    const rate = this.data.models[`${provider}:${model}`];
    if (!rate) throw new AppError('unknown_model');
    return new Price(rate);
  }
}

/** Lee el catálogo distribuido con la app; no consulta ni actualiza tarifas automáticamente por red. */
export async function loadPrices(): Promise<PriceCatalog> {
  try {
    return new PriceCatalog(await readSharedResource('prices.yaml'));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('configuration_error');
  }
}
