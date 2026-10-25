"""El núcleo didáctico: preparar contexto, llamar una vez y validar el resultado."""

import json
from importlib.resources import files

import yaml
from pydantic import ValidationError

from nubbix_support.errors import SupportError
from nubbix_support.providers.base import LLMProvider, LLMRequest
from nubbix_support_basic.models import SupportResponse, Ticket


def load_prompt() -> str:
    """Buscar el YAML en el paquete instalado evita depender de dónde se abre la terminal."""
    text = files("nubbix_support_basic").joinpath("prompt.yaml").read_text(encoding="utf-8")
    data = yaml.safe_load(text)
    system = data.get("system") if isinstance(data, dict) else None
    if not isinstance(system, str) or not system.strip() or data.get("version") != "basic-v1":
        raise SupportError("invalid_prompt", "El prompt básico no tiene la estructura esperada.")
    return system


class SupportAssistant:
    """El proveedor se recibe como dependencia: los tests pueden reemplazar la red."""

    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider

    def respond(self, ticket: Ticket) -> SupportResponse:
        """Clasificar y redactar en la misma llamada, sin moderación ni reintentos extra."""
        request = LLMRequest(
            system_prompt=load_prompt(),
            # El texto se envía como dato de usuario, separado de las instrucciones del sistema.
            user_content=json.dumps({"ticket": ticket.text}, ensure_ascii=False),
            response_model=SupportResponse,
            max_output_tokens=1024,
            timeout_seconds=15,
        )
        result = self.provider.complete(request)
        if result.refused:
            raise SupportError(
                "model_refusal", "El modelo rechazó la consulta; requiere revisión humana."
            )
        if result.finish_reason != "stop":
            raise SupportError("incomplete_output", "El modelo no terminó una respuesta completa.")
        try:
            # Structured Outputs ayuda, pero el contrato local sigue siendo la autoridad.
            return SupportResponse.model_validate_json(result.text)
        except ValidationError:
            # No mostrar el error original: podría incluir fragmentos privados de la respuesta.
            raise SupportError(
                "invalid_output", "La respuesta del modelo no respeta el contrato."
            ) from None
