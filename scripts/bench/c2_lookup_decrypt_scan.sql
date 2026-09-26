-- C2 - tra khách theo CCCD KHÔNG có blind index: phải giải mã từng dòng rồi so.
-- Đây là thứ sẽ xảy ra nếu bỏ cột cccd_hash - pgp_sym_encrypt không tất định
-- nên không so sánh ciphertext được.
BEGIN;
SET LOCAL ROLE nv_hn01;
SELECT id, full_name FROM app.customers WHERE app.decrypt_text(cccd) = '001201000001';
COMMIT;
