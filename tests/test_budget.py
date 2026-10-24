from decimal import Decimal

import pytest

from nubbix_support.budget import Budget, ModelPrice, estimate_request_cost, load_prices
from nubbix_support.contracts import SafetyAssessment
from nubbix_support.errors import SupportError
from nubbix_support.providers.base import LLMRequest, TokenUsage


def test_unknown_usage_keeps_reservation_and_known_usage_reconciles():
    budget = Budget(Decimal("0.05"))
    reservation = budget.reserve(Decimal("0.02"))
    budget.settle(reservation, None)
    second = budget.reserve(Decimal("0.02"))
    budget.settle(second, Decimal("0.001"))
    assert budget.spent_usd == Decimal("0.021")
    assert budget.unknown_usd == Decimal("0.02")
    assert budget.known_usd == Decimal("0.001")
    with pytest.raises(SupportError, match="presupuesto"):
        budget.reserve(Decimal("0.03"))


def test_prices_are_packaged_and_missing_models_fail_closed():
    prices = load_prices()
    price = prices.get("openai", "gpt-6-luna")
    assert price.cost(TokenUsage(input_tokens=1000, output_tokens=100)) == Decimal("0.00015")
    with pytest.raises(SupportError):
        prices.get("openai", "unknown-model")


@pytest.mark.parametrize("value", ["-1", "0", "NaN", "Infinity"])
def test_budget_rejects_invalid_limits(value):
    with pytest.raises(ValueError):
        Budget(Decimal(value))


def test_cache_writes_and_reasoning_are_not_charged_twice():
    price = load_prices().get("openai", "gpt-6-luna")
    usage = TokenUsage(
        input_tokens=1000,
        output_tokens=200,
        cached_input_tokens=100,
        cache_write_input_tokens=200,
        reasoning_output_tokens=50,
    )
    assert price.cost(usage) == Decimal("0.000196")


def test_zero_cache_write_price_is_not_replaced_by_regular_input_price():
    price = ModelPrice(
        input_per_million="1",
        output_per_million="2",
        cached_input_per_million="0",
        cache_write_input_per_million="0",
    )
    usage = TokenUsage(input_tokens=100, output_tokens=0, cache_write_input_tokens=100)
    assert price.cost(usage) == 0


@pytest.mark.parametrize(
    "subtotals",
    [
        {"cached_input_tokens": 101},
        {"cache_write_input_tokens": 101},
        {"cached_input_tokens": 60, "cache_write_input_tokens": 50},
        {"reasoning_output_tokens": 11},
    ],
)
def test_usage_rejects_subtotals_larger_than_their_totals(subtotals):
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        TokenUsage(input_tokens=100, output_tokens=10, **subtotals)


def test_estimate_covers_the_highest_configured_input_rate():
    price = ModelPrice(input_per_million="1", output_per_million="1", cached_input_per_million="10")
    request = LLMRequest("system", "ticket", SafetyAssessment, 1, 1.0)
    usage = TokenUsage(input_tokens=4000, output_tokens=0, cached_input_tokens=4000)
    assert estimate_request_cost(request, price) >= price.cost(usage)
