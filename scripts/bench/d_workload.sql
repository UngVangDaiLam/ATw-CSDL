-- D - workload điển hình của backend: SET LOCAL ROLE + đọc 1 khách + đọc đơn
-- hàng của khách đó. Chạy hai lần: pgaudit.log tắt và bật (cấu hình thật).
\set id random(1, 6000)
BEGIN;
SET LOCAL ROLE nv_hn01;
SELECT id, full_name, phone FROM app.customers WHERE id = :id;
SELECT id, order_no, total_amount FROM app.orders WHERE customer_id = :id;
COMMIT;
