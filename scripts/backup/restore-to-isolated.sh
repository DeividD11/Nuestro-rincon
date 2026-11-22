#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

required=(NR_RESTORE_PROJECT_REF NR_RESTORE_DATABASE_URL NR_RESTORE_ENCRYPTED_FILE NR_RESTORE_AGE_IDENTITY NR_RESTORE_CONFIRM)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Falta la variable requerida: %s\n' "$name" >&2
    exit 2
  fi
done

production_ref='tiqbmuubpbmxqvtkcdhq'
if [[ "$NR_RESTORE_PROJECT_REF" == "$production_ref" ]]; then
  echo 'Bloqueado: el procedimiento de prueba nunca restaura sobre producción.' >&2
  exit 3
fi
if [[ "$NR_RESTORE_CONFIRM" != 'RESTORE_TO_ISOLATED_PROJECT' ]]; then
  echo 'Bloqueado: define NR_RESTORE_CONFIRM=RESTORE_TO_ISOLATED_PROJECT tras verificar que el destino es desechable.' >&2
  exit 3
fi
for tool in age psql tar node sha256sum diff; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Falta la herramienta: %s\n' "$tool" >&2; exit 2; }
done

node --input-type=module <<'NODE'
const ref = process.env.NR_RESTORE_PROJECT_REF;
let parsed;
try { parsed = new URL(process.env.NR_RESTORE_DATABASE_URL); } catch { throw new Error('NR_RESTORE_DATABASE_URL no es válida.'); }
if (!/^[a-z0-9]{20}$/.test(ref || '')) throw new Error('NR_RESTORE_PROJECT_REF no es válida.');
const directHost = parsed.hostname === `db.${ref}.supabase.co`;
const poolerHost = /^[a-z0-9-]+\.pooler\.supabase\.com$/i.test(parsed.hostname)
  && decodeURIComponent(parsed.username) === `postgres.${ref}`;
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || (!directHost && !poolerHost)) {
  throw new Error('La URL no coincide exactamente con el proyecto aislado indicado.');
}
if (!parsed.password) throw new Error('La conexión de destino no contiene contraseña.');
NODE

if [[ ! -f "$NR_RESTORE_ENCRYPTED_FILE" ]]; then echo 'No se encontró el respaldo cifrado.' >&2; exit 2; fi
checksum_file="${NR_RESTORE_CHECKSUM_FILE:-${NR_RESTORE_ENCRYPTED_FILE}.sha256}"
if [[ ! -f "$checksum_file" ]]; then echo 'No se encontró el archivo lateral SHA-256 del respaldo.' >&2; exit 2; fi
expected_checksum="$(awk 'NR==1 {print $1}' "$checksum_file")"
if [[ ! "$expected_checksum" =~ ^[a-fA-F0-9]{64}$ ]]; then echo 'El archivo lateral no contiene un SHA-256 válido.' >&2; exit 2; fi
actual_checksum="$(sha256sum "$NR_RESTORE_ENCRYPTED_FILE" | awk '{print $1}')"
if [[ "${actual_checksum,,}" != "${expected_checksum,,}" ]]; then
  echo 'El archivo cifrado no coincide con su SHA-256; se cancela la restauración.' >&2
  exit 3
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
identity_file="$work_dir/age-identity.txt"
printf '%s\n' "$NR_RESTORE_AGE_IDENTITY" > "$identity_file"
chmod 600 "$identity_file"

archive="$work_dir/backup.tar.gz"
age -d -i "$identity_file" -o "$archive" "$NR_RESTORE_ENCRYPTED_FILE"

mapfile -t archive_members < <(tar -tzf "$archive" | LC_ALL=C sort)
expected_members=($'data.sql' $'manifest.json' $'roles.sql' $'schema.sql')
if [[ "${archive_members[*]}" != "${expected_members[*]}" ]]; then
  echo 'El TAR no contiene exactamente los cuatro archivos esperados; se rechaza.' >&2
  exit 3
fi
tar -xzf "$archive" -C "$work_dir"

manifest_json="$(node --input-type=module - "$work_dir/manifest.json" <<'NODE'
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const requiredComponents = ['roles.sql','schema.sql','data.sql'];
if (manifest?.format !== 'nuestro-rincon-logical-backup'
  || manifest?.formatVersion !== 1
  || manifest?.scope !== 'public'
  || manifest?.encryption !== 'age'
  || !/^[a-z0-9]{20}$/.test(manifest?.projectRef || '')
  || !Number.isFinite(Date.parse(manifest?.createdAt || ''))
  || JSON.stringify(manifest?.components) !== JSON.stringify(requiredComponents)) {
  throw new Error('El manifiesto del respaldo no es compatible o está incompleto.');
}
if (manifest.migrationHistory !== undefined) {
  if (!Array.isArray(manifest.migrationHistory) || manifest.migrationHistory.some(item =>
    !/^\d{14}$/.test(String(item?.version || '')) || (item?.name !== null && item?.name !== undefined && (typeof item.name !== 'string' || item.name.length > 160))
  )) throw new Error('El historial de migraciones del manifiesto no es válido.');
}
const counts = manifest.rowCounts;
for (const key of ['app_users','letters','letter_threads','user_sessions','user_recovery_codes','notifications']) {
  if (!Number.isSafeInteger(counts?.[key]) || counts[key] < 0) throw new Error(`El manifiesto no contiene un recuento válido para ${key}.`);
}
process.stdout.write(JSON.stringify({projectRef:manifest.projectRef,rowCounts:counts,migrationHistoryCount:manifest.migrationHistory?.length ?? null}));
NODE
)"
manifest_ref="$(NR_RESTORE_MANIFEST="$manifest_json" node --input-type=module -e "const m=JSON.parse(process.env.NR_RESTORE_MANIFEST); process.stdout.write(m.projectRef)")"
if [[ "$manifest_ref" != "$NR_RESTORE_PROJECT_REF" && "${NR_RESTORE_ALLOW_CROSS_PROJECT:-NO}" != 'YES' ]]; then
  echo 'El ref de origen y destino son distintos. Para una restauración de prueba entre proyectos, revisa el runbook y define NR_RESTORE_ALLOW_CROSS_PROJECT=YES.' >&2
  exit 3
fi

# No se sobrescribe una base que ya tenga objetos de aplicación en public.
existing_objects="$(psql "$NR_RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc \
  "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S','f') and c.relname not in ('spatial_ref_sys','geometry_columns','geography_columns');")"
if [[ ! "$existing_objects" =~ ^[0-9]+$ ]] || (( existing_objects > 0 )); then
  echo 'El esquema public del destino no está vacío. Por seguridad, restaura solo en un proyecto de prueba recién creado.' >&2
  exit 3
fi

printf 'Restaurando en el proyecto aislado %s…\n' "$NR_RESTORE_PROJECT_REF"
cat > "$work_dir/restore-prepare.sql" <<'SQL'
-- Supabase recomienda revocar grants predeterminados antes de restaurar el esquema.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
-- El backend usa extensions.gen_random_bytes en el flujo de invitaciones.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
SQL
psql "$NR_RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
  -f "$work_dir/roles.sql" \
  -f "$work_dir/restore-prepare.sql" \
  -f "$work_dir/schema.sql" \
  --command 'SET session_replication_role = replica' \
  -f "$work_dir/data.sql"

# Una copia restaurada en otro proyecto es un entorno aislado: revoca las sesiones
# importadas para que ningún token de la copia original se pueda reutilizar allí.
psql "$NR_RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction --command \
  "with revoked as (update public.user_sessions set revoked_at = coalesce(revoked_at, now()), revocation_reason = coalesce(revocation_reason, 'isolated_backup_restore') where revoked_at is null returning id) update public.user_session_refresh_tokens r set revoked_at = coalesce(r.revoked_at, now()) from public.user_sessions s where r.session_id = s.id and s.revoked_at is not null and r.revoked_at is null;"

expected_counts="$(NR_RESTORE_MANIFEST="$manifest_json" node --input-type=module -e "const m=JSON.parse(process.env.NR_RESTORE_MANIFEST); process.stdout.write(JSON.stringify(m.rowCounts))")"
actual_counts="$(psql "$NR_RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc \
  "select jsonb_build_object(\
    'app_users',(select count(*) from public.app_users),\
    'letters',(select count(*) from public.letters),\
    'letter_threads',(select count(*) from public.letter_threads),\
    'user_sessions',(select count(*) from public.user_sessions),\
    'user_recovery_codes',(select count(*) from public.user_recovery_codes),\
    'notifications',(select count(*) from public.notifications)\
  )::text;")"
NR_RESTORE_EXPECTED_COUNTS="$expected_counts" NR_RESTORE_ACTUAL_COUNTS="$actual_counts" node --input-type=module <<'NODE'
const expected = JSON.parse(process.env.NR_RESTORE_EXPECTED_COUNTS || 'null');
const actual = JSON.parse(process.env.NR_RESTORE_ACTUAL_COUNTS || 'null');
if (!expected || !actual) throw new Error('No se pudieron comparar los recuentos restaurados.');
for (const key of ['app_users','letters','letter_threads','user_sessions','user_recovery_codes','notifications']) {
  if (Number(expected[key]) !== Number(actual[key])) {
    throw new Error(`El recuento restaurado no coincide para ${key}: esperado ${expected[key]}, recibido ${actual[key]}.`);
  }
}
NODE

printf 'Restauración aislada verificada: checksum, manifiesto y seis recuentos coinciden.\n'
printf 'Ejecuta además las pruebas pgTAP y de integración antes de considerar la copia recuperable.\n'
