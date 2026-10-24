"""Context engineering explícito: recursos validados y versiones reproducibles."""

import json
from importlib.resources import files

import yaml
from pydantic import BaseModel, ConfigDict

from nubbix_support.contracts import SupportResponse
from nubbix_support.errors import SupportError


class VersionedText(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str
    content: str


class Example(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ticket: str
    response: SupportResponse


class PromptVersion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str
    description: str
    examples: list[Example]


class SafetyPrompts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str
    support: str
    input_safety: str
    output_safety: str
    repair: str
    evaluation_marker: str


class PromptRepository:
    """Cargar contexto versionado sin interpolar tickets en instrucciones privilegiadas."""

    def __init__(self, *, evaluation_canary: bool = False) -> None:
        """Resolver recursos del paquete instalado, independientemente del directorio actual."""
        root = files("nubbix_support.resources")
        self.evaluation_canary = evaluation_canary
        # El YAML pertenece al proyecto: safe_load evita constructores Python y los modelos
        # comprueban su estructura. Esto no vuelve confiable cualquier contenido externo.
        self.manual = VersionedText.model_validate(
            yaml.safe_load(root.joinpath("manual.yaml").read_text("utf-8"))
        )
        self.safety = SafetyPrompts.model_validate(
            yaml.safe_load(root.joinpath("prompts/common.yaml").read_text("utf-8"))
        )
        self.ablation = VersionedText.model_validate(
            yaml.safe_load(root.joinpath("prompts/ablation.yaml").read_text("utf-8"))
        )

    def load(self, version: str) -> PromptVersion:
        """Aceptar sólo versiones conocidas antes de construir la ruta del recurso."""
        if version not in {"v1", "v2"}:
            raise SupportError("unknown_prompt", "La versión de prompt debe ser v1 o v2.")
        text = (
            files("nubbix_support.resources").joinpath(f"prompts/{version}.yaml").read_text("utf-8")
        )
        prompt = PromptVersion.model_validate(yaml.safe_load(text))
        if prompt.version != version:
            raise SupportError("invalid_prompt", "La versión declarada no coincide con el recurso.")
        return prompt

    def support(self, version: str) -> str:
        """Variar los ejemplos manteniendo iguales el manual y la política compartida."""
        prompt = self.load(version)
        examples = json.dumps([item.model_dump() for item in prompt.examples], ensure_ascii=False)
        # El marcador sintético es opt-in para evals; nunca debe convertirse en un secreto real.
        canary = f"\n{self.safety.evaluation_marker}" if self.evaluation_canary else ""
        return (
            f"{self.safety.support}\nMANUAL:\n{self.manual.content}\nEJEMPLOS:\n{examples}{canary}"
        )

    def moderation(self, stage: str) -> str:
        """Dar al evaluador el mismo manual para revisar lo que la generación puede afirmar."""
        policy = self.safety.input_safety if stage == "input" else self.safety.output_safety
        canary = f"\n{self.safety.evaluation_marker}" if self.evaluation_canary else ""
        return f"{policy}\nMANUAL DE REFERENCIA:\n{self.manual.content}{canary}"

    def ablation_support(self, version: str) -> str:
        """Preparar el control experimental reducido, reservado al runner de evals sintéticas."""
        prompt = self.load(version)
        examples = json.dumps([item.model_dump() for item in prompt.examples], ensure_ascii=False)
        return f"{self.ablation.content}\nMANUAL:\n{self.manual.content}\nEJEMPLOS:\n{examples}"
