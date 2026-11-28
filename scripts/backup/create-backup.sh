#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

required=(NR_BACKUP_PROJECT_REF NR_BACKUP_DATABASE_URL NR_BACKUP_STORAGE_SERVICE_KEY NR_BACKUP_AGE_RECIPIENT NR_BACKUP_S3_ENDPOINT NR_BACKUP_S3_BUCKET NR_BACKUP_S3_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Falta la variable requerida: %s\n' "$name" >&2
    exit 2
  fi
done

for tool in supabase age aws psql node; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Falta la herramienta: %s\n' "$tool" >&2; exit 2; }
done

# No imprime la URL porque contiene el usuario y la contraseña PostgreSQL.
node --input-type=module <<'NODE'
const ref = process.env.NR_BACKUP_PROJECT_REF;
const raw = process.env.NR_BACKUP_DATABASE_URL;
if (!/^[a-z0-9]{20}$/.test(ref || '')) throw new Error('NR_BACKUP_PROJECT_REF no es una referencia Supabase válida.');
let parsed;
try { parsed = new URL(raw); } catch { throw new Error('NR_BACKUP_DATABASE_URL no es una URL válida.'); }
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('La conexión debe utilizar postgres:// o postgresql://.');
const directHost = parsed.hostname === `db.${ref}.supabase.co`;
const poolerHost = /^[a-z0-9-]+\.pooler\.supabase\.com$/i.test(parsed.hostname)
  && decodeURIComponent(parsed.username) === `postgres.${ref}`;
if (!directHost && !poolerHost) throw new Error('La conexión debe ser la directa del proyecto o su Session Pooler con usuario postgres.<PROJECT_REF>.');
if (!parsed.password) throw new Error('La URL PostgreSQL no contiene contraseña.');
if (!/^age1[0-9a-z]{30,}$/i.test(process.env.NR_BACKUP_AGE_RECIPIENT || '')) throw new Error('NR_BACKUP_AGE_RECIPIENT no parece una clave pública age.');
if (!/^https:\/\//i.test(process.env.NR_BACKUP_S3_ENDPOINT || '')) throw new Error('NR_BACKUP_S3_ENDPOINT debe ser HTTPS.');
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(process.env.NR_BACKUP_S3_BUCKET || '')) throw new Error('NR_BACKUP_S3_BUCKET no tiene un nombre válido.');
const prefix = process.env.NR_BACKUP_S3_PREFIX || 'nuestro-rincon';
if (!/^[A-Za-z0-9/_-]+$/.test(prefix) || prefix.includes('..') || prefix.startsWith('/') || prefix.endsWith('/')) {
  throw new Error('NR_BACKUP_S3_PREFIX contiene caracteres o segmentos no permitidos.');
}
NODE

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

project_ref="$NR_BACKUP_PROJECT_REF"
created_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
stamp="$(date -u +'%Y%m%dT%H%M%SZ')"
month="$(date -u +'%Y-%m')"
day="$(date -u +'%d')"
base="nuestro-rincon-${project_ref}-${stamp}"

read_migration_history() {
  psql "$NR_BACKUP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc \
    "select coalesce(jsonb_agg(jsonb_build_object('version', version, 'name', name) order by version), '[]'::jsonb)::text from supabase_migrations.schema_migrations;"
}

read_row_counts() {
  psql "$NR_BACKUP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc \
    "select jsonb_build_object(\
      'app_users',(select count(*) from public.app_users),\
      'letters',(select count(*) from public.letters),\
      'letter_threads',(select count(*) from public.letter_threads),\
      'user_sessions',(select count(*) from public.user_sessions),\
      'user_recovery_codes',(select count(*) from public.user_recovery_codes),\
      'notifications',(select count(*) from public.notifications)\
    )::text;"
}

printf 'Contando registros de control antes de la exportación…\n'
row_counts_before="$(read_row_counts)"
migration_history_before="$(read_migration_history)"

printf 'Generando exportación lógica del proyecto %s…\n' "$project_ref"
# roles.sql puede quedar vacío si no hay roles personalizados exportables; schema y data no.
supabase db dump --remote="$NR_BACKUP_DATABASE_URL" --role-only --file "$work_dir/roles.sql"
supabase db dump --remote="$NR_BACKUP_DATABASE_URL" --schema public --file "$work_dir/schema.sql"
supabase db dump --remote="$NR_BACKUP_DATABASE_URL" --schema public --data-only --use-copy \
  --file "$work_dir/data.sql"

# Dos ejecuciones separadas de db dump no comparten una misma instantánea PostgreSQL.
# Repetir el esquema y los contadores detecta cambios de DDL y variaciones netas de
# cardinalidad durante el intervalo; si los detecta, no publica un backup dudoso.
supabase db dump --remote="$NR_BACKUP_DATABASE_URL" --schema public --file "$work_dir/schema-after.sql"
if ! cmp -s "$work_dir/schema.sql" "$work_dir/schema-after.sql"; then
  echo 'El esquema public cambió durante la exportación. Se cancela la copia y debe reintentarse.' >&2
  exit 1
fi
row_counts_after="$(read_row_counts)"
migration_history_after="$(read_migration_history)"
if [[ "$row_counts_before" != "$row_counts_after" ]]; then
  echo 'Cambió el número de registros de control durante la exportación. Se cancela la copia y debe reintentarse.' >&2
  exit 1
fi
if [[ "$migration_history_before" != "$migration_history_after" ]]; then
  echo 'El historial de migraciones cambió durante la exportación. Se cancela la copia y debe reintentarse.' >&2
  exit 1
fi

printf 'Exportando objetos privados de Storage con manifiesto SHA-256…\n'
storage_summary="$(node "$(dirname "$0")/storage-objects.mjs" backup "$work_dir")"

NR_BACKUP_ROW_COUNTS="$row_counts_after" NR_BACKUP_MIGRATION_HISTORY="$migration_history_after" NR_BACKUP_STORAGE_SUMMARY="$storage_summary" NR_BACKUP_CREATED_AT="$created_at" node --input-type=module <<'NODE' > "$work_dir/manifest.json"
const rowCounts = JSON.parse(process.env.NR_BACKUP_ROW_COUNTS || 'null');
if (!rowCounts || typeof rowCounts !== 'object' || Array.isArray(rowCounts)) throw new Error('No se pudieron obtener los recuentos de verificación.');
for (const key of ['app_users','letters','letter_threads','user_sessions','user_recovery_codes','notifications']) {
  if (!Number.isSafeInteger(rowCounts[key]) || rowCounts[key] < 0) throw new Error(`Recuento inválido para ${key}.`);
}
const migrationHistory = JSON.parse(process.env.NR_BACKUP_MIGRATION_HISTORY || 'null');
if (!Array.isArray(migrationHistory) || migrationHistory.some(item =>
  !/^\d{14}$/.test(String(item?.version || '')) || (item?.name !== null && item?.name !== undefined && (typeof item.name !== 'string' || item.name.length > 160))
)) throw new Error('El historial de migraciones no tiene un formato válido.');
const storage = JSON.parse(process.env.NR_BACKUP_STORAGE_SUMMARY || 'null');
if (!storage || !Number.isSafeInteger(storage.objectCount) || storage.objectCount < 0
  || !Number.isSafeInteger(storage.totalBytes) || storage.totalBytes < 0) {
  throw new Error('No se pudo validar el manifiesto de Storage.');
}
const manifest = {
  format: 'nuestro-rincon-logical-backup',
  formatVersion: 2,
  projectRef: process.env.NR_BACKUP_PROJECT_REF,
  createdAt: process.env.NR_BACKUP_CREATED_AT,
  scope: 'public+private-media',
  components: ['roles.sql','schema.sql','data.sql','storage-manifest.json'],
  rowCounts,
  migrationHistory,
  storage: { bucket: 'private-media', objectCount: storage.objectCount, totalBytes: storage.totalBytes, manifest: 'storage-manifest.json' },
  encryption: 'age',
  consistencyChecks: ['public-schema-identical-before-and-after-data-export','six-domain-table-counts-identical-before-and-after-export','migration-ledger-identical-before-and-after-export','storage-objects-downloaded-and-sha256-verified'],
  notes: [
    'Logical dump generated with Supabase CLI.',
    'Supabase-managed database schemas are excluded by Supabase CLI.',
    'Private Storage object bytes are included as storage/objects and protected by a SHA-256 manifest.',
    'migrationHistory is archival metadata only; it is not restored into the target migration ledger.',
    'Data rows are exported by a single pg_dump data-only operation.',
    'The backup is accepted only when the public schema dump and six control counts remain stable during export.',
    'The Storage API export is enumerated recursively; unsupported paths or MIME types abort the backup instead of being silently omitted.',
    'Restore only into a fresh isolated Supabase project after reviewing the runbook.'
  ]
};
if (!/^[a-z0-9]{20}$/.test(manifest.projectRef || '') || !Number.isFinite(Date.parse(manifest.createdAt))) {
  throw new Error('Metadatos de origen inválidos.');
}
process.stdout.write(`${JSON.stringify(manifest,null,2)}\n`);
NODE

for file in roles.sql schema.sql data.sql manifest.json; do
  if [[ ! -f "$work_dir/$file" ]]; then
    printf 'La exportación no creó el archivo requerido: %s\n' "$file" >&2
    exit 1
  fi
done
for file in schema.sql data.sql manifest.json storage-manifest.json; do
  if [[ ! -s "$work_dir/$file" ]]; then
    printf 'La exportación produjo un archivo vacío: %s\n' "$file" >&2
    exit 1
  fi
done

archive="$work_dir/${base}.tar.gz"
tar -C "$work_dir" -czf "$archive" roles.sql schema.sql data.sql manifest.json storage-manifest.json storage/objects
encrypted="$work_dir/${base}.tar.gz.age"
age -r "$NR_BACKUP_AGE_RECIPIENT" -o "$encrypted" "$archive"
test -s "$encrypted"

checksum="$(sha256sum "$encrypted" | awk '{print $1}')"
prefix="${NR_BACKUP_S3_PREFIX:-nuestro-rincon}"
daily_key="${prefix}/daily/${base}.tar.gz.age"
checksum_file="$work_dir/${base}.tar.gz.age.sha256"
printf '%s  %s\n' "$checksum" "${base}.tar.gz.age" > "$checksum_file"

upload_and_verify() {
  local object_key="$1"
  aws s3 cp "$encrypted" "s3://${NR_BACKUP_S3_BUCKET}/${object_key}" \
    --endpoint-url "$NR_BACKUP_S3_ENDPOINT" \
    --region "$NR_BACKUP_S3_REGION" \
    --only-show-errors \
    --metadata "project-ref=${project_ref},format=age-encrypted"
  aws s3 cp "$checksum_file" "s3://${NR_BACKUP_S3_BUCKET}/${object_key}.sha256" \
    --endpoint-url "$NR_BACKUP_S3_ENDPOINT" \
    --region "$NR_BACKUP_S3_REGION" \
    --only-show-errors
  aws s3api head-object --bucket "$NR_BACKUP_S3_BUCKET" --key "$object_key" \
    --endpoint-url "$NR_BACKUP_S3_ENDPOINT" --region "$NR_BACKUP_S3_REGION" >/dev/null
  aws s3 cp "s3://${NR_BACKUP_S3_BUCKET}/${object_key}" "$work_dir/roundtrip.age" \
    --endpoint-url "$NR_BACKUP_S3_ENDPOINT" \
    --region "$NR_BACKUP_S3_REGION" --only-show-errors
  local downloaded_checksum
  downloaded_checksum="$(sha256sum "$work_dir/roundtrip.age" | awk '{print $1}')"
  if [[ "$downloaded_checksum" != "$checksum" ]]; then
    echo 'El objeto descargado no coincide con el archivo cifrado subido.' >&2
    return 1
  fi
  aws s3 cp "s3://${NR_BACKUP_S3_BUCKET}/${object_key}.sha256" "$work_dir/roundtrip.sha256" \
    --endpoint-url "$NR_BACKUP_S3_ENDPOINT" --region "$NR_BACKUP_S3_REGION" --only-show-errors
  local uploaded_sidecar_hash
  uploaded_sidecar_hash="$(awk 'NR==1 {print $1}' "$work_dir/roundtrip.sha256")"
  if [[ "$uploaded_sidecar_hash" != "$checksum" ]]; then
    echo 'El checksum remoto no coincide con el artefacto cifrado.' >&2
    return 1
  fi
  printf 'Verificado: s3://%s/%s\n' "$NR_BACKUP_S3_BUCKET" "$object_key"
}

printf 'Subiendo respaldo cifrado al almacenamiento externo…\n'
upload_and_verify "$daily_key"

# Una copia de inicio de mes tiene ruta propia para aplicar una retención mensual mayor.
if [[ "$day" == '01' ]]; then
  monthly_key="${prefix}/monthly/${month}/${base}.tar.gz.age"
  upload_and_verify "$monthly_key"
fi

printf 'Respaldo cifrado verificado por descarga de ida y vuelta + SHA-256.\n'
printf 'Proyecto: %s\nFecha UTC: %s\nObjeto diario: s3://%s/%s\nSHA-256 del objeto cifrado: %s\n' \
  "$project_ref" "$created_at" "$NR_BACKUP_S3_BUCKET" "$daily_key" "$checksum"
