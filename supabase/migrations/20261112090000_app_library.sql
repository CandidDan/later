-- Release only owned, unconsumed library rows after exposure is recorded.
create or replace function public.app_library_page(
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit int default 50
)
returns table(capture_id uuid, captured_at timestamptz, has_more boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_row record;
  v_limit int := greatest(1, least(50, coalesce(p_limit, 50)));
  v_ids uuid[] := array[]::uuid[];
  v_times timestamptz[] := array[]::timestamptz[];
  v_more boolean := false;
begin
  if (p_before is null) <> (p_before_id is null) then
    raise exception 'Incomplete library cursor' using errcode = '22023';
  end if;

  for v_row in
    select c.id, c.captured_at from public.captures c
    left join public.capture_revisit_state s on s.capture_id = c.id
    where c.user_id = auth.uid() and s.consumed_at is null
      and (p_before is null or (c.captured_at, c.id) < (p_before, p_before_id))
    order by c.captured_at desc, c.id desc
  loop
    -- Serialize with consume/recall, and recheck eligibility after waiting.
    perform 1 from public.captures c
      where c.id = v_row.id and c.user_id = auth.uid() for update;
    if not found then continue; end if;
    if exists (select 1 from public.capture_revisit_state s
      where s.capture_id = v_row.id and s.consumed_at is not null) then
      continue;
    end if;
    -- A lookahead establishes pagination but must not count as exposure.
    if cardinality(v_ids) = v_limit then
      v_more := true;
      exit;
    end if;
    if public.revisit_expose(v_row.id) then
      v_ids := array_append(v_ids, v_row.id);
      v_times := array_append(v_times, v_row.captured_at);
    end if;
  end loop;

  return query select v_ids[n], v_times[n], v_more
    from pg_catalog.generate_subscripts(v_ids, 1) n order by n;
end $$;

revoke all on function public.app_library_page(timestamptz,uuid,int) from public, anon, service_role;
grant execute on function public.app_library_page(timestamptz,uuid,int) to authenticated;
