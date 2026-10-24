"""Adaptador al SDK gRPC oficial: deadlines y retries deben ser explícitos."""

import os
from typing import TYPE_CHECKING, Any

import grpc
from opentelemetry.trace import NoOpTracer
from pydantic import ValidationError

from nubbix_support.errors import ProviderError, SupportError
from nubbix_support.providers.base import LLMRequest, LLMResult, TokenUsage

if TYPE_CHECKING:
    from xai_sdk.chat import Response

_FINISH_REASONS = {
    "REASON_STOP": "stop",
    "REASON_MAX_LEN": "length",
    "REASON_MAX_CONTEXT": "length",
    "REASON_TIME_LIMIT": "incomplete",
    "REASON_TOOL_CALLS": "tool_calls",
}
_ERROR_CODES = {
    grpc.StatusCode.UNAUTHENTICATED: "authentication",
    grpc.StatusCode.PERMISSION_DENIED: "permission",
    grpc.StatusCode.INVALID_ARGUMENT: "invalid_request",
    grpc.StatusCode.RESOURCE_EXHAUSTED: "rate_limit",
    grpc.StatusCode.DEADLINE_EXCEEDED: "timeout",
    grpc.StatusCode.UNAVAILABLE: "provider_unavailable",
    grpc.StatusCode.INTERNAL: "provider_unavailable",
}
_RETRYABLE_CODES = {
    grpc.StatusCode.RESOURCE_EXHAUSTED,
    grpc.StatusCode.DEADLINE_EXCEEDED,
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.INTERNAL,
}


def _ensure_safe_sdk_tracing() -> None:
    """Desactivar trazas antes del import: sanitizar después del RPC llega tarde.
    El SDK liga un tracer al cargar su módulo y registra también las excepciones.
    Sus flags son globales al proceso; no se restauran ni se modifican por petición.
    Si otra biblioteca ya cargó un tracer inseguro, rechazar la configuración evita
    parchear un objeto global que podría estar usándose en otro hilo.
    """
    os.environ["XAI_SDK_DISABLE_TRACING"] = "1"
    os.environ["XAI_SDK_DISABLE_SENSITIVE_TELEMETRY_ATTRIBUTES"] = "1"
    from xai_sdk.sync import chat
    if not isinstance(getattr(chat, "tracer", None), NoOpTracer):
        raise SupportError(
            "unsafe_sdk_telemetry",
            "El SDK de xAI ya se importó con trazas potencialmente activas. "
            "Establecé XAI_SDK_DISABLE_TRACING=1 antes de importar xai_sdk "
            "y reiniciá el proceso antes de enviar tickets.",
        )


def _usage(response: "Response") -> TokenUsage | None:
    """Normalizar contadores sin convertir un mensaje protobuf ausente en costo cero."""
    # Los protobuf devuelven ceros aun cuando falta el mensaje: HasField evita
    # confundir un consumo desconocido con una llamada gratuita.
    if not response.proto.HasField("usage"):
        return None
    usage = response.usage
    # gRPC publica completion (texto) y reasoning como contadores separados.
    # La abstracción incluye ambos en output para presupuestar todo el decode.
    return TokenUsage(
        input_tokens=usage.prompt_tokens,
        output_tokens=usage.completion_tokens + usage.reasoning_tokens,
        cached_input_tokens=usage.cached_prompt_text_tokens,
        reasoning_output_tokens=usage.reasoning_tokens,
    )


class XAIProvider:
    """Adaptar xAI sin inicializar su SDK cuando se elige otro proveedor.

    Por privacidad, este adaptador desactiva las trazas automáticas de xAI en todo
    el proceso antes de cargarlo. En aplicaciones que importen xai_sdk por su cuenta,
    XAI_SDK_DISABLE_TRACING=1 debe configurarse antes de ese primer import. Nuestra
    telemetría de metadatos sigue funcionando sin exportar tickets ni excepciones SDK.
    """

    name = "xai"

    def __init__(self, model: str, api_key: str, client: Any = None) -> None:
        """Validar la instrumentación antes de aceptar contenido de un cliente."""
        _ensure_safe_sdk_tracing()
        self.model = model
        self._api_key = api_key
        self._client = client

    def complete(self, request: LLMRequest) -> LLMResult:
        """Ejecutar un intento sin almacenamiento remoto ni reintentos ocultos."""
        from xai_sdk import Client
        from xai_sdk.chat import system, user
        # sample() no expone timeout en este SDK. Un cliente por intento aplica
        # el plazo restante sin modificar interceptores privados ni estado global.
        client = self._client or Client(
            api_key=self._api_key,
            timeout=request.timeout_seconds,
            channel_options=[("grpc.enable_retries", 0), ("grpc.service_config", "{}")],
        )
        try:
            chat = client.chat.create(
                model=self.model,
                messages=[system(request.system_prompt), user(request.user_content)],
                response_format=request.response_model,
                max_tokens=request.max_output_tokens,
                store_messages=False,
                tools=[],
            )
            response = chat.sample()
            return LLMResult(
                text=response.content,
                usage=_usage(response),
                model=response.proto.model,
                finish_reason=_FINISH_REASONS.get(response.finish_reason, "incomplete"),
            )
        except grpc.RpcError as exc:
            status = exc.code()
            raise ProviderError(
                _ERROR_CODES.get(status, "provider_failed"),
                retryable=status in _RETRYABLE_CODES,
            ) from None
        except ValidationError:
            raise ProviderError("invalid_response", retryable=True) from None
        finally:
            if self._client is None:
                client.close()

    def close(self) -> None:
        """Cerrar sólo el cliente inyectado; los clientes propios se cierran por intento."""
        if self._client is not None:
            self._client.close()
