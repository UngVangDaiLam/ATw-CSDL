-- A4 - CÓ RLS, tra 1 dòng theo khóa chính.
\set id random(1, 6000)
BEGIN;
SET LOCAL ROLE nv_hn01;
SELECT id, full_name, phone FROM app.customers WHERE id = :id;
COMMIT;
