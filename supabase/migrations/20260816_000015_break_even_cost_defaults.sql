create or replace function public.default_business_cost_behavior()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if tg_op='INSERT' then
    new.cost_behavior := case
      when new.category='inventory' then 'variable'
      when new.category in ('rent','insurance','software','professional','financing','goodwill','equipment') then 'fixed'
      when new.category in ('utilities','payroll','maintenance','marketing','taxes') then 'mixed'
      else coalesce(new.cost_behavior,'fixed') end;
    if new.cost_behavior='mixed' and new.variable_percent is null then new.variable_percent:=0.50; end if;
  end if;
  return new;
end; $$;
drop trigger if exists trg_default_business_cost_behavior on public.business_costs;
create trigger trg_default_business_cost_behavior before insert on public.business_costs for each row execute function public.default_business_cost_behavior();
