-- Lectures (vue d'ensemble, détail) et réglages (moniteurs, incidents, maintenance, canaux).
create or replace function athena.sync_monitors(items jsonb) returns int language plpgsql as $$
declare it jsonb; n int := 0;
begin
  for it in select * from jsonb_array_elements(items) loop
    if athena._safe_url(it->>'url') and coalesce(it->>'id', '') ~ '^[A-Za-z0-9_.~:@+-]{1,200}$' then
      insert into athena.monitors (id, name, url) values (it->>'id', left(coalesce(it->>'name', it->>'id'), 80), it->>'url')
      on conflict (id) do update set
        name = excluded.name,
        url = excluded.url,
        state = case when athena.monitors.url <> excluded.url then 'unknown' else athena.monitors.state end,
        fail_count = case when athena.monitors.url <> excluded.url then 0 else athena.monitors.fail_count end;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function athena.overview() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'now', now(),
    'up24', (select round(100.0 * count(*) filter (where ok) / nullif(count(*), 0), 2) from athena.checks where not maintenance and at > now() - interval '24 hours'),
    'avg24', (select round(avg(ms)) from athena.checks where ok and at > now() - interval '24 hours'),
    'open_incidents', (select count(*) from athena.incidents where ended_at is null),
    'monitors', coalesce((select jsonb_agg(jsonb_build_object(
      'id', m.id, 'name', m.name, 'url', m.url, 'kind', m.kind, 'paused', m.paused,
      'state', case when m.paused then 'paused' else m.state end,
      'fail_count', m.fail_count, 'retries', m.retries,
      'last_check_at', m.last_check_at, 'last_ms', m.last_ms, 'last_status', m.last_status,
      'last_error', m.last_error, 'last_note', m.last_note,
      'up24', athena._uptime(m.id, interval '24 hours'),
      'up30', athena._uptime(m.id, interval '30 days'),
      'avg24', (select round(avg(ms)) from athena.checks c where c.monitor_id = m.id and c.ok and c.at > now() - interval '24 hours'),
      'bars', (select coalesce(jsonb_agg(jsonb_build_array(x.state, x.at, x.ms) order by x.at), '[]')
               from (select state, at, ms from athena.checks c where c.monitor_id = m.id order by at desc limit 40) x),
      'open_incident', (select jsonb_build_object('id', i.id, 'started_at', i.started_at, 'cause', i.cause)
                        from athena.incidents i where i.monitor_id = m.id and i.ended_at is null order by started_at desc limit 1),
      'in_maintenance', exists (select 1 from athena.maintenance x where (x.monitor_id = m.id or x.monitor_id is null) and now() between x.starts_at and x.ends_at)
    )) from athena.monitors m), '[]')
  )
$$;

create or replace function athena.detail(mid text, period text default '24h', failures_only boolean default false)
returns jsonb language plpgsql stable as $$
declare iv interval; bk interval; since timestamptz; res jsonb;
begin
  iv := case period when '7d' then interval '7 days' when '30d' then interval '30 days' else interval '24 hours' end;
  bk := case period when '7d' then interval '3 hours' when '30d' then interval '12 hours' else interval '30 minutes' end;
  since := now() - iv;
  select jsonb_build_object(
    'now', now(),
    'monitor', to_jsonb(m) - 'last_notified_at',
    'in_maintenance', exists (select 1 from athena.maintenance x where (x.monitor_id = m.id or x.monitor_id is null) and now() between x.starts_at and x.ends_at),
    'uptime', jsonb_build_object('d1', athena._uptime(mid, interval '24 hours'), 'd7', athena._uptime(mid, interval '7 days'),
                                 'd30', athena._uptime(mid, interval '30 days'), 'd90', athena._uptime(mid, interval '90 days')),
    'stats', (select jsonb_build_object('count', count(*), 'fails', count(*) filter (where not ok),
               'avg', round(avg(ms) filter (where ok)), 'min', min(ms) filter (where ok), 'max', max(ms) filter (where ok),
               'p95', round((percentile_cont(0.95) within group (order by ms) filter (where ok))::numeric))
              from athena.checks where monitor_id = mid and at > since),
    'series', (select coalesce(jsonb_agg(jsonb_build_array(b, avg_ms, oks, total) order by b), '[]')
               from (select date_bin(bk, at, timestamptz '2000-01-01') b, round(avg(ms) filter (where ok)) avg_ms,
                            count(*) filter (where ok) oks, count(*) total
                     from athena.checks where monitor_id = mid and at > since group by 1) s),
    'checks', (select coalesce(jsonb_agg(to_jsonb(c) order by c.at desc), '[]')
               from (select at, ok, state, status, ms, error, note, maintenance, worker from athena.checks
                     where monitor_id = mid and at > since and (not failures_only or not ok)
                     order by at desc limit 200) c),
    'incidents', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'started_at', i.started_at, 'ended_at', i.ended_at,
                    'status', i.status, 'cause', i.cause, 'root_cause', i.root_cause,
                    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'body', e.body) order by e.at), '[]')
                               from athena.incident_events e where e.incident_id = i.id)) order by i.started_at desc), '[]')
                  from (select * from athena.incidents where monitor_id = mid order by started_at desc limit 30) i),
    'maintenance', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'starts_at', x.starts_at,
                      'ends_at', x.ends_at, 'mute', x.mute, 'all', x.monitor_id is null) order by x.starts_at desc), '[]')
                    from (select * from athena.maintenance where (monitor_id = mid or monitor_id is null)
                          and ends_at > now() - interval '30 days' order by starts_at desc limit 30) x),
    'deliveries', (select coalesce(jsonb_agg(jsonb_build_object('at', d.at, 'event', d.event, 'ok', d.ok, 'status', d.status,
                     'error', d.error, 'channel', ch.name, 'kind', ch.kind) order by d.at desc), '[]')
                   from (select * from athena.deliveries where monitor_id = mid order by at desc limit 30) d
                   left join athena.channels ch on ch.id = d.channel_id)
  ) into res from athena.monitors m where m.id = mid;
  return res;
end $$;

create or replace function athena.save_monitor(mid text, cfg jsonb) returns void language plpgsql as $$
begin
  if cfg ? 'expected_codes' and (cfg->>'expected_codes') !~ '^\s*\d{3}(-\d{3})?(\s*,\s*\d{3}(-\d{3})?)*\s*$' then
    raise exception 'Codes attendus invalides. Exemple : 200-299,301';
  end if;
  update athena.monitors set
    kind = coalesce(cfg->>'kind', kind),
    method = coalesce(cfg->>'method', method),
    interval_s = coalesce((cfg->>'interval_s')::int, interval_s),
    timeout_ms = coalesce((cfg->>'timeout_ms')::int, timeout_ms),
    retries = coalesce((cfg->>'retries')::int, retries),
    expected_codes = coalesce(nullif(replace(cfg->>'expected_codes', ' ', ''), ''), expected_codes),
    keyword = case when cfg ? 'keyword' then nullif(left(cfg->>'keyword', 200), '') else keyword end,
    keyword_invert = coalesce((cfg->>'keyword_invert')::boolean, keyword_invert),
    degraded_ms = coalesce((cfg->>'degraded_ms')::int, degraded_ms),
    repeat_min = coalesce((cfg->>'repeat_min')::int, repeat_min),
    paused = coalesce((cfg->>'paused')::boolean, paused),
    tags = case when cfg ? 'tags' then array(select left(t, 30) from jsonb_array_elements_text(cfg->'tags') t limit 12) else tags end,
    state = case when (cfg->>'paused')::boolean is false and paused then 'unknown' else state end
  where id = mid;
  if not found then raise exception 'Moniteur inconnu'; end if;
end $$;

create or replace function athena.remove_monitor(mid text) returns void language sql as $$
  delete from athena.monitors where id = mid
$$;

create or replace function athena.incident_update(iid bigint, comment text, new_status text, root text) returns void
language plpgsql as $$
begin
  if coalesce(comment, '') <> '' then
    insert into athena.incident_events (incident_id, kind, body) values (iid, 'comment', left(comment, 2000));
  end if;
  if new_status is not null then
    if new_status not in ('open','investigating','identified','resolved') then raise exception 'Statut invalide'; end if;
    update athena.incidents set status = new_status,
      ended_at = case when new_status = 'resolved' then coalesce(ended_at, now()) else ended_at end
    where id = iid and status <> new_status;
    if found then
      insert into athena.incident_events (incident_id, kind, body) values (iid, 'status', new_status);
    end if;
  end if;
  if root is not null then
    update athena.incidents set root_cause = nullif(left(root, 2000), '') where id = iid;
  end if;
end $$;

create or replace function athena.maintenance_add(mid text, title text, starts timestamptz, ends timestamptz, mute boolean)
returns bigint language plpgsql as $$
declare nid bigint;
begin
  if ends <= starts then raise exception 'La fin doit être après le début'; end if;
  insert into athena.maintenance (monitor_id, title, starts_at, ends_at, mute)
  values (nullif(mid, ''), left(coalesce(nullif(title, ''), 'Maintenance'), 120), starts, ends, coalesce(mute, true))
  returning id into nid;
  return nid;
end $$;

create or replace function athena.maintenance_delete(xid bigint) returns void language sql as $$
  delete from athena.maintenance where id = xid
$$;

-- Les secrets des canaux ne sont jamais renvoyés en entier.
create or replace function athena._mask(c athena.channels) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'name', c.name, 'enabled', c.enabled, 'on_down', c.on_down, 'on_up', c.on_up,
    'monitor_ids', c.monitor_ids,
    'target', case c.kind
      when 'telegram' then 'Chat ' || coalesce(c.config->>'chat_id', '?') || ' · bot ••••' || right(coalesce(c.config->>'token', ''), 4)
      else coalesce(athena._host(c.config->>'url'), '?') || ' · ••••' || right(coalesce(c.config->>'url', ''), 4)
    end)
$$;

create or replace function athena.channels_list() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'channels', coalesce((select jsonb_agg(athena._mask(c) order by c.created_at) from athena.channels c), '[]'),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object('at', d.at, 'event', d.event, 'ok', d.ok, 'status', d.status,
        'error', d.error, 'channel', ch.name, 'monitor', m.name) order by d.at desc)
      from (select * from athena.deliveries order by at desc limit 40) d
      left join athena.channels ch on ch.id = d.channel_id
      left join athena.monitors m on m.id = d.monitor_id), '[]'))
$$;

create or replace function athena.channel_save(cid bigint, kind text, name text, cfg jsonb, monitor_ids jsonb,
                                                enabled boolean, on_down boolean, on_up boolean)
returns bigint language plpgsql as $$
declare cur athena.channels; merged jsonb; nid bigint; mids text[];
begin
  if kind not in ('discord','slack','telegram','webhook') then raise exception 'Type de canal inconnu'; end if;
  if cid is not null then
    select * into cur from athena.channels where id = cid;
    if not found then raise exception 'Canal inconnu'; end if;
  end if;
  merged := coalesce(cur.config, '{}'::jsonb) || coalesce((select jsonb_object_agg(k, v) from jsonb_each(coalesce(cfg, '{}')) e(k, v)
                                                            where v <> '""'::jsonb and v <> 'null'::jsonb), '{}'::jsonb);
  if kind = 'telegram' then
    if coalesce(merged->>'token', '') !~ '^\d+:[A-Za-z0-9_-]{20,}$' then raise exception 'Jeton du bot Telegram invalide'; end if;
    if coalesce(merged->>'chat_id', '') !~ '^(-?\d+|@[A-Za-z0-9_]{4,})$' then raise exception 'Identifiant de chat Telegram invalide'; end if;
    merged := jsonb_build_object('token', merged->>'token', 'chat_id', merged->>'chat_id');
  else
    if not athena._safe_url(merged->>'url') or (merged->>'url') !~* '^https://' then raise exception 'Adresse du webhook invalide (https obligatoire)'; end if;
    merged := jsonb_build_object('url', merged->>'url');
  end if;
  if monitor_ids is not null and jsonb_typeof(monitor_ids) = 'array' and jsonb_array_length(monitor_ids) > 0 then
    mids := array(select jsonb_array_elements_text(monitor_ids));
  end if;
  if cid is null then
    insert into athena.channels (kind, name, config, monitor_ids, enabled, on_down, on_up)
    values (kind, left(coalesce(nullif(name, ''), initcap(kind)), 60), merged, mids, coalesce(enabled, true), coalesce(on_down, true), coalesce(on_up, true))
    returning id into nid;
  else
    update athena.channels c set kind = channel_save.kind, name = left(coalesce(nullif(channel_save.name, ''), c.name), 60), config = merged,
      monitor_ids = mids, enabled = coalesce(channel_save.enabled, c.enabled),
      on_down = coalesce(channel_save.on_down, c.on_down), on_up = coalesce(channel_save.on_up, c.on_up)
    where c.id = cid;
    nid := cid;
  end if;
  return nid;
end $$;

create or replace function athena.channel_delete(cid bigint) returns void language sql as $$
  delete from athena.channels where id = cid
$$;

create or replace function athena.channel_test(cid bigint) returns jsonb language plpgsql as $$
declare c athena.channels; s record;
begin
  select * into c from athena.channels where id = cid;
  if not found then raise exception 'Canal inconnu'; end if;
  s := athena._send(c, '🧪 Test Athena : ce canal reçoit bien les alertes.',
                    jsonb_build_object('event', 'test', 'source', 'athena', 'at', now()));
  insert into athena.deliveries (channel_id, event, ok, status, error) values (c.id, 'test', s.ok, s.status, s.err);
  return jsonb_build_object('ok', s.ok, 'status', s.status, 'error', s.err);
end $$;

revoke all on all functions in schema athena from public, anon, authenticated;
