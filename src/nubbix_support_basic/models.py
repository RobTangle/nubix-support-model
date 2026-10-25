"""Contratos pequeños que se pueden estudiar sin recorrer la versión completa."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Ticket(BaseModel):
    """Pydantic valida el dato real; escribir text: str por sí solo no lo validaría."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)
    text: str = Field(min_length=1, max_length=8000)

    @field_validator("text", mode="before")
    @classmethod
    def limit_original_text(cls, value: object) -> object:
        # Se comprueba antes de quitar espacios para no aceptar una entrada larga truncada.
        if isinstance(value, str) and len(value) > 8000:
            raise ValueError("El ticket no puede superar los 8000 caracteres.")
        return value


class SupportResponse(BaseModel):
    """Esquema de salida: valida forma y tipos, no la veracidad de lo que dice la IA."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)
    answer: str = Field(min_length=1, max_length=4000)
    # Es confianza autodeclarada: 0.9 no demuestra un 90 % de probabilidad de acierto.
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    category: Literal["billing", "technical", "account", "other"]
    actions: list[str] = Field(max_length=5)

    @field_validator("actions")
    @classmethod
    def validate_action_text(cls, actions: list[str]) -> list[str]:
        # Validar el contenido de cada elemento importa además del tamaño de la lista.
        if any(not action or len(action) > 4000 for action in actions):
            raise ValueError("Cada acción debe tener entre 1 y 4000 caracteres.")
        return actions
