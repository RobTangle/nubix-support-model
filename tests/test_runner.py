import json
from decimal import Decimal

from nubbix_support.budget import Budget
from nubbix_support.config import Settings
from nubbix_support.evals.data import TicketCase
from nubbix_support.evals.review import assess_report, load_reviews
from nubbix_support.evals.runner import read_report, run_evaluation
from nubbix_support.providers.base import LLMResult, TokenUsage
from nubbix_support.service import SupportService


class EvalProvider:
    name = "openai"
    model = "gpt-6-luna"

    def __init__(self):
        self.calls = 0

    def complete(self, request):
        self.calls += 1
        text = (
            '{"decision":"allow"}'
            if request.response_model.__name__ == "SafetyAssessment"
            else json.dumps(
                dict(
                    answer="El equipo verificará el cargo.",
                    confidence=0.9,
                    category="billing",
                    actions=[],
                )
            )
        )
        return LLMResult(text, TokenUsage(input_tokens=100, output_tokens=20), self.model, "stop")


def small_dataset(monkeypatch):
    cases = [
        TicketCase(
            id=f"test-{i}",
            split="dev",
            text=f"Consulta sintética de facturación {i}",
            category="billing",
            expected_actions=["Verificar el cargo"],
            forbidden_patterns=[],
            scenario="Caso sintético de prueba de software",
        )
        for i in range(2)
    ]
    monkeypatch.setattr("nubbix_support.evals.runner.load_tickets", lambda _: cases)
    monkeypatch.setattr("nubbix_support.evals.runner.load_adversarial", lambda: [])


def test_runner_preserves_unexecuted_cases_when_batch_budget_is_exhausted(monkeypatch, tmp_path):
    small_dataset(monkeypatch)
    provider = EvalProvider()
    service = SupportService(provider, Settings(_env_file=None), emit=lambda _: None)
    report, path = run_evaluation(
        service,
        prompt_version="v1",
        split="dev",
        output_dir=tmp_path,
        budget=Budget(Decimal("0.000000001"), scope="eval"),
    )
    assert provider.calls == 0
    assert not report["complete"]
    assert report["metrics"]["cases"] == 2
    assert report["metrics"]["not_run_cases"] == 1
    assert report["records"][0]["error_code"] == "eval_budget_exceeded"
    assert read_report(path) == report


def test_simulated_eval_is_not_labeled_live_or_approved(monkeypatch, tmp_path):
    small_dataset(monkeypatch)
    provider = EvalProvider()
    service = SupportService(provider, Settings(_env_file=None), emit=lambda _: None)
    report, path = run_evaluation(
        service,
        prompt_version="v1",
        split="dev",
        output_dir=tmp_path,
        budget=Budget(Decimal("5"), scope="eval"),
    )
    assert provider.calls == 6
    assert report["provenance"]["evidence"] == "offline_simulation"
    assert not assess_report(report, [])["pilot_candidate"]
    assert path.with_suffix(".reviews.jsonl").exists()


def test_unfilled_human_template_cannot_be_loaded_as_approval(monkeypatch, tmp_path):
    import pytest
    from pydantic import ValidationError
    small_dataset(monkeypatch)
    service = SupportService(EvalProvider(), Settings(_env_file=None), emit=lambda _: None)
    _, path = run_evaluation(
        service,
        prompt_version="v1",
        split="dev",
        output_dir=tmp_path,
        budget=Budget(Decimal("5"), scope="eval"),
    )
    with pytest.raises(ValidationError):
        load_reviews(path.with_suffix(".reviews.jsonl"))


def test_eval_comparison_detects_a_changed_output_contract(monkeypatch, tmp_path):
    from nubbix_support.contracts import SupportResponse
    small_dataset(monkeypatch)
    service = SupportService(EvalProvider(), Settings(_env_file=None), emit=lambda _: None)
    first, _ = run_evaluation(
        service,
        prompt_version="v1",
        split="dev",
        output_dir=tmp_path,
        budget=Budget(Decimal("5"), scope="eval"),
    )
    schema = SupportResponse.model_json_schema() | {"description": "Contrato modificado"}
    monkeypatch.setattr(
        SupportResponse, "model_json_schema", classmethod(lambda cls, **kwargs: schema)
    )
    second, _ = run_evaluation(
        service,
        prompt_version="v2",
        split="dev",
        output_dir=tmp_path,
        budget=Budget(Decimal("5"), scope="eval"),
    )
    assert first["comparison_key"] != second["comparison_key"]
