-- Half-day leave support: store Full Day vs Half Day on leave requests.
-- Run once in Supabase SQL Editor.

ALTER TABLE public.crc6f_table14s
  ADD COLUMN IF NOT EXISTS crc6f_dayduration VARCHAR(20) DEFAULT 'Full Day';

COMMENT ON COLUMN public.crc6f_table14s.crc6f_dayduration IS 'Full Day or Half Day';

-- crc6f_totaldays already supports decimals (0.5 for half-day).
