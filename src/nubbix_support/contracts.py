"""Contratos públicos: validar en el borde evita propagar datos ambiguos."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictFloat, field_validator

Category = Literal["billing", "technical", "account", "other"]
CATEGORIES: tuple[Category, ...] = ("billing", "technical", "account", "other")
# Annotated conserva el tipo str para mypy y agrega restricciones reutilizables de Pydantic.
NonEmptyText = Annotated[str, Field(strict=True, min_length=1, max_length=4000)]
HUMAN_REVIEW_ACTION = "Derivar a un agente humano para revisión."


# Los type hints orientan al editor; BaseModel valida los datos reales al construir el objeto.
class Ticket(BaseModel):
    """El límite se comprueba antes de llamar a un proveedor."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    text: str = Field(strict=True, min_length=1, max_length=8000)

    @field_validator("text", mode="before")
    @classmethod
    def bound_raw_input(cls, value: object) -> object:
        """Limitar la entrada original antes de que Pydantic recorte sus espacios."""
        if isinstance(value, str) and len(value) > 8000:
            raise ValueError("La entrada completa no puede superar los 8000 caracteres.")
        return value


class SupportResponse(BaseModel):
    """confidence es autodeclarada; no equivale a probabilidad calibrada."""

    # Ignorar propiedades extra ocultaría un incumplimiento del contrato del consumidor.
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    answer: NonEmptyText
    # El rango y la finitud validan el formato, no demuestran que el modelo acierte un 80 %.
    confidence: StrictFloat = Field(ge=0, le=1, allow_inf_nan=False)
    category: Category
    actions: list[NonEmptyText] = Field(max_length=5)

    @field_validator("confidence", mode="before")
    @classmethod
    def reject_boolean_confidence(cls, value: object) -> object:
        """Evitar la coerción numérica de bool: en Python True también es un int."""
        if isinstance(value, bool):
            raise ValueError("La confianza no puede ser booleana.")
        return value


class SafetyAssessment(BaseModel):
    """Una decisión acotada facilita aplicar una política fuera del modelo."""

    model_config = ConfigDict(extra="forbid")
    # El modelo aporta una señal; el servicio decide qué publicar a partir de ella.
    decision: Literal["allow", "review", "block"]


def safe_response() -> SupportResponse:
    """La derivación no reutiliza fragmentos de una salida insegura."""
    return SupportResponse(
        answer="Tu consulta requiere revisión del equipo de soporte para responder con seguridad.",
        confidence=0.0,
        category="other",
        actions=[HUMAN_REVIEW_ACTION],
    )
