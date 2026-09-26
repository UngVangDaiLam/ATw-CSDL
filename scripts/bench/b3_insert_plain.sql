-- B3 - thêm 1 khách hàng KHÔNG có CCCD. ROLLBACK để không làm bẩn dữ liệu seed.
BEGIN;
SET LOCAL ROLE nv_hn01;
INSERT INTO app.customers (branch_id, full_name, phone) VALUES (1, 'Bench', '0900000000');
ROLLBACK;
