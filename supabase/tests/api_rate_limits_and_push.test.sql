begin;

select plan(24);

select has_table('public', 'app_api_rate_limit_buckets', 'rate-limit bucket table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.app_api_rate_limit_buckets'::regclass), 'rate-limit table has RLS');
select ok(not has_table_privilege('anon', 'public.app_api_rate_limit_buckets', 'select'), 'anon cannot read rate-limit buckets');
select ok(not has_table_privilege('authenticated', 'public.app_api_rate_limit_buckets', 'select'), 'authenticated cannot read rate-limit buckets');
select ok(has_table_privilege('service_role', 'public.app_api_rate_limit_buckets', 'select') and has_table_privilege('service_role', 'public.app_api_rate_limit_buckets', 'insert') and has_table_privilege('service_role', 'public.app_api_rate_limit_buckets', 'update') and has_table_privilege('service_role', 'public.app_api_rate_limit_buckets', 'delete'), 'only the backend needs direct rate-limit table access');
select has_function('public', 'consume_app_api_rate_limit', ARRAY['uuid','uuid','text','timestamp with time zone'], 'rate-limit RPC exists');
select ok(has_function_privilege('service_role', 'public.consume_app_api_rate_limit(uuid,uuid,text,timestamp with time zone)', 'execute'), 'service_role can consume rate limit');
select ok(not has_function_privilege('anon', 'public.consume_app_api_rate_limit(uuid,uuid,text,timestamp with time zone)', 'execute'), 'anon cannot call rate limit RPC');
select ok(not has_function_privilege('authenticated', 'public.consume_app_api_rate_limit(uuid,uuid,text,timestamp with time zone)', 'execute'), 'authenticated cannot call rate limit RPC directly');

select has_table('public', 'push_subscriptions', 'push subscription table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.push_subscriptions'::regclass), 'push subscriptions have RLS');
select ok(not has_table_privilege('anon', 'public.push_subscriptions', 'select') and not has_table_privilege('anon', 'public.push_subscriptions', 'insert'), 'anon cannot access push subscriptions');
select ok(not has_table_privilege('authenticated', 'public.push_subscriptions', 'select') and not has_table_privilege('authenticated', 'public.push_subscriptions', 'insert'), 'authenticated cannot access push subscriptions');
select ok(has_table_privilege('service_role', 'public.push_subscriptions', 'select') and has_table_privilege('service_role', 'public.push_subscriptions', 'insert') and has_table_privilege('service_role', 'public.push_subscriptions', 'update') and has_table_privilege('service_role', 'public.push_subscriptions', 'delete'), 'backend can manage subscriptions');
select has_function('public', 'upsert_app_push_subscription', ARRAY['uuid','uuid','text','text','text','text','text','timestamp with time zone'], 'push subscription RPC exists');
select ok(has_function_privilege('service_role', 'public.upsert_app_push_subscription(uuid,uuid,text,text,text,text,text,timestamp with time zone)', 'execute'), 'service_role can register push subscriptions');
select ok(not has_function_privilege('anon', 'public.upsert_app_push_subscription(uuid,uuid,text,text,text,text,text,timestamp with time zone)', 'execute'), 'anon cannot register push subscriptions');

select has_table('public', 'push_delivery_attempts', 'push delivery idempotency table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.push_delivery_attempts'::regclass), 'push delivery attempts have RLS');
select ok(not has_table_privilege('anon', 'public.push_delivery_attempts', 'select') and not has_table_privilege('authenticated', 'public.push_delivery_attempts', 'select'), 'clients cannot inspect delivery attempts');
select has_function('public', 'claim_app_push_delivery', ARRAY['uuid','uuid','timestamp with time zone'], 'delivery claim RPC exists');
select ok(has_function_privilege('service_role', 'public.claim_app_push_delivery(uuid,uuid,timestamp with time zone)', 'execute'), 'service_role can claim push delivery');
select ok(not has_function_privilege('anon', 'public.claim_app_push_delivery(uuid,uuid,timestamp with time zone)', 'execute') and not has_function_privilege('authenticated', 'public.claim_app_push_delivery(uuid,uuid,timestamp with time zone)', 'execute'), 'clients cannot claim push delivery');
select ok(exists (select 1 from pg_indexes where schemaname='public' and tablename='push_delivery_attempts' and indexdef ilike '%unique%notification_id%subscription_id%'), 'delivery uniqueness prevents duplicate event/device rows');

select * from finish();
rollback;
