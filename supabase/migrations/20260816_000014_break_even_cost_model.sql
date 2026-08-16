alter table public.business_costs add column if not exists cost_behavior text not null default 'fixed' check (cost_behavior in ('fixed','variable','mixed'));
alter table public.business_costs add column if not exists variable_percent numeric(7,4) check (variable_percent is null or (variable_percent >= 0 and variable_percent <= 1));
alter table public.products add column if not exists unit_cost numeric(12,4) check (unit_cost is null or unit_cost >= 0);

update public.business_costs set cost_behavior = case
  when category in ('inventory') then 'variable'
  when category in ('rent','insurance','software','professional','financing','goodwill','equipment') then 'fixed'
  when category in ('utilities','payroll','maintenance','marketing','taxes') then 'mixed'
  else cost_behavior end
where cost_behavior='fixed';

create index if not exists business_costs_behavior_idx on public.business_costs(restaurant_id,cost_behavior,active);
