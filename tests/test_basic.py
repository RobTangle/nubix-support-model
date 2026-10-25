import json
import sys

import pytest
from pydantic import ValidationError

from nubbix_support.errors import ProviderError, SupportError
from nubbix_support.providers.base import LLMResult
from nubbix_support_basic.cli import main
from nubbix_support_basic.models import SupportResponse, Ticket
from nubbix_support_basic.providers import ProviderSettings, create_provider
from nubbix_support_basic.service import SupportAssistant, load_prompt

ANSWER = {
    "answer": "Soporte puede verificar los cargos.",
    "confidence": 0.85,
    "category": "billing",
    "actions": ["Solicitar fecha y referencia del cargo."],
}


class FakeProvider:
    """Un resultado fijo prueba el flujo; no demuestra que un LLM clasifique correctamente."""

    def __init__(self, result=None):
        self.result = result or LLMResult(json.dumps(ANSWER), None, "test-model", "stop")
        self.requests = []
        self.closed = False

    def complete(self, request):
        self.requests.append(request)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    def close(self):
        self.closed = True


@pytest.mark.parametrize(
    "text",
    ["", "   ", "x" * 8001, "hola" + " " * 8000],
    ids=["empty", "whitespace", "long", "raw_long"],
)
def test_basic_rejects_invalid_ticket(text):
    with pytest.raises(ValidationError):
        Ticket(text=text)


@pytest.mark.parametrize(
    "change",
    [
        {"confidence": True},
        {"confidence": float("nan")},
        {"confidence": 1.1},
        {"category": "sales"},
        {"answer": " "},
        {"actions": [""]},
        {"actions": ["x"] * 6},
        {"actions": ["x" * 4001]},
        {"unexpected": "value"},
    ],
)
def test_basic_validates_public_response(change):
    with pytest.raises(ValidationError):
        SupportResponse.model_validate(ANSWER | change)


def test_basic_processes_one_call_without_using_full_service():
    provider = FakeProvider()
    result = SupportAssistant(provider).respond(Ticket(text="  Me cobraron dos veces  "))
    assert result.model_dump() == ANSWER
    assert len(provider.requests) == 1
    request = provider.requests[0]
    assert json.loads(request.user_content) == {"ticket": "Me cobraron dos veces"}
    assert "MANUAL FICTICIO" in request.system_prompt
    assert request.response_model is SupportResponse
    assert request.timeout_seconds == 15
    assert request.max_output_tokens == 1024


@pytest.mark.parametrize(
    "text,finish,refused,code",
    [
        ("invalid", "stop", False, "invalid_output"),
        (json.dumps(ANSWER), "length", False, "incomplete_output"),
        (json.dumps(ANSWER), "stop", True, "model_refusal"),
    ],
)
def test_basic_never_publishes_invalid_or_refused_output(text, finish, refused, code):
    provider = FakeProvider(LLMResult(text, None, "test-model", finish, refused))
    with pytest.raises(SupportError) as error:
        SupportAssistant(provider).respond(Ticket(text="Consulta de soporte"))
    assert error.value.code == code
    assert len(provider.requests) == 1


def test_basic_does_not_retry_provider_errors():
    provider = FakeProvider(ProviderError("timeout", retryable=True))
    with pytest.raises(ProviderError):
        SupportAssistant(provider).respond(Ticket(text="Consulta"))
    assert len(provider.requests) == 1


def test_basic_loads_its_own_prompt_from_another_directory(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    assert "MANUAL FICTICIO" in load_prompt()
    assert "contraseñas" in load_prompt()


@pytest.mark.parametrize("name", ["openai", "xai"])
def test_basic_requires_only_selected_provider_key(monkeypatch, name):
    settings = ProviderSettings(_env_file=None, openai_api_key=None, xai_api_key=None)
    with pytest.raises(SupportError) as error:
        create_provider(name, settings)
    assert error.value.code == "missing_key"


def test_basic_cli_stdout_is_only_the_public_contract(monkeypatch, capsys):
    provider = FakeProvider()
    monkeypatch.setattr("nubbix_support_basic.cli.create_provider", lambda *args: provider)
    monkeypatch.setattr(sys, "argv", ["nubbix-support-basic", "--text", "TICKET_PRIVATE_SENTINEL"])
    main()
    captured = capsys.readouterr()
    assert json.loads(captured.out) == ANSWER
    assert captured.err == ""
    assert provider.closed


def test_basic_cli_validates_ticket_before_creating_a_provider(monkeypatch, capsys):
    def unexpected_provider(*args):
        raise AssertionError("El proveedor no debe construirse para una entrada inválida.")
    monkeypatch.setattr("nubbix_support_basic.cli.create_provider", unexpected_provider)
    monkeypatch.setattr(sys, "argv", ["nubbix-support-basic", "--text", "  "])
    with pytest.raises(SystemExit) as error:
        main()
    captured = capsys.readouterr()
    assert error.value.code == 2
    assert captured.out == ""
    assert json.loads(captured.err)["error"]["code"] == "validation_error"


def test_basic_cli_sanitizes_invalid_provider_output(monkeypatch, capsys):
    provider = FakeProvider(LLMResult("PRIVATE_OUTPUT_SENTINEL", None, "test-model", "stop"))
    monkeypatch.setattr("nubbix_support_basic.cli.create_provider", lambda *args: provider)
    monkeypatch.setattr(sys, "argv", ["nubbix-support-basic", "--text", "Consulta"])
    with pytest.raises(SystemExit):
        main()
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "PRIVATE_OUTPUT_SENTINEL" not in captured.err
    assert json.loads(captured.err)["error"]["code"] == "invalid_output"
    assert provider.closed


@pytest.mark.parametrize("name", ["openai", "xai"])
def test_basic_factory_uses_selected_key_and_model_without_other_credentials(monkeypatch, name):
    calls = []
    provider = FakeProvider()
    def constructor(model, key):
        calls.append((model, key))
        return provider
    target = "OpenAIProvider" if name == "openai" else "XAIProvider"
    monkeypatch.setattr(f"nubbix_support_basic.providers.{target}", constructor)
    values = {
        "openai_api_key": None,
        "xai_api_key": None,
        f"{name}_api_key": "test-only-key",
        f"{name}_model": "selected-model",
    }
    settings = ProviderSettings(_env_file=None, **values)
    assert create_provider(name, settings) is provider
    assert calls == [("selected-model", "test-only-key")]


def test_basic_cli_reads_stdin_and_rejects_oversized_input(monkeypatch, capsys):
    import io
    monkeypatch.setattr("nubbix_support_basic.cli.create_provider", lambda *args: FakeProvider())
    monkeypatch.setattr(sys, "argv", ["nubbix-support-basic", "--stdin"])
    monkeypatch.setattr(sys, "stdin", io.StringIO("Consulta"))
    main()
    assert json.loads(capsys.readouterr().out) == ANSWER
    monkeypatch.setattr(sys, "stdin", io.StringIO("hola" + " " * 9000))
    with pytest.raises(SystemExit):
        main()
    captured = capsys.readouterr()
    assert captured.out == ""
    assert json.loads(captured.err)["error"]["code"] == "validation_error"


def test_basic_help_does_not_need_credentials_or_a_provider(monkeypatch, capsys):
    def unexpected_provider(*args):
        raise AssertionError("El help no debe construir clientes.")
    monkeypatch.setattr("nubbix_support_basic.cli.create_provider", unexpected_provider)
    monkeypatch.setattr(sys, "argv", ["nubbix-support-basic", "--help"])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 0
    assert "--provider" in capsys.readouterr().out
