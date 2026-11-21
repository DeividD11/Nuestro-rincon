# Diseño propuesto de cifrado de extremo a extremo (E2EE)

## Estado real hoy

**El proyecto todavía no tiene cifrado de extremo a extremo.** Los títulos y cuerpos de las cartas se envían a `letters-api` y se almacenan en PostgreSQL en forma legible (el cuerpo se conserva como HTML sanitizado). La sanitización reduce el riesgo de HTML peligroso; no cifra el contenido ni impide que un administrador con acceso suficiente a la base de datos lo lea.

Esta guía define una arquitectura de trabajo. No se activa cifrado en esta versión ni se transforma automáticamente el contenido histórico. Presentarlo como habilitado antes de completar la gestión y recuperación de claves sería una promesa de privacidad falsa.

## Objetivos y límites de seguridad

El objetivo es que una copia de la base de datos, un respaldo o un acceso administrativo a PostgreSQL no revele el texto de una carta. El cifrado y descifrado deben suceder en el navegador de las cuentas participantes.

E2EE no protege frente a:

- Un dispositivo desbloqueado, malware, extensiones maliciosas o capturas de pantalla de una persona autorizada.
- XSS, una dependencia comprometida o una modificación maliciosa del JavaScript servido por GitHub Pages. El código que se ejecuta en el navegador puede acceder al texto y a las claves desbloqueadas.
- Metadatos operativos: identificadores, remitente/destinatario, fechas, número de cartas, tamaños aproximados, estados de carpeta y notificaciones. No se deben confundir metadatos minimizados con metadatos ocultos.
- La pérdida simultánea de la clave privada y de su respaldo. Sin una copia válida, el contenido cifrado no puede recuperarse ni siquiera por el administrador.

El HTTPS, la CSP, la sanitización, la revisión de dependencias, la ausencia de scripts de terceros innecesarios y la protección contra XSS seguirían siendo controles obligatorios. E2EE no reemplaza esas defensas.

## Modelo criptográfico propuesto

1. **Identidad criptográfica por cuenta.** Cada cuenta genera en el navegador un par de claves de cifrado y un par separado de firma. Las claves privadas no se envían ni se guardan en PostgreSQL. La clave pública se registra como dato de identidad, asociada a una huella verificable.
2. **Autenticación de las claves públicas.** Antes de confiar en una clave pública, las dos personas verifican sus huellas mediante un canal independiente o un intercambio de invitación autenticado. Un cambio de clave debe generar una alerta visible y requerir una nueva verificación; no se sustituye silenciosamente.
3. **Clave por carta.** El navegador genera una clave de datos aleatoria de 256 bits (DEK) para cada carta o versión cifrada. El HTML y el título se cifran en el cliente con AES-256-GCM, un nonce aleatorio de 96 bits y autenticación de datos asociados (AAD) que vincule, como mínimo, la versión del formato, el ID de carta, el ID del hilo, remitente, destinatario y revisión. Así se detecta manipulación, intercambio de ciphertext entre cartas y cambios de contexto.
4. **Distribución de la DEK.** La DEK se envuelve por separado para cada participante mediante un mecanismo HPKE compatible con RFC 9180 y una biblioteca mantenida, revisada y fijada por versión. El paquete debe autenticar al emisor mediante la clave de firma. No se deben diseñar primitivas propias ni tratar un acuerdo X25519 sin autenticación como prueba de identidad.
5. **Borradores.** Un borrador nuevo se cifra antes de salir del navegador. Mientras no tenga destinatario, se protege con la clave privada del autor; al asignar destinatario, se crea también el sobre destinado a la otra cuenta. Las copias offline se guardan cifradas en IndexedDB. No se guardan cuerpos en claro en `localStorage`, logs, analítica o mensajes de error.
6. **Descifrado.** El navegador obtiene el sobre correspondiente a la cuenta autenticada, desbloquea su clave privada local y descifra la DEK y el contenido en memoria. El backend solo valida identidad, permisos, estados, tamaño y estructura; no necesita las claves ni el texto en claro.

AES-GCM, el acuerdo de claves, el formato de sobre y las firmas deben implementarse mediante primitivas y bibliotecas criptográficas mantenidas. La suite final, los parámetros y las versiones se fijarán en una especificación de protocolo antes de escribir el código de producción.

## Protección y recuperación de claves

La contraseña de inicio de sesión no debe reutilizarse sin más como clave de cifrado: un cambio o restablecimiento de contraseña no debe destruir silenciosamente el acceso al historial.

La propuesta es:

- Generar las claves privadas con un CSPRNG en el navegador.
- Envolver la clave privada local con una clave de cifrado (KEK) derivada de una frase de cifrado independiente y de alta entropía mediante Argon2id en una implementación WASM mantenida y revisada. Guardar solo el ciphertext, el salt y los parámetros de derivación; nunca la frase ni la KEK.
- Ofrecer un archivo de respaldo cifrado que contenga las claves privadas y la información de versión. El usuario debe protegerlo fuera del dispositivo. Como alternativa de recuperación, generar un secreto aleatorio de recuperación de alta entropía que envuelva la misma clave privada; mostrarlo una sola vez y exigir confirmación de guardado.
- Probar en dispositivos distintos el flujo completo de exportar, borrar el almacenamiento local, importar y descifrar. Una copia de seguridad que no se ha probado no debe considerarse válida.
- Mantener separadas la recuperación de la cuenta y la recuperación E2EE. El código actual de recuperación restablece credenciales de la cuenta; **no** recupera por sí solo las claves E2EE. La interfaz debe decirlo expresamente.
- Al cambiar contraseña, volver a envolver la clave privada local sin cambiar las claves públicas. Al cambiar o perder una clave, aplicar una rotación explícita, verificar las huellas y volver a envolver las DEK de cartas a las que la cuenta todavía deba tener acceso.

Si ambas opciones de recuperación se pierden, el contenido no se puede recuperar. No debe existir una llave maestra de soporte que permita al servidor descifrar cartas; eso eliminaría la propiedad E2EE.

## Compatibilidad con funciones de la aplicación

- **Búsqueda:** al cifrar título y cuerpo, PostgreSQL ya no puede buscar su contenido. La búsqueda textual tendrá que ejecutarse en el cliente sobre cartas descifradas y cacheadas, mientras el servidor seguirá filtrando por carpeta, fechas y otros metadatos permitidos. No se deben prometer búsquedas completas en el servidor sobre ciphertext.
- **Paginación:** los IDs y marcas de tiempo pueden seguir ordenándose en el servidor. El cliente descifra cada página y busca localmente. Para localizar un texto antiguo que todavía no se ha descargado, hará falta cargar páginas sucesivas o un índice local cifrado.
- **Notificaciones:** deben evitar incluir títulos o fragmentos de contenido en claro. Pueden comunicar que llegó una carta o respuesta y abrir el ciphertext para descifrarlo en el dispositivo.
- **Cuenta eliminada:** al borrar una cuenta se destruye su acceso local y se elimina su estado de cuenta. La otra persona conserva su propio sobre de la DEK y puede descifrar las cartas que le correspondan, sin depender de la clave privada eliminada.
- **Descartar y eliminar:** una eliminación lógica o una confirmación compartida debe borrar ciphertext, sobres y versiones conforme a la política documentada. Un respaldo externo del usuario no puede revocarse desde el servidor.
- **HTML enriquecido:** el contenido se descifra solo en el cliente y sigue pasando por sanitización antes de insertarse en el DOM. El cifrado no hace que HTML confiable sea seguro.

## Migración del historial existente

Las cartas actuales están almacenadas en claro. No existe una conversión segura que pueda realizar el servidor sin ver el contenido ni poseer claves privadas.

La migración tendrá que ser una operación explícita y auditable desde un navegador autenticado:

1. Crear y respaldar las claves de ambas cuentas; comprobar las huellas entre sí.
2. Activar un esquema versionado de contenido, por ejemplo `plaintext-v1` y `e2ee-v2`, y permitir temporalmente ambos formatos durante la transición.
3. Cada cliente obtiene una carta histórica que está autorizado a leer, la descifra (porque todavía está en claro), cifra el contenido localmente y sube el ciphertext junto con los dos sobres de DEK.
4. La otra cuenta verifica que puede descifrar la carta y confirma la conversión. Solo después se programa el borrado de la versión en claro, backups y cachés conforme a una política de retención explícita.
5. Si una cuenta ya fue eliminada, el participante activo puede cifrar el contenido para sí mismo, pero no debe fabricar ni restaurar una clave privada del usuario eliminado.

No se debe activar el modo obligatorio E2EE hasta que todas las cartas elegibles estén convertidas o el usuario haya elegido explícitamente excluir/eliminar los elementos históricos que no pueda migrar.

## Fases y criterios de aceptación

| Fase | Entrega | Criterio de salida |
|---|---|---|
| 0 | Modelo de amenazas, formato versionado, biblioteca elegida y revisión criptográfica externa | Protocolo y límites documentados; no hay criptografía casera |
| 1 | Creación de claves, huellas, verificación de la otra cuenta y respaldo probado | Dos dispositivos independientes importan y verifican claves |
| 2 | Sobres DEK y cifrado de borradores locales/remotos | Ningún cuerpo de borrador queda en claro fuera de memoria |
| 3 | Cifrado de envío, respuestas, descifrado y notificaciones sin contenido | Solo remitente/destinatario descifran; la base solo contiene ciphertext |
| 4 | Conversión de historial y eliminación de plaintext | Prueba de descifrado y restauración de respaldo para cada grupo de datos |
| 5 | Rotación, cambio de contraseña, recuperación, cambio/pérdida de dispositivo y eliminación de cuenta | Recuperación validada y comportamiento documentado ante pérdida de claves |

Pruebas obligatorias: alteración de un byte del ciphertext, nonce repetido por error, sobre de otro destinatario, ciphertext de otra carta, revisión antigua/replay, clave pública sustituida, clave de respaldo incorrecta, contraseña restablecida, cuenta deshabilitada, respuesta a una carta histórica y restauración en dispositivo limpio. Ninguna prueba debe registrar el plaintext ni material secreto.

## Referencias técnicas

- [Web Cryptography API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API): primitivas criptográficas accesibles desde navegadores en contextos seguros (HTTPS); es una API de bajo nivel, no un protocolo E2EE completo.
- [RFC 9180 — Hybrid Public Key Encryption (HPKE)](https://www.rfc-editor.org/rfc/rfc9180): marco para encapsular claves para un destinatario mediante criptografía híbrida.
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html): selección de algoritmos, gestión de claves, nonces y almacenamiento.

**Decisión para esta versión:** documentar y preparar el sistema para paginación/búsqueda mientras se conserva el backend de cartas actual; no activar E2EE parcialmente. El cifrado se debe implementar como un cambio de protocolo coordinado entre frontend, base de datos, notificaciones, recuperación y migración, después de probarlo con dos cuentas en una branch aislada.
