import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.ico', 'image/x-icon'],
  ['.json', 'application/json; charset=utf-8'], ['.webmanifest', 'application/manifest+json']
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    const relativePath = pathname.replace(/^\/+/, '');
    let target = resolve(root, relativePath || 'index.html');
    if (target !== root && !target.startsWith(root + sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const info = await stat(target);
      if (info.isDirectory()) target = resolve(target, 'index.html');
    } catch {
      // Las rutas sin extensión se resuelven a la SPA; los recursos faltantes dan 404.
      if (!extname(relativePath)) target = resolve(root, 'index.html');
      else {
        response.writeHead(404).end('Not found');
        return;
      }
    }
    const body = await readFile(target);
    response.writeHead(200, {
      'Content-Type': contentTypes.get(extname(target).toLowerCase()) || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
  } catch {
    response.writeHead(400).end('Bad request');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Nuestro Rincón disponible en http://127.0.0.1:${port}\n`);
});
