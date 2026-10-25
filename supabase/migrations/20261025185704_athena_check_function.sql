-- Cache des favicons et captures d'écran (aperçus), plus contrôle ponctuel d'un site.
create table if not exists athena.cache (
  url text primary key,
  state text,              -- up | protected | down
  status int,
  ms int,
  title text,
  icon text,               -- data URI
  icon_at timestamptz,
  preview text,            -- data URI
  preview_at timestamptz,
  checked_at timestamptz
);
alter table athena.cache enable row level security;
revoke all on athena.cache from public, anon, authenticated;

create or replace function athena._abs(base text, href text) returns text
language sql immutable as $$
  select case
    when href is null or href = '' then null
    when href ~* '^https?://' then href
    when href like '//%' then 'https:' || href
    when href like '/%' then substring(base from '^(https?://[^/]+)') || href
    else substring(base from '^(https?://[^/]+)') || '/' || href
  end
$$;

create or replace function athena._fetch_data_uri(u text, max_bytes int default 200000)
returns text language plpgsql as $$
declare r extensions.http_response; b bytea; ct text;
begin
  if u is null then return null; end if;
  begin
    r := extensions.http_get(u);
  exception when others then return null;
  end;
  if r.status < 200 or r.status >= 300 then return null; end if;
  ct := lower(split_part(coalesce(r.content_type, ''), ';', 1));
  if ct not like 'image/%' and ct <> 'application/octet-stream' then return null; end if;
  if ct = 'application/octet-stream' then ct := 'image/x-icon'; end if;
  b := textsend(r.content);
  if length(b) = 0 or length(b) > max_bytes then return null; end if;
  return 'data:' || ct || ';base64,' || replace(encode(b, 'base64'), E'\n', '');
end $$;

create or replace function athena.check(target text, force_preview boolean default false)
returns table (url text, state text, status int, ms int, title text, icon text, preview text,
               preview_pending boolean, checked_at timestamptz, preview_at timestamptz)
language plpgsql as $$
declare
  r extensions.http_response; t0 timestamptz; dur int; st text; html text;
  ttl text; icon_href text; c athena.cache; shot extensions.http_response; shot_ct text; pend boolean := false;
  new_icon text; new_prev text;
begin
  if target !~* '^https?://[a-z0-9.-]+' then raise exception 'invalid url'; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '9000');
  select * into c from athena.cache where athena.cache.url = target;

  -- 1. ping
  t0 := clock_timestamp();
  begin
    r := extensions.http_get(target);
    dur := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
    html := coalesce(r.content, '');
    ttl := substring(html from '<title[^>]*>([^<]*)');
    if r.status between 200 and 399 then st := 'up';
    elsif r.status in (403, 503) and (ttl ilike 'Just a moment%' or exists (select 1 from unnest(r.headers) h where lower(h.field) = 'cf-mitigated')) then st := 'protected';
    else st := 'down';
    end if;
  exception when others then
    dur := (extract(epoch from clock_timestamp() - t0) * 1000)::int; st := 'down'; r := null; html := ''; ttl := null;
  end;

  -- 2. icon (refresh daily)
  new_icon := c.icon;
  if st = 'up' and (c.icon is null or c.icon_at < now() - interval '1 day') then
    icon_href := coalesce(
      substring(html from '<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"'),
      substring(html from '<link[^>]+href="([^"]+)"[^>]+rel="apple-touch-icon"'),
      substring(html from '<link[^>]+rel="icon"[^>]+type="image/(?:png|svg\+xml)"[^>]+href="([^"]+)"'),
      substring(html from '<link[^>]+rel="icon"[^>]+href="([^"]+\.(?:png|svg)[^"]*)"'),
      substring(html from '<link[^>]+rel="(?:shortcut )?icon"[^>]+href="([^"]+)"'),
      '/favicon.ico');
    new_icon := coalesce(athena._fetch_data_uri(athena._abs(target, replace(icon_href, '&amp;', '&'))), c.icon);
  end if;

  -- 3. preview screenshot (refresh every 15 min, or on demand)
  new_prev := c.preview;
  if st <> 'down' and (force_preview or c.preview is null or c.preview_at < now() - interval '15 minutes') then
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '15000');
    begin
      shot := extensions.http_get('https://s.wordpress.com/mshots/v1/' || replace(replace(replace(target, ':', '%3A'), '/', '%2F'), '?', '%3F')
              || '?w=960&h=600' || case when force_preview then '&_r=' || floor(extract(epoch from now()) / 600)::text else '' end);
      shot_ct := lower(split_part(coalesce(shot.content_type, ''), ';', 1));
      if shot.status = 200 and shot_ct = 'image/jpeg' then
        new_prev := 'data:image/jpeg;base64,' || replace(encode(textsend(shot.content), 'base64'), E'\n', '');
      else pend := true;
      end if;
    exception when others then pend := true;
    end;
  end if;

  insert into athena.cache as k (url, state, status, ms, title, icon, icon_at, preview, preview_at, checked_at)
  values (target, st, r.status, dur, ttl, new_icon,
          case when new_icon is distinct from c.icon then now() else c.icon_at end,
          new_prev,
          case when new_prev is distinct from c.preview then now() else c.preview_at end,
          now())
  on conflict on constraint cache_pkey do update set
    state = excluded.state, status = excluded.status, ms = excluded.ms,
    title = coalesce(excluded.title, k.title), icon = excluded.icon, icon_at = excluded.icon_at,
    preview = excluded.preview, preview_at = excluded.preview_at, checked_at = excluded.checked_at
  returning * into c;

  return query select c.url, c.state, c.status, c.ms, c.title, c.icon, c.preview, pend, c.checked_at, c.preview_at;
end $$;

revoke all on function athena.check(text, boolean) from public, anon, authenticated;
revoke all on function athena._fetch_data_uri(text, int) from public, anon, authenticated;
revoke all on function athena._abs(text, text) from public, anon, authenticated;
