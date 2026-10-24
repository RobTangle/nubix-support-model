"""Un Protocol permite sustituir infraestructura sin herencia obligatoria."""

from dataclasses import dataclass
from typing import Protocol, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class TokenUsage(BaseModel):
    """input y output incluyen los subtotales cacheados y de razonamiento."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    # Cada adaptador convierte las convenciones del SDK a estos totales comunes.
    input_tokens: int = Field(ge=0, strict=True)
    output_tokens: int = Field(ge=0, strict=True)
    # Son subtotales ya incluidos arriba: sumarlos otra vez duplicaría consumo y costo.
    cached_input_tokens: int = Field(default=0, ge=0, strict=True)
    cache_write_input_tokens: int = Field(default=0, ge=0, strict=True)
    reasoning_output_tokens: int = Field(default=0, ge=0, strict=True)

    @model_validator(mode="after")
    def check_subtotals(self) -> Self:
        """Un sobre válido también debe ser coherente entre campos, no sólo tener enteros."""
        if self.cached_input_tokens + self.cache_write_input_tokens > self.input_tokens:
            raise ValueError("Los subtotales de caché no pueden superar la entrada total.")
        if self.reasoning_output_tokens > self.output_tokens:
            raise ValueError("El razonamiento ya debe estar incluido en la salida total.")
        return self


@dataclass(frozen=True)
class LLMRequest:
    """Mensaje interno tipado; frozen evita reasignar campos, no congela objetos anidados."""

    system_prompt: str
    user_content: str
    # Es la clase, no una instancia: permite derivar su JSON Schema y validar después.
    response_model: type[BaseModel]
    max_output_tokens: int
    timeout_seconds: float


@dataclass(frozen=True)
class LLMResult:
    """Conservar texto y metadatos permite contabilizar incluso antes de un parsing fallido."""

    text: str
    # None significa consumo desconocido; no equivale a un contador de cero tokens.
    usage: TokenUsage | None
    model: str
    finish_reason: str
    refused: bool = False


class LLMProvider(Protocol):
    """Tipado estructural: el objeto cumple el contrato sin heredar de esta clase."""

    name: str
    model: str

    def complete(self, request: LLMRequest) -> LLMResult: ...
