"""Contabilidad local: reservar antes, conciliar después y no ocultar incertidumbre."""

import json
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from importlib.resources import files
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

from nubbix_support.errors import SupportError
from nubbix_support.providers.base import LLMRequest, TokenUsage


class ModelPrice(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    input_per_million: Decimal = Field(gt=0, allow_inf_nan=False)
    output_per_million: Decimal = Field(gt=0, allow_inf_nan=False)
    cached_input_per_million: Decimal = Field(ge=0, allow_inf_nan=False)
    cache_write_input_per_million: Decimal | None = Field(default=None, ge=0, allow_inf_nan=False)

    def cost(self, usage: TokenUsage) -> Decimal:
        """Aplica cada tarifa una sola vez: los tokens de razonamiento ya integran output."""
        cached = usage.cached_input_tokens
        writes = usage.cache_write_input_tokens
        uncached = usage.input_tokens - cached - writes
        # None significa sin tarifa específica; cero es una tarifa gratuita válida.
        write_rate = self.cache_write_input_per_million
        if write_rate is None:
            write_rate = self.input_per_million
        return (
            uncached * self.input_per_million
            + cached * self.cached_input_per_million
            + writes * write_rate
            + usage.output_tokens * self.output_per_million
        ) / Decimal(1_000_000)


class PriceCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    version: str
    checked_on: date
    currency: Literal["USD"]
    sources: list[str]
    models: dict[str, ModelPrice]

    def get(self, provider: str, model: str) -> ModelPrice:
        price = self.models.get(f"{provider}:{model}")
        if price is None:
            raise SupportError(
                "unknown_price", "Falta una tarifa verificada para el modelo elegido."
            )
        return price


def load_prices(path: Path | None = None) -> PriceCatalog:
    source = (
        path.read_text(encoding="utf-8")
        if path
        else files("nubbix_support.resources").joinpath("prices.yaml").read_text(encoding="utf-8")
    )
    return PriceCatalog.model_validate(yaml.safe_load(source))


def estimate_request_cost(request: LLMRequest, price: ModelPrice) -> Decimal:
    """Margen local conservador: no garantiza la tokenización ni la factura remota."""
    input_bound = (
        len((request.system_prompt + request.user_content).encode("utf-8"))
        + len(json.dumps(request.response_model.model_json_schema()).encode("utf-8"))
        + 4096
    )
    # Un catálogo propio puede tener tarifas distintas; reservar con la mayor evita subestimar.
    input_rate = max(
        price.input_per_million,
        price.cached_input_per_million,
        price.cache_write_input_per_million or Decimal(0),
    )
    return (
        input_bound * input_rate + request.max_output_tokens * price.output_per_million
    ) / Decimal(1_000_000)


@dataclass
class Reservation:
    amount: Decimal
    settled: bool = False


class Budget:
    """Contador secuencial por ticket o corrida; no es un límite de facturación remoto."""

    def __init__(self, limit_usd: Decimal, *, scope: str = "ticket") -> None:
        if not limit_usd.is_finite() or limit_usd <= 0:
            raise ValueError("El presupuesto debe ser finito y mayor que cero.")
        self.limit_usd = limit_usd
        self.scope = scope
        self.known_usd = Decimal(0)
        self.unknown_usd = Decimal(0)

    @property
    def spent_usd(self) -> Decimal:
        return self.known_usd + self.unknown_usd

    def check(self, amount: Decimal) -> None:
        if not amount.is_finite() or amount < 0:
            raise ValueError("Importe inválido.")
        if self.spent_usd + amount > self.limit_usd:
            code = "eval_budget_exceeded" if self.scope == "eval" else "budget_exceeded"
            raise SupportError(code, "Se alcanzó el presupuesto local estimado.")

    def reserve(self, amount: Decimal) -> Reservation:
        """Compromete gasto antes de la red para evitar reintentos sin presupuesto."""
        self.check(amount)
        self.unknown_usd += amount
        return Reservation(amount)

    def settle(self, reservation: Reservation, actual: Decimal | None) -> None:
        """Libera el sobrante sólo si hubo uso conocido; un timeout no implica costo cero."""
        if reservation.settled:
            raise ValueError("La reserva ya fue conciliada.")
        if actual is not None and (not actual.is_finite() or actual < 0):
            raise ValueError("Costo inválido.")
        reservation.settled = True
        if actual is not None:
            self.unknown_usd -= reservation.amount
            self.known_usd += actual
