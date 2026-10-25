"""Elegir un proveedor y su clave sin repetir la integración de los SDK."""

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from nubbix_support.errors import SupportError
from nubbix_support.providers.openai import OpenAIProvider
from nubbix_support.providers.xai import XAIProvider


class ProviderSettings(BaseSettings):
    """Ambas versiones comparten variables de claves/modelos; la básica ignora cuotas."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
        str_strip_whitespace=True,
    )
    # SecretStr oculta el valor al mostrar el objeto; no cifra el secreto en memoria.
    openai_api_key: SecretStr | None = Field(default=None, validation_alias="OPENAI_API_KEY")
    xai_api_key: SecretStr | None = Field(default=None, validation_alias="XAI_API_KEY")
    openai_model: str = Field(
        default="gpt-6-luna", validation_alias="NUBBIX_OPENAI_MODEL", min_length=1
    )
    xai_model: str = Field(
        default="grok-4.20-0309-non-reasoning", validation_alias="NUBBIX_XAI_MODEL", min_length=1
    )


def create_provider(name: str, settings: ProviderSettings) -> OpenAIProvider | XAIProvider:
    """Compartimos adaptadores, no SupportService: la lógica didáctica es independiente.
    Los adaptadores ya resuelven timeouts, formato nativo y sanitización de errores.
    Sólo se exige la credencial del proveedor que se va a utilizar.
    """
    if name not in {"openai", "xai"}:
        raise SupportError("invalid_provider", "Elegí openai o xai.")
    key = settings.openai_api_key if name == "openai" else settings.xai_api_key
    if key is None or not key.get_secret_value().strip():
        raise SupportError(
            "missing_key", "Configurá la clave del proveedor elegido en .env o el entorno."
        )
    if name == "openai":
        return OpenAIProvider(settings.openai_model, key.get_secret_value())
    return XAIProvider(settings.xai_model, key.get_secret_value())
