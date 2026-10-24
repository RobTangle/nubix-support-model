import json
from decimal import Decimal

import pytest

from nubbix_support.contracts import SupportResponse
from nubbix_support.evals.data import load_adversarial, load_tickets
from nubbix_support.evals.metrics import CaseRecord, summarize
from nubbix_support.evals.review import HumanReview, recommend_prompt
from nubbix_support.telemetry import RunTrace


def record(case_id, expected, predicted=None, *, abstained=False, error=None, kind="ticket"):
    response = (
        SupportResponse(
            answer="Soporte verificará el caso.", confidence=0.9, category=predicted, actions=[]
        )
        if predicted
        else None
    )
    trace = RunTrace(
        request_id=case_id,
        provider="openai",
        model="gpt-6-luna",
        prompt_version="v1",
        manual_version="m1",
        safety_version="s1",
        price_version="p1",
        abstained=abstained,
        status="ok",
        attempts=3,
        valid_outputs=3,
        latency_ms=100,
        known_cost_usd=Decimal("0.001"),
    )
    return CaseRecord(
        id=case_id,
        kind=kind,
        expected_category=expected,
        response=response,
        trace=trace,
        error_code=error,
        rules_passed=True,
    )


def test_metrics_include_errors_and_abstentions_in_denominators():
    rows = [
        record("1", "billing", "billing"),
        record("2", "billing", error="timeout"),
        record("3", "other", "other", abstained=True),
    ]
    metrics = summarize(rows)
    assert metrics["accuracy"] == pytest.approx(1 / 3)
    assert metrics["per_category"]["billing"]["recall"] == 0.5
    assert metrics["confusion_matrix"]["other"]["abstained"] == 1
    assert metrics["operational_error_rate"] == pytest.approx(1 / 3)
    assert metrics["known_cost_usd"] == "0.003"


def test_benign_blocking_and_attack_rule_checks_are_separate():
    attack = record("a", "other", "other", abstained=True, kind="attack")
    benign = record("b", "account", "other", abstained=True, kind="benign")
    metrics = summarize([attack, benign])
    assert metrics["false_block_rate"] == 1
    assert metrics["detected_attack_successes"] == 0
    assert metrics["classification_cases"] == 0


def test_recommendation_requires_human_reviews_and_complete_runs():
    report = {
        "run_id": "r1",
        "provider": "openai",
        "model": "gpt-6-luna",
        "prompt_version": "v1",
        "complete": True,
        "records": [record("1", "billing", "billing").model_dump(mode="json")],
        "metrics": summarize([record("1", "billing", "billing")]),
    }
    result = recommend_prompt([report], {})
    assert result["recommended_prompt"] is None
    assert result["status"] == "pending_human_review"


def test_review_missing_severity_is_not_a_pass():
    with pytest.raises(ValueError):
        HumanReview.model_validate({"run_id": "r", "case_id": "1", "quality_pass": True})


def test_dataset_is_balanced_and_not_reused_in_fewshot():
    dev, test = load_tickets("dev"), load_tickets("test")
    assert len(dev) == len(test) == 40
    for split in [dev, test]:
        assert {
            category: sum(row.category == category for row in split)
            for category in ["billing", "technical", "account", "other"]
        } == dict.fromkeys(["billing", "technical", "account", "other"], 10)
    assert not {row.text.casefold() for row in dev} & {row.text.casefold() for row in test}
    attacks = load_adversarial()
    assert len(attacks) == 20
    assert sum(row.kind == "attack" for row in attacks) == 10
    json.dumps([row.model_dump() for row in attacks], ensure_ascii=False)
    from nubbix_support.prompts import PromptRepository
    examples = {item.ticket.casefold() for item in PromptRepository().load("v2").examples}
    assert not examples & {row.text.casefold() for row in dev + test}


@pytest.mark.parametrize("canary_enabled", [False, True])
def test_reviewed_comparison_selects_by_score_then_cost(canary_enabled):
    rows = [
        record(f"{category}-{i}", category, category)
        for category in ["billing", "technical", "account", "other"]
        for i in range(10)
    ]
    rows += [
        record(f"attack-{i}", "other", "other", abstained=True, kind="attack") for i in range(10)
    ]
    rows += [record(f"benign-{i}", "billing", "billing", kind="benign") for i in range(10)]
    metrics = summarize(rows)
    base = dict(
        provider="openai",
        model="gpt-6-luna",
        split="dev",
        complete=True,
        comparison_key="identical",
        provenance={"evidence": "live_provider_calls", "evaluation_canary": canary_enabled},
        records=[row.model_dump(mode="json") for row in rows],
    )
    reports = [
        base | dict(run_id="r1", prompt_version="v1", metrics=metrics),
        base
        | dict(
            run_id="r2", prompt_version="v2", metrics=metrics | {"estimated_committed_usd": "0.001"}
        ),
    ]
    reviews = {
        run_id: [
            HumanReview(
                run_id=run_id,
                case_id=row.id,
                quality_pass=True,
                severe_issue=False,
                attack_succeeded=False if row.kind == "attack" else None,
            )
            for row in rows
        ]
        for run_id in ["r1", "r2"]
    }
    assert recommend_prompt(reports, reviews)["recommended_prompt"] == (
        "v2" if canary_enabled else None
    )


def test_different_contexts_cannot_be_compared():
    reports = [
        dict(provider="openai", model="gpt-6-luna", split="dev", comparison_key=key)
        for key in ["a", "b"]
    ]
    with pytest.raises(ValueError, match="diferentes"):
        recommend_prompt(reports, {})
