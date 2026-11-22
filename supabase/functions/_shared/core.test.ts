import { errorStatus, readJson } from './core.ts';

async function expectCode(operation: () => Promise<unknown>, expected: string) {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== expected) {
      throw new Error(`Se esperaba ${expected}; se recibió ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  throw new Error(`Se esperaba que la operación fallara con ${expected}.`);
}

Deno.test('readJson acepta JSON UTF-8 de objeto', async () => {
  const request = new Request('https://unit.test/functions/v1/letters-api', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ title: 'Carta ñandú', enabled: true })
  });
  const result = await readJson(request);
  if (result.title !== 'Carta ñandú' || result.enabled !== true) throw new Error('El objeto JSON no se decodificó correctamente.');
});

Deno.test('readJson rechaza media types que no son JSON', async () => {
  const request = new Request('https://unit.test/functions/v1/letters-api', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}'
  });
  await expectCode(() => readJson(request), 'INVALID_CONTENT_TYPE');
});

Deno.test('readJson distingue JSON mal formado', async () => {
  const request = new Request('https://unit.test/functions/v1/letters-api', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{'
  });
  await expectCode(() => readJson(request), 'INVALID_JSON');
});

Deno.test('readJson rechaza Content-Length no numérico', async () => {
  const request = new Request('https://unit.test/functions/v1/letters-api', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 'unknown' }, body: '{}'
  });
  await expectCode(() => readJson(request), 'INVALID_CONTENT_LENGTH');
});

Deno.test('readJson corta un stream grande aunque no anuncie Content-Length', async () => {
  const oversized = `{"payload":"${'a'.repeat(150_100)}"}`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(oversized);
      controller.enqueue(bytes.subarray(0, 80_000));
      controller.enqueue(bytes.subarray(80_000));
      controller.close();
    }
  });
  const request = new Request('https://unit.test/functions/v1/letters-api', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half'
  });
  await expectCode(() => readJson(request), 'PAYLOAD_TOO_LARGE');
});

Deno.test('readJson solo acepta objetos JSON en la raíz', async () => {
  const request = new Request('https://unit.test/functions/v1/letters-api', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]'
  });
  await expectCode(() => readJson(request), 'INVALID_BODY');
});

Deno.test('errorStatus mapea errores de cliente, tamaño y timeout correctamente', () => {
  const cases: Array<[string, number, string]> = [
    ['INVALID_JSON', 400, 'INVALID_JSON'],
    ['INVALID_CONTENT_TYPE', 415, 'INVALID_CONTENT_TYPE'],
    ['PAYLOAD_TOO_LARGE', 413, 'PAYLOAD_TOO_LARGE'],
    ['DATABASE_TIMEOUT', 504, 'DATABASE_TIMEOUT']
  ];
  for (const [code, status, mappedCode] of cases) {
    const mapped = errorStatus(new Error(code));
    if (mapped.status !== status || mapped.code !== mappedCode) {
      throw new Error(`Mapeo incorrecto de ${code}: ${JSON.stringify(mapped)}`);
    }
  }
});
