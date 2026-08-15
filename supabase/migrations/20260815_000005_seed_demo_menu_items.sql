create or replace function public.seed_simplepos_demo_products(rid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.products where restaurant_id = rid) then
    insert into public.products (restaurant_id,name,category,price,kitchen_station,sort_order,active)
    values
      (rid,'Burger classique','PLATS',18.50,'kitchen',10,true),
      (rid,'Poutine','PLATS',14.00,'kitchen',20,true),
      (rid,'Tartare de saumon','PLATS',22.00,'kitchen',30,true),
      (rid,'Salade César','ENTRÉES',16.00,'kitchen',10,true),
      (rid,'Frites','ENTRÉES',6.00,'kitchen',20,true),
      (rid,'Bière blonde','BOISSONS',8.00,'bar',10,true),
      (rid,'Coke','BOISSONS',4.25,'bar',20,true),
      (rid,'Café','BOISSONS',3.75,'bar',30,true),
      (rid,'Cheesecake','DESSERTS',9.50,'kitchen',10,true);
  end if;
end;
$$;

revoke all on function public.seed_simplepos_demo_products(uuid) from public, anon, authenticated;

create or replace function public.seed_simplepos_demo_products_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$;

begin
  perform public.seed_simplepos_demo_products(new.id);
  return new;
end;
$$;

revoke all on function public.seed_simplepos_demo_products_trigger() from public, anon, authenticated;

drop trigger if exists trg_seed_simplepos_demo_products on public.restaurants;
create trigger trg_seed_simplepos_demo_products
after insert on public.restaurants
for each row execute function public.seed_simplepos_demo_products_trigger();

do $$
declare r record;
begin
  for r in select id from public.restaurants loop
    perform public.seed_simplepos_demo_products(r.id);
  end loop;
end $$;
