#!/usr/bin/env bash
set -euo pipefail

# A reset is Supabase's supported clean migration workflow. Repeating it proves that
# the complete migration set deterministically recreates the same secure schema.
for pass in 1 2; do
  echo "migration verification pass ${pass}/2"
  supabase db reset --local
  supabase test db
done
