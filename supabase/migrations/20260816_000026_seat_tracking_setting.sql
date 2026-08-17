-- Per-seat tracking is the right default for table service, but a counter or a
-- fast bistro does not want the extra step. Making it a per-restaurant switch
-- rather than forcing one flow on everyone.

alter table public.app_settings
  add column if not exists seat_tracking_enabled boolean not null default true;

comment on column public.app_settings.seat_tracking_enabled is
  'When false the POS hides the seat map and bills the table as one, without tagging items to a seat.';
