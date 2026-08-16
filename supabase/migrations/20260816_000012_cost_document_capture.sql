create table if not exists public.business_cost_documents (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  business_cost_id uuid references public.business_costs(id) on delete set null,
  file_name text not null,
  mime_type text not null,
  file_size integer not null check (file_size > 0 and file_size <= 15728640),
  status text not null default 'pending' check (status in ('pending','extracting','review','accepted','failed')),
  extracted_data jsonb not null default '{}'::jsonb,
  raw_text text,
  confidence numeric(5,4),
  error_message text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists business_cost_documents_restaurant_idx on public.business_cost_documents(restaurant_id, created_at desc);
create index if not exists business_cost_documents_cost_idx on public.business_cost_documents(business_cost_id) where business_cost_id is not null;
alter table public.business_cost_documents enable row level security;
drop policy if exists business_cost_documents_member_access on public.business_cost_documents;
create policy business_cost_documents_member_access on public.business_cost_documents for all to authenticated using (private.is_restaurant_member(restaurant_id)) with check (private.is_restaurant_member(restaurant_id));

alter table public.business_costs add column if not exists subtotal numeric(12,2) check (subtotal is null or subtotal >= 0);
alter table public.business_costs add column if not exists gst numeric(12,2) check (gst is null or gst >= 0);
alter table public.business_costs add column if not exists qst numeric(12,2) check (qst is null or qst >= 0);
alter table public.business_costs add column if not exists document_id uuid references public.business_cost_documents(id) on delete set null;
create index if not exists business_costs_document_idx on public.business_costs(document_id) where document_id is not null;