-- B1 - đọc 100 dòng, cột KHÔNG mã hóa (phone). Cùng RLS với B2 để chỉ còn
-- khác nhau ở bước giải mã.
BEGIN;
SET LOCAL ROLE nv_hn01;
SELECT phone FROM app.customers ORDER BY id LIMIT 100;
COMMIT;
