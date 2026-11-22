#!/usr/bin/env node
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let outputArg = 'dist/nuestro-rincon-source.zip';
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--output') {
    outputArg = args[index + 1];
    if (!outputArg) throw new Error('Falta la ruta después de --output.');
    index++;
  } else {
    throw new Error(`Argumento desconocido: ${args[index]}`);
  }
}
const output = resolve(root, outputArg);
const excludedDirectories = new Set([
  '.git', 'node_modules', '_site', 'dist', '.dist', 'coverage', 'backups', 'backup-output',
  'playwright-report', 'test-results', '.cache', '.turbo', '__pycache__'
]);
const excludedNames = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const includedEnvExamples = new Set(['.env.example', '.env.sample', '.env.template']);

function shouldExclude(name, relativePath, isDirectory) {
  // Excluye .git como directorio y como archivo marcador de un git worktree.
  // La comprobación por segmentos también protege frente a rutas anidadas.
  if (name === '.git' || relativePath.split('/').includes('.git')) return true;
  if (isDirectory && excludedDirectories.has(name)) return true;
  if (excludedNames.has(name)) return true;
  if (name.endsWith('.zip') || name.endsWith('.log') || name.endsWith('.tsbuildinfo')
    || name.endsWith('.age') || name.endsWith('.dump') || name.endsWith('.backup')) return true;
  if ((name === '.env' || name.startsWith('.env.')) && !includedEnvExamples.has(name)) return true;
  if (relativePath.startsWith('dist/')) return true;
  return false;
}

async function collect(directory, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    const relativePath = relative(root, fullPath).split(sep).join('/');
    if (shouldExclude(entry.name, relativePath, entry.isDirectory())) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collect(fullPath, files);
    else if (entry.isFile()) files.push({ fullPath, relativePath });
  }
  return files;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  crcTable[n] = value >>> 0;
}
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}
function u16(value) { const buffer = Buffer.allocUnsafe(2); buffer.writeUInt16LE(value & 0xffff); return buffer; }
function u32(value) { const buffer = Buffer.allocUnsafe(4); buffer.writeUInt32LE(value >>> 0); return buffer; }

const files = await collect(root);
const leakedGitEntries = files.filter(file => file.relativePath.split('/').includes('.git'));
if (leakedGitEntries.length) throw new Error(`El empaquetado detectó metadatos Git: ${leakedGitEntries.map(file => file.relativePath).join(', ')}`);
if (!files.length) throw new Error('No se encontraron archivos para empaquetar.');
if (files.length > 0xffff) throw new Error('El paquete excede el límite ZIP clásico de archivos.');

const localParts = [];
const centralParts = [];
let localOffset = 0;
for (const file of files) {
  const data = await readFile(file.fullPath);
  const compressed = deflateRawSync(data, { level: 9 });
  if (data.length > 0xffffffff || compressed.length > 0xffffffff) {
    throw new Error(`Archivo demasiado grande para ZIP clásico: ${file.relativePath}`);
  }
  const name = Buffer.from(file.relativePath, 'utf8');
  const crc = crc32(data);
  const { dosTime, dosDate } = dosDateTime(await stat(file.fullPath).then(info => info.mtime));
  const localHeader = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(dosTime), u16(dosDate),
    u32(crc), u32(compressed.length), u32(data.length), u16(name.length), u16(0), name
  ]);
  localParts.push(localHeader, compressed);

  const centralHeader = Buffer.concat([
    u32(0x02014b50), u16(0x031e), u16(20), u16(0x0800), u16(8), u16(dosTime), u16(dosDate),
    u32(crc), u32(compressed.length), u32(data.length), u16(name.length), u16(0), u16(0),
    u16(0), u16(0), u32(0o100644 << 16), u32(localOffset), name
  ]);
  centralParts.push(centralHeader);
  localOffset += localHeader.length + compressed.length;
}

const centralDirectory = Buffer.concat(centralParts);
const centralOffset = localOffset;
const endRecord = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
  u32(centralDirectory.length), u32(centralOffset), u16(0)
]);
const archive = Buffer.concat([...localParts, centralDirectory, endRecord]);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, archive);
let totalSourceBytes = 0;
for (const file of files) totalSourceBytes += (await stat(file.fullPath)).size;
process.stdout.write(`ZIP creado: ${output}\nArchivos: ${files.length}\nTamaño fuente: ${totalSourceBytes} bytes\nTamaño ZIP: ${archive.length} bytes\n`);
