import pytest

from satellite_fleet.principal import (
    InvalidPrincipalError,
    Principal,
    sign_principal,
    verify_principal,
)

SECRET = "test-secret"
DANA = Principal(
    sub="dana@acme.example",
    tenant_id="acme",
    audience="internal",
    scopes=("fleet.read",),
)


def test_round_trips_a_principal() -> None:
    assert verify_principal(sign_principal(DANA, SECRET), SECRET) == DANA


# The architecture's central security claim is that a satellite authorizes
# independently rather than trusting the hub. That is only true if the satellite
# verifies the identity it is handed — these tests are what make it real.
def test_rejects_a_token_signed_with_a_different_secret() -> None:
    forged = sign_principal(DANA, "not-the-secret")
    with pytest.raises(InvalidPrincipalError):
        verify_principal(forged, SECRET)


def test_rejects_a_tampered_payload() -> None:
    import base64
    import json

    token = sign_principal(DANA, SECRET)
    signature = token.split(".")[1]
    swapped = (
        base64.urlsafe_b64encode(
            json.dumps({**DANA.to_claims(), "tenantId": "globex"}).encode()
        )
        .rstrip(b"=")
        .decode()
    )
    with pytest.raises(InvalidPrincipalError):
        verify_principal(f"{swapped}.{signature}", SECRET)


@pytest.mark.parametrize("bad", ["", "no-dot", "a.b.c", "....", "!!!.???", ".", "x."])
def test_rejects_malformed_tokens(bad: str) -> None:
    with pytest.raises(InvalidPrincipalError):
        verify_principal(bad, SECRET)


def test_rejects_a_correctly_signed_token_carrying_a_nonsense_principal() -> None:
    import base64
    import hashlib
    import hmac
    import json

    payload = (
        base64.urlsafe_b64encode(json.dumps({"nope": True}).encode()).rstrip(b"=").decode()
    )
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest()
        )
        .rstrip(b"=")
        .decode()
    )
    with pytest.raises(InvalidPrincipalError):
        verify_principal(f"{payload}.{signature}", SECRET)


class TestCrossLanguageContract:
    """The polyglot claim is only real if the wire format actually crosses.

    This token was minted by the TypeScript implementation in
    `apps/satellite-orders/src/principal.ts` under the secret below. If a change
    to either side breaks this, the two satellites have silently stopped
    speaking the same protocol — which no single-language test would catch.

    Regenerate with:
        node -e 'const{createHmac}=require("crypto");
          const p={sub:"dana@acme.example",tenantId:"acme",
                   audience:"internal",scopes:["fleet.read"]};
          const b=Buffer.from(JSON.stringify(p),"utf8").toString("base64url");
          console.log(b+"."+createHmac("sha256","cross-language-fixture")
            .update(b).digest("base64url"))'
    """

    SECRET = "cross-language-fixture"
    TOKEN = (
        "eyJzdWIiOiJkYW5hQGFjbWUuZXhhbXBsZSIsInRlbmFudElkIjoiYWNtZSIsImF1ZGllbmNlIjoi"
        "aW50ZXJuYWwiLCJzY29wZXMiOlsiZmxlZXQucmVhZCJdfQ"
        ".rSTY_1hMvKQ4VQkFl21Ei26LRebW6RbGcxYaz5Bd2iU"
    )

    def test_verifies_a_token_minted_by_the_typescript_satellite(self) -> None:
        principal = verify_principal(self.TOKEN, self.SECRET)
        assert principal.tenant_id == "acme"
        assert principal.sub == "dana@acme.example"
        assert principal.audience == "internal"
        assert principal.scopes == ("fleet.read",)

    def test_that_token_still_fails_under_a_different_secret(self) -> None:
        with pytest.raises(InvalidPrincipalError):
            verify_principal(self.TOKEN, "some-other-secret")
