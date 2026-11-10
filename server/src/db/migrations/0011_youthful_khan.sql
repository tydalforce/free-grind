-- Snapshot sync only: the composite primary keys on admin_audit_log and
-- security_events were already created by 0010_partition_logs (custom SQL,
-- which drizzle-kit does not reflect in its snapshot).
SELECT 1;
