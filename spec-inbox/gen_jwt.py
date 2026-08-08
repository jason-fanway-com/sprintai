#!/usr/bin/env python3
"""Generate Supabase JWTs for tenant isolation testing."""
import hmac, hashlib, base64, json, time, sys

JWT_SECRET = "29f034d5e74255b81b5c8151a53f86d7cc56da867335a782d5cd7be61bf7ddb2"
REF = "rvdqfxtrskxekfkqnegx"

def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def make_jwt(sub: str, role: str, app_tenant_id: str, user_tenant_id: str = None, is_admin: bool = False):
    now = int(time.time())
    payload = {
        "sub": sub,
        "iss": "supabase",
        "ref": REF,
        "aud": "authenticated",
        "role": "authenticated",
        "iat": now,
        "exp": now + 3600,
        "email": f"test-{sub[:8]}@sprintai-test.com",
        "app_metadata": {
            "role": role,
            "tenant_id": app_tenant_id,
            "provider": "email",
            "providers": ["email"]
        },
        "user_metadata": {
            "tenant_id": user_tenant_id or app_tenant_id
        }
    }
    if is_admin:
        payload["user_metadata"]["is_admin"] = True
    
    header = {"alg": "HS256", "typ": "JWT"}
    h = b64(json.dumps(header, separators=(",", ":")).encode())
    p = b64(json.dumps(payload, separators=(",", ":")).encode())
    msg = f"{h}.{p}".encode()
    sig_bytes = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{h}.{p}.{b64(sig_bytes)}"

if __name__ == "__main__":
    import sys
    # NJB shop_owner
    njb = make_jwt(
        "8316efed-65d5-44c1-9067-077e95679ccc",
        "shop_owner",
        "a0000000-0000-0000-0000-000000000001"
    )
    # Super admin
    sa = make_jwt(
        "1361d386-3617-4488-8f73-0b341b833280",
        "super_admin",
        "a0000000-0000-0000-0000-000000000001",
        is_admin=True
    )
    # NJB spoofing user_metadata to claim Melvin's tenant
    spoof = make_jwt(
        "8316efed-65d5-44c1-9067-077e95679ccc",
        "shop_owner",
        "a0000000-0000-0000-0000-000000000001",
        user_tenant_id="7d806f0c-feba-4983-9697-a5940c8990ef"
    )
    
    print(f"NJB_TOKEN={njb}")
    print(f"SA_TOKEN={sa}")
    print(f"SPOOF_TOKEN={spoof}")