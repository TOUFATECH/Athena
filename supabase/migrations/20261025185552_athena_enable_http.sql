create extension if not exists http with schema extensions;
create schema if not exists athena;
revoke all on schema athena from public, anon, authenticated;
