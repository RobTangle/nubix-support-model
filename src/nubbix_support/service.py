"""Caso de uso independiente de CLI y SDK: aquí viven las políticas del servicio."""

import json
import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from uuid import uuid4

from pydantic import BaseModel, ValidationError

from nubbix_support.budget import Budget, PriceCatalog, estimate_request_cost, load_prices
from nubbix_support.config import Settings
from nubbix_support.contracts import (
    HUMAN_REVIEW_ACTION,
    SafetyAssessment,
    SupportResponse,
    Ticket,
    safe_response,
)
from nubbix_support.errors import ProviderError, SupportError
from nubbix_support.prompts import PromptRepository
from nubbix_support.providers.base import LLMProvider, LLMRequest
from nubbix_support.telemetry import EventSink, RunTrace


@dataclass(frozen=True)
class SupportRun:
    response: SupportResponse
    trace: RunTrace


class SupportService:
    """Una ejecución es secuencial; el estado por ticket no se comparte entre solicitudes."""

    def __init__(
        self,
        provider: LLMProvider,
        settings: Settings,
        *,
        emit: EventSink,
        prompts: PromptRepository | None = None,
        prices: PriceCatalog | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.provider = provider
        self.settings = settings
        self.emit = emit
        self.prompts = prompts or PromptRepository()
        self.prices = prices or load_prices(settings.prices_file)
        self.clock = clock
        self.sleep = sleep

    def process(
        self, ticket: Ticket, prompt_version: str = "v1", *, batch_budget: Budget | None = None
    ) -> SupportRun:
        """Coordina políticas de soporte; el adaptador sólo traduce llamadas al proveedor.
        batch_budget permite que una suite comparta un tope además del tope por ticket.
        El estado exitoso se fija al completar la moderación final, nunca antes.
        """
        started = self.clock()
        deadline = started + self.settings.deadline_seconds
        budget = Budget(self.settings.ticket_budget_usd)
        trace = RunTrace(
            request_id=str(uuid4()),
            provider=self.provider.name,
            model=self.provider.model,
            prompt_version=prompt_version,
            manual_version=self.prompts.manual.version,
            safety_version=self.prompts.safety.version,
            price_version=self.prices.version,
        )
        failure: SupportError | None = None
        try:
            system = self.prompts.support(prompt_version)
            verdict = self._call(
                "input_moderation",
                self.prompts.moderation("input"),
                json.dumps({"ticket": ticket.text}, ensure_ascii=False),
                SafetyAssessment,
                trace,
                deadline,
                budget,
                batch_budget,
            )
            if verdict is None or verdict.decision != "allow":
                trace.status = "blocked"
                trace.abstained = True
                return SupportRun(safe_response(), trace)
            answer = self._call(
                "generation",
                system,
                json.dumps({"ticket": ticket.text}, ensure_ascii=False),
                SupportResponse,
                trace,
                deadline,
                budget,
                batch_budget,
            )
            if answer is None:
                trace.status = "blocked"
                trace.abstained = True
                return SupportRun(safe_response(), trace)
            if answer.confidence < 0.70:
                actions = [item for item in answer.actions if item != HUMAN_REVIEW_ACTION]
                answer = SupportResponse(
                    **(answer.model_dump() | {"actions": actions[:4] + [HUMAN_REVIEW_ACTION]})
                )
            verdict = self._call(
                "output_moderation",
                self.prompts.moderation("output"),
                answer.model_dump_json(),
                SafetyAssessment,
                trace,
                deadline,
                budget,
                batch_budget,
            )
            if verdict is None or verdict.decision != "allow":
                trace.status = "blocked"
                trace.abstained = True
                return SupportRun(safe_response(), trace)
            trace.status = "escalated" if answer.confidence < 0.70 else "ok"
            return SupportRun(answer, trace)
        except SupportError as exc:
            trace.status = "error"
            failure = exc
            raise
        finally:
            # finally también corre al retornar: el consumidor recibe la traza ya completada.
            trace.latency_ms = max(0, (self.clock() - started) * 1000)
            trace.known_cost_usd = budget.known_usd
            trace.reserved_unknown_usd = budget.unknown_usd
            if failure is not None:
                failure.trace = trace.model_dump(mode="json")
            self.emit({"event": "run_summary", **trace.model_dump(mode="json")})

    def _call[T: BaseModel](
        self,
        stage: str,
        system: str,
        content: str,
        response_model: type[T],
        trace: RunTrace,
        deadline: float,
        budget: Budget,
        batch_budget: Budget | None,
    ) -> T | None:
        """Comparte límites y validación entre generación y moderación.
        El genérico T conserva el tipo del esquema: SafetyAssessment o SupportResponse.
        None representa rechazo explícito; los fallos operativos se propagan como errores.
        """
        price = self.prices.get(self.provider.name, self.provider.model)
        max_tokens = (
            self.settings.generation_max_tokens
            if stage == "generation"
            else self.settings.moderation_max_tokens
        )
        for attempt in range(1, 3):
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise SupportError("deadline_exceeded", "Se agotó el tiempo total del ticket.")
            request = LLMRequest(
                system_prompt=system,
                user_content=content,
                response_model=response_model,
                max_output_tokens=max_tokens,
                timeout_seconds=min(self.settings.timeout_seconds, remaining),
            )
            estimate = estimate_request_cost(request, price)
            budgets = [budget] + ([batch_budget] if batch_budget is not None else [])
            # Comprobar ambos topes antes de reservar evita comprometer sólo uno por error.
            for counter in budgets:
                counter.check(estimate)
            reservations = [(counter, counter.reserve(estimate)) for counter in budgets]
            call_started = self.clock()
            trace.attempts += 1
            trace.stages_attempted += int(attempt == 1)
            usage = None
            code = "ok"
            result = None
            failure: SupportError | None = None
            retryable = False
            try:
                result = self.provider.complete(request)
                usage = result.usage
            except ProviderError as exc:
                usage = exc.usage
                failure = exc
                code = exc.code
                retryable = exc.retryable
            finally:
                actual = price.cost(usage) if usage is not None else None
                for counter, reservation in reservations:
                    counter.settle(reservation, actual)
                if usage is None:
                    trace.usage_complete = False
                else:
                    trace.input_tokens += usage.input_tokens
                    trace.output_tokens += usage.output_tokens
                self.emit(
                    {
                        "event": "llm_attempt",
                        "request_id": trace.request_id,
                        "provider": self.provider.name,
                        "model": self.provider.model,
                        "prompt_version": trace.prompt_version,
                        "stage": stage,
                        "attempt": attempt,
                        "status": code,
                        "input_tokens": usage.input_tokens if usage else None,
                        "output_tokens": usage.output_tokens if usage else None,
                        "known_cost_usd": str(actual) if actual is not None else None,
                        "reserved_unknown_usd": str(estimate) if actual is None else "0",
                        "usage_complete": usage is not None,
                        "latency_ms": max(0, (self.clock() - call_started) * 1000),
                    }
                )
            if self.clock() >= deadline:
                raise SupportError("deadline_exceeded", "Se agotó el tiempo total del ticket.")
            if any(counter.spent_usd > counter.limit_usd for counter in budgets):
                raise SupportError("budget_exceeded", "El consumo informado superó el presupuesto.")
            if result is not None:
                if result.model not in trace.returned_models:
                    trace.returned_models.append(result.model)
                if result.refused:
                    trace.refusals += 1
                    return None
                try:
                    if result.finish_reason.lower() in {
                        "length",
                        "max_tokens",
                        "incomplete",
                        "max_output_tokens",
                        "reason_max_len",
                    }:
                        raise ValueError("Salida truncada.")
                    parsed = response_model.model_validate_json(result.text)
                    trace.valid_outputs += 1
                    trace.first_attempt_valid_outputs += int(attempt == 1)
                    return parsed
                except (ValidationError, ValueError):
                    trace.invalid_outputs += 1
                    failure = SupportError(
                        "invalid_output", "El proveedor devolvió un formato inválido."
                    )
                    retryable = True
                    content += f"\n{self.prompts.safety.repair}"
            if failure is not None and (not retryable or attempt == 2):
                raise failure
            # Jitter evita reintentos simultáneos; parse y transporte comparten el mismo tope.
            delay = min(random.uniform(0.25, 0.75), max(0, deadline - self.clock()))
            self.sleep(delay)
        raise SupportError("invalid_output", "No se obtuvo una salida válida.")
