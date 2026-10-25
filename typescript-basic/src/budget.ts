import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { parse } from 'yaml';
import { z } from 'zod';
import { AppError } from './errors.js';
import type { CompletionRequest, TokenUsage } from './provider-types.js';
import { readSharedResource } from './resources.js';

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

/** Dinero decimal, no number binario: permite sumar costos pequeños sin redondeos acumulados. */
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
  get committedUsd(): string {
    return this.known.plus(this.unknownUsd).toFixed();
  }

  check(amount: string): void {
    const value = new Decimal(amount);
    if (!value.isFinite() || value.isNegative()) throw new AppError('configuration_error');
    if (new Decimal(this.committedUsd).plus(value).gt(this.limit)) throw new AppError(this.code);
  }

  reserve(amount: string): string {
    this.check(amount);
    const id = randomUUID();
    this.reservations.set(id, new Decimal(amount));
    this.pending.add(id);
    return id;
  }

  settle(id: string, actualUsd: string | null): void {
    if (!this.pending.delete(id)) throw new AppError('internal_error');
    if (actualUsd !== null) {
      this.reservations.delete(id);
      this.known = this.known.plus(actualUsd);
    }
    // Si no sabemos consumo, la reserva permanece comprometida; no fingimos una llamada gratis.
  }
}

export class Price {
  constructor(private readonly rates: z.infer<typeof rateSchema>) {}

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

export class PriceCatalog {
  readonly version: string;
  readonly hash: string;
  private readonly data: z.infer<typeof catalogSchema>;

  constructor(readonly source: string) {
    try {
      this.data = catalogSchema.parse(parse(source));
    } catch {
      throw new AppError('configuration_error');
    }
    this.version = this.data.version;
    this.hash = createHash('sha256').update(source).digest('hex');
  }

  get(provider: string, model: string): Price {
    const rate = this.data.models[`${provider}:${model}`];
    if (!rate) throw new AppError('unknown_model');
    return new Price(rate);
  }
}

export async function loadPrices(): Promise<PriceCatalog> {
  try {
    return new PriceCatalog(await readSharedResource('prices.yaml'));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('configuration_error');
  }
}
