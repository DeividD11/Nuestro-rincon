begin;
select plan(18);

with samples(title, body, needle) as (values
  ('Una carta de amor', '<p>Te quiero mucho</p>', 'amor'),
  ('100% nuestro', '<p>el 100% es literal</p>', '%'),
  ('A_B', '<p>A_B</p>', '_'),
  ('ruta\\carta', '<p>ruta\\carta</p>', E'\\'),
  ('Árbol', '<p>Árbol</p>', 'árbol'),
  ('Sin coincidencia', '<p>otro texto</p>', 'café'),
  ('', '<p>hola &amp; adiós</p>', '&'),
  ('', '<p>uno<br>dos</p>', 'uno dos'),
  ('', '<strong>Texto</strong>', 'texto'),
  ('', '<p>literal %_\\</p>', '%_\\'),
  ('', '<p>espacios   repetidos</p>', 'repetidos'),
  ('', '<p>mayúsculas</p>', 'MAYÚSCULAS')
), normalized as (
  select *,
    lower(regexp_replace(replace(replace(replace(replace(replace(coalesce(body, ''), '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '<[^>]*>', ' ', 'g')) as old_body,
    public.normalize_letter_search_body(body) as new_body,
    '%' || replace(replace(replace(lower(btrim(needle)), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' as pattern
  from samples
)
select is(new_body, old_body, 'normalizador conserva el HTML normalizado: ' || needle)
from normalized;

with samples(title, body, needle) as (values
  ('Una carta de amor', '<p>Te quiero mucho</p>', 'amor'),
  ('100% nuestro', '<p>el 100% es literal</p>', '%'),
  ('A_B', '<p>A_B</p>', '_'),
  ('ruta\\carta', '<p>ruta\\carta</p>', E'\\'),
  ('Árbol', '<p>Árbol</p>', 'árbol'),
  ('Sin coincidencia', '<p>otro texto</p>', 'café')
), normalized as (
  select *,
    '%' || replace(replace(replace(lower(btrim(needle)), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' as pattern
  from samples
)
select is(
  (strpos(lower(coalesce(title,'')), lower(btrim(needle))) > 0 or strpos(public.normalize_letter_search_body(body), lower(btrim(needle))) > 0),
  (lower(coalesce(title,'')) like pattern escape E'\\' or public.normalize_letter_search_body(body) like pattern escape E'\\'),
  'LIKE mantiene la semántica literal de strpos: ' || needle
) from normalized;

select * from finish();
rollback;
