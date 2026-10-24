"""Evals reales por comando; jamás convertir un fake en evidencia de calidad."""

import json
import re
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict

from nubbix_support.budget import Budget
from nubbix_support.contracts import SafetyAssessment, SupportResponse, Ticket
from nubbix_support.errors import SupportError
from nubbix_support.evals.data import (
    AdversarialCase,
    TicketCase,
    dataset_hashes,
    load_adversarial,
    load_tickets,
)
from nubbix_support.evals.metrics import CaseRecord, summarize
from nubbix_support.evals.review import write_review_template
from nubbix_support.providers.openai import OpenAIProvider
from nubbix_support.providers.xai import XAIProvider
from nubbix_support.service import SupportService
from nubbix_support.telemetry import RunTrace


class EvalReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    report_version: Literal["1"] = "1"
    run_id: str
    created_at: str
    provider: str
    model: str
    prompt_version: str
    split: Literal["dev", "test", "adversarial"]
    mode: Literal["guarded", "ablation"] = "guarded"
    complete: bool
    comparison_key: str
    provenance: dict[str, Any]
    metrics: dict[str, Any]
    records: list[CaseRecord]
    human_review_status: Literal["pending"] = "pending"


def run_evaluation(
    service: SupportService,
    *,
    prompt_version: str,
    split: Literal["dev", "test", "adversarial"],
    output_dir: Path,
    budget: Budget,
) -> tuple[dict[str, Any], Path]:
    """Usa el servicio real; los casos fallidos y no ejecutados permanecen en el reporte."""
    cases: list[TicketCase | AdversarialCase] = []
    if split != "adversarial":
        cases.extend(load_tickets(split))
    cases.extend(load_adversarial())
    rows: list[CaseRecord] = []
    exhausted = False
    for case in cases:
        expected = case.category if isinstance(case, TicketCase) else case.expected_category
        row = CaseRecord(
            id=case.id,
            text=case.text,
            kind="ticket" if isinstance(case, TicketCase) else case.kind,
            expected_category=expected,
            expected_actions=case.expected_actions if isinstance(case, TicketCase) else [],
        )
        if exhausted:
            row.not_run = True
            row.error_code = "budget_not_run"
            rows.append(row)
            continue
        try:
            result = service.process(Ticket(text=case.text), prompt_version, batch_budget=budget)
            row.response = result.response
            row.trace = result.trace
            output = result.response.model_dump_json()
            row.rules_passed = not any(
                re.search(pattern, output, re.IGNORECASE) for pattern in case.forbidden_patterns
            )
        except SupportError as exc:
            row.error_code = exc.code
            row.trace = RunTrace.model_validate(exc.trace) if exc.trace else None
            exhausted = exc.code == "eval_budget_exceeded"
        rows.append(row)
    return save_report(service, prompt_version, split, rows, output_dir)


def save_report(
    service: SupportService,
    prompt_version: str,
    split: Literal["dev", "test", "adversarial"],
    rows: list[CaseRecord],
    output_dir: Path,
    *,
    mode: Literal["guarded", "ablation"] = "guarded",
) -> tuple[dict[str, Any], Path]:
    """Guarda resultados sintéticos y huellas de los insumos necesarios para compararlos."""
    # El hash de contexto registra exactamente qué se evaluó sin registrar tickets reales.
    settings = service.settings.model_dump(mode="json", exclude={"openai_api_key", "xai_api_key"})
    actual_prompt = (
        service.prompts.support(prompt_version)
        if mode == "guarded"
        else service.prompts.ablation_support(prompt_version)
    )
    provenance = {
        "dataset_sha256": dataset_hashes(),
        "settings": settings,
        "manual_sha256": sha256(service.prompts.manual.model_dump_json().encode()).hexdigest(),
        "safety_sha256": sha256(service.prompts.safety.model_dump_json().encode()).hexdigest(),
        "prompt_sha256": sha256(actual_prompt.encode()).hexdigest(),
        "ablation_version": service.prompts.ablation.version if mode == "ablation" else "disabled",
        "prices_sha256": sha256(service.prices.model_dump_json().encode()).hexdigest(),
        # Un cambio de contrato también cambia lo que ve el modelo, aunque el YAML sea igual.
        "schemas_sha256": sha256(
            json.dumps(
                {
                    "support": SupportResponse.model_json_schema(),
                    "safety": SafetyAssessment.model_json_schema(),
                },
                sort_keys=True,
            ).encode()
        ).hexdigest(),
        "evaluation_canary": service.prompts.evaluation_canary,
        "dataset_origin": "synthetic",
        "evidence": "live_provider_calls"
        if isinstance(service.provider, (OpenAIProvider, XAIProvider))
        else "offline_simulation",
    }
    comparison = {key: value for key, value in provenance.items() if key != "prompt_sha256"}
    comparison_key = sha256(json.dumps(comparison, sort_keys=True).encode()).hexdigest()
    report = EvalReport(
        run_id=str(uuid4()),
        created_at=datetime.now(UTC).isoformat(),
        provider=service.provider.name,
        model=service.provider.model,
        prompt_version=prompt_version,
        split=split,
        mode=mode,
        complete=all(not row.not_run for row in rows),
        comparison_key=comparison_key,
        provenance=provenance,
        metrics=summarize(rows),
        records=rows,
    ).model_dump(mode="json")
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{report['run_id']}.json"
    path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    write_review_template(report, output_dir / f"{report['run_id']}.reviews.jsonl")
    return report, path


def read_report(path: Path) -> dict[str, Any]:
    return EvalReport.model_validate_json(path.read_text("utf-8")).model_dump(mode="json")
