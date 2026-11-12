"""Reject unconfigured or privileged credentials before producing a Release app."""
import base64
import json
import os
import sys
from urllib.parse import urlsplit


def validate(values):
    for name in ("SUPABASE_URL", "LATER_API_BASE_URL"):
        raw = values.get(name, "")
        url = urlsplit(raw)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.query or url.fragment or "your_" in raw.lower()):
            raise ValueError(name + " must be a configured HTTPS URL")
    key = values.get("SUPABASE_ANON_KEY", "")
    if key.startswith("sb_publishable_") and len(key) > 20:
        return
    try:
        pieces = key.split(".")
        if len(pieces) != 3:
            raise ValueError()
        payload = pieces[1] + "=" * (-len(pieces[1]) % 4)
        role = json.loads(base64.urlsafe_b64decode(payload))["role"]
        if role != "anon":
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ValueError("SUPABASE_ANON_KEY must be a public anon or publishable key") from None


def test_validation():
    valid = {"SUPABASE_URL": "https://project.supabase.co",
             "LATER_API_BASE_URL": "https://notfor.now",
             "SUPABASE_ANON_KEY": "sb_publishable_test_fixture"}
    validate(valid)
    for name, value in [("SUPABASE_URL", "https://YOUR_PROJECT.supabase.co"),
                        ("SUPABASE_URL", "http://project.supabase.co"),
                        ("LATER_API_BASE_URL", ""),
                        ("SUPABASE_ANON_KEY", "YOUR_SUPABASE_PUBLIC_ANON_KEY"),
                        ("SUPABASE_ANON_KEY", "sb_secret_forbidden"),
                        ("SUPABASE_ANON_KEY", "x.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x")]:
        try:
            validate({**valid, name: value})
        except ValueError:
            continue
        raise AssertionError("Release accepted invalid " + name)
    print("auth-config: valid public configuration and six rejection cases passed")


if __name__ == "__main__":
    if "--test" in sys.argv:
        test_validation()
    elif os.environ.get("CONFIGURATION") == "Release":
        try:
            validate(os.environ)
        except ValueError as error:
            print("error: Later Release sign-in configuration: " + str(error)
                  + ". Provide ios/Config/Secrets.xcconfig from Secrets.example.xcconfig.",
                  file=sys.stderr)
            sys.exit(1)
