#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

required=(NR_RECONCILE_PROJECT_REF NR_RECONCILE_DATABASE_URL)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Falta la variable requerida: %s\n' "$name" >&2
    exit 2
  fi
done
for tool in psql node; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Falta la herramienta: %s\n' "$tool" >&2; exit 2; }
done

node --input-type=module <<'NODE'
const ref = process.env.NR_RECONCILE_PROJECT_REF;
let parsed;
try { parsed = new URL(process.env.NR_RECONCILE_DATABASE_URL); }
catch { throw new Error('NR_RECONCILE_DATABASE_URL no es una URL válida.'); }
if (!/^[a-z0-9]{20}$/.test(ref || '')) throw new Error('NR_RECONCILE_PROJECT_REF no es una referencia Supabase válida.');
const directHost = parsed.hostname === `db.${ref}.supabase.co`;
const poolerHost = /^[a-z0-9-]+\.pooler\.supabase\.com$/i.test(parsed.hostname)
  && decodeURIComponent(parsed.username) === `postgres.${ref}`;
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || (!directHost && !poolerHost) || !parsed.password) {
  throw new Error('La URL debe corresponder exactamente al proyecto/ref indicado y contener contraseña.');
}
NODE

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

# Defensa adicional: fuerza transacciones de solo lectura también en el cliente.
export PGOPTIONS="${PGOPTIONS:+${PGOPTIONS} }-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=3000"
psql "$NR_RECONCILE_DATABASE_URL" \
  -X -q -t -A -v ON_ERROR_STOP=1 \
  -f "$root_dir/supabase/diagnostics/reconciliation-readonly.sql" \
  > "$work_dir/remote.json"

NR_RECONCILE_PROJECT_REF="$NR_RECONCILE_PROJECT_REF" \
  node "$root_dir/tools/render-reconciliation-report.mjs" "$work_dir/remote.json" "$root_dir"
