import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = [
  'assets/js/views/app-view.js',
  'assets/js/views/auth-view.js',
  'assets/js/views/correspondence-view.js',
  'assets/js/views/settings-view.js'
];

/** Fuentes de todas las vistas en módulos, sin modificar el orden de su contrato. */
export async function readAppViewSource() {
  const sources = await Promise.all(files.map(file => readFile(resolve(root, file), 'utf8')));
  return sources.join('\n\n/* --- view module boundary --- */\n\n');
}
