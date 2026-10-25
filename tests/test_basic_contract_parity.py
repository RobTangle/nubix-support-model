import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from nubbix_support_basic.models import SupportResponse, Ticket

CASES = json.loads(
    Path(__file__).with_name("fixtures").joinpath("basic-contract.json").read_text("utf-8")
)


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_python_uses_the_same_contract_cases_as_typescript(case):
    model = Ticket if case["target"] == "ticket" else SupportResponse
    if case["valid"]:
        result = model.model_validate(case["input"])
        if "expected" in case:
            assert result.model_dump() == case["expected"]
    else:
        with pytest.raises(ValidationError):
            model.model_validate(case["input"])
