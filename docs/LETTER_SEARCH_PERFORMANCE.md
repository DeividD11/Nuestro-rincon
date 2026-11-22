# Rendimiento de la búsqueda de cartas

## Estado de la implementación

La ruta paginada `public.list_user_letters_cursor` mantiene el contrato de cursores fecha+UUID y cambia el predicado de substring de `strpos(...) > 0` a `LIKE` con comodines del usuario escapados. Se conservan las reglas de búsqueda:

- El título se compara en minúsculas.
- El cuerpo se decodifica para las entidades HTML habituales (`&nbsp;`, `&amp;`, `&lt;`, `&gt;`, `&quot;`) y las etiquetas se convierten en espacios antes de comparar.
- `%`, `_` y `\` introducidos por la persona son caracteres literales, no comodines.
- El criterio sigue siendo una subcadena, no una búsqueda por palabras ni por relevancia.

La lógica de normalización del cuerpo está centralizada en `public.normalize_letter_search_body(text)`, marcada `IMMUTABLE` para que PostgreSQL pueda usarla en una expresión indexada. La ejecución se revoca a `PUBLIC`, `anon` y `authenticated`, y se concede a `service_role`; la RPC cursor se ejecuta desde las Edge Functions con esa credencial privilegiada.

## Medición de referencia disponible

El 22 de noviembre de 2026 se ejecutó una consulta de referencia con `EXPLAIN (ANALYZE, BUFFERS)` sobre el proyecto actual. `public.letters` tenía 23 filas y ninguna carta activa enviada o borrador. El plan del ejemplo usó `Seq Scan`, evaluó 23 filas, devolvió 0 y registró aproximadamente 0,162 ms de ejecución, 7 bloques compartidos en caché y 0 lecturas físicas.

Este resultado solo confirma que la consulta se puede planificar y ejecutar en el esquema actual. **No representa un benchmark de volumen**: no había cartas activas y la tabla era demasiado pequeña para concluir que un índice sería beneficioso.

## Índices `pg_trgm`: candidatos, no migración

`supabase/performance/search-trigram-candidate.sql` contiene los índices candidatos para título y cuerpo normalizado. Está fuera de `supabase/migrations/` deliberadamente:

- No se debe aplicar automáticamente a producción.
- Requiere confirmar la extensión `pg_trgm` y su esquema en el destino.
- Usa GIN y las mismas expresiones del predicado `LIKE`.
- Debe probarse en una branch/proyecto aislado con volumen y distribución representativos.
- La creación `CONCURRENTLY` debe ejecutarse fuera de una transacción.

`pg_trgm` puede acelerar patrones `LIKE`/`ILIKE` cuando el patrón contiene trigramas útiles; patrones cortos de uno o dos caracteres pueden no extraer trigramas y seguir requiriendo un recorrido amplio. Consulta la [documentación oficial de PostgreSQL 17 sobre `pg_trgm`](https://www.postgresql.org/docs/17/pgtrgm.html).

## Procedimiento de benchmark

1. Crea una branch aislada con una copia sintética de volumen representativo. No uses las cartas reales como fixtures.
2. Incluye distribución realista de longitud, proporción título/cuerpo, estados, propietarios, y cadenas frecuentes/poco frecuentes.
3. Ejecuta `supabase/performance/search-benchmark.sql` con consultas de 2, 3, 8 y más caracteres. Guarda cada plan JSON.
4. Registra `Execution Time`, `Planning Time`, `Shared Hit/Read Blocks`, filas eliminadas por filtro y nodos `Bitmap Index Scan`/`BitmapOr`.
5. Instala los índices candidatos únicamente en esa branch y repite exactamente los mismos parámetros y datos.
6. Compara medianas y percentiles en varias ejecuciones con caché fría y caliente. Comprueba también latencia de INSERT/UPDATE y tamaño de índice: GIN añade coste de almacenamiento y escritura.
7. Ejecuta `supabase/tests/search_semantics.test.sql` con pgTAP y verifica que el resultado por carpeta y por usuario coincide con el comportamiento previo.
8. Conserva los índices solo si existe una mejora repetible en consultas representativas sin degradar de forma relevante las escrituras.

## Full-text search

No se migró a `tsvector` en esta fase. El full-text search separa el texto por lexemas y puede aplicar stemming/configuración lingüística; eso cambia la semántica de subcadena y no sustituye a `strpos` sin un diseño explícito. Si se adopta, debe ser una función de búsqueda adicional o una migración funcional separada, con análisis de idioma español, acentos, puntuación y coincidencias dentro de palabras.

## Alcance y despliegue

Los cambios están en una migración local ya existente y en pruebas pgTAP. No se aplicaron a Supabase remoto ni se desplegó `letters-api`. La migración debe validarse con `supabase db reset`/pgTAP en entorno aislado antes de sincronizarla con la Edge Function correspondiente.
