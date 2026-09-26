-- B4 - thêm 1 khách hàng CÓ CCCD: mã hóa + blind index, như app/routes/customers.js.
-- Tiền tố 0018 không trùng PHẦN A/PHẦN B của seed; ROLLBACK nên không đụng UNIQUE.
\set n random(1, 99999999)
BEGIN;
SET LOCAL ROLE nv_hn01;
INSERT INTO app.customers (branch_id, full_name, phone, cccd, cccd_hash)
VALUES (1, 'Bench', '0900000000',
        app.encrypt_text('0018' || lpad(:n::text, 8, '0')),
        app.blind_index('0018' || lpad(:n::text, 8, '0')));
ROLLBACK;
