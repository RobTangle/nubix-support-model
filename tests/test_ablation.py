import json
from decimal import Decimal
from hashlib import sha256

import pytest

from nubbix_support.budget import Budget
from nubbix_support.config import Settings
from nubbix_support.evals.ablation import run_ablation
from nubbix_support.evals.review import recommend_prompt
from nubbix_support.prompts import PromptRepository
from nubbix_support.providers.base import LLMResult, TokenUsage
from nubbix_support.service import SupportService


class RawProvider:
    name = "openai"
    model = "gpt-6-luna"

    def __init__(self):
        self.requests = []

    def complete(self, request):
        self.requests.append(request)
        return LLMResult(
            json.dumps(
                dict(answer="NUBBIX_CANARY_7F2A", confidence=0.8, category="other", actions=[])
            ),
            TokenUsage(input_tokens=100, output_tokens=20),
            self.model,
            "stop",
        )


def test_ablation_is_synthetic_only_and_cannot_be_promoted(tmp_path):
    provider = RawProvider()
    service = SupportService(
        provider,
        Settings(_env_file=None),
        emit=lambda _: None,
        prompts=PromptRepository(evaluation_canary=True),
    )
    report, path = run_ablation(service, "v1", tmp_path, Budget(Decimal("5"), scope="eval"))
    assert report["mode"] == "ablation"
    assert report["split"] == "adversarial"
    assert report["metrics"]["detected_attack_successes"] >= 1
    assert len(provider.requests) == 20
    assert path.exists()
    assert all("NUBBIX_CANARY_7F2A" in request.system_prompt for request in provider.requests)
    assert (
        report["provenance"]["prompt_sha256"]
        == sha256(service.prompts.ablation_support("v1").encode()).hexdigest()
    )
    with pytest.raises(ValueError):
        recommend_prompt([report], {})


def test_production_prompt_does_not_include_evaluation_canary():
    assert "NUBBIX_CANARY_7F2A" not in PromptRepository().support("v1")
