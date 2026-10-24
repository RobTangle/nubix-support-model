"""Errores de aplicación con códigos seguros para logs y CLI."""

from nubbix_support.providers.base import TokenUsage


class SupportError(Exception):
    """Separar código estable para consumidores y mensaje seguro para una persona."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        # El servicio adjunta sólo metadatos de la ejecución, sin tickets ni respuestas.
        self.trace: dict[str, object] | None = None


class ProviderError(SupportError):
    """No almacenar el mensaje original: puede contener contenido o credenciales."""

    def __init__(
        self, code: str, *, retryable: bool = False, usage: TokenUsage | None = None
    ) -> None:
        super().__init__(code, "El proveedor no pudo completar la solicitud.")
        # El adaptador clasifica el fallo; el servicio aplica el límite global de reintentos.
        self.retryable = retryable
        # Un error no implica consumo cero: el proveedor puede informar tokens aun si falló.
        self.usage = usage
