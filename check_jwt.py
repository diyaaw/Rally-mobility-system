"""
Verify JWT validation independently of DB.
Reads token from a file to avoid passing it as an argument.
Run: python check_jwt.py <token_file>
"""
import sys
import json
import pathlib

# Read the token from stdin to avoid exposing it in process args
token_b64_file = sys.argv[1] if len(sys.argv) > 1 else None

# Instead: use the backend's own security module
import os
os.chdir(r'c:\rally\rally\backend')
sys.path.insert(0, r'c:\rally\rally\backend')

# pyrefly: ignore[missing-import]
from app.core.security import decode_supabase_jwt, InvalidTokenError
# pyrefly: ignore[missing-import]
from app.core.config import settings

print(f"SUPABASE_URL configured: {'YES' if settings.SUPABASE_URL else 'NO'}")
print(f"JWT_ALGORITHM: {settings.JWT_ALGORITHM}")
print(f"JWT_SECRET present: {'YES' if settings.JWT_SECRET else 'NO'}")
print(f"JWKS URL will be: {settings.SUPABASE_URL}/auth/v1/.well-known/jwks.json")

# Read token from file (token file path passed as arg)
if token_b64_file and pathlib.Path(token_b64_file).exists():
    token = pathlib.Path(token_b64_file).read_text().strip()
    print(f"\nToken length: {len(token)}")
    
    # Decode header without verification
    import base64
    parts = token.split('.')
    header_raw = parts[0] + '=='  # pad
    header = json.loads(base64.b64decode(header_raw.replace('-', '+').replace('_', '/')))
    print(f"Token header alg: {header.get('alg')}")
    print(f"Token header kid: {header.get('kid', '(none)')}")
    
    print("\nAttempting signature verification via JWKS...")
    try:
        claims = decode_supabase_jwt(token)
        sub = claims.get('sub', '')
        print(f"VERIFICATION: PASS")
        print(f"  sub (first 8): {sub[:8]}...")
        print(f"  email: {claims.get('email')}")
        print(f"  aud: {claims.get('aud')}")
        print(f"  iss: {claims.get('iss')}")
        import datetime
        exp = claims.get('exp')
        if exp:
            print(f"  exp: {datetime.datetime.fromtimestamp(exp).isoformat()}")
        print(f"  role: {claims.get('role')}")
    except InvalidTokenError as e:
        print(f"VERIFICATION: FAIL — {e}")
    except Exception as e:
        print(f"VERIFICATION: ERROR — {type(e).__name__}: {e}")
else:
    print("No token file provided. Provide path to a file containing the JWT as argument.")
    print("Usage: python check_jwt.py <path_to_token_file>")

