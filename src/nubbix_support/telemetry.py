"""Telemetría de metadatos; nunca registrar contenido de clientes."""

import json
from collections.abc import Callable
from decimal import Decimal
from typing import Literal, TextIO

from pydantic import BaseModel, Field

# Inyectar un callback permite escribir en stderr o capturar eventos sin acoplar el servicio.
EventSink = Callable[[dict[str, object]], None]


class RunTrace(BaseModel):
    request_id: str
    provider: str
    model: str
    prompt_version: str
    manual_version: str
    safety_version: str
    price_version: str
    status: Literal["ok", "escalated", "blocked", "error"] = "error"
    abstained: bool = False
    attempts: int = 0
    stages_attempted: int = 0
    refusals: int = 0
    invalid_outputs: int = 0
    valid_outputs: int = 0
    first_attempt_valid_outputs: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    # Si falta usage, los totales son sólo la parte conocida y la reserva sigue computándose.
    usage_complete: bool = True
    known_cost_usd: Decimal = Decimal(0)
    reserved_unknown_usd: Decimal = Decimal(0)
    latency_ms: float = 0
    # La factory crea una lista por traza, en vez de compartir estado mutable entre tickets.
    returned_models: list[str] = Field(default_factory=list)


def write_event(event: dict[str, object], streams: list[TextIO]) -> None:
    """Escribir un evento por línea sin cerrar los streams que administra el llamador."""
    line = json.dumps(event, ensure_ascii=False, allow_nan=False)
    for stream in streams:
        stream.write(line + "\n")
        stream.flush()
