import asyncio
import json
import os
import subprocess
import sys
import textwrap
import time
from contextlib import contextmanager
from dataclasses import replace
from importlib import import_module
from unittest.mock import AsyncMock, Mock

import grpc
import httpx
import pytest
from openai import AsyncOpenAI
from openai.types.responses import Response as OpenAIResponse

from nubbix_support.contracts import SupportResponse
from nubbix_support.errors import ProviderError
from nubbix_support.providers.base import LLMRequest
from nubbix_support.providers.openai import OpenAIProvider
from nubbix_support.providers.xai import XAIProvider

# Las pruebas que usan el SDK real simulan un host configurado antes del import.
# Los órdenes inseguros se prueban en procesos independientes, sin parches de tracer.
os.environ["XAI_SDK_DISABLE_TRACING"] = "1"
XAIResponse = import_module("xai_sdk.chat").Response
chat_pb2 = import_module("xai_sdk.proto").chat_pb2
sample_pb2 = import_module("xai_sdk.proto").sample_pb2
usage_pb2 = import_module("xai_sdk.proto").usage_pb2
XAIChatClient = import_module("xai_sdk.sync.chat").Client


@pytest.fixture
def request_data():
    return LLMRequest("Instrucciones de prueba.", "Ticket sintético.", SupportResponse, 1024, 3.25)


def openai_body(*, status="completed", usage=True, refusal=False):
    content = (
        {"type": "refusal", "refusal": "No puedo responder."}
        if refusal
        else {"type": "output_text", "text": "{invalid json", "annotations": []}
    )
    return {
        "id": "resp_test",
        "object": "response",
        "created_at": 0,
        "model": "gpt-6-luna",
        "status": status,
        "output": [
            {
                "type": "message",
                "id": "msg_test",
                "role": "assistant",
                "status": "completed",
                "content": [content],
            }
        ],
        "parallel_tool_calls": False,
        "tool_choice": "none",
        "tools": [],
        "usage": {
            "input_tokens": 120,
            "output_tokens": 50,
            "total_tokens": 170,
            "input_tokens_details": {"cached_tokens": 20, "cache_write_tokens": 11},
            "output_tokens_details": {"reasoning_tokens": 15},
        }
        if usage
        else None,
        "incomplete_details": {"reason": "max_output_tokens"} if status == "incomplete" else None,
    }


@contextmanager
def openai_client(handler):
    client = AsyncOpenAI(
        api_key="offline-key",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    try:
        yield client
    finally:
        asyncio.run(client.close())


def test_openai_preserves_raw_output_usage_and_native_schema(request_data):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=openai_body())
    with openai_client(handler) as client:
        result = OpenAIProvider("gpt-6-luna", "unused", client=client).complete(request_data)
    body = json.loads(requests[0].content)
    assert body["text"]["format"]["type"] == "json_schema"
    assert body["text"]["format"]["strict"] is True
    assert body["store"] is False
    assert body["tools"] == []
    assert body["reasoning"]["effort"] == "none"
    assert body["max_output_tokens"] == 1024
    assert result.text == "{invalid json"
    assert result.usage.input_tokens == 120
    assert result.usage.output_tokens == 50
    assert result.usage.reasoning_output_tokens == 15
    assert result.usage.cached_input_tokens == 20
    assert result.usage.cache_write_input_tokens == 11
    assert result.finish_reason == "stop"


@pytest.mark.parametrize(
    "status,refusal,expected", [("incomplete", False, "length"), ("completed", True, "refusal")]
)
def test_openai_reports_truncation_and_refusal(request_data, status, refusal, expected):
    with openai_client(
        lambda _: httpx.Response(200, json=openai_body(status=status, refusal=refusal))
    ) as client:
        result = OpenAIProvider("gpt-6-luna", "unused", client=client).complete(request_data)
    assert result.finish_reason == expected
    assert result.refused is refusal


def test_openai_missing_usage_remains_unknown(request_data):
    with openai_client(lambda _: httpx.Response(200, json=openai_body(usage=False))) as client:
        result = OpenAIProvider("gpt-6-luna", "unused", client=client).complete(request_data)
    assert result.usage is None


@pytest.mark.parametrize(
    "status,code,retryable",
    [
        (401, "authentication", False),
        (403, "permission", False),
        (400, "invalid_request", False),
        (429, "rate_limit", True),
        (500, "provider_unavailable", True),
        (503, "provider_unavailable", True),
    ],
)
def test_openai_sanitizes_errors_without_sdk_retries(request_data, status, code, retryable):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(
            status, json={"error": {"message": "secret key and ticket contents", "type": "error"}}
        )
    with openai_client(handler) as client:
        with pytest.raises(ProviderError) as error:
            OpenAIProvider("gpt-6-luna", "unused", client=client).complete(request_data)
    assert len(calls) == 1
    assert error.value.code == code
    assert error.value.retryable is retryable
    assert "secret" not in str(error.value)
    assert error.value.__cause__ is None


def test_openai_uses_request_timeout_and_configured_key(monkeypatch, request_data):
    client = Mock()
    client.responses.create = AsyncMock(return_value=OpenAIResponse.model_validate(openai_body()))
    client.close = AsyncMock()
    factory = Mock(return_value=client)
    monkeypatch.setattr("nubbix_support.providers.openai.AsyncOpenAI", factory)
    provider = OpenAIProvider("gpt-6-luna", "only-openai-key")
    provider.complete(request_data)
    assert factory.call_args.kwargs["api_key"] == "only-openai-key"
    assert factory.call_args.kwargs["max_retries"] == 0
    assert client.responses.create.call_args.kwargs["timeout"] == 3.25
    provider.close()
    client.close.assert_awaited_once()


def test_openai_timeout_is_retryable_and_sanitized(request_data):
    def handler(request):
        raise httpx.ReadTimeout("sensitive request", request=request)
    with openai_client(handler) as client:
        with pytest.raises(ProviderError) as error:
            OpenAIProvider("gpt-6-luna", "unused", client=client).complete(request_data)
    assert error.value.code == "timeout"
    assert error.value.retryable is True


def xai_response(*, reason=sample_pb2.REASON_STOP, usage=True):
    response = chat_pb2.GetChatCompletionResponse(
        model="grok-4.20-0309-non-reasoning",
        outputs=[
            chat_pb2.CompletionOutput(
                finish_reason=reason,
                index=0,
                message=chat_pb2.CompletionMessage(role=chat_pb2.ROLE_ASSISTANT, content="{raw"),
            )
        ],
    )
    if usage:
        response.usage.CopyFrom(
            usage_pb2.SamplingUsage(
                prompt_tokens=120,
                completion_tokens=50,
                reasoning_tokens=15,
                cached_prompt_text_tokens=20,
                total_tokens=185,
            )
        )
    return XAIResponse(response, 0)


def test_xai_preserves_raw_output_and_sums_separate_reasoning(request_data):
    client = Mock()
    client.chat.create.return_value.sample.return_value = xai_response()
    result = XAIProvider("grok-4.20-0309-non-reasoning", "unused", client=client).complete(
        request_data
    )
    kwargs = client.chat.create.call_args.kwargs
    assert kwargs["response_format"] is SupportResponse
    assert kwargs["store_messages"] is False
    assert kwargs["tools"] == []
    assert kwargs["max_tokens"] == 1024
    assert len(kwargs["messages"]) == 2
    assert result.text == "{raw"
    assert result.usage.input_tokens == 120
    assert result.usage.output_tokens == 65
    assert result.usage.reasoning_output_tokens == 15
    assert result.usage.cached_input_tokens == 20
    assert result.finish_reason == "stop"


@pytest.mark.parametrize(
    "reason,expected",
    [
        (sample_pb2.REASON_MAX_LEN, "length"),
        (sample_pb2.REASON_MAX_CONTEXT, "length"),
        (sample_pb2.REASON_TIME_LIMIT, "incomplete"),
        (sample_pb2.REASON_INVALID, "incomplete"),
        (sample_pb2.REASON_TOOL_CALLS, "tool_calls"),
    ],
)
def test_xai_maps_finish_reason(request_data, reason, expected):
    client = Mock()
    client.chat.create.return_value.sample.return_value = xai_response(reason=reason)
    result = XAIProvider("grok", "unused", client=client).complete(request_data)
    assert result.finish_reason == expected


def test_xai_absent_proto_usage_remains_unknown(request_data):
    client = Mock()
    client.chat.create.return_value.sample.return_value = xai_response(usage=False)
    result = XAIProvider("grok", "unused", client=client).complete(request_data)
    assert result.usage is None


def test_xai_creates_deadline_bound_client_disables_retries_and_closes(monkeypatch, request_data):
    client = Mock()
    client.chat.create.return_value.sample.return_value = xai_response()
    factory = Mock(return_value=client)
    monkeypatch.setattr("xai_sdk.Client", factory)
    XAIProvider("grok", "only-xai-key").complete(request_data)
    kwargs = factory.call_args.kwargs
    assert kwargs["api_key"] == "only-xai-key"
    assert kwargs["timeout"] == 3.25
    assert ("grpc.enable_retries", 0) in kwargs["channel_options"]
    assert ("grpc.service_config", "{}") in kwargs["channel_options"]
    client.close.assert_called_once()


class GRPCFailure(grpc.RpcError):
    def __init__(self, code):
        self._code = code

    def code(self):
        return self._code

    def details(self):
        return "sensitive credentials and ticket"


@pytest.mark.parametrize(
    "status,code,retryable",
    [
        (grpc.StatusCode.UNAUTHENTICATED, "authentication", False),
        (grpc.StatusCode.PERMISSION_DENIED, "permission", False),
        (grpc.StatusCode.INVALID_ARGUMENT, "invalid_request", False),
        (grpc.StatusCode.RESOURCE_EXHAUSTED, "rate_limit", True),
        (grpc.StatusCode.UNAVAILABLE, "provider_unavailable", True),
        (grpc.StatusCode.DEADLINE_EXCEEDED, "timeout", True),
    ],
)
def test_xai_sanitizes_grpc_errors(request_data, status, code, retryable):
    client = Mock()
    client.chat.create.return_value.sample.side_effect = GRPCFailure(status)
    with pytest.raises(ProviderError) as error:
        XAIProvider("grok", "unused", client=client).complete(request_data)
    assert error.value.code == code
    assert error.value.retryable is retryable
    assert "sensitive" not in str(error.value)
    assert error.value.__cause__ is None


def test_xai_forces_sensitive_telemetry_off(monkeypatch):
    monkeypatch.setenv("XAI_SDK_DISABLE_SENSITIVE_TELEMETRY_ATTRIBUTES", "0")
    XAIProvider("grok", "unused", client=Mock())
    from xai_sdk.telemetry import should_disable_sensitive_attributes
    assert should_disable_sensitive_attributes() is True


def test_openai_malformed_envelope_is_sanitized(request_data):
    with openai_client(
        lambda _: httpx.Response(200, json={"malformed": "secret ticket"})
    ) as client:
        with pytest.raises(ProviderError) as error:
            OpenAIProvider("gpt-6-luna", "unused", client=client).complete(request_data)
    assert error.value.code == "invalid_response"
    assert error.value.retryable is True
    assert "secret" not in str(error.value)


def test_openai_failed_response_keeps_known_usage(request_data):
    body = openai_body(status="failed")
    body["error"] = {"code": "server_error", "message": "sensitive ticket"}
    with openai_client(lambda _: httpx.Response(200, json=body)) as client:
        with pytest.raises(ProviderError) as error:
            OpenAIProvider("gpt-6-luna", "unused", client=client).complete(request_data)
    assert error.value.code == "provider_failed"
    assert error.value.usage.output_tokens == 50
    assert "sensitive" not in str(error.value)


def test_xai_real_sdk_serializes_schema_without_network(request_data):
    channel = Mock()
    rpc = channel.unary_unary.return_value
    rpc.return_value = xai_response().proto
    client = Mock()
    client.chat = XAIChatClient(channel)
    result = XAIProvider("grok", "unused", client=client).complete(request_data)
    sent = rpc.call_args.args[0]
    schema = json.loads(sent.response_format.schema)
    assert schema["additionalProperties"] is False
    assert schema["properties"]["confidence"]["minimum"] == 0
    assert schema["properties"]["confidence"]["maximum"] == 1
    assert sent.store_messages is False
    assert len(sent.tools) == 0
    assert result.text == "{raw"


def test_openai_invalid_json_envelope_is_sanitized(request_data):
    with openai_client(
        lambda _: httpx.Response(
            200, content="not JSON", headers={"content-type": "application/json"}
        )
    ) as client:
        with pytest.raises(ProviderError) as error:
            OpenAIProvider("gpt-6-luna", "unused", client=client).complete(request_data)
    assert error.value.code == "invalid_response"
    assert error.value.retryable is True


def test_xai_invalid_usage_is_sanitized(request_data):
    response = xai_response()
    response.proto.usage.prompt_tokens = -1
    client = Mock()
    client.chat.create.return_value.sample.return_value = response
    with pytest.raises(ProviderError) as error:
        XAIProvider("grok", "unused", client=client).complete(request_data)
    assert error.value.code == "invalid_response"
    assert error.value.retryable is True


class SlowResponseStream(httpx.AsyncByteStream):
    def __init__(self, payload):
        self.parts = [payload[index : index + 10] for index in range(0, len(payload), 10)]
        self.delivered = 0
        self.cancelled = False
        self.closed = False

    async def __aiter__(self):
        try:
            for part in self.parts:
                await asyncio.sleep(0.02)
                self.delivered += 1
                yield part
        except asyncio.CancelledError:
            self.cancelled = True
            raise

    async def aclose(self):
        self.closed = True


def test_openai_wall_clock_deadline_cancels_drip_feed(request_data):
    stream = SlowResponseStream(json.dumps(openai_body()).encode())
    client = AsyncOpenAI(
        api_key="offline-key",
        max_retries=0,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200, stream=stream, headers={"content-type": "application/json"}
                )
            )
        ),
    )
    provider = OpenAIProvider("gpt-6-luna", "unused", client=client)
    started = time.monotonic()
    try:
        with pytest.raises(ProviderError) as error:
            provider.complete(replace(request_data, timeout_seconds=0.05))
        assert error.value.code == "timeout"
        assert error.value.retryable is True
        assert error.value.usage is None
        assert time.monotonic() - started < 0.8
        assert stream.cancelled is True
        assert stream.closed is True
        delivered = stream.delivered
        time.sleep(0.1)
        assert stream.delivered == delivered < len(stream.parts)
    finally:
        asyncio.run(client.close())


def test_openai_uses_fresh_client_for_each_event_loop(monkeypatch, request_data):
    clients = [Mock(), Mock()]
    for client in clients:
        client.responses.create = AsyncMock(
            return_value=OpenAIResponse.model_validate(openai_body())
        )
        client.close = AsyncMock()
    factory = Mock(side_effect=clients)
    monkeypatch.setattr("nubbix_support.providers.openai.AsyncOpenAI", factory)
    provider = OpenAIProvider("gpt-6-luna", "offline-key")
    provider.complete(request_data)
    provider.complete(request_data)
    assert factory.call_count == 2
    for client in clients:
        client.responses.create.assert_awaited_once()
        client.close.assert_awaited_once()


def test_openai_sync_interface_rejects_active_event_loop_without_starting_request(
    monkeypatch, request_data
):
    factory = Mock()
    monkeypatch.setattr("nubbix_support.providers.openai.AsyncOpenAI", factory)
    provider = OpenAIProvider("gpt-6-luna", "offline-key")
    async def call_in_async_server():
        with pytest.raises(ProviderError) as error:
            provider.complete(request_data)
        assert error.value.code == "async_context"
        assert error.value.retryable is False
    asyncio.run(call_in_async_server())
    factory.assert_not_called()


@pytest.mark.parametrize(
    "preload_sdk,disable_before_import", [(False, False), (True, False), (True, True)]
)
def test_xai_error_events_cannot_export_ticket_contents(preload_sdk, disable_before_import):
    """Aislar imports permite probar hosts con SDK nuevo, seguro o ya instrumentado."""
    script = textwrap.dedent(
        f"""
        import json
        import os
        from unittest.mock import Mock
        import grpc
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
        os.environ.pop("XAI_SDK_DISABLE_TRACING", None)
        os.environ.pop("XAI_SDK_DISABLE_SENSITIVE_TELEMETRY_ATTRIBUTES", None)
        if {disable_before_import!r}:
            os.environ["XAI_SDK_DISABLE_TRACING"] = "1"
        exporter = InMemorySpanExporter()
        tracer_provider = TracerProvider()
        tracer_provider.add_span_processor(SimpleSpanProcessor(exporter))
        trace.set_tracer_provider(tracer_provider)
        if {preload_sdk!r}:
            import xai_sdk
        from nubbix_support.contracts import SupportResponse
        from nubbix_support.errors import SupportError
        from nubbix_support.providers.base import LLMRequest
        from nubbix_support.providers.xai import XAIProvider
        class OfflineRPCError(grpc.RpcError):
            def code(self):
                return grpc.StatusCode.UNAVAILABLE
            def details(self):
                return "PRIVATE_TICKET_SENTINEL"
        rpc = Mock(side_effect=OfflineRPCError("PRIVATE_TICKET_SENTINEL"))
        channel = Mock()
        channel.unary_unary.return_value = rpc
        client = Mock()
        public_code = None
        try:
            adapter = XAIProvider("grok-4.20-0309-non-reasoning", "offline-key", client=client)
            from xai_sdk.sync.chat import Client as ChatClient
            client.chat = ChatClient(channel)
            adapter.complete(LLMRequest(
                "Instrucciones sintéticas", "PRIVATE_TICKET_SENTINEL", SupportResponse, 256, 1.0
            ))
        except SupportError as exc:
            public_code = exc.code
        with tracer_provider.get_tracer("host").start_as_current_span("host-exporter-proof"):
            pass
        spans = exporter.get_finished_spans()
        assert any(span.name == "host-exporter-proof" for span in spans)
        exported = json.dumps([span.to_json() for span in spans])
        assert "PRIVATE_TICKET_SENTINEL" not in exported
        if {preload_sdk and not disable_before_import!r}:
            assert public_code == "unsafe_sdk_telemetry", public_code
            assert rpc.call_count == 0
        else:
            assert public_code == "provider_unavailable", public_code
            assert rpc.call_count == 1
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=30, check=False
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_importing_cli_does_not_initialize_xai_sdk():
    """Mostrar ayuda o elegir OpenAI no debe cargar ni configurar otro SDK."""
    script = textwrap.dedent(
        """
        import os
        import sys
        os.environ.pop("XAI_SDK_DISABLE_TRACING", None)
        import nubbix_support.cli
        assert "xai_sdk" not in sys.modules
        assert "XAI_SDK_DISABLE_TRACING" not in os.environ
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=30, check=False
    )
    assert result.returncode == 0, result.stdout + result.stderr
