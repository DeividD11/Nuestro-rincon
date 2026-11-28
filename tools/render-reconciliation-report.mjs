#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const [jsonPath, rootArg] = process.argv.slice(2);
if (!jsonPath || !rootArg) throw new Error('Uso: node tools/render-reconciliation-report.mjs <remote.json> <project-root>');
const root = resolve(rootArg);
const remote = JSON.parse((await readFile(jsonPath, 'utf8')).trim());
const manifest = JSON.parse(await readFile(join(root, 'supabase', 'diagnostics', 'edge-rpc-contract.json'), 'utf8'));
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
const tables = Array.isArray(remote.tables) ? remote.tables : [];
const insecureGrants = tables.filter(t => t.anonSelect || t.anonInsert || t.authenticatedSelect || t.authenticatedInsert);
const rlsOff = tables.filter(t => !t.rlsEnabled);
const check = value => value ? 'sí' : 'no';
const signature = item => String(item.arguments || '').replace(/\s+/g, ' ').trim();
const expectedSearchPath = String(manifest.principles?.searchPath || '').toLowerCase();
const contractRows = manifest.functions.map(expected => {
  const sameName = functions.filter(item => item.name === expected.name);
  const exact = sameName.filter(item => signature(item) === expected.arguments);
  const item = exact.length === 1 ? exact[0] : null;
  const actualSearchPath = String(item?.searchPath || '').replace(/^search_path=/i, '').trim().toLowerCase();
  const checks = {
    exists: Boolean(item),
    uniqueSignature: sameName.length === 1 && exact.length === 1,
    securityInvoker: item ? item.securityDefiner === false : false,
    noAnon: item ? item.anonExecute === false : false,
    noAuthenticated: item ? item.authenticatedExecute === false : false,
    serviceRole: item ? item.serviceRoleExecute === true : false,
    pinnedSearchPath: item ? actualSearchPath === expectedSearchPath : false
  };
  return { expected, sameName, item, checks, compatible: Object.values(checks).every(Boolean) };
});
const incompatible = contractRows.filter(row => !row.compatible);
const compatibleCount = contractRows.length - incompatible.length;
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
md.push('', '## Contrato de RPC requerido por Edge Functions', '');
md.push(`- RPC compatibles: **${compatibleCount}/${contractRows.length}**`);
md.push(`- RPC incompatibles o ausentes: **${incompatible.length}**`, '');
md.push('| RPC | Resultado | Firma exacta | SECURITY INVOKER | anon EXECUTE | authenticated EXECUTE | service_role EXECUTE | search_path |');
md.push('|---|---:|---|---:|---:|---:|---:|---:|');
for (const row of contractRows) {
  const { expected, item, sameName, checks } = row;
  const actualSig = item ? `\`${signature(item)}\`` : sameName.length ? sameName.map(entry => `\`${signature(entry)}\``).join('<br>') : '—';
  const searchPath = item?.searchPath || '—';
  md.push(`| \`${expected.name}\` | ${row.compatible ? 'compatible' : '**BLOQUEA RELEASE**'} | ${actualSig} | ${check(checks.securityInvoker)} | ${check(item?.anonExecute === false)} | ${check(item?.authenticatedExecute === false)} | ${check(checks.serviceRole)} | \`${searchPath}\` |`);
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
md.push('- El contrato de RPC valida nombre, firma PostgreSQL exacta, seguridad invoker, grants mínimos y `search_path` fijado. No compara la definición completa; `definitionMd5` queda disponible para diff más profundo.');
md.push('- No ejecutes `supabase migration repair` solo para hacer desaparecer diferencias. Ese comando ajusta el historial; no aplica ni revierte el DDL.');
md.push('- No uses `db push`, `db reset`, `apply_migration` ni despliegues de funciones como parte de este diagnóstico.', '');
md.push(`## Estado para release: **${incompatible.length ? 'BLOQUEADO' : 'RPC COMPATIBLES'}**`);
md.push(incompatible.length
  ? 'Corrige/aplica únicamente las migraciones que aportan objetos requeridos, prueba en un entorno aislado y vuelve a ejecutar este diagnóstico.'
  : 'Las RPC cumplen el contrato declarado. El historial de migraciones sigue requiriendo reconciliación documental y no debe repararse por timestamp sin comparar DDL.', '');
process.stdout.write(`${md.join('\n')}\n`);
if (incompatible.length) process.exitCode = 2;
