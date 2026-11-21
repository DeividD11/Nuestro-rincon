import { readFile } from 'node:fs/promises';

const stylesheetFiles = [
  'app.css',
  'editor.css',
  'dialogs.css',
  'security-panels.css',
  'correspondence.css',
  'accessibility.css',
  'recovery.css'
];

/** Devuelve el CSS en el mismo orden en que index.html lo carga. */
export async function readCssBundle() {
  const root = new URL('../../assets/css/', import.meta.url);
  const parts = await Promise.all(stylesheetFiles.map(file => readFile(new URL(file, root), 'utf8')));
  return parts.join('\n');
}
