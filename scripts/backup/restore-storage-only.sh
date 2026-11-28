#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

required=(NR_RESTORE_PROJECT_REF NR_RESTORE_ENCRYPTED_FILE NR_RESTORE_AGE_IDENTITY NR_RESTORE_STORAGE_SERVICE_KEY NR_RESTORE_STORAGE_CONFIRM)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Falta la variable requerida: %s\n' "$name" >&2
    exit 2
  fi
done
production_ref='tiqbmuubpbmxqvtkcdhq'
if [[ "$NR_RESTORE_PROJECT_REF" == "$production_ref" ]]; then
  echo 'Bloqueado: la restauración de objetos nunca escribe en producción.' >&2
  exit 3
fi
if [[ "$NR_RESTORE_STORAGE_CONFIRM" != 'RESTORE_STORAGE_TO_ISOLATED_PROJECT' ]]; then
  echo 'Bloqueado: confirma primero un destino Storage aislado y desechable.' >&2
  exit 3
fi
if [[ "${NR_RESTORE_ALLOW_CROSS_PROJECT:-NO}" != 'YES' ]]; then
  echo 'Para recuperar Storage desde un backup a otro proyecto aislado define NR_RESTORE_ALLOW_CROSS_PROJECT=YES.' >&2
  exit 3
fi
for tool in age tar node sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Falta la herramienta: %s\n' "$tool" >&2; exit 2; }
done

node --input-type=module <<'NODE'
const ref = process.env.NR_RESTORE_PROJECT_REF;
if (!/^[a-z0-9]{20}$/.test(ref || '')) throw new Error('NR_RESTORE_PROJECT_REF no es válida.');
if (String(process.env.NR_RESTORE_STORAGE_SERVICE_KEY || '').length < 20) throw new Error('La clave de Storage está vacía o no es válida.');
NODE

if [[ ! -f "$NR_RESTORE_ENCRYPTED_FILE" ]]; then echo 'No se encontró el respaldo cifrado.' >&2; exit 2; fi
checksum_file="${NR_RESTORE_CHECKSUM_FILE:-${NR_RESTORE_ENCRYPTED_FILE}.sha256}"
if [[ ! -f "$checksum_file" ]]; then echo 'No se encontró el archivo lateral SHA-256.' >&2; exit 2; fi
expected_checksum="$(awk 'NR==1 {print $1}' "$checksum_file")"
if [[ ! "$expected_checksum" =~ ^[a-fA-F0-9]{64}$ ]]; then echo 'El archivo lateral no contiene un SHA-256 válido.' >&2; exit 2; fi
actual_checksum="$(sha256sum "$NR_RESTORE_ENCRYPTED_FILE" | awk '{print $1}')"
if [[ "${actual_checksum,,}" != "${expected_checksum,,}" ]]; then
  echo 'El archivo cifrado no coincide con SHA-256.' >&2
  exit 3
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
identity_file="$work_dir/age-identity.txt"
printf '%s\n' "$NR_RESTORE_AGE_IDENTITY" > "$identity_file"
chmod 600 "$identity_file"
archive="$work_dir/backup.tar.gz"
age -d -i "$identity_file" -o "$archive" "$NR_RESTORE_ENCRYPTED_FILE"
archive_members="$(tar -tzf "$archive")"
while IFS= read -r member; do
  clean_member="${member%/}"
  if [[ -z "$clean_member" || "$clean_member" == *\\* ]]; then
    echo 'El TAR contiene una ruta insegura; se rechaza.' >&2
    exit 3
  fi
  case "$clean_member" in
    manifest.json|storage-manifest.json|storage|storage/objects|storage/objects/*) ;;
    *) echo "El TAR contiene un componente inesperado: $clean_member" >&2; exit 3 ;;
  esac
done <<< "$archive_members"
if ! tar -tvzf "$archive" | awk 'substr($1,1,1) !~ /^[-d]$/ { bad=1 } END { exit bad ? 1 : 0 }'; then
  echo 'El TAR contiene enlaces u objetos no regulares; se rechaza.' >&2
  exit 3
fi
tar -xzf "$archive" -C "$work_dir" --no-same-owner --no-same-permissions

NR_RESTORE_MANIFEST_PATH="$work_dir/manifest.json" NR_RESTORE_STORAGE_MANIFEST_PATH="$work_dir/storage-manifest.json" NR_RESTORE_ARCHIVE="$archive" node --input-type=module <<'NODE'
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const main = JSON.parse(fs.readFileSync(process.env.NR_RESTORE_MANIFEST_PATH, 'utf8'));
const storage = JSON.parse(fs.readFileSync(process.env.NR_RESTORE_STORAGE_MANIFEST_PATH, 'utf8'));
if (main?.format !== 'nuestro-rincon-logical-backup' || main.formatVersion !== 2
  || main.scope !== 'public+private-media' || main.encryption !== 'age'
  || !/^[a-z0-9]{20}$/.test(main.projectRef || '')) {
  throw new Error('Este archivo no es un backup v2 completo; no contiene el inventario de Storage esperado.');
}
if (main.projectRef !== process.env.NR_RESTORE_PROJECT_REF && process.env.NR_RESTORE_ALLOW_CROSS_PROJECT !== 'YES') {
  throw new Error('El proyecto de origen y destino no coinciden.');
}
if (storage?.format !== 'nuestro-rincon-storage-backup' || storage.formatVersion !== 1
  || storage.projectRef !== main.projectRef || storage.bucket !== 'private-media'
  || storage.objectCount !== main.storage?.objectCount || storage.totalBytes !== main.storage?.totalBytes
  || !Array.isArray(storage.objects) || storage.objects.length !== storage.objectCount
  || storage.objectCount > 100000 || !Number.isSafeInteger(storage.totalBytes) || storage.totalBytes > 10 * 1024 * 1024 * 1024) {
  throw new Error('Los manifiestos de DB y Storage no coinciden.');
}
const objectPaths = storage.objects.map(item => {
  if (typeof item?.path !== 'string' || item.path.startsWith('/') || item.path.includes('\\')
    || item.path.split('/').some(segment => !segment || segment === '.' || segment === '..')
    || !/^(?:[0-9a-f-]{36}\/avatars\/[0-9a-f-]{36}|letters\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36})\.(?:jpg|jpeg|png|webp)$/i.test(item.path)
    || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 5 * 1024 * 1024
    || !['image/jpeg','image/png','image/webp'].includes(item.contentType)
    || !/^[a-f0-9]{64}$/i.test(item.sha256 || '')) throw new Error('El manifiesto contiene un objeto inválido.');
  return `storage/objects/${item.path}`;
});
if (new Set(objectPaths).size !== objectPaths.length) throw new Error('El manifiesto repite rutas de Storage.');
const actualFiles = execFileSync('tar', ['-tzf', process.env.NR_RESTORE_ARCHIVE], { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean).filter(name => !name.endsWith('/')).sort();
const expectedFiles = ['manifest.json','storage-manifest.json', ...objectPaths].sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error('El TAR no coincide exactamente con los objetos declarados.');
NODE

printf 'Restaurando exclusivamente private-media en el proyecto aislado %s…\n' "$NR_RESTORE_PROJECT_REF"
node "$(dirname "$0")/storage-objects.mjs" restore "$work_dir"
printf 'Restauración de Storage completada. La base de datos no fue modificada.\n'
