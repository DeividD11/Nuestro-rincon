-- Benchmark reproducible y de solo lectura sobre el proyecto objetivo.
-- Sustituir :user_id y :query en el cliente SQL. No se insertan datos reales.
-- Usar al menos tres longitudes: 2, 3 y 8+ caracteres; pg_trgm no suele ayudar
-- a patrones que no permiten extraer trigramas.

-- Baseline de equivalencia con la ruta actual (cursor).
explain (analyze, buffers, settings, format json)
select l.id
from public.letters l
join public.letter_user_state us
  on us.letter_id = l.id and us.user_id = :'user_id'::uuid
where l.content_purged_at is null
  and (
    (:'folder' = 'drafts' and l.status = 'draft' and l.sender_id = :'user_id'::uuid and us.trashed_at is null)
    or (:'folder' = 'inbox' and l.status = 'sent' and l.recipient_id = :'user_id'::uuid and us.trashed_at is null and us.archived_at is null)
    or (:'folder' = 'sent' and l.status = 'sent' and l.sender_id = :'user_id'::uuid and us.trashed_at is null and us.archived_at is null)
    or (:'folder' = 'favorites' and l.status = 'sent' and us.is_favorite and us.trashed_at is null)
    or (:'folder' = 'archive' and l.status = 'sent' and us.archived_at is not null and us.trashed_at is null)
    or (:'folder' = 'trash' and l.status in ('draft','sent') and us.trashed_at is not null)
  )
  and (
    lower(coalesce(l.title, '')) like '%' || replace(replace(replace(lower(:'query'), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' escape E'\\'
    or public.normalize_letter_search_body(l.body) like '%' || replace(replace(replace(lower(:'query'), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' escape E'\\'
  )
order by case when :'folder' in ('inbox','sent') then l.sent_at when :'folder'='trash' then us.trashed_at when :'folder'='archive' then us.archived_at when :'folder'='favorites' then us.updated_at else l.updated_at end desc nulls last, l.id desc
limit 41;

-- Tras instalar los índices candidatos en el proyecto aislado, ejecutar de nuevo
-- exactamente esta consulta con los mismos parámetros y comparar: Execution Time,
-- Shared Hit/Read Blocks, Rows Removed by Filter, Bitmap Index Scan y BitmapOr.
