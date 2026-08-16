alter table public.business_cost_documents add column if not exists storage_path text;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('business-cost-documents','business-cost-documents',false,15728640,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public=false, file_size_limit=15728640, allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists business_cost_documents_storage_select on storage.objects;
create policy business_cost_documents_storage_select on storage.objects for select to authenticated using (
  bucket_id='business-cost-documents' and private.is_restaurant_member((storage.foldername(name))[1]::uuid)
);
drop policy if exists business_cost_documents_storage_insert on storage.objects;
create policy business_cost_documents_storage_insert on storage.objects for insert to authenticated with check (
  bucket_id='business-cost-documents' and private.is_restaurant_member((storage.foldername(name))[1]::uuid)
);
drop policy if exists business_cost_documents_storage_delete on storage.objects;
create policy business_cost_documents_storage_delete on storage.objects for delete to authenticated using (
  bucket_id='business-cost-documents' and private.is_restaurant_member((storage.foldername(name))[1]::uuid)
);