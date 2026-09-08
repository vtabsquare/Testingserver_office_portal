-- ============================================================================
-- FACEAUTH RE-VERIFICATION TRACKING - add columns to crc6f_table12s (employee)
-- Persists the "last verified at" timestamp server-side (previously only
-- lived in the browser's localStorage) so a backend scheduler can compute
-- due_soon/overdue/missed status and push native alerts to the Monitoring
-- Tool even when the OfficeHub browser tab is closed.
-- ============================================================================

ALTER TABLE crc6f_table12s
    ADD COLUMN IF NOT EXISTS crc6f_lastfaceverifiedat TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS crc6f_lastfacealertlevel VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_crc6f_table12s_lastfaceverifiedat ON crc6f_table12s(crc6f_lastfaceverifiedat);
