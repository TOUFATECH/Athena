-- API publique protégée : une seule fonction, réservée aux utilisateurs connectés ET autorisés.
alter table athena.monitors add column if not exists cat text;
alter table athena.monitors add column if not exists note text;
alter table athena.monitors add column if not exists logo text;

-- Adresses autorisées (rôle admin ou viewer). Le premier accès crée l'entrée dans athena.members.
create table if not exists athena.allowed (
  email text primary key,
  role text not null check (role in ('admin', 'viewer'))
);
create table if not exists athena.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);
alter table athena.allowed enable row level security;
alter table athena.members enable row level security;
revoke all on athena.allowed, athena.members from public, anon, authenticated;
-- Ajouter les comptes autorisés directement en base (non versionné, dépôt public) :
--   insert into athena.allowed (email, role) values ('vous@exemple.com', 'admin');

create or replace function public.athena_rpc(action text, args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); r text; res jsonb; mid text; known timestamptz; base text;
begin
  if uid is null then raise exception 'Connexion requise' using errcode = '28000'; end if;
  select m.role into r from athena.members m where m.user_id = uid;
  if r is null then
    select a.role into r from auth.users u join athena.allowed a on lower(a.email) = lower(u.email)
    where u.id = uid and u.email_confirmed_at is not null;
    if r is not null then insert into athena.members (user_id, role) values (uid, r) on conflict do nothing; end if;
  end if;
  if r is null then raise exception 'Accès refusé : ce compte n''est pas autorisé sur Athena' using errcode = '42501'; end if;
  args := coalesce(args, '{}'::jsonb);
  if action not in ('me', 'sites', 'overview', 'detail', 'channels', 'check') and r <> 'admin' then
    raise exception 'Accès en lecture seule' using errcode = '42501';
  end if;
  mid := nullif(args->>'id', '');

  case action
  when 'me' then
    return jsonb_build_object('role', r, 'email', (select u.email from auth.users u where u.id = uid));
  when 'sites' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'url', m.url, 'cat', m.cat,
             'note', m.note, 'logo', m.logo, 'created_at', m.created_at) order by m.name) from athena.monitors m), '[]'::jsonb);
  when 'overview' then
    return athena.overview();
  when 'detail' then
    return athena.detail(mid, coalesce(args->>'period', '24h'), coalesce((args->>'fails')::boolean, false));
  when 'channels' then
    return athena.channels_list();
  when 'check' then
    known := coalesce((args->>'known')::timestamptz, 'epoch'::timestamptz);
    select jsonb_build_object('icon', c.icon, 'preview', case when c.preview_at > known then c.preview end,
                              'preview_at', c.preview_at, 'preview_pending', c.preview_pending)
      into res from athena.check(args->>'url', coalesce((args->>'force')::boolean, false) and r = 'admin') c;
    return res;
  when 'run' then
    return athena.run_one(mid);
  when 'site_save' then
    if coalesce(btrim(args->>'name'), '') = '' then raise exception 'Donne un nom au site.'; end if;
    if not athena._safe_url(args->>'url') then raise exception 'Adresse invalide ou sur un réseau privé.'; end if;
    if args ? 'logo' and args->>'logo' is not null
       and (length(args->>'logo') > 300000 or (args->>'logo') !~ '^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$') then
      raise exception 'Logo invalide ou trop lourd.';
    end if;
    if mid is null then
      base := trim(both '-' from left(regexp_replace(lower(coalesce(athena._host(args->>'url'), 'site')), '[^a-z0-9]+', '-', 'g'), 40));
      mid := base;
      if exists (select 1 from athena.monitors where id = mid) then mid := base || '-' || substr(md5(random()::text), 1, 5); end if;
      insert into athena.monitors (id, name, url, cat, note, logo)
      values (mid, left(btrim(args->>'name'), 80), args->>'url', nullif(left(args->>'cat', 60), ''),
              nullif(left(args->>'note', 300), ''), nullif(args->>'logo', ''));
    else
      update athena.monitors m set
        name = left(btrim(args->>'name'), 80),
        state = case when m.url <> args->>'url' then 'unknown' else m.state end,
        fail_count = case when m.url <> args->>'url' then 0 else m.fail_count end,
        url = args->>'url',
        cat = nullif(left(args->>'cat', 60), ''),
        note = nullif(left(args->>'note', 300), ''),
        logo = case when args ? 'logo' then nullif(args->>'logo', '') else m.logo end
      where m.id = mid;
      if not found then raise exception 'Site inconnu'; end if;
    end if;
    return jsonb_build_object('id', mid);
  when 'site_delete' then
    perform athena.remove_monitor(mid); return '{}'::jsonb;
  when 'save_monitor' then
    perform athena.save_monitor(mid, coalesce(args->'cfg', '{}'::jsonb)); return '{}'::jsonb;
  when 'incident_update' then
    perform athena.incident_update((args->>'iid')::bigint, args->>'comment', args->>'status', args->>'root'); return '{}'::jsonb;
  when 'maintenance_add' then
    return to_jsonb(athena.maintenance_add(mid, args->>'title', (args->>'starts')::timestamptz, (args->>'ends')::timestamptz,
                                           coalesce((args->>'mute')::boolean, true)));
  when 'maintenance_delete' then
    perform athena.maintenance_delete((args->>'xid')::bigint); return '{}'::jsonb;
  when 'channel_save' then
    return to_jsonb(athena.channel_save(nullif(args->>'cid', '')::bigint, args->>'kind', args->>'name', coalesce(args->'cfg', '{}'::jsonb),
             case when jsonb_typeof(args->'monitor_ids') = 'array' then args->'monitor_ids' end,
             (args->>'enabled')::boolean, (args->>'on_down')::boolean, (args->>'on_up')::boolean));
  when 'channel_delete' then
    perform athena.channel_delete((args->>'cid')::bigint); return '{}'::jsonb;
  when 'channel_test' then
    return athena.channel_test((args->>'cid')::bigint);
  else
    raise exception 'Action inconnue';
  end case;
  return null;
end $$;

revoke all on function public.athena_rpc(text, jsonb) from public, anon;
grant execute on function public.athena_rpc(text, jsonb) to authenticated;
