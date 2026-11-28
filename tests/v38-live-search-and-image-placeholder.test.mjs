import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('la búsqueda de cartas no vuelve a abrir ni renderizar la ruta completa por cada tecla', async () => {
  const draft = await read('../assets/js/controllers/draft-controller.js');
  const navigation = await read('../assets/js/controllers/navigation-controller.js');
  const view = await read('../assets/js/views/correspondence-view.js');
  assert.match(draft, /this\.runLetterSearch\(route, query, requestId\)/);
  assert.match(draft, /this\.repository\.list\(route, query, null, 40\)/);
  assert.match(draft, /this\.renderListResultsOnly\(\)/);
  assert.doesNotMatch(draft.slice(draft.indexOf("if (event.target.id === 'letter-search')"), draft.indexOf("if (event.target.id === 'editor-title'")), /openRoute\(/);
  assert.match(navigation, /renderListResultsOnly\(\)[\s\S]*container\.innerHTML = this\.view\.renderListResults\(this\.state\)/);
  assert.match(view, /id="letter-list-results"/);
  assert.match(view, /id="letter-search"/);
});

test('la búsqueda es temporal, se invalida al cambiar de sección y no usa historial/autocompletado', async () => {
  const navigation = await read('../assets/js/controllers/navigation-controller.js');
  const view = await read('../assets/js/views/correspondence-view.js');
  const app = await read('../assets/js/controllers/app-controller.js');
  assert.match(navigation, /window\.clearTimeout\(this\.searchTimer\)/);
  assert.match(navigation, /this\.searchRequestId = \(this\.searchRequestId \|\| 0\) \+ 1/);
  assert.match(navigation, /this\.state\.search = ''/);
  assert.match(navigation, /return `\$\{route\}:\$\{accountId\}`/);
  assert.doesNotMatch(navigation, /routeCacheKey\(route\)[\s\S]{0,180}this\.state\.search/);
  assert.match(view, /autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"/);
  assert.match(app, /this\.searchRequestId = 0/);
});

test('las respuestas antiguas del buscador no pueden reemplazar resultados más recientes', async () => {
  const draft = await read('../assets/js/controllers/draft-controller.js');
  assert.match(draft, /requestId !== this\.searchRequestId \|\| this\.state\.route !== route \|\| this\.state\.search !== query/);
  assert.match(draft, /const requestId = this\.searchRequestId = \(this\.searchRequestId \|\| 0\) \+ 1/);
  assert.match(draft, /window\.setTimeout\([\s\S]*?170\)/);
});

test('la lista reactualiza sus resultados sin reemplazar el campo de búsqueda y anuncia el estado', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const css = await read('../assets/css/correspondence.css');
  assert.match(view, /id="letter-search-status" class="search-status" role="status"/);
  assert.match(view, /id="letter-list-results" class="letter-list-results" aria-live="polite"/);
  assert.match(css, /\.letter-list-results\.is-searching/);
});

test('una imagen sin URL firmada permanece en estado Cargando imagen y no muestra error prematuro', async () => {
  const helper = await read('../assets/js/utils/letter-images.js');
  assert.match(helper, /frame\.classList\.add\('is-loading'\)/);
  assert.match(helper, /if \(!hasSource\) frame\.classList\.add\('is-pending-source'\)/);
  assert.doesNotMatch(helper, /if \(!hasSource\)[\s\S]{0,160}Imagen no disponible/);
  assert.match(helper, /placeholder-label">Cargando imagen…/);
});

test('el sello utiliza firstImageUrl y conserva el fallback mientras carga la primera miniatura', async () => {
  const view = await read('../assets/js/views/correspondence-view.js');
  const edge = await read('../supabase/functions/letters-api/index.ts');
  const events = await read('../assets/js/controllers/app-event-coordinator-controller.js');
  assert.match(view, /const source = String\(item\?\.firstImageUrl \|\| ''\)/);
  assert.match(view, /letter-stamp has-image is-loading/);
  assert.match(view, /firstImageUrl/);
  assert.match(edge, /const items = decorated;/);
  assert.doesNotMatch(edge, /withFirstImagePreviews/);
  assert.match(events, /rootMargin: '120px 0px'/);
});

test('una carta que recibe la URL privada de su primera imagen usa esa miniatura en letter-stamp', async () => {
  const { AppView } = await import('../assets/js/views/app-view.js');
  const view = new AppView({});
  const firstImageUrl = 'https://tiqbmuubpbmxqvtkcdhq.supabase.co/storage/v1/object/sign/private-media/letters/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.jpg?token=test';
  const markup = view.letterCard({
    id: '11111111-1111-4111-8111-111111111111', status: 'draft', title: 'Borrador con foto',
    firstImageUrl, updated_at: '2026-11-24T00:00:00Z'
  });
  assert.match(markup, /letter-stamp has-image is-loading/);
  assert.ok(markup.includes(firstImageUrl));
});
