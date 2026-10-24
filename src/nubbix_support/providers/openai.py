"""Adaptación de Responses API: conservar texto y usage antes del parsing local."""

import asyncio
from json import JSONDecodeError
from typing import cast

from openai import (
    APIConnectionError,
    APIResponseValidationError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
)
from openai.types.responses import Response, ResponseTextConfigParam
from pydantic import ValidationError

from nubbix_support.errors import ProviderError
from nubbix_support.providers.base import LLMRequest, LLMResult, TokenUsage


def _usage(response: Response) -> TokenUsage | None:
    if response.usage is None:
        return None
    usage = response.usage
    return TokenUsage(
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        cached_input_tokens=usage.input_tokens_details.cached_tokens,
        cache_write_input_tokens=usage.input_tokens_details.cache_write_tokens,
        reasoning_output_tokens=usage.output_tokens_details.reasoning_tokens,
    )


class OpenAIProvider:
    """Interfaz síncrona con I/O cancelable y un cliente async por intento.

    Desde un servidor async, ejecutar complete en un worker thread (o endpoint
    síncrono); no se debe anidar asyncio.run dentro de un event loop existente.
    """

    name = "openai"

    def __init__(self, model: str, api_key: str, client: AsyncOpenAI | None = None) -> None:
        self.model = model
        self._api_key = api_key
        # Inyección para pruebas sin conexiones; producción crea un cliente por intento.
        self._client = client

    def complete(self, request: LLMRequest) -> LLMResult:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise ProviderError("async_context")
        text_format = cast(
            ResponseTextConfigParam,
            {
                "format": {
                    "type": "json_schema",
                    "name": request.response_model.__name__,
                    "schema": request.response_model.model_json_schema(),
                    "strict": True,
                }
            },
        )
        try:
            response = asyncio.run(self._create_response(request, text_format))
        except (TimeoutError, APITimeoutError):
            raise ProviderError("timeout", retryable=True) from None
        except APIConnectionError:
            raise ProviderError("connection", retryable=True) from None
        except APIStatusError as exc:
            code = {401: "authentication", 403: "permission", 429: "rate_limit"}.get(
                exc.status_code,
                "provider_unavailable" if exc.status_code >= 500 else "invalid_request",
            )
            raise ProviderError(
                code, retryable=exc.status_code == 429 or exc.status_code >= 500
            ) from None
        except (APIResponseValidationError, JSONDecodeError):
            raise ProviderError("invalid_response", retryable=True) from None
        # El SDK construye objetos sin validar todos sus campos por defecto.
        # Validar el sobre evita que una respuesta HTTP200 corrupta filtre un traceback.
        if not isinstance(response, Response):
            raise ProviderError("invalid_response", retryable=True)
        try:
            response = Response.model_validate(response.model_dump())
            usage = _usage(response)
        except ValidationError:
            raise ProviderError("invalid_response", retryable=True) from None
        if response.status == "failed" or response.error is not None:
            raise ProviderError("provider_failed", usage=usage)
        refused = any(
            content.type == "refusal"
            for item in response.output
            if item.type == "message"
            for content in item.content
        )
        incomplete_reason = (
            response.incomplete_details.reason if response.incomplete_details else None
        )
        refused = refused or incomplete_reason == "content_filter"
        finish_reason = "stop" if response.status == "completed" else "incomplete"
        if incomplete_reason == "max_output_tokens":
            finish_reason = "length"
        if refused:
            finish_reason = "refusal"
        return LLMResult(response.output_text, usage, response.model, finish_reason, refused)

    async def _create_response(
        self, request: LLMRequest, text_format: ResponseTextConfigParam
    ) -> Response:
        # HTTPX limita cada operación por separado. asyncio.timeout limita el
        # tiempo total y cancela el I/O aunque lleguen fragmentos continuamente.
        async with asyncio.timeout(request.timeout_seconds):
            client = self._client or AsyncOpenAI(api_key=self._api_key, max_retries=0)
            try:
                return await client.responses.create(
                    model=self.model,
                    instructions=request.system_prompt,
                    input=[{"role": "user", "content": request.user_content}],
                    text=text_format,
                    max_output_tokens=request.max_output_tokens,
                    reasoning={"effort": "none"},
                    timeout=request.timeout_seconds,
                    store=False,
                    tools=[],
                )
            finally:
                # No reutilizar conexiones ligadas al loop que asyncio.run cierra.
                if self._client is None:
                    await client.close()

    def close(self) -> None:
        """Los clientes de producción ya se cierran dentro de cada llamada."""
        if self._client is not None:
            asyncio.run(self._client.close())
