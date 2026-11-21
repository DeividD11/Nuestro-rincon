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

La base ya dispone de índices compuestos para las carpetas, hilos y notificaciones, incorporados por migraciones anteriores. Antes de añadir otros, se deben recoger planes con `EXPLAIN (ANALYZE, BUFFERS)` en una branch aislada con volumen representativo. La búsqueda actual por substring de título y texto extraído de HTML puede seguir examinando muchas filas; cursor pagination elimina el coste de `OFFSET` y del recuento exacto, pero no convierte automáticamente una búsqueda de substring en una búsqueda indexada.

Una siguiente optimización podría evaluar `pg_trgm` para títulos/cuerpo normalizado o una columna/vector de búsqueda actualizado transaccionalmente. No se añade ahora porque implica medir selectividad, almacenamiento y resultados para HTML enriquecido antes de cambiar la semántica de búsqueda.

## Migración y producción

La función nueva se define en `supabase/migrations/20261121210000_cursor_based_letter_pagination.sql` y `letters-api` local ya la invoca. **La migración todavía no está aplicada en producción**. Debe probarse con pgTAP en una base aislada y desplegarse junto con la nueva `letters-api`; no publiques la Edge Function antes de que el RPC exista en el backend remoto.

`supabase/tests/cursor_pagination.test.sql` comprueba existencia, tipo de retorno, permisos `service_role` y propiedades del cursor/página limitada. También deben hacerse pruebas con registros que compartan timestamp, cambios concurrentes y decenas de miles de filas para validar los límites de negocio.


## Rendimiento de búsqueda: límite conocido

La búsqueda continúa usando `strpos` sobre título y cuerpo HTML normalizado. El filtro se ejecuta antes del límite de página en PostgreSQL, por lo que no se pierde una coincidencia porque una carta quede detrás de los primeros 100 resultados. Sin embargo, la operación por substring no está respaldada automáticamente por los índices de orden existentes y puede recorrer muchas filas. No se añadió un índice GIN/GiST ni se cambió la semántica de búsqueda en esta entrega. El siguiente paso debe medir consultas con `EXPLAIN (ANALYZE, BUFFERS)` sobre una branch con volumen realista; después se puede valorar `pg_trgm` sobre texto normalizado o una columna de búsqueda mantenida transaccionalmente.
