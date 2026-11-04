-- Les captures sont prises dès que le site répond (même en maintenance ou en erreur HTTP).
do $$ declare d text; begin
  select pg_get_functiondef('athena.check(text,boolean)'::regprocedure) into d;
  d := replace(d, 'if st <> ''down'' and (force_preview', 'if r is not null and (force_preview');
  execute d;
end $$;

-- Lecture du jeton qui permet à Athena de passer le pare-feu Cloudflare (admins uniquement, via athena_rpc).
create or replace function athena.probe_settings() returns jsonb language sql stable as $$
  select jsonb_build_object('header', 'X-Athena-Monitor', 'token', (select value from athena.settings where key = 'probe_token'),
                            'user_agent', 'Athena-Monitor/1.0 (TOUFATECH)')
$$;

do $$ declare d text; begin
  select pg_get_functiondef('public.athena_rpc(text,jsonb)'::regprocedure) into d;
  d := replace(d, '  when ''channel_test'' then', '  when ''probe_settings'' then
    return athena.probe_settings();
  when ''channel_test'' then');
  execute d;
end $$;

revoke all on all functions in schema athena from public, anon, authenticated;
revoke all on function public.athena_rpc(text, jsonb) from public, anon;
grant execute on function public.athena_rpc(text, jsonb) to authenticated;
