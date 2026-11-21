# Sincronización segura de código, GitHub y Supabase

## Estado de referencia

La revisión del 21 de noviembre de 2026 detectó que el ZIP de trabajo contenía cambios locales respecto al único commit incluido (`5a071371cde5dcc22a5bbfa675f3c2e98ca54560`). El proyecto GitHub `DeividD11/Nuestro-rincon` utiliza `main` como rama predeterminada.

En Supabase, el proyecto `tiqbmuubpbmxqvtkcdhq` tiene 23 migraciones registradas y Edge Functions `auth-api` v11 y `letters-api` v8. La inspección en vivo encontró que las ocho funciones SQL y estructuras declaradas por las primeras cuatro migraciones locales no registradas ya existen en `public`, con permisos `EXECUTE` exclusivos de `service_role`. También están presentes los índices de paginación seleccionados y el trigger que reevalúa la purga al deshabilitar una cuenta. Las Edge Functions activas todavía no usan las RPC locales más recientes.

Esta diferencia requiere reconciliar esquema, ledger y código desplegado; no debe resolverse ejecutando todas las migraciones por orden sin comprobar primero sus efectos.

## 1. Preparar un clon Git coherente

No uses el directorio `.git` incluido en un ZIP antiguo como sustituto de un clon actualizado. Clona el repositorio de GitHub y crea una rama de trabajo:

```bash
git clone https://github.com/DeividD11/Nuestro-rincon.git
cd Nuestro-rincon
git switch -c fix/deno-crypto-types-and-release-gates
```

Extrae el ZIP limpio de esta entrega en una carpeta temporal y copia su contenido sobre el clon, **sin reemplazar ni borrar la carpeta `.git/` del clon**. No copies `.env`, credenciales, `node_modules/`, `_site/` ni artefactos temporales.

Comprueba que el origen es el repositorio esperado y revisa los cambios:

```bash
git remote -v
git status --short
git diff --check
git diff --stat
```

## 2. Ejecutar las verificaciones localmente

```bash
npm run check
npm test
npm run build:pages
```

Para comprobar las Edge Functions instala Deno 2.9.8 y ejecuta:

```bash
deno --version
npm run check:edge
```

El workflow de GitHub Actions también ejecutará `deno check` en cada pull request dirigida a `main`. La rama no debe fusionarse si falla el job `verify`.

## 3. Commit y Pull Request

Después de revisar el diff completo y confirmar que no contiene datos privados:

```bash
git add -A
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m "Fix Deno Edge Function types and gate Pages deployment"
git push -u origin fix/deno-crypto-types-and-release-gates
```

Abre un pull request desde esa rama hacia `main`. No se recomienda enviar estos cambios directamente a `main`: el workflow valida primero estructura, tipos Deno, pruebas y compilación. Al fusionarse una versión verificada en `main`, GitHub Pages publicará el artefacto que produjo el job de verificación.

## 4. Reconciliar Supabase sin repetir migraciones

Antes de desplegar Edge Functions:

1. Obtener un respaldo verificable y probar su restauración en un proyecto aislado.
2. Comparar las ocho funciones SQL definidas por los cuatro scripts de dominio anteriores con las definiciones reales (`pg_get_functiondef`), firmas, propietarios, permisos y dependencias.
3. Comparar constraints, columnas, triggers e índices de los cuatro scripts anteriores con el estado remoto real. La quinta migración, `20261121200000_recovery_code_bundles.sql`, es nueva: no está en producción y sus objetos deben probarse como DDL nuevo, incluido el RPC del alta con diez códigos.
4. Ejecutar `npm run test:db` (psql + parser TAP) en una base aislada y las pruebas de integración con dos cuentas de prueba.
5. Solo después decidir si se necesita aplicar DDL, reparar el historial de migraciones para reflejar objetos ya existentes, o ambas cosas. No marcar una migración como aplicada hasta demostrar que todo su efecto ya está presente y coincide exactamente.
6. Desplegar `auth-api` y `letters-api` como un conjunto compatible con las RPC existentes y ejecutar pruebas de humo con las cuentas de prueba.

No usar `supabase db push --remote` contra producción para resolver la diferencia descrita. No se ha aplicado ningún cambio de base de datos ni desplegado funciones como parte de esta entrega.

## 5. Activación E2EE: puerta separada

La migración de los diez códigos de respaldo `20261121200000_recovery_code_bundles.sql` y su nueva versión de `auth-api` deben validarse y desplegarse juntos; la función antigua no acepta `recoveryCodes` en el registro. El cifrado de extremo a extremo no forma parte de este arreglo de CI ni de la sincronización. `docs/E2EE_ARCHITECTURE.md` sigue siendo una propuesta. Antes de activar E2EE debe aprobarse y probarse el protocolo criptográfico, la identidad/huella de ambas cuentas, el respaldo/recuperación de claves, el cifrado de borradores, el formato versionado de ciphertext y la migración reversible y verificable del historial en claro. No desplegar un esquema híbrido que anuncie privacidad E2EE mientras el servidor siga recibiendo contenido legible.
