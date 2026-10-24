"""Arnés adversarial: jamás aceptar texto libre ni exponer este bypass en respond."""

import json
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import ValidationError

from nubbix_support.budget import Budget, estimate_request_cost
from nubbix_support.contracts import SupportResponse, safe_response
from nubbix_support.errors import ProviderError, SupportError
from nubbix_support.evals.data import AdversarialCase, load_adversarial
from nubbix_support.evals.metrics import CaseRecord
from nubbix_support.evals.runner import save_report
from nubbix_support.providers.base import LLMRequest
from nubbix_support.service import SupportService
from nubbix_support.telemetry import RunTrace


def _raw_case(
    service: SupportService, case: AdversarialCase, version: str, batch_budget: Budget
) -> CaseRecord:
    """Mismo contrato y límites, sin políticas de prompting ni pasos de moderación."""
    started = service.clock()
    deadline = started + service.settings.deadline_seconds
    local = Budget(service.settings.ticket_budget_usd)
    price = service.prices.get(service.provider.name, service.provider.model)
    trace = RunTrace(
        request_id=str(uuid4()),
        provider=service.provider.name,
        model=service.provider.model,
        prompt_version=version,
        manual_version=service.prompts.manual.version,
        safety_version="disabled-eval-only",
        price_version=service.prices.version,
    )
    row = CaseRecord(
        id=case.id,
        text=case.text,
        kind=case.kind,
        expected_category=case.expected_category,
        trace=trace,
    )
    system = service.prompts.ablation_support(version)
    try:
        for attempt in range(1, 3):
            remaining = deadline - service.clock()
            if remaining <= 0:
                raise SupportError(
                    "deadline_exceeded", "Se agotó el tiempo del caso de evaluación."
                )
            request = LLMRequest(
                system,
                json.dumps({"ticket": case.text}, ensure_ascii=False),
                SupportResponse,
                service.settings.generation_max_tokens,
                min(service.settings.timeout_seconds, remaining),
            )
            estimate = estimate_request_cost(request, price)
            local.check(estimate)
            batch_budget.check(estimate)
            reservations = [(meter, meter.reserve(estimate)) for meter in (local, batch_budget)]
            usage = None
            trace.attempts += 1
            trace.stages_attempted = 1
            retryable = False
            failure: SupportError | None = None
            try:
                result = service.provider.complete(request)
                usage = result.usage
                row.raw_output = result.text
                row.rules_passed = not any(
                    re.search(pattern, result.text, re.IGNORECASE)
                    for pattern in case.forbidden_patterns
                )
                if result.refused:
                    trace.refusals += 1
                    trace.abstained = True
                    row.response = safe_response()
                elif result.finish_reason.lower() in {
                    "length",
                    "incomplete",
                    "max_tokens",
                    "max_output_tokens",
                }:
                    raise ValueError("Salida truncada.")
                else:
                    row.response = SupportResponse.model_validate_json(result.text)
                    trace.valid_outputs = 1
                    trace.first_attempt_valid_outputs = int(attempt == 1)
                trace.returned_models.append(result.model)
            except ProviderError as exc:
                usage = exc.usage
                failure = exc
                retryable = exc.retryable
            except (ValidationError, ValueError):
                trace.invalid_outputs += 1
                failure = SupportError("invalid_output", "Salida inválida del arnés de evaluación.")
                retryable = True
            finally:
                actual = price.cost(usage) if usage else None
                for meter, reservation in reservations:
                    meter.settle(reservation, actual)
                if usage is None:
                    trace.usage_complete = False
                else:
                    trace.input_tokens += usage.input_tokens
                    trace.output_tokens += usage.output_tokens
            if service.clock() >= deadline:
                raise SupportError(
                    "deadline_exceeded", "Se agotó el tiempo del caso de evaluación."
                )
            if local.spent_usd > local.limit_usd or batch_budget.spent_usd > batch_budget.limit_usd:
                raise SupportError("budget_exceeded", "El consumo superó el presupuesto estimado.")
            if failure is None:
                trace.status = "blocked" if trace.abstained else "ok"
                break
            if not retryable or attempt == 2:
                raise failure
            service.sleep(min(0.25, max(0, deadline - service.clock())))
    except SupportError as exc:
        row.error_code = exc.code
    finally:
        trace.latency_ms = max(0, (service.clock() - started) * 1000)
        trace.known_cost_usd = local.known_usd
        trace.reserved_unknown_usd = local.unknown_usd
        service.emit({"event": "eval_ablation_summary", **trace.model_dump(mode="json")})
    return row


def run_ablation(
    service: SupportService, prompt_version: str, output_dir: Path, budget: Budget
) -> tuple[dict[str, Any], Path]:
    service.prompts.load(prompt_version)
    rows: list[CaseRecord] = []
    exhausted = False
    for case in load_adversarial():
        if exhausted:
            rows.append(
                CaseRecord(
                    id=case.id,
                    kind=case.kind,
                    expected_category=case.expected_category,
                    not_run=True,
                    error_code="budget_not_run",
                )
            )
            continue
        row = _raw_case(service, case, prompt_version, budget)
        rows.append(row)
        exhausted = row.error_code == "eval_budget_exceeded"
    return save_report(service, prompt_version, "adversarial", rows, output_dir, mode="ablation")
