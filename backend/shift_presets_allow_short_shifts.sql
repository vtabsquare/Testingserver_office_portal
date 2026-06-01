-- Allow shifts shorter than 9 hours (minimum 2 hours; matches app validation).
-- Run once in Supabase SQL Editor, then retry saving shift settings.

-- shift_presets
alter table public.shift_presets drop constraint if exists shift_presets_min_9h_chk;

alter table public.shift_presets drop constraint if exists shift_presets_min_2h_chk;

alter table public.shift_presets
  add constraint shift_presets_min_2h_chk
  check ((shift_end - shift_start) >= interval '2 hours');

-- employee_shift_settings (required for custom per-employee timings)
alter table public.employee_shift_settings drop constraint if exists employee_shift_settings_min_9h_chk;

alter table public.employee_shift_settings drop constraint if exists employee_shift_settings_min_2h_chk;

alter table public.employee_shift_settings
  add constraint employee_shift_settings_min_2h_chk
  check ((shift_end - shift_start) >= interval '2 hours');
