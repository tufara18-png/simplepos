revoke all on function public.add_owner_membership() from public, anon, authenticated;
revoke all on function public.is_restaurant_member(uuid) from public, anon;
grant execute on function public.is_restaurant_member(uuid) to authenticated;
