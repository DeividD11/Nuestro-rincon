import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourcePackager = fileURLToPath(new URL('../scripts/package-zip.mjs', import.meta.url));

function zipEntryNames(buffer) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = buffer.lastIndexOf(signature);
  assert.notEqual(end, -1, 'El archivo debe incluir el directorio central ZIP.');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, `Entrada central ZIP inválida (${index}).`);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

test('el ZIP excluye .git como directorio y como marcador de worktree, sin retirar .github ni .gitignore', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'nuestro-rincon-package-'));
  try {
    await mkdir(join(fixture, 'scripts'), { recursive: true });
    await mkdir(join(fixture, '.git', 'objects'), { recursive: true });
    await mkdir(join(fixture, '.github', 'workflows'), { recursive: true });
    await mkdir(join(fixture, 'node_modules', 'fake-package'), { recursive: true });
    await copyFile(sourcePackager, join(fixture, 'scripts', 'package-zip.mjs'));
    await writeFile(join(fixture, 'README.md'), '# Paquete de prueba\n');
    await writeFile(join(fixture, '.gitignore'), 'node_modules\n');
    await writeFile(join(fixture, '.env'), 'PRIVATE=must-not-ship\n');
    await writeFile(join(fixture, '.env.example'), 'PUBLIC_EXAMPLE=value\n');
    await writeFile(join(fixture, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n');
    await writeFile(join(fixture, '.github', 'workflows', 'pages.yml'), 'name: Pages\n');
    await writeFile(join(fixture, 'node_modules', 'fake-package', 'index.js'), 'throw new Error("do not ship");\n');

    const run = output => {
      const result = spawnSync(process.execPath, ['scripts/package-zip.mjs', '--output', output], {
        cwd: fixture, encoding: 'utf8'
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return readFile(join(fixture, output));
    };

    let archive = await run('dist/directory-git.zip');
    let names = zipEntryNames(archive);
    assert.ok(names.includes('README.md'));
    assert.ok(names.includes('.github/workflows/pages.yml'));
    assert.ok(names.includes('.gitignore'));
    assert.ok(names.includes('.env.example'));
    assert.ok(!names.some(name => name === '.git' || name.startsWith('.git/')));
    assert.ok(!names.includes('.env'));
    assert.ok(!names.some(name => name.startsWith('node_modules/')));

    await rm(join(fixture, '.git'), { recursive: true, force: true });
    await writeFile(join(fixture, '.git'), 'gitdir: ../actual-worktree\n');
    archive = await run('dist/worktree-git.zip');
    names = zipEntryNames(archive);
    assert.ok(!names.includes('.git'), 'El archivo marcador .git tampoco debe empaquetarse.');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('las descripciones de distribución distinguen .git de .github', async () => {
  const packager = await readFile(sourcePackager, 'utf8');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(packager, /name === '\.git' \|\| relativePath\.split\('\/'\)\.includes\('\.git'\)/);
  assert.match(readme, /ZIP fuente sin `\.git\//);
});
