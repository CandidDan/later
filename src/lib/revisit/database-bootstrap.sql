-- Minimal Supabase base contract, not a substitute for product migrations/RLS.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
create schema extensions;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text);
create function storage.foldername(text) returns text[] language sql immutable as
  $$ select (string_to_array($1, '/'))[1:array_length(string_to_array($1, '/'), 1)-1] $$;
alter table storage.objects enable row level security;
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
grant select on storage.objects to authenticated;
-- Supabase's base defaults; each product migration owns its tighter grants.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
