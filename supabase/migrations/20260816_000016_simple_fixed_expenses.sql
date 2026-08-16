create table if not exists public.fixed_expenses (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  category text not null check (category in ('rent','electricity','gas','water','insurance','alarm','internet','phone','software','accounting','permits','bank_fees','loan','goodwill','equipment','payroll','cleaning','pest_control','waste','maintenance','marketing','taxes','other')),
  label text not null check (char_length(trim(label)) between 2 and 120),
  amount numeric(12,2) not null check (amount >= 0),
  frequency text not null default 'monthly' check (frequency in ('weekly','monthly','quarterly','yearly','one_time')),
  amortization_months integer check (amortization_months is null or amortization_months between 1 and 600),
  vendor text,
  due_day smallint check (due_day is null or due_day between 1 and 31),
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fixed_expenses_restaurant_idx on public.fixed_expenses(restaurant_id, active, category);
alter table public.fixed_expenses enable row level security;
drop policy if exists fixed_expenses_member_access on public.fixed_expenses;
create policy fixed_expenses_member_access on public.fixed_expenses for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));
update public.business_costs set cost_behavior='variable', variable_percent=null where category='inventory';
update public.business_costs set cost_behavior='fixed', variable_percent=null where category<>'inventory';