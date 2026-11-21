declare namespace Deno {
  const env: { get(name: string): string | undefined };
  function serve(handler: (request: Request) => Response | Promise<Response>): void;
}
declare module 'linkedom' {
  export class DOMParser {
    parseFromString(html: string, mimeType?: string): Document;
  }
}
