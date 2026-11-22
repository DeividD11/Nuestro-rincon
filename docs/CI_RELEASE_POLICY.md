# Política de calidad y publicación

## Qué bloquea GitHub Pages

El workflow `.github/workflows/pages.yml` ejecuta `pull_request` y `push` hacia `main`. El job `verify` debe terminar correctamente antes de que el job `deploy` pueda publicar el artefacto:

1. `npm ci` instala las dependencias fijadas en `package-lock.json`.
2. `npm run check` valida estructura, sintaxis, imports y contratos del repositorio.
3. `npm run check:contrast` revisa la paleta clara/oscura.
4. `npm run check:edge` ejecuta el `deno check` nativo sobre las tres Edge Functions.
5. `npm test` ejecuta las pruebas automatizadas Node.
6. `npm run build:pages` genera `_site/`.
7. `npm run test:a11y` ejecuta axe-core y las pruebas geométricas/de teclado del editor en Chromium.

El job `verify` genera `_site/` y, únicamente para una publicación desde `main`, crea allí mismo el artefacto oficial `github-pages` mediante `actions/upload-pages-artifact`. El job `deploy` depende de `verify` (`needs: verify`) y solo ejecuta `actions/deploy-pages`; no vuelve a descargar, empaquetar ni subir el sitio. Esta separación deja que termine la carga del artefacto y que finalice el job de verificación antes de que el job de despliegue consulte sus metadatos, evitando una consulta inmediata de lectura tras escritura. Una pull request nunca publica Pages.

## Protección recomendada de `main`

En GitHub → Settings → Rules → Rulesets, configura `main` para:

- exigir una pull request;
- exigir al menos una aprobación propia/revisión antes de fusionar, cuando haya otra persona revisora disponible;
- exigir que pase `Verify and deploy Nuestro Rincón / Verify frontend and Edge Functions`;
- bloquear force-push y borrado de `main`;
- exigir que la rama esté actualizada antes de fusionar.

El nombre del check debe seleccionarse desde la lista que GitHub muestre después de la primera ejecución del workflow; no lo escribas a mano si GitHub muestra un nombre distinto.

## Cambios que tocan Supabase

Los workflows `security-db.yml`, `security-integration.yml` y `security-playwright.yml` se mantienen manuales y requieren credenciales de una branch/proyecto aislado. No se ejecutan automáticamente en cada pull request porque consumen invitaciones y crean/limpian datos de prueba. Para cualquier release que cambie migraciones, RPC, autenticación, sesiones, permisos o Edge Functions:

1. crear o seleccionar una branch de Supabase distinta de producción;
2. configurar los secretos `NR_DB_TEST_*`, `NR_TEST_*` o `NR_E2E_*` que correspondan;
3. ejecutar los tres workflows desde la rama de la pull request;
4. revisar pgTAP, flujos de dos cuentas y reporte Playwright;
5. no fusionar ni desplegar si hay fallos o si alguno fue omitido por falta de configuración.

Los workflows manuales no se presentan como un check automático requerido por Pages. El equipo debe revisar sus ejecuciones desde Actions y registrar su resultado en la pull request antes de fusionar un cambio de backend. Nunca se deben configurar esas variables con la conexión ni las cuentas de producción.

## Toolchain y dependencias

- Node.js: `.nvmrc` fija `24.22.3`.
- npm: `package.json` fija `11.19.1`.
- Dependencias de prueba: `@playwright/test` `1.65.1` y `axe-core` `4.14.1`, fijadas en `package.json` y `package-lock.json`.
- Deno: `v2.9.8` en el workflow de Pages.
- Supabase CLI: `3.0.0` en workflows de DB/backup.
- `dependabot.yml` revisa semanalmente dependencias npm y referencias de GitHub Actions.

Las referencias de acciones se fijan a líneas de versión (`@vN`) y Dependabot propone nuevas revisiones. Para repositorios con una política de supply chain más estricta, se recomienda migrar esas referencias a SHA completos revisados y mantener Dependabot configurado para actualizar los SHA.

## Resultado de auditoría de accesibilidad

`axe-core` ejecuta reglas WCAG 2.0/2.1/2.2 A/AA en nueve vistas y dos temas, con escenarios adicionales de error, recuperación, Papelera y diálogo de eliminación de cuenta. Playwright comprueba además 640 y 320 píxeles CSS. La auditoría estática de contraste analiza 24 combinaciones seleccionadas de la paleta. Ninguna de esas automatizaciones sustituye las pruebas manuales con NVDA, VoiceOver y TalkBack, que siguen siendo una condición de validación humana documentada en `docs/ACCESSIBILITY.md`.
