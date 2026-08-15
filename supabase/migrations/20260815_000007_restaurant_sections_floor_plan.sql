create table if not exists public.restaurant_sections (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (restaurant_id, name)
);

alter table public.restaurant_sections enable row level security;
create policy "sections member access" on public.restaurant_sections for all using (public.is_restaurant_member(restaurant_id)) with check (public.is_restaurant_member(restaurant_id));

alter table public.restaurant_tables add column if not exists section_id uuid references public.restaurant_sections(id) on delete set null;
alter table public.restaurant_tables add column if not exists seats integer not null default 4 check (seats >= 1 and seats <= 50);
alter table public.restaurant_tables add column if not exists floor_x integer not null default 0;
alter table public.restaurant_tables add column if not exists floor_y integer not null default 0;
create index if not exists restaurant_tables_section_idx on public.restaurant_tables(section_id, sort_order, number);

create or replace function public.ensure_default_restaurant_section(rid uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare sid uuid;
begin
  select id into sid from public.restaurant_sections where restaurant_id = rid and active = true order by sort_order, created_at limit 1;
  if sid is null then
    insert into public.restaurant_sections(restaurant_id,name,sort_order) values(rid,'Salle',0) returning id into sid;
  end if;
  update public.restaurant_tables set section_id = sid where restaurant_id = rid and section_id is null;
  return sid;
end;
$$;
revoke all on function public.ensure_default_restaurant_section(uuid) from public, anon, authenticated;

do $$ declare r record; begin for r in select id from public.restaurants loop perform public.ensure_default_restaurant_section(r.id); end loop; end $$;
