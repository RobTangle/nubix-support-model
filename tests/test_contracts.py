import math

import pytest
from pydantic import ValidationError

from nubbix_support.contracts import SupportResponse, Ticket


def test_ticket_strips_surrounding_whitespace():
    assert Ticket(text="  cobro duplicado  ").text == "cobro duplicado"


@pytest.mark.parametrize(
    "text",
    ["", "   ", "x" * 8001, "x" + " " * 8000],
    ids=["empty", "spaces", "oversized", "raw_oversized"],
)
def test_ticket_rejects_invalid_input(text):
    with pytest.raises(ValidationError):
        Ticket(text=text)


@pytest.mark.parametrize("value", [-0.01, 1.01, math.nan, math.inf, True, "0.8"])
def test_response_rejects_invalid_confidence(value):
    with pytest.raises(ValidationError):
        SupportResponse(
            answer="Revisaremos el cargo.", confidence=value, category="billing", actions=[]
        )


def test_contract_has_exact_fields_and_rejects_extras():
    payload = dict(answer="Podemos revisarlo.", confidence=0.8, category="billing", actions=[])
    assert set(SupportResponse(**payload).model_dump()) == set(payload)
    with pytest.raises(ValidationError):
        SupportResponse(**payload, internal_reason="secreto")


@pytest.mark.parametrize(
    "changes",
    [dict(answer=" "), dict(category="sales"), dict(actions=["x"] * 6), dict(actions=[""])],
)
def test_response_checks_content_and_category(changes):
    payload = dict(answer="Podemos revisarlo.", confidence=0.8, category="billing", actions=[])
    with pytest.raises(ValidationError):
        SupportResponse(**(payload | changes))
