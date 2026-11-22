-- CANDIDATO DE BENCHMARK; NO ES UNA MIGRACIÓN Y NO DEBE EJECUTARSE EN PRODUCCIÓN
-- Ejecutar solo en un proyecto aislado después de poblarlo con un volumen
-- representativo y comparar EXPLAIN (ANALYZE, BUFFERS) antes/después.
-- pg_trgm requiere patrones con al menos tres caracteres útiles para extraer
-- trigrams; consultas de 1-2 caracteres seguirán usando un plan secuencial.

-- Confirmar primero que la extensión no está instalada en otro esquema:
select e.extname, n.nspname as extension_schema
from pg_extension e
join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'pg_trgm';

-- En un destino aislado y solo si el resultado anterior está vacío:
create extension if not exists pg_trgm with schema extensions;

-- Los índices usan exactamente las mismas expresiones que la función cursor.
-- CONCURRENTLY se ejecuta fuera de una transacción.
create index concurrently if not exists letters_title_trgm_idx
  on public.letters using gin (lower(coalesce(title, '')) extensions.gin_trgm_ops);

create index concurrently if not exists letters_body_search_trgm_idx
  on public.letters using gin (public.normalize_letter_search_body(body) extensions.gin_trgm_ops);

analyze public.letters;
analyze public.letter_user_state;

-- Repetir las consultas de docs/LETTER_SEARCH_PERFORMANCE.md y guardar ambos planes.
