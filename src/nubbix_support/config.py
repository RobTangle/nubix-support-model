"""Configuración validada al iniciar, independiente del proveedor activo."""

from decimal import Decimal
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # BaseSettings valida al iniciar; el entorno prevalece sobre .env y luego los defaults.
    # Aquí se toleran claves extra porque .env puede contener opciones de otras herramientas.
    model_config = SettingsConfigDict(
        env_prefix="NUBBIX_", env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )
    # SecretStr enmascara repr/serialización: no cifra la clave ni evita su extracción explícita.
    # Los aliases respetan los nombres habituales de los SDK, fuera del prefijo NUBBIX_.
    openai_api_key: SecretStr | None = Field(default=None, validation_alias="OPENAI_API_KEY")
    xai_api_key: SecretStr | None = Field(default=None, validation_alias="XAI_API_KEY")
    openai_model: str = "gpt-6-luna"
    xai_model: str = "grok-4.20-0309-non-reasoning"
    # Decimal expresa dinero decimal sin introducir las aproximaciones binarias de float.
    ticket_budget_usd: Decimal = Field(default=Decimal("0.05"), gt=0, allow_inf_nan=False)
    eval_budget_usd: Decimal = Field(default=Decimal("5"), gt=0, allow_inf_nan=False)
    timeout_seconds: float = Field(default=15, gt=0, le=15, allow_inf_nan=False)
    deadline_seconds: float = Field(default=60, gt=0, le=60, allow_inf_nan=False)
    generation_max_tokens: int = Field(default=1024, ge=128, le=4096)
    moderation_max_tokens: int = Field(default=256, ge=32, le=1024)
    prices_file: Path | None = None
