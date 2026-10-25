-- Moteur de surveillance : moniteurs, contrôles, incidents, maintenance, canaux d'alerte.
create table if not exists athena.monitors (
  id text primary key,
  name text not null,
  url text not null,
  kind text not null default 'http' check (kind in ('http','keyword','dns')),
  method text not null default 'GET' check (method in ('GET','HEAD','POST')),
  interval_s int not null default 60 check (interval_s between 60 and 86400),
  timeout_ms int not null default 10000 check (timeout_ms between 1000 and 30000),
  retries int not null default 3 check (retries between 1 and 10),
  expected_codes text not null default '200-399',
  keyword text,
  keyword_invert boolean not null default false,
  degraded_ms int not null default 3000 check (degraded_ms between 100 and 60000),
  repeat_min int not null default 0 check (repeat_min between 0 and 1440),
  tags text[] not null default '{}',
  paused boolean not null default false,
  state text not null default 'unknown',
  fail_count int not null default 0,
  last_check_at timestamptz,
  last_ok_at timestamptz,
  last_status int,
  last_ms int,
  last_error text,
  last_note text,
  last_notified_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists athena.checks (
  id bigint generated always as identity primary key,
  monitor_id text not null references athena.monitors(id) on delete cascade,
  at timestamptz not null default now(),
  ok boolean not null,
  state text not null,
  status int,
  ms int,
  error text,
  note text,
  maintenance boolean not null default false,
  worker text not null default 'supabase · eu-west-1'
);
create index if not exists checks_monitor_at on athena.checks (monitor_id, at desc);
create table if not exists athena.incidents (
  id bigint generated always as identity primary key,
  monitor_id text not null references athena.monitors(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'open' check (status in ('open','investigating','identified','resolved')),
  cause text,
  root_cause text
);
create index if not exists incidents_monitor on athena.incidents (monitor_id, started_at desc);
create table if not exists athena.incident_events (
  id bigint generated always as identity primary key,
  incident_id bigint not null references athena.incidents(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  body text
);
create table if not exists athena.maintenance (
  id bigint generated always as identity primary key,
  monitor_id text references athena.monitors(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  mute boolean not null default true,
  check (ends_at > starts_at)
);
create table if not exists athena.channels (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('discord','slack','telegram','webhook')),
  name text not null,
  config jsonb not null default '{}',
  monitor_ids text[],
  enabled boolean not null default true,
  on_down boolean not null default true,
  on_up boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists athena.deliveries (
  id bigint generated always as identity primary key,
  channel_id bigint references athena.channels(id) on delete set null,
  monitor_id text references athena.monitors(id) on delete cascade,
  incident_id bigint references athena.incidents(id) on delete set null,
  at timestamptz not null default now(),
  event text, ok boolean, status int, error text
);
create index if not exists deliveries_at on athena.deliveries (at desc);

alter table athena.monitors enable row level security;
alter table athena.checks enable row level security;
alter table athena.incidents enable row level security;
alter table athena.incident_events enable row level security;
alter table athena.maintenance enable row level security;
alter table athena.channels enable row level security;
alter table athena.deliveries enable row level security;

create or replace function athena._host(u text) returns text language sql immutable as $$
  select lower(substring(u from '^https?://(?:[^@/]*@)?([^/:?#]+)'))
$$;

-- Protection SSRF : refuse les réseaux privés et les noms internes.
create or replace function athena._safe_url(u text) returns boolean language plpgsql immutable as $$
declare h text;
begin
  if u is null or u !~* '^https?://[^/\s]+' then return false; end if;
  h := athena._host(u);
  if h is null or h !~ '\.' or h ~ '^\[' then return false; end if;
  if h ~ '(^localhost$|\.local$|\.internal$|\.localhost$|\.lan$)' then return false; end if;
  if h ~ '^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' then return false; end if;
  return true;
end $$;

create or replace function athena._code_ok(code int, spec text) returns boolean language plpgsql immutable as $$
declare part text;
begin
  if code is null then return false; end if;
  foreach part in array string_to_array(replace(coalesce(spec, '200-399'), ' ', ''), ',') loop
    if part ~ '^\d{3}-\d{3}$' then
      if code between split_part(part, '-', 1)::int and split_part(part, '-', 2)::int then return true; end if;
    elsif part ~ '^\d{3}$' and code = part::int then return true;
    end if;
  end loop;
  return false;
end $$;

-- Disponibilité = contrôles réussis / contrôles effectués, hors maintenance.
create or replace function athena._uptime(mid text, iv interval) returns numeric language sql stable as $$
  select round(100.0 * count(*) filter (where ok) / nullif(count(*), 0), 3)
  from athena.checks where monitor_id = mid and not maintenance and at > now() - iv
$$;

create or replace function athena._probe(m athena.monitors, out ok boolean, out status int, out ms int, out err text, out note text)
language plpgsql as $$
declare r extensions.http_response; t0 timestamptz; h text; j jsonb;
begin
  ok := false;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', m.timeout_ms::text);
  h := athena._host(m.url);
  t0 := clock_timestamp();
  begin
    if m.kind = 'dns' then
      r := extensions.http_get('https://dns.google/resolve?name=' || extensions.urlencode(h) || '&type=A');
    elsif m.method = 'HEAD' then r := extensions.http_head(m.url);
    elsif m.method = 'POST' then r := extensions.http_post(m.url, '', 'text/plain');
    else r := extensions.http_get(m.url);
    end if;
  exception when others then
    ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
    err := left(regexp_replace(SQLERRM, '\s+', ' ', 'g'), 300);
    return;
  end;
  ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
  status := r.status;
  if m.kind = 'dns' then
    begin j := r.content::jsonb; exception when others then j := null; end;
    ok := j is not null and (j->>'Status') = '0' and jsonb_array_length(coalesce(j->'Answer', '[]'::jsonb)) > 0;
    if ok then note := (select string_agg(a->>'data', ', ') from jsonb_array_elements(j->'Answer') a);
    else err := 'Aucun enregistrement DNS pour ' || h; end if;
    return;
  end if;
  if athena._code_ok(r.status, m.expected_codes) then ok := true;
  elsif r.status in (403, 503) and (exists (select 1 from unnest(r.headers) x where lower(x.field) = 'cf-mitigated')
        or coalesce(r.content, '') ilike '%<title>Just a moment%') then
    ok := true; note := 'Protégé par Cloudflare';
  else err := 'Code HTTP ' || r.status || ' (attendu ' || m.expected_codes || ')';
  end if;
  if ok and m.kind = 'keyword' and coalesce(m.keyword, '') <> '' then
    if (position(lower(m.keyword) in lower(coalesce(r.content, ''))) > 0) = m.keyword_invert then
      ok := false;
      err := case when m.keyword_invert then 'Mot-clé interdit « ' || m.keyword || ' » trouvé'
                  else 'Mot-clé « ' || m.keyword || ' » introuvable' end;
    end if;
  end if;
end $$;

create or replace function athena._send(c athena.channels, msg text, payload jsonb, out ok boolean, out status int, out err text)
language plpgsql as $$
declare r extensions.http_response;
begin
  ok := false;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '8000');
  begin
    if c.kind = 'discord' then
      r := extensions.http_post(c.config->>'url', jsonb_build_object('content', msg)::text, 'application/json');
    elsif c.kind = 'slack' then
      r := extensions.http_post(c.config->>'url', jsonb_build_object('text', msg)::text, 'application/json');
    elsif c.kind = 'telegram' then
      r := extensions.http_get('https://api.telegram.org/bot' || (c.config->>'token') || '/sendMessage?chat_id='
            || extensions.urlencode(c.config->>'chat_id') || '&text=' || extensions.urlencode(msg));
    else
      r := extensions.http_post(c.config->>'url', payload::text, 'application/json');
    end if;
    status := r.status;
    ok := r.status between 200 and 299;
    if not ok then err := 'Réponse ' || r.status || ' : ' || left(coalesce(r.content, ''), 200); end if;
  exception when others then
    err := left(regexp_replace(SQLERRM, 'bot[0-9]+:[A-Za-z0-9_-]+', 'bot•••', 'g'), 300);
  end;
end $$;

create or replace function athena._notify(m athena.monitors, ev text, inc bigint, detail text) returns int
language plpgsql as $$
declare c athena.channels; s record; msg text; n int := 0; payload jsonb;
begin
  msg := case ev
    when 'down' then '🔴 ' || m.name || ' est HORS LIGNE' || coalesce(' — ' || detail, '') || E'\n' || m.url
    when 'up' then '🟢 ' || m.name || ' est de nouveau EN LIGNE' || coalesce(' — ' || detail, '') || E'\n' || m.url
    else '🔴 Rappel : ' || m.name || ' est toujours hors ligne' || coalesce(' — ' || detail, '') || E'\n' || m.url
  end;
  payload := jsonb_build_object('event', ev, 'monitor', jsonb_build_object('id', m.id, 'name', m.name, 'url', m.url),
                                'incident_id', inc, 'detail', detail, 'at', now(), 'source', 'athena');
  for c in select * from athena.channels
           where enabled and (monitor_ids is null or m.id = any(monitor_ids))
             and ((ev in ('down', 'still_down') and on_down) or (ev = 'up' and on_up)) loop
    s := athena._send(c, msg, payload);
    insert into athena.deliveries (channel_id, monitor_id, incident_id, event, ok, status, error)
    values (c.id, m.id, inc, ev, s.ok, s.status, s.err);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Un contrôle + machine à états (incident à la confirmation de panne, fermeture au retour, alertes).
create or replace function athena.run_one(mid text) returns jsonb language plpgsql as $$
declare m athena.monitors; p record; in_m boolean; mute boolean; new_state text; inc bigint; chk_state text;
begin
  select * into m from athena.monitors where id = mid for update;
  if not found then raise exception 'Moniteur inconnu'; end if;
  if not athena._safe_url(m.url) then
    update athena.monitors set last_check_at = now(), state = 'unknown',
      last_error = 'Adresse refusée : réseau privé ou adresse invalide' where id = mid;
    return jsonb_build_object('ok', false, 'error', 'Adresse refusée');
  end if;
  select * into p from athena._probe(m);
  select count(*) > 0, coalesce(bool_or(x.mute), false) into in_m, mute
  from athena.maintenance x where (x.monitor_id = m.id or x.monitor_id is null) and now() between x.starts_at and x.ends_at;

  if p.ok then
    new_state := case when p.ms > m.degraded_ms then 'degraded' else 'up' end;
    if m.state = 'down' then
      update athena.incidents set ended_at = now(), status = 'resolved'
      where monitor_id = m.id and ended_at is null returning id into inc;
      if inc is not null then
        insert into athena.incident_events (incident_id, kind, body) values (inc, 'up', 'Retour en ligne · ' || p.ms || ' ms');
      end if;
      if not mute then perform athena._notify(m, 'up', inc, p.ms || ' ms'); end if;
    end if;
    update athena.monitors set state = new_state, fail_count = 0, last_ok_at = now(), last_check_at = now(),
      last_status = p.status, last_ms = p.ms, last_error = null, last_note = p.note where id = mid;
    chk_state := new_state;
  else
    new_state := m.state;
    if m.fail_count + 1 >= m.retries then
      new_state := 'down';
      if m.state <> 'down' then
        insert into athena.incidents (monitor_id, cause) values (m.id, p.err) returning id into inc;
        insert into athena.incident_events (incident_id, kind, body)
        values (inc, 'down', coalesce(p.err, 'Échec') || ' · ' || (m.fail_count + 1) || ' échecs consécutifs');
        if not mute then
          perform athena._notify(m, 'down', inc, p.err);
          update athena.monitors set last_notified_at = now() where id = mid;
        end if;
      elsif m.repeat_min > 0 and not mute
            and (m.last_notified_at is null or m.last_notified_at < now() - make_interval(mins => m.repeat_min)) then
        select id into inc from athena.incidents where monitor_id = m.id and ended_at is null order by started_at desc limit 1;
        perform athena._notify(m, 'still_down', inc, p.err);
        update athena.monitors set last_notified_at = now() where id = mid;
      end if;
    end if;
    update athena.monitors set state = new_state, fail_count = m.fail_count + 1, last_check_at = now(),
      last_status = p.status, last_ms = p.ms, last_error = p.err, last_note = p.note where id = mid;
    chk_state := case when new_state = 'down' then 'down' else 'pending' end;
  end if;

  insert into athena.checks (monitor_id, ok, state, status, ms, error, note, maintenance)
  values (m.id, p.ok, chk_state, p.status, p.ms, p.err, p.note, in_m);

  return jsonb_build_object('ok', p.ok, 'state', new_state, 'status', p.status, 'ms', p.ms, 'error', p.err, 'note', p.note, 'maintenance', in_m);
end $$;

-- Appelée chaque minute par pg_cron : contrôle les moniteurs arrivés à échéance.
create or replace function athena.run_due() returns int language plpgsql as $$
declare r record; n int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('athena.run_due')) then return 0; end if;
  for r in select id from athena.monitors
           where not paused and (last_check_at is null or last_check_at <= now() - make_interval(secs => interval_s - 5))
           order by last_check_at nulls first loop
    begin
      perform athena.run_one(r.id); n := n + 1;
    exception when others then
      update athena.monitors set last_check_at = now(), last_error = left(SQLERRM, 300) where id = r.id;
    end;
  end loop;
  return n;
end $$;

revoke all on all tables in schema athena from public, anon, authenticated;
revoke all on all functions in schema athena from public, anon, authenticated;
