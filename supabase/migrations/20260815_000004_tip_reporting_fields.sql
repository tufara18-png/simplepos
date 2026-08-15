alter table public.payments add column if not exists employee_id uuid references auth.users(id) on delete set null default auth.uid();
alter table public.payments add column if not exists tip_kind text not null default 'voluntary' check (tip_kind in ('voluntary','service_charge'));
create index if not exists payments_employee_created_idx on public.payments(employee_id, created_at desc);
