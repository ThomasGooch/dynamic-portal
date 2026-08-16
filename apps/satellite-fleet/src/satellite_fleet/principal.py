"""Principal verification.

The satellite verifies the identity it is handed. It does not trust the hub.

This is the architecture's central security claim: authorization lives in the
satellite, so a hub bug is an availability incident rather than a cross-tenant
disclosure. That is only true if the satellite actually checks the signature.

The wire format is shared with the TypeScript satellite
(``apps/satellite-orders/src/principal.ts``) — base64url(JSON) ``.``
base64url(HMAC-SHA256). Note that verification runs over the *received* payload
string and never re-serializes it: JSON key order differs between languages, so
re-encoding before comparing would break every cross-language token.

The prototype uses a shared HMAC secret. Production swaps this for verifying an
RFC 8693 exchanged token against the issuer's JWKS; the ``Principal`` shape and
the call sites do not change.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Any, Literal

Audience = Literal["internal", "external"]
_AUDIENCES: frozenset[str] = frozenset({"internal", "external"})


class InvalidPrincipalError(Exception):
    """Raised whenever a token cannot be trusted, for any reason."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"Invalid principal token: {reason}")


@dataclass(frozen=True, slots=True)
class Principal:
    sub: str
    tenant_id: str
    audience: Audience
    scopes: tuple[str, ...]

    def to_claims(self) -> dict[str, Any]:
        """The on-the-wire shape, which is camelCase to match TypeScript."""
        return {
            "sub": self.sub,
            "tenantId": self.tenant_id,
            "audience": self.audience,
            "scopes": list(self.scopes),
        }


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    # base64url on the wire is unpadded; restore padding before decoding.
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _sign(payload: str, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), payload.encode("ascii"), hashlib.sha256)
    return _b64url_encode(digest.digest())


def sign_principal(principal: Principal, secret: str) -> str:
    payload = _b64url_encode(
        json.dumps(principal.to_claims(), separators=(",", ":")).encode("utf-8")
    )
    return f"{payload}.{_sign(payload, secret)}"


def _parse_claims(decoded: object) -> Principal:
    if not isinstance(decoded, dict):
        raise InvalidPrincipalError("payload is not an object")

    sub, tenant_id = decoded.get("sub"), decoded.get("tenantId")
    audience, scopes = decoded.get("audience"), decoded.get("scopes")

    if not isinstance(sub, str) or not sub:
        raise InvalidPrincipalError("payload is not a principal")
    if not isinstance(tenant_id, str) or not tenant_id:
        raise InvalidPrincipalError("payload is not a principal")
    if audience not in _AUDIENCES:
        raise InvalidPrincipalError("payload is not a principal")
    if not isinstance(scopes, list) or not all(
        isinstance(s, str) and s for s in scopes
    ):
        raise InvalidPrincipalError("payload is not a principal")

    return Principal(
        sub=sub,
        tenant_id=tenant_id,
        audience=audience,  # type: ignore[arg-type]
        scopes=tuple(scopes),
    )


def verify_principal(token: str, secret: str) -> Principal:
    parts = token.split(".")
    if len(parts) != 2:
        raise InvalidPrincipalError("expected <payload>.<signature>")

    payload, signature = parts
    if not payload or not signature:
        raise InvalidPrincipalError("empty segment")

    # Constant-time, and over the payload exactly as received.
    if not hmac.compare_digest(_sign(payload, secret), signature):
        raise InvalidPrincipalError("signature mismatch")

    try:
        decoded = json.loads(_b64url_decode(payload))
    except (ValueError, binascii.Error) as exc:
        raise InvalidPrincipalError("payload is not JSON") from exc

    return _parse_claims(decoded)
