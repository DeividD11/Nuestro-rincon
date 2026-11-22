#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const [jsonPath, rootArg] = process.argv.slice(2);
if (!jsonPath || !rootArg) throw new Error('Uso: node tools/render-reconciliation-report.mjs <remote.json> <project-root>');
const root = resolve(rootArg);
const remoteText = (await readFile(jsonPath, 'utf8')).trim();
const remote = JSON.parse(remoteText);
const migrationDirectory = join(root, 'supabase', 'migrations');
const files = (await readdir(migrationDirectory)).filter(file => file.endsWith('.sql'));
const localMigrations = files.map(file => {
  const match = basename(file).match(/^(\d{14})_(.+)\.sql$/);
  return match ? { version: match[1], name: match[2], file } : null;
}).filter(Boolean).sort((a, b) => a.version.localeCompare(b.version));
const remoteMigrations = Array.isArray(remote.remoteMigrations) ? remote.remoteMigrations : [];
const localVersions = new Set(localMigrations.map(item => item.version));
const remoteVersions = new Set(remoteMigrations.map(item => String(item.version)));
const onlyLocal = localMigrations.filter(item => !remoteVersions.has(item.version));
const onlyRemote = remoteMigrations.filter(item => !localVersions.has(String(item.version)));
const shared = localMigrations.filter(item => remoteVersions.has(item.version));
const functions = Array.isArray(remote.functions) ? remote.functions : [];
const functionNames = new Set(functions.map(item => item.name));
const expectedFunctions = [
  ['start_app_auth_attempt', 'Rate limit per cuenta/IP para login, recuperación y registro'],
  ['register_app_user_with_invite_idempotent_bundle', 'Alta idempotente con paquete de diez códigos'],
  ['rotate_app_recovery_codes_bundle', 'Rotación atómica de diez códigos'],
  ['list_user_letters_cursor', 'Paginación de cartas por cursor'],
  ['rename_app_profile', 'Actualización transaccional del perfil']
];
const tables = Array.isArray(remote.tables) ? remote.tables : [];
const insecureGrants = tables.filter(t => t.anonSelect || t.anonInsert || t.authenticatedSelect || t.authenticatedInsert);
const rlsOff = tables.filter(t => !t.rlsEnabled);
const check = value => value ? 'sí' : 'no';
const md = [];
md.push('# Informe de reconciliación Supabase (solo lectura)', '');
md.push(`- Proyecto: \`${process.env.NR_RECONCILE_PROJECT_REF || 'no indicado'}\``);
md.push(`- Generado por el servidor: ${remote.generatedAt || 'no indicado'}`);
md.push(`- PostgreSQL: ${remote.serverVersion || 'no indicado'}`);
md.push(`- Migraciones remotas: **${remoteMigrations.length}**`);
md.push(`- Archivos de migración locales: **${localMigrations.length}**`, '');
md.push('> Este informe no aplica SQL, no repara el historial, no despliega Edge Functions y no modifica datos.', '');
md.push('## Historial de migraciones', '');
md.push(`- Coinciden por timestamp: **${shared.length}**`);
md.push(`- Solo en el directorio local: **${onlyLocal.length}**`);
md.push(`- Solo en el ledger remoto: **${onlyRemote.length}**`, '');
md.push('### Locales no registradas en el ledger remoto', '');
if (onlyLocal.length) md.push(...onlyLocal.map(item => `- \`${item.version}\` — \`${item.name}\``));
else md.push('- Ninguna');
md.push('', '### Remotas sin archivo local', '');
if (onlyRemote.length) md.push(...onlyRemote.map(item => `- \`${item.version}\` — \`${item.name || 'nombre no devuelto'}\``));
else md.push('- Ninguna');
md.push('', '## RPC críticas', '');
md.push('| RPC | Existe | Firma | Propietario | SECURITY DEFINER | anon EXECUTE | authenticated EXECUTE | service_role EXECUTE |');
md.push('|---|---:|---|---|---:|---:|---:|---:|');
for (const [name] of expectedFunctions) {
  const items = functions.filter(item => item.name === name);
  if (!items.length) md.push(`| \`${name}\` | no | — | — | — | — | — | — |`);
  for (const item of items) md.push(`| \`${name}\` | sí | \`${item.arguments}\` | \`${item.owner}\` | ${check(item.securityDefiner)} | ${check(item.anonExecute)} | ${check(item.authenticatedExecute)} | ${check(item.serviceRoleExecute)} |`);
}
md.push('', '## Tablas, RLS y privilegios directos', '');
md.push(`- Tablas públicas detectadas: **${tables.length}**`);
md.push(`- Tablas sin RLS: **${rlsOff.length}**`);
md.push(`- Tablas con SELECT/INSERT directo para anon o authenticated: **${insecureGrants.length}**`, '');
if (rlsOff.length) md.push(`Tablas sin RLS: ${rlsOff.map(t => `\`${t.name}\``).join(', ')}`, '');
if (insecureGrants.length) md.push(`Tablas con grants directos: ${insecureGrants.map(t => `\`${t.name}\``).join(', ')}`, '');
if (!rlsOff.length && !insecureGrants.length) md.push('No se detectaron permisos SELECT/INSERT directos para `anon` o `authenticated`, y todas las tablas públicas detectadas tienen RLS activado.', '');
md.push('## Objetos auxiliares', '');
md.push(`- Índices incluidos en el diagnóstico: **${(remote.indexes || []).length}**`);
md.push(`- Triggers incluidos en el diagnóstico: **${(remote.triggers || []).length}**`, '');
md.push('## Interpretación y siguiente paso', '');
md.push('- Los timestamps comparan el directorio de migraciones con `supabase_migrations.schema_migrations`; por sí solos **no prueban** que el SQL ejecutado coincida con el archivo local.');
md.push('- La presencia y firma de una RPC tampoco demuestra identidad de su definición SQL. Revisa `definitionMd5`, propietario, permisos, dependencias, triggers, índices y constraints contra el resultado esperado antes de reparar el ledger.');
md.push('- No ejecutes `supabase migration repair` solo para hacer desaparecer diferencias. Ese comando ajusta el historial; no aplica ni revierte el DDL.');
md.push('- No uses `db push`, `db reset`, `apply_migration` ni despliegues de funciones como parte de este diagnóstico.', '');
process.stdout.write(`${md.join('\n')}\n`);
