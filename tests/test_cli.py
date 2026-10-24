import json
import os
import subprocess
import sys
from contextlib import contextmanager

import pytest
from test_runner import EvalProvider, small_dataset
from typer.testing import CliRunner

from nubbix_support.cli import app
from nubbix_support.config import Settings
from nubbix_support.service import SupportService
from nubbix_support.telemetry import write_event

runner = CliRunner()


def test_missing_key_is_sanitized_and_stdout_is_empty(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = runner.invoke(app, ["respond", "--text", "Tengo un cargo duplicado"])
    assert result.exit_code == 2
    assert result.stdout == ""
    assert json.loads(result.stderr)["error"]["code"] == "missing_key"


def test_invalid_ticket_does_not_need_credentials(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["respond", "--text", "   "])
    assert result.exit_code == 2
    assert result.stdout == ""
    assert json.loads(result.stderr)["error"]["code"] == "validation_error"


def test_stdin_and_text_are_mutually_exclusive():
    result = runner.invoke(app, ["respond", "--text", "hola", "--stdin"], input="consulta")
    assert result.exit_code == 2
    assert result.stdout == ""
    assert json.loads(result.stderr)["error"]["code"] == "invalid_input"


def test_configuration_secrets_never_appear_in_error(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OPENAI_API_KEY", "FAKE_SECRET_DO_NOT_PRINT")
    monkeypatch.setenv("NUBBIX_TICKET_BUDGET_USD", "NaN")
    result = runner.invoke(app, ["respond", "--text", "Consulta"])
    assert result.exit_code == 2
    assert "FAKE_SECRET_DO_NOT_PRINT" not in result.output + result.stderr


def test_help_does_not_construct_clients():
    assert runner.invoke(app, ["--help"]).exit_code == 0
    assert runner.invoke(app, ["eval", "--help"]).exit_code == 0
    assert runner.invoke(app, ["eval", "compare", "--help"]).exit_code == 0


def test_settings_do_not_require_both_provider_credentials(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("XAI_API_KEY", "test-only-key")
    settings = Settings(_env_file=None)
    assert settings.openai_api_key is None
    assert settings.xai_api_key.get_secret_value() == "test-only-key"


def test_success_stdout_is_only_contract_and_stderr_does_not_contain_ticket(monkeypatch):
    import sys
    @contextmanager
    def fake_service(*args, **kwargs):
        yield SupportService(
            EvalProvider(),
            Settings(_env_file=None),
            emit=lambda event: write_event(event, [sys.stderr]),
        )
    monkeypatch.setattr("nubbix_support.cli.open_service", fake_service)
    result = runner.invoke(
        app, ["respond", "--stdin"], input="TICKET_PRIVATE_SENTINEL: cargo duplicado"
    )
    assert result.exit_code == 0, result.stderr
    assert set(json.loads(result.stdout)) == {"answer", "confidence", "category", "actions"}
    events = [json.loads(line) for line in result.stderr.splitlines()]
    assert events[-1]["event"] == "run_summary"
    assert len(events) == 4
    assert "TICKET_PRIVATE_SENTINEL" not in result.stderr


def test_oversized_stdin_is_rejected_before_constructing_provider():
    result = runner.invoke(app, ["respond", "--stdin"], input="x" * 100_000)
    assert result.exit_code == 2
    assert result.stdout == ""
    assert json.loads(result.stderr)["error"]["code"] == "validation_error"


def test_oversized_stdin_with_whitespace_is_not_silently_truncated(monkeypatch):
    def unexpected_provider(*args, **kwargs):
        raise AssertionError("No debe construirse un proveedor para una entrada inválida.")
    monkeypatch.setattr("nubbix_support.cli.open_service", unexpected_provider)
    result = runner.invoke(
        app, ["respond", "--stdin"], input="hola" + " " * 9000 + "contenido final"
    )
    assert result.exit_code == 2
    assert json.loads(result.stderr)["error"]["code"] == "validation_error"


def test_entrypoint_emits_utf8_even_when_host_default_is_cp1252(tmp_path):
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("NUBBIX_") and key not in {"OPENAI_API_KEY", "XAI_API_KEY"}
    }
    environment["PYTHONIOENCODING"] = "cp1252"
    result = subprocess.run(
        [sys.executable, "-m", "nubbix_support", "respond", "--text", "Consulta"],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        timeout=15,
    )
    assert result.returncode == 2
    assert result.stdout == b""
    assert json.loads(result.stderr.decode("utf-8"))["error"]["code"] == "missing_key"


def test_eval_cli_exports_report_and_offline_comparison(monkeypatch, tmp_path):
    @contextmanager
    def fake_service(*args, **kwargs):
        yield SupportService(EvalProvider(), Settings(_env_file=None), emit=lambda _: None)
    monkeypatch.setattr("nubbix_support.cli.open_service", fake_service)
    small_dataset(monkeypatch)
    first = runner.invoke(app, ["eval", "--output-dir", str(tmp_path)])
    assert first.exit_code == 0, first.stderr
    report = json.loads(first.stdout)
    assert report["metrics"]["cases"] == 2
    assert report["human_review_status"] == "pending"
    comparison = runner.invoke(app, ["eval", "compare", "--output-dir", str(tmp_path)])
    assert comparison.exit_code == 0, comparison.stderr
    exported = json.loads(comparison.stdout)
    assert exported["recommended_prompt"] is None
    offline = runner.invoke(
        app,
        [
            "eval",
            "compare",
            "--reports",
            exported["reports"][0],
            "--reports",
            exported["reports"][1],
        ],
    )
    assert offline.exit_code == 0, offline.stderr
    assert json.loads(offline.stdout)["status"] == "pending_human_review"


def test_eval_cli_partial_run_has_nonzero_exit_and_keeps_report(monkeypatch, tmp_path):
    @contextmanager
    def fake_service(*args, **kwargs):
        yield SupportService(EvalProvider(), Settings(_env_file=None), emit=lambda _: None)
    monkeypatch.setattr("nubbix_support.cli.open_service", fake_service)
    small_dataset(monkeypatch)
    result = runner.invoke(
        app, ["eval", "--output-dir", str(tmp_path), "--max-cost-usd", "0.000000001"]
    )
    assert result.exit_code == 3
    data = json.loads(result.stdout)
    assert not data["complete"]
    assert data["metrics"]["cases"] == 2


def test_summarize_cli_is_offline_and_does_not_modify_report(monkeypatch, tmp_path):
    @contextmanager
    def fake_service(*args, **kwargs):
        yield SupportService(EvalProvider(), Settings(_env_file=None), emit=lambda _: None)
    monkeypatch.setattr("nubbix_support.cli.open_service", fake_service)
    small_dataset(monkeypatch)
    initial = runner.invoke(app, ["eval", "--output-dir", str(tmp_path)])
    result = json.loads(initial.stdout)
    path = tmp_path / (result["run_id"] + ".json")
    before = path.read_bytes()
    data = json.loads(before)
    reviews = tmp_path / "filled.jsonl"
    reviews.write_text(
        "\n".join(
            json.dumps(
                dict(
                    run_id=data["run_id"],
                    case_id=row["id"],
                    quality_pass=True,
                    severe_issue=False,
                    attack_succeeded=None,
                )
            )
            for row in data["records"]
        ),
        encoding="utf-8",
    )
    summary = runner.invoke(
        app, ["eval", "summarize", "--report", str(path), "--reviews", str(reviews)]
    )
    assert summary.exit_code == 0, summary.stderr
    assert json.loads(summary.stdout)["status"] == "reviewed"
    assert not json.loads(summary.stdout)["pilot_candidate"]
    assert path.read_bytes() == before


@pytest.mark.parametrize("command", [["eval"], ["eval", "compare"], ["eval", "adversarial"]])
def test_explicit_empty_eval_budget_is_rejected_without_provider_calls(
    monkeypatch, tmp_path, command
):
    provider = EvalProvider()
    @contextmanager
    def fake_service(*args, **kwargs):
        yield SupportService(provider, Settings(_env_file=None), emit=lambda _: None)
    monkeypatch.setattr("nubbix_support.cli.open_service", fake_service)
    small_dataset(monkeypatch)
    result = runner.invoke(app, [*command, "--max-cost-usd", "", "--output-dir", str(tmp_path)])
    assert result.exit_code == 2
    assert json.loads(result.stderr)["error"]["code"] == "invalid_configuration"
    assert provider.calls == 0
