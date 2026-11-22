import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('PBKDF2 verify usa un ArrayBuffer propio para el salt', async () => {
  const core = await read('../supabase/functions/_shared/core.ts');
  assert.match(core, /function toOwnedArrayBuffer\(bytes: Uint8Array\): ArrayBuffer/);
  assert.match(core, /const buffer = new ArrayBuffer\(bytes\.byteLength\)/);
  assert.match(core, /new Uint8Array\(buffer\)\.set\(bytes\)/);
  assert.match(core, /salt: toOwnedArrayBuffer\(salt\)/);
});

test('el sanitizador obtiene Document desde DOMParser, no desde parseHTML.window.document', async () => {
  const core = await read('../supabase/functions/_shared/core.ts');
  assert.match(core, /import \{ DOMParser \} from 'linkedom'/);
  assert.match(core, /new DOMParser\(\)\.parseFromString\([\s\S]*?,\s*'text\/html'\)/);
  assert.match(core, /const body = document\.querySelector\('body'\)/);
  assert.match(core, /Array\.from\(body\.childNodes\)/);
  assert.doesNotMatch(core, /parseHTML|document\.body\.childNodes/);
});

test('Deno check es un gate de PR y deploy consume el artefacto ya verificado', async () => {
  const workflow = await read('../.github/workflows/pages.yml');
  assert.match(workflow, /pull_request:\s*\n\s*branches:\s*\[main\]/);
  assert.match(workflow, /deno-version:\s*v2\.9\.8/);
  assert.match(workflow, /run: npm run check:edge/);
  assert.match(workflow, /verify:[\s\S]*?deploy:[\s\S]*?needs: verify/);
  assert.match(workflow, /actions\/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f/);
  assert.match(workflow, /actions\/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'[\s\S]*?github\.event_name != 'pull_request'/);
  assert.match(workflow, /actions\/deploy-pages@f33f41b675f0ab2dc5a6863c9a170fe83af3571e/);
});
