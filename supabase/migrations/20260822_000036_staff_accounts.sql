-- Multi-user readiness: until now, nothing in the app ever inserted into restaurant_members --
-- confirmed by a full-repo grep, the only match is a comment. ensureRestaurant() (app-v2.js)
-- gives any user with no restaurant of their own a brand-new one as owner, so a second staff
-- account signing up today gets its own empty restaurant instead of joining the real one.
-- RLS itself was already correct (every member-scoped table admits any row in
-- restaurant_members without checking role) -- the actual gap is that no client-callable path
-- can ever add that second row, since a client only has the anon/publishable key and cannot
-- look up another user's auth.users id to insert one directly.
--
-- add_restaurant_member is a SECURITY DEFINER function so it can read auth.users (email lookup)
-- on the owner's behalf without exposing auth.users to the client at all. Restaurant_members
-- INSERT/UPDATE/DELETE via plain REST already required restaurants.owner_id = auth.uid() (see
-- 20260816_000010_restaurant_member_policy_cleanup.sql), so this function re-checks the exact
-- same condition rather than loosening it.

create or replace function public.add_restaurant_member(p_email text, p_role text default 'staff')
returns public.restaurant_members
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_restaurant_id uuid;
  v_user_id uuid;
  v_member public.restaurant_members;
begin
  if p_role not in ('manager', 'staff') then
    raise exception 'MEV: role invalide (manager ou staff)' using errcode = '22023';
  end if;

  select id into v_restaurant_id from public.restaurants where owner_id = auth.uid() order by created_at asc limit 1;
  if v_restaurant_id is null then
    raise exception 'MEV: aucun restaurant trouve pour ce compte' using errcode = 'P0002';
  end if;

  select id into v_user_id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_user_id is null then
    raise exception 'MEV: aucun compte avec ce courriel -- la personne doit d''abord creer un compte dans l''appli' using errcode = 'P0002';
  end if;

  if v_user_id = auth.uid() then
    raise exception 'MEV: vous etes deja proprietaire de ce restaurant' using errcode = '22023';
  end if;

  insert into public.restaurant_members (restaurant_id, user_id, role)
  values (v_restaurant_id, v_user_id, p_role)
  on conflict (restaurant_id, user_id) do update set role = excluded.role
  returning * into v_member;

  return v_member;
end;
$$;
revoke all on function public.add_restaurant_member(text, text) from public, anon;
grant execute on function public.add_restaurant_member(text, text) to authenticated;

-- list_restaurant_members lets the owner see who currently has access, with the same auth.users
-- email lookup add_restaurant_member uses (also otherwise unreachable from the client). Owner-only
-- for the same reason add_restaurant_member is: it's the "manage staff access" screen.

create or replace function public.list_restaurant_members()
returns table (user_id uuid, email text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_restaurant_id uuid;
begin
  select id into v_restaurant_id from public.restaurants where owner_id = auth.uid() order by created_at asc limit 1;
  if v_restaurant_id is null then
    raise exception 'MEV: aucun restaurant trouve pour ce compte' using errcode = 'P0002';
  end if;

  return query
    select m.user_id, u.email::text, m.role, m.created_at
    from public.restaurant_members m
    join auth.users u on u.id = m.user_id
    where m.restaurant_id = v_restaurant_id
    order by m.created_at asc;
end;
$$;
revoke all on function public.list_restaurant_members() from public, anon;
grant execute on function public.list_restaurant_members() to authenticated;

-- remove_restaurant_member: owner-only, cannot remove self (the owner isn't even a member row
-- with a removable meaning here -- ownership is via restaurants.owner_id, not restaurant_members).

create or replace function public.remove_restaurant_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_restaurant_id uuid;
begin
  select id into v_restaurant_id from public.restaurants where owner_id = auth.uid() order by created_at asc limit 1;
  if v_restaurant_id is null then
    raise exception 'MEV: aucun restaurant trouve pour ce compte' using errcode = 'P0002';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'MEV: impossible de se retirer soi-meme' using errcode = '22023';
  end if;

  delete from public.restaurant_members where restaurant_id = v_restaurant_id and user_id = p_user_id;
end;
$$;
revoke all on function public.remove_restaurant_member(uuid) from public, anon;
grant execute on function public.remove_restaurant_member(uuid) to authenticated;

-- mev_partner_config was owner-only for read AND write. That's right for write (only the owner
-- should change the authorization code/dossier number), but wrong for read: any logged-in staff
-- member submitting a real sale in mev_mode "live" needs these same constants (IDPARTN/IDSEV/
-- CODCERTIF/etc, see mev-live.js loadDeviceAndConfig()) to build a valid request header. Under
-- the owner-only policy, a staff account's every live MEV submission would fail with
-- "Inscription partenaire incomplète" even when the owner has fully configured it.

drop policy if exists "mev partner config owner only" on public.mev_partner_config;

create policy "mev partner config member read" on public.mev_partner_config
  for select to authenticated
  using (private.is_restaurant_member(restaurant_id));

create policy "mev partner config owner write" on public.mev_partner_config
  for insert to authenticated
  with check (exists (select 1 from public.restaurants r where r.id = mev_partner_config.restaurant_id and r.owner_id = (select auth.uid())));

create policy "mev partner config owner update" on public.mev_partner_config
  for update to authenticated
  using (exists (select 1 from public.restaurants r where r.id = mev_partner_config.restaurant_id and r.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.restaurants r where r.id = mev_partner_config.restaurant_id and r.owner_id = (select auth.uid())));

create policy "mev partner config owner delete" on public.mev_partner_config
  for delete to authenticated
  using (exists (select 1 from public.restaurants r where r.id = mev_partner_config.restaurant_id and r.owner_id = (select auth.uid())));
