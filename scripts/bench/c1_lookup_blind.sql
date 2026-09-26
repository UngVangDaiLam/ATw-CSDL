-- C1 - tra khách theo CCCD qua blind index (dùng index UNIQUE trên cccd_hash).
BEGIN;
SET LOCAL ROLE nv_hn01;
SELECT id, full_name FROM app.customers WHERE cccd_hash = app.blind_index('001201000001');
COMMIT;
