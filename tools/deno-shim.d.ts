declare namespace Deno {
  const env: { get(name: string): string | undefined };
  function serve(handler: (request: Request) => Response | Promise<Response>): void;
}
declare module 'linkedom' {
  export function parseHTML(html: string): { document: any };
}
