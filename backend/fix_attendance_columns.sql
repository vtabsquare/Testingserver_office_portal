-- Fix attendance column types: checkin/checkout/checkintime/checkouttime 
-- should be TEXT not TIMESTAMPTZ because the code stores time-only strings like "10:00:00"
-- The actual timestamps are stored as BIGINT in crc6f_checkin_timestamp/crc6f_checkout_timestamp

-- 1. Fix crc6f_table13s (attendance)
ALTER TABLE crc6f_table13s ALTER COLUMN crc6f_checkin TYPE TEXT USING crc6f_checkin::TEXT;
ALTER TABLE crc6f_table13s ALTER COLUMN crc6f_checkout TYPE TEXT USING crc6f_checkout::TEXT;

-- 2. Fix crc6f_hr_loginactivitytbs (login activity)
ALTER TABLE crc6f_hr_loginactivitytbs ALTER COLUMN crc6f_checkintime TYPE TEXT USING crc6f_checkintime::TEXT;
ALTER TABLE crc6f_hr_loginactivitytbs ALTER COLUMN crc6f_checkouttime TYPE TEXT USING crc6f_checkouttime::TEXT;
