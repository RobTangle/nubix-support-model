"""CLI con argparse de la biblioteca estándar: no requiere aprender otro framework."""

import argparse
import io
import json
import sys

from pydantic import ValidationError

from nubbix_support.errors import SupportError
from nubbix_support_basic.models import Ticket
from nubbix_support_basic.providers import ProviderSettings, create_provider
from nubbix_support_basic.service import SupportAssistant


def main() -> None:
    """Convierte argumentos de terminal en objetos y publica sólo el contrato JSON."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(
        description="Nubbix didáctico: clasificar y proponer una respuesta."
    )
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--text", help="Texto de un ticket.")
    inputs.add_argument(
        "--stdin", action="store_true", help="Leer un ticket desde la entrada estándar."
    )
    parser.add_argument("--provider", choices=("openai", "xai"), default="openai")
    args = parser.parse_args()
    try:
        text = sys.stdin.read(8001) if args.stdin else args.text
        # Validar antes de crear el proveedor evita gastar o pedir claves para una entrada inválida.
        ticket = Ticket(text=text)
        provider = create_provider(args.provider, ProviderSettings())
        try:
            response = SupportAssistant(provider).respond(ticket)
        finally:
            # finally también se ejecuta si el proveedor falla o el JSON no es válido.
            provider.close()
        print(response.model_dump_json())
    except Exception as exc:
        if isinstance(exc, SupportError):
            code, message = exc.code, str(exc)
        elif isinstance(exc, ValidationError):
            code, message = "validation_error", "Entrada o configuración inválida."
        else:
            code, message = "internal_error", "No se pudo completar la consulta."
        # La terminal recibe diagnósticos estables, sin mensajes crudos del SDK ni credenciales.
        print(
            json.dumps({"error": {"code": code, "message": message}}, ensure_ascii=False),
            file=sys.stderr,
        )
        raise SystemExit(2) from None
