-- Statuts plus justes : maintenance annoncée par le site (503 + Retry-After ou page de maintenance)
-- et blocage anti-robots (Cloudflare) traités à part, ni « en ligne » ni « hors ligne ».
create table if not exists athena.settings (key text primary key, value text not null);
alter table athena.settings enable row level security;
revoke all on athena.settings from public, anon, authenticated;
-- Jeton secret envoyé dans l'en-tête X-Athena-Monitor (à autoriser dans le pare-feu Cloudflare).
insert into athena.settings (key, value) values ('probe_token', replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

alter table athena.checks add column if not exists blocked boolean not null default false;

-- Disponibilité : on exclut la maintenance ET les contrôles bloqués (statut réel inconnu).
create or replace function athena._uptime(mid text, iv interval) returns numeric language sql stable as $$
  select round(100.0 * count(*) filter (where ok) / nullif(count(*), 0), 3)
  from athena.checks where monitor_id = mid and not maintenance and not blocked and at > now() - iv
$$;

-- Nouvelle sonde : en-têtes Athena, verdict ok | fail | maintenance | blocked.
create or replace function athena._probe_v2(m athena.monitors, out ok boolean, out status int, out ms int, out err text, out note text, out verdict text)
language plpgsql as $$
declare r extensions.http_response; t0 timestamptz; h text; j jsonb; tok text; hdrs extensions.http_header[]; body text; retry text;
begin
  ok := false; verdict := 'fail';
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', m.timeout_ms::text);
  h := athena._host(m.url);
  select value into tok from athena.settings where key = 'probe_token';
  hdrs := array[extensions.http_header('User-Agent', 'Athena-Monitor/1.0 (TOUFATECH)'),
                extensions.http_header('X-Athena-Monitor', coalesce(tok, ''))];
  t0 := clock_timestamp();
  begin
    if m.kind = 'dns' then
      r := extensions.http_get('https://dns.google/resolve?name=' || extensions.urlencode(h) || '&type=A');
    else
      r := extensions.http((m.method::extensions.http_method, m.url, hdrs,
                            case when m.method = 'POST' then 'text/plain' end,
                            case when m.method = 'POST' then '' end)::extensions.http_request);
    end if;
  exception when others then
    ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
    err := left(regexp_replace(SQLERRM, '\s+', ' ', 'g'), 300);
    return;
  end;
  ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
  status := r.status;
  body := coalesce(r.content, '');

  if m.kind = 'dns' then
    begin j := body::jsonb; exception when others then j := null; end;
    ok := j is not null and (j->>'Status') = '0' and jsonb_array_length(coalesce(j->'Answer', '[]'::jsonb)) > 0;
    if ok then verdict := 'ok'; note := (select string_agg(a->>'data', ', ') from jsonb_array_elements(j->'Answer') a);
    else err := 'Aucun enregistrement DNS pour ' || h; end if;
    return;
  end if;

  -- 1. Blocage anti-robots : on ne voit pas le vrai site, le statut réel est inconnu.
  if r.status in (403, 429, 503) and (exists (select 1 from unnest(r.headers) x where lower(x.field) = 'cf-mitigated')
        or body ~* '<title>\s*(Just a moment|Attention Required|Un instant)') then
    verdict := 'blocked';
    note := 'Bloqué par Cloudflare : le vrai site n''est pas visible pour Athena';
    return;
  end if;

  -- 2. Maintenance annoncée par le site lui-même (convention : 503 + Retry-After, ou page de maintenance).
  if r.status = 503 then
    select x.value into retry from unnest(r.headers) x where lower(x.field) = 'retry-after' limit 1;
    if retry is not null or body ~* '(maintenance|bient[ôo]t de retour|coming soon|under construction)' then
      ok := true; verdict := 'maintenance';
      note := 'Page de maintenance affichée par le site'
              || case when retry ~ '^\d+$' then ' · retour annoncé dans ' ||
                   case when retry::int >= 3600 then (retry::int / 3600) || ' h' else greatest(1, retry::int / 60) || ' min' end
                 else '' end;
      return;
    end if;
  end if;

  -- 3. Cas normal.
  if athena._code_ok(r.status, m.expected_codes) then ok := true; verdict := 'ok';
  else err := 'Code HTTP ' || r.status || ' (attendu ' || m.expected_codes || ')';
  end if;
  if ok and m.kind = 'keyword' and coalesce(m.keyword, '') <> '' then
    if (position(lower(m.keyword) in lower(body)) > 0) = m.keyword_invert then
      ok := false; verdict := 'fail';
      err := case when m.keyword_invert then 'Mot-clé interdit « ' || m.keyword || ' » trouvé'
                  else 'Mot-clé « ' || m.keyword || ' » introuvable' end;
    end if;
  end if;
end $$;

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
  select * into p from athena._probe_v2(m);
  select count(*) > 0, coalesce(bool_or(x.mute), false) into in_m, mute
  from athena.maintenance x where (x.monitor_id = m.id or x.monitor_id is null) and now() between x.starts_at and x.ends_at;

  if p.verdict in ('maintenance', 'blocked') then
    -- Ni panne ni succès : pas d'incident, pas d'alerte, exclu du calcul de disponibilité.
    new_state := p.verdict;
    if m.state = 'down' then
      update athena.incidents set ended_at = now(), status = 'resolved'
      where monitor_id = m.id and ended_at is null returning id into inc;
      if inc is not null then
        insert into athena.incident_events (incident_id, kind, body) values (inc, 'status', 'resolved');
        insert into athena.incident_events (incident_id, kind, body)
        values (inc, 'comment', case when p.verdict = 'maintenance' then 'Reclassé : le site affiche sa page de maintenance (pas une panne).'
                                     else 'Clôturé : le statut réel n''est plus visible (blocage Cloudflare).' end);
      end if;
    end if;
    update athena.monitors set state = new_state, fail_count = 0, last_check_at = now(),
      last_status = p.status, last_ms = p.ms, last_error = null, last_note = p.note where id = mid;
    insert into athena.checks (monitor_id, ok, state, status, ms, error, note, maintenance, blocked)
    values (m.id, p.ok, new_state, p.status, p.ms, null, p.note, p.verdict = 'maintenance' or in_m, p.verdict = 'blocked');
    return jsonb_build_object('ok', p.ok, 'state', new_state, 'status', p.status, 'ms', p.ms, 'note', p.note);
  end if;

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
    new_state := case when m.state in ('maintenance', 'blocked') then 'unknown' else m.state end;
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

create or replace function athena.overview() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'now', now(),
    'up24', (select round(100.0 * count(*) filter (where ok) / nullif(count(*), 0), 2) from athena.checks where not maintenance and not blocked and at > now() - interval '24 hours'),
    'avg24', (select round(avg(ms)) from athena.checks where ok and not blocked and not maintenance and at > now() - interval '24 hours'),
    'open_incidents', (select count(*) from athena.incidents where ended_at is null),
    'monitors', coalesce((select jsonb_agg(jsonb_build_object(
      'id', m.id, 'name', m.name, 'url', m.url, 'kind', m.kind, 'paused', m.paused,
      'state', case when m.paused then 'paused' else m.state end,
      'fail_count', m.fail_count, 'retries', m.retries,
      'last_check_at', m.last_check_at, 'last_ms', m.last_ms, 'last_status', m.last_status,
      'last_error', m.last_error, 'last_note', m.last_note,
      'up24', athena._uptime(m.id, interval '24 hours'),
      'up30', athena._uptime(m.id, interval '30 days'),
      'avg24', (select round(avg(ms)) from athena.checks c where c.monitor_id = m.id and c.ok and not c.blocked and not c.maintenance and c.at > now() - interval '24 hours'),
      'bars', (select coalesce(jsonb_agg(jsonb_build_array(x.state, x.at, x.ms) order by x.at), '[]')
               from (select state, at, ms from athena.checks c where c.monitor_id = m.id order by at desc limit 40) x),
      'open_incident', (select jsonb_build_object('id', i.id, 'started_at', i.started_at, 'cause', i.cause)
                        from athena.incidents i where i.monitor_id = m.id and i.ended_at is null order by started_at desc limit 1),
      'in_maintenance', exists (select 1 from athena.maintenance x where (x.monitor_id = m.id or x.monitor_id is null) and now() between x.starts_at and x.ends_at)
    )) from athena.monitors m), '[]')
  )
$$;

revoke all on all functions in schema athena from public, anon, authenticated;
