"""Borde de la aplicación: validar argumentos, construir dependencias y serializar."""

import io
import json
import sys
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from decimal import Decimal, DecimalException
from pathlib import Path
from typing import Annotated, Any, Literal, NoReturn

import typer
from pydantic import ValidationError

from nubbix_support.budget import Budget, load_prices
from nubbix_support.config import Settings
from nubbix_support.contracts import Ticket
from nubbix_support.errors import SupportError
from nubbix_support.evals.review import assess_report, load_reviews, recommend_prompt
from nubbix_support.evals.runner import read_report, run_evaluation
from nubbix_support.prompts import PromptRepository
from nubbix_support.providers.openai import OpenAIProvider
from nubbix_support.providers.xai import XAIProvider
from nubbix_support.service import SupportService
from nubbix_support.telemetry import write_event

ProviderName = Literal["openai", "xai"]
SplitName = Literal["dev", "test"]
app = typer.Typer(
    help="Clasificar y proponer respuestas seguras para soporte.", no_args_is_help=True
)
eval_app = typer.Typer(
    help="Evaluar datos sintéticos; las llamadas reales consumen saldo.",
    invoke_without_command=True,
)
app.add_typer(eval_app, name="eval")


def main() -> None:
    """UTF-8 en el borde CLI: el JSON redirigido no depende del code page de Windows."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding="utf-8")
    app()


def _abort(exc: Exception) -> NoReturn:
    """No serializar ValidationError ni errores SDK: pueden contener valores sensibles."""
    if isinstance(exc, SupportError):
        code, message = exc.code, str(exc)
    elif isinstance(exc, ValidationError):
        code, message = (
            "validation_error",
            "Entrada o configuración inválida; revisá los límites y tipos.",
        )
    elif isinstance(exc, (ValueError, OSError, DecimalException)):
        code, message = "invalid_configuration", "Revisá argumentos, archivos y configuración."
    else:
        code, message = "internal_error", "No se pudo completar la operación de forma segura."
    typer.echo(
        json.dumps({"error": {"code": code, "message": message}}, ensure_ascii=False), err=True
    )
    raise typer.Exit(2) from None


@contextmanager
def open_service(
    provider: ProviderName,
    *,
    evaluation: bool = False,
    telemetry_file: Path | None = None,
) -> Iterator[SupportService]:
    """Composition root: sólo el adaptador activo recibe su secreto."""
    settings = Settings()
    prices = load_prices(settings.prices_file)
    model = settings.openai_model if provider == "openai" else settings.xai_model
    prices.get(provider, model)
    secret = settings.openai_api_key if provider == "openai" else settings.xai_api_key
    if secret is None or not secret.get_secret_value().strip():
        raise SupportError(
            "missing_key", "Configurá la clave del proveedor seleccionado en el entorno o .env."
        )
    adapter = (
        OpenAIProvider(model, secret.get_secret_value())
        if provider == "openai"
        else XAIProvider(model, secret.get_secret_value())
    )
    with ExitStack() as stack:
        stack.callback(adapter.close)
        streams = [sys.stderr]
        if telemetry_file:
            telemetry_file.parent.mkdir(parents=True, exist_ok=True)
            streams.append(stack.enter_context(telemetry_file.open("a", encoding="utf-8")))
        yield SupportService(
            adapter,
            settings,
            prices=prices,
            prompts=PromptRepository(evaluation_canary=evaluation),
            emit=lambda event: write_event(event, streams),
        )


@app.command()
def respond(
    text: Annotated[str | None, typer.Option(help="Texto del ticket.")] = None,
    stdin: Annotated[
        bool, typer.Option("--stdin", help="Leer un ticket completo desde stdin.")
    ] = False,
    provider: Annotated[ProviderName, typer.Option()] = "openai",
    prompt_version: Annotated[str, typer.Option()] = "v1",
    telemetry_file: Annotated[Path | None, typer.Option()] = None,
) -> None:
    """Devuelve únicamente {answer, confidence, category, actions} en stdout."""
    try:
        if (text is not None) == stdin:
            raise SupportError("invalid_input", "Usá exactamente una opción: --text o --stdin.")
        # Leer con límite evita acumular una entrada arbitrariamente grande en memoria.
        value = sys.stdin.read(8002) if stdin else (text or "")
        ticket = Ticket(text=value)
        with open_service(provider, telemetry_file=telemetry_file) as service:
            run = service.process(ticket, prompt_version)
            output = run.response.model_dump_json()
        typer.echo(output)
    except Exception as exc:
        _abort(exc)


def _eval_result(report: dict[str, Any], path: Path) -> dict[str, Any]:
    return {
        "report": str(path.resolve()),
        "review_template": str(path.with_suffix(".reviews.jsonl").resolve()),
        "run_id": report["run_id"],
        "complete": report["complete"],
        "metrics": report["metrics"],
        "human_review_status": report["human_review_status"],
    }


@eval_app.callback()
def evaluate(
    ctx: typer.Context,
    provider: Annotated[ProviderName, typer.Option()] = "openai",
    prompt_version: Annotated[str, typer.Option()] = "v1",
    split: Annotated[SplitName, typer.Option()] = "dev",
    output_dir: Annotated[Path, typer.Option()] = Path("reports"),
    max_cost_usd: Annotated[str | None, typer.Option()] = None,
) -> None:
    """Evalúa un split más ataques y controles; requiere credenciales y saldo."""
    if ctx.invoked_subcommand is not None:
        return
    try:
        with open_service(provider, evaluation=True) as service:
            budget = Budget(
                Decimal(max_cost_usd)
                if max_cost_usd is not None
                else service.settings.eval_budget_usd,
                scope="eval",
            )
            report, path = run_evaluation(
                service,
                prompt_version=prompt_version,
                split=split,
                output_dir=output_dir,
                budget=budget,
            )
        typer.echo(json.dumps(_eval_result(report, path), ensure_ascii=False))
        if not report["complete"]:
            raise typer.Exit(3)
    except typer.Exit:
        raise
    except Exception as exc:
        _abort(exc)


@eval_app.command("compare")
def compare(
    provider: Annotated[ProviderName, typer.Option()] = "openai",
    split: Annotated[SplitName, typer.Option()] = "dev",
    output_dir: Annotated[Path, typer.Option()] = Path("reports"),
    reviews_dir: Annotated[Path | None, typer.Option()] = None,
    reports: Annotated[list[Path] | None, typer.Option("--reports")] = None,
    max_cost_usd: Annotated[str | None, typer.Option()] = None,
) -> None:
    """Compara v1/v2; --reports permite revisar corridas existentes sin red."""
    try:
        if split != "dev":
            raise SupportError("invalid_split", "La selección usa dev; test queda reservado.")
        paths: list[Path] = []
        data: list[dict[str, Any]] = []
        if reports:
            paths = reports
            data = [read_report(path) for path in paths]
        else:
            with open_service(provider, evaluation=True) as service:
                budget = Budget(
                    Decimal(max_cost_usd)
                    if max_cost_usd is not None
                    else service.settings.eval_budget_usd,
                    scope="eval",
                )
                for version in ("v1", "v2"):
                    report, path = run_evaluation(
                        service,
                        prompt_version=version,
                        split="dev",
                        output_dir=output_dir,
                        budget=budget,
                    )
                    data.append(report)
                    paths.append(path)
        if len(data) != 2 or {item["prompt_version"] for item in data} != {"v1", "v2"}:
            raise ValueError("Se necesitan dos reportes, uno de cada versión.")
        human = {}
        for item in data:
            review_path = reviews_dir / f"{item['run_id']}.jsonl" if reviews_dir else None
            human[item["run_id"]] = (
                load_reviews(review_path) if review_path and review_path.is_file() else []
            )
        recommendation = recommend_prompt(data, human)
        typer.echo(
            json.dumps(
                {"reports": [str(path.resolve()) for path in paths], **recommendation},
                ensure_ascii=False,
            )
        )
        if any(not item["complete"] for item in data):
            raise typer.Exit(3)
    except typer.Exit:
        raise
    except Exception as exc:
        _abort(exc)


@eval_app.command("summarize")
def summarize_report(
    report: Annotated[Path, typer.Option(exists=True, dir_okay=False)],
    reviews: Annotated[Path, typer.Option(exists=True, dir_okay=False)],
) -> None:
    """Aplica la rúbrica humana a un reporte existente, sin llamadas ni escrituras."""
    try:
        assessment = assess_report(read_report(report), load_reviews(reviews))
        typer.echo(json.dumps(assessment, ensure_ascii=False))
    except Exception as exc:
        _abort(exc)


@eval_app.command("adversarial")
def adversarial(
    provider: Annotated[ProviderName, typer.Option()] = "openai",
    prompt_version: Annotated[str, typer.Option()] = "v1",
    output_dir: Annotated[Path, typer.Option()] = Path("reports"),
    ablation: Annotated[bool, typer.Option("--ablation")] = False,
    max_cost_usd: Annotated[str | None, typer.Option()] = None,
) -> None:
    """Ejecuta sólo ataques/controles; la ablación se limita al dataset sintético."""
    try:
        with open_service(provider, evaluation=True) as service:
            budget = Budget(
                Decimal(max_cost_usd)
                if max_cost_usd is not None
                else service.settings.eval_budget_usd,
                scope="eval",
            )
            guarded, path = run_evaluation(
                service,
                prompt_version=prompt_version,
                split="adversarial",
                output_dir=output_dir,
                budget=budget,
            )
            result = {"guarded": _eval_result(guarded, path)}
            if ablation:
                from nubbix_support.evals.ablation import run_ablation
                unguarded, raw_path = run_ablation(service, prompt_version, output_dir, budget)
                result["ablation"] = _eval_result(unguarded, raw_path)
        typer.echo(json.dumps(result, ensure_ascii=False))
        if any(not item["complete"] for item in result.values()):
            raise typer.Exit(3)
    except typer.Exit:
        raise
    except Exception as exc:
        _abort(exc)
