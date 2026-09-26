-- A3 - KHÔNG RLS, tra 1 dòng theo khóa chính.
\set id random(1, 6000)
BEGIN;
SET LOCAL ROLE postgres;
SELECT id, full_name, phone FROM app.customers WHERE id = :id AND branch_id = 1;
COMMIT;
