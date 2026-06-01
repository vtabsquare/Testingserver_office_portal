-- Shift presets + employee assignment (run in Supabase SQL Editor)

create table if not exists public.shift_presets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  shift_start time not null default time '09:00',
  shift_end time not null default time '18:00',
  work_week text not null default 'mon-sat',
  grace_minutes smallint not null default 15,
  tolerance_minutes smallint not null default 15,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_presets_grace_chk check (grace_minutes = 15),
  constraint shift_presets_order_chk check (shift_end > shift_start),
  constraint shift_presets_min_2h_chk check ((shift_end - shift_start) >= interval '2 hours'),
  constraint shift_presets_work_week_chk check (work_week in ('mon-fri', 'mon-sat'))
);

alter table public.employee_shift_settings
  add column if not exists preset_id uuid references public.shift_presets(id) on delete set null;

create index if not exists idx_employee_shift_settings_preset_id
  on public.employee_shift_settings (preset_id);

-- Optional starter presets (safe to run once)
insert into public.shift_presets (name, shift_start, shift_end, work_week)
values
  ('Shift 1', time '09:00', time '18:00', 'mon-sat'),
  ('Shift 2', time '11:00', time '21:00', 'mon-fri')
on conflict (name) do nothing;
