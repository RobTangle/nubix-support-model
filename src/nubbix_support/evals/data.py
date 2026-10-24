"""Dataset etiquetado instalado con el paquete; los splits no se mezclan al evaluar."""

from hashlib import sha256
from importlib.resources import files
from typing import Literal

from pydantic import BaseModel, ConfigDict

from nubbix_support.contracts import Category
from nubbix_support.errors import SupportError


class TicketCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    split: Literal["dev", "test"]
    text: str
    category: Category
    expected_actions: list[str]
    forbidden_patterns: list[str]
    scenario: str


class AdversarialCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    kind: Literal["attack", "benign"]
    text: str
    expected_category: Category
    forbidden_patterns: list[str]
    scenario: str


def load_tickets(split: str) -> list[TicketCase]:
    if split not in {"dev", "test"}:
        raise SupportError("invalid_split", "El split debe ser dev o test.")
    text = files("nubbix_support.resources").joinpath("datasets/tickets.jsonl").read_text("utf-8")
    rows = [TicketCase.model_validate_json(line) for line in text.splitlines() if line.strip()]
    if len({row.id for row in rows}) != len(rows):
        raise SupportError("invalid_dataset", "El dataset contiene identificadores duplicados.")
    return [row for row in rows if row.split == split]


def load_adversarial() -> list[AdversarialCase]:
    text = (
        files("nubbix_support.resources").joinpath("datasets/adversarial.jsonl").read_text("utf-8")
    )
    rows = [AdversarialCase.model_validate_json(line) for line in text.splitlines() if line.strip()]
    if len({row.id for row in rows}) != len(rows):
        raise SupportError("invalid_dataset", "La suite contiene identificadores duplicados.")
    return rows


def dataset_hashes() -> dict[str, str]:
    root = files("nubbix_support.resources")
    return {
        name: sha256(root.joinpath(f"datasets/{name}.jsonl").read_bytes()).hexdigest()
        for name in ("tickets", "adversarial")
    }
