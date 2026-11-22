# Paginación por cursor y búsqueda

## Contrato

Las carpetas de cartas usan `public.list_user_letters_cursor` (migración local `20261121210000_cursor_based_letter_pagination.sql`) y no devuelven un total exacto. La función retorna `items`, `loaded`, `limit`, `hasMore` y `nextCursor`. El cursor se compone de `sortAt` e `id` y aplica una comparación lexicográfica descendente:

```sql
(sort_at, id) < (p_cursor_sort_at, p_cursor_id)
```

La combinación de timestamp e identificador mantiene un orden determinista cuando varias cartas comparten fecha. La consulta recupera `limit + 1` filas; esa fila adicional solo sirve para conocer `hasMore`, no para contar todo el buzón. El cursor siguiente corresponde a la última fila devuelta al cliente.

La función filtra carpeta y búsqueda en PostgreSQL. Los hilos usan cursor por `sent_at` e ID; las notificaciones, por `created_at` e ID. El frontend guarda el cursor en el estado de cada sección, concatena páginas y elimina duplicados por UUID.

## Recuento del dashboard

`list_user_letters` se conserva para las cifras agregadas del dashboard (recibidas, enviadas, borradores y no leídas), donde se necesita el total. La carga paginada de carpetas/hilos/notificaciones no calcula `COUNT(*)` exacto en cada página. La antigua función `selectPageRows` basada en `Range`/`OFFSET` se retiró del módulo compartido porque ya no tenía consumidores; la única llamada restante con límite/offset lógico es el RPC de agregados del dashboard.

## Índices y evaluación

La búsqueda cursor conserva la semántica de subcadena literal y normaliza el cuerpo HTML a través de `public.normalize_letter_search_body(text)`. Los comodines `%`, `_` y `\` introducidos por el usuario se escapan para que `LIKE` equivalga al filtro anterior basado en `strpos`.

No se crean índices GIN/GiST de búsqueda en esta migración. Consulta [`docs/LETTER_SEARCH_PERFORMANCE.md`](LETTER_SEARCH_PERFORMANCE.md) para la medición de referencia, `EXPLAIN (ANALYZE, BUFFERS)`, los índices `pg_trgm` candidatos y el procedimiento de validación con datos sintéticos en una branch aislada. La paginación por cursor elimina `OFFSET` y los recuentos exactos por página, pero no hace automáticamente barata una búsqueda por substring.

## Migración y producción

La función nueva se define en `supabase/migrations/20261121210000_cursor_based_letter_pagination.sql` y `letters-api` local ya la invoca. **La migración todavía no está aplicada en producción**. Debe probarse con pgTAP en una base aislada y desplegarse junto con la nueva `letters-api`; no publiques la Edge Function antes de que el RPC exista en el backend remoto.

`supabase/tests/cursor_pagination.test.sql` comprueba existencia, tipo de retorno, permisos `service_role` y propiedades del cursor/página limitada. También deben hacerse pruebas con registros que compartan timestamp, cambios concurrentes y decenas de miles de filas para validar los límites de negocio.



