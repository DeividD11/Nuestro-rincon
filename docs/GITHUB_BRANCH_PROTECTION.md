# Protección de la rama `main`

## Alcance

Los workflows y sus acciones externas están versionados en el repositorio, pero la protección de ramas es una configuración del repositorio en GitHub. No se puede activar ni verificar mediante un ZIP local; la regla no se configura desde el ZIP. Debe configurarse desde la cuenta que administra el repositorio.

## Regla recomendada

1. Abre el repositorio en GitHub y entra en **Settings → Rules → Rulesets**.
2. Crea un ruleset de ramas, por ejemplo `protect-main`, y activa su aplicación.
3. En **Target branches**, incluye únicamente `main`.
4. Activa **Require a pull request before merging**. Exige al menos una aprobación si hay otra persona disponible para revisar; en un repositorio individual, conserva la revisión como una comprobación manual antes de fusionar.
5. Activa **Require status checks to pass** y añade el check de verificación del workflow Pages. Su nombre visible en la matriz de Actions es **Verify frontend and Edge Functions** (job `verify`). Ejecuta primero una PR para que GitHub registre el check antes de seleccionarlo.
6. Activa **Block force pushes** y **Restrict deletions** para `main`.
7. Guarda el ruleset y confirma que aparece como activo y que el destino coincide exactamente con `main`.

No marques como obligatorio el job `Deploy GitHub Pages`: en las PR no debe ejecutarse. El despliegue depende del job `verify` y se ejecuta solo después de una publicación aceptada en `main`.

## Gates del repositorio

El job `verify` ejecuta estructura, auditoría de contraste, `deno check`, pruebas unitarias/contrato, cobertura frontend, build de Pages y axe-core. Los workflows de integración PostgreSQL y pruebas de dos cuentas siguen siendo manuales porque requieren un proyecto aislado y secretos; no deben ser requisito para cada PR mientras no exista un entorno de prueba permanente.

## Revisión periódica

- Comprueba que los checks requeridos siguen llamándose `Verify frontend and Edge Functions` y que el workflow `pages.yml` no fue renombrado.
- Revisa Dependabot y actualiza los SHA de Actions solo después de verificar los commits oficiales y su firma.
- Mantén la publicación protegida: nunca uses `pull_request_target` para ejecutar código de una PR con secretos.

## Estado de esta entrega

Esta guía documenta la configuración recomendada, pero no afirma que el ruleset ya esté activo. Debes activarlo en GitHub y verificarlo en **Settings → Rules → Rulesets**.
