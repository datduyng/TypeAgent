# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

import argparse
import contextlib
import json
import math
import os
import struct
import sys
from typing import Any

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 1024 * 1024
ENCODER_MAX_POSITIONS = 512
GLINER_VERSION = "2.0.0"
TRANSFORMERS_VERSION = "4.45.2"
MODEL_REVISION = "1cb4166094dc58fa8d836429f060d6c95f62b495"
THRESHOLD = 0.5
LABELS = [
    "person",
    "full_name",
    "first_name",
    "middle_name",
    "last_name",
    "date_of_birth",
    "email",
    "phone_number",
    "address",
    "street_address",
    "city",
    "state_or_region",
    "postal_code",
    "country",
    "government_id",
    "national_id_number",
    "passport_number",
    "drivers_license_number",
    "license_number",
    "tax_id",
    "tax_number",
    "bank_account",
    "account_number",
    "routing_number",
    "iban",
    "payment_card",
    "card_number",
    "card_expiry",
    "card_cvv",
    "username",
    "ip_address",
    "account_id",
    "sensitive_account_id",
    "password",
    "secret",
    "api_key",
    "access_token",
    "recovery_code",
    "sensitive_date",
    "document_date",
    "expiration_date",
    "transaction_date",
]


class InputTooLargeError(Exception):
    pass


def read_exact(size: int) -> bytes | None:
    data = bytearray()
    while len(data) < size:
        chunk = sys.stdin.buffer.read(size - len(data))
        if not chunk:
            if not data:
                return None
            raise EOFError
        data.extend(chunk)
    return bytes(data)


def read_frame() -> Any | None:
    header = read_exact(4)
    if header is None:
        return None
    (size,) = struct.unpack(">I", header)
    if size == 0 or size > MAX_FRAME_BYTES:
        raise ValueError
    payload = read_exact(size)
    if payload is None:
        raise EOFError
    return json.loads(payload.decode("utf-8"))


def write_frame(message: dict[str, Any]) -> None:
    payload = json.dumps(
        message, ensure_ascii=True, allow_nan=False, separators=(",", ":")
    ).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise ValueError
    sys.stdout.buffer.write(struct.pack(">I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def request_id(message: Any) -> int | None:
    if not isinstance(message, dict):
        return None
    value = message.get("id")
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def validate_request(message: Any) -> tuple[int, str]:
    identifier = request_id(message)
    if (
        identifier is None
        or message.get("protocol") != PROTOCOL_VERSION
        or message.get("type") != "redact"
        or not isinstance(message.get("text"), str)
        or message.get("labels") != LABELS
        or isinstance(message.get("threshold"), bool)
        or message.get("threshold") != THRESHOLD
    ):
        raise ValueError
    return identifier, message["text"]


def ensure_context_fits(model: Any, text: str) -> None:
    schema = model.create_schema().entities(LABELS)
    batch = model.processor.collate_fn_inference(
        [(text, schema)],
        error_policy="raise",
        architecture=model.architecture,
    )
    if len(batch.original_lengths) != 1:
        raise RuntimeError
    if batch.original_lengths[0] > ENCODER_MAX_POSITIONS:
        raise InputTooLargeError


def utf16_offsets(text: str, positions: set[int]) -> dict[int, int]:
    offsets: dict[int, int] = {}
    units = 0
    for index, character in enumerate(text):
        if index in positions:
            offsets[index] = units
        units += 2 if ord(character) > 0xFFFF else 1
    if len(text) in positions:
        offsets[len(text)] = units
    if len(offsets) != len(positions):
        raise ValueError
    return offsets


def extract_spans(model: Any, text: str) -> list[dict[str, Any]]:
    with (
        open(os.devnull, "w", encoding="utf-8") as sink,
        contextlib.redirect_stdout(sink),
    ):
        ensure_context_fits(model, text)
        import torch

        with torch.inference_mode():
            result = model.extract_entities(
                text,
                LABELS,
                threshold=THRESHOLD,
                include_confidence=True,
                include_spans=True,
            )
    if not isinstance(result, dict) or not isinstance(result.get("entities"), dict):
        raise ValueError

    code_point_spans: list[tuple[str, int, int, float]] = []
    positions: set[int] = set()
    entities = result["entities"]
    for label, values in entities.items():
        if label not in LABELS or not isinstance(values, list):
            raise ValueError
        for value in values:
            if not isinstance(value, dict):
                raise ValueError
            start = value.get("start")
            end = value.get("end")
            confidence = value.get("confidence")
            if (
                isinstance(start, bool)
                or not isinstance(start, int)
                or isinstance(end, bool)
                or not isinstance(end, int)
                or isinstance(confidence, bool)
                or not isinstance(confidence, (int, float))
                or not math.isfinite(confidence)
                or start < 0
                or start >= end
                or end > len(text)
            ):
                raise ValueError
            positions.update((start, end))
            code_point_spans.append((label, start, end, float(confidence)))

    offsets = utf16_offsets(text, positions)
    return [
        {
            "label": label,
            "start": offsets[start],
            "end": offsets[end],
            "confidence": confidence,
        }
        for label, start, end, confidence in code_point_spans
    ]


def load_model(model_path: str) -> Any:
    if not os.path.isabs(model_path) or not os.path.isdir(model_path):
        raise ValueError

    import transformers
    from gliner2 import AutoExtractor, __version__

    if (
        __version__ != GLINER_VERSION
        or transformers.__version__ != TRANSFORMERS_VERSION
    ):
        raise RuntimeError
    with (
        open(os.devnull, "w", encoding="utf-8") as sink,
        contextlib.redirect_stdout(sink),
    ):
        model = AutoExtractor.from_pretrained(model_path, local_files_only=True)
    if model.encoder.config.max_position_embeddings != ENCODER_MAX_POSITIONS:
        raise RuntimeError
    return model


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model", required=True)
    arguments = parser.parse_args()
    model = load_model(arguments.model)
    write_frame(
        {
            "protocol": PROTOCOL_VERSION,
            "type": "ready",
            "glinerVersion": GLINER_VERSION,
            "transformersVersion": TRANSFORMERS_VERSION,
            "modelRevision": MODEL_REVISION,
            "labels": LABELS,
            "threshold": THRESHOLD,
        }
    )

    while True:
        message = read_frame()
        if message is None:
            return
        identifier = request_id(message)
        try:
            identifier, text = validate_request(message)
            spans = extract_spans(model, text)
            write_frame(
                {
                    "protocol": PROTOCOL_VERSION,
                    "type": "result",
                    "id": identifier,
                    "spans": spans,
                }
            )
        except InputTooLargeError:
            if identifier is None:
                raise
            write_frame(
                {
                    "protocol": PROTOCOL_VERSION,
                    "type": "error",
                    "id": identifier,
                    "code": "input_too_large",
                }
            )
        except Exception:
            if identifier is None:
                raise
            write_frame(
                {
                    "protocol": PROTOCOL_VERSION,
                    "type": "error",
                    "id": identifier,
                    "code": "inference_failed",
                }
            )


if __name__ == "__main__":
    main()
