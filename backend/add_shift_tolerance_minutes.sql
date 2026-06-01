-- Present tolerance: worked >= (shift duration - tolerance_minutes).
-- Separate from grace_minutes (late check-in after shift_start + grace).
-- Run once in Supabase SQL Editor.

ALTER TABLE public.shift_presets
  ADD COLUMN IF NOT EXISTS tolerance_minutes smallint NOT NULL DEFAULT 15;

ALTER TABLE public.employee_shift_settings
  ADD COLUMN IF NOT EXISTS tolerance_minutes smallint NOT NULL DEFAULT 15;

COMMENT ON COLUMN public.shift_presets.tolerance_minutes IS 'Minutes subtracted from shift length for Present threshold';
COMMENT ON COLUMN public.employee_shift_settings.tolerance_minutes IS 'Per-employee Present tolerance (minutes)';
