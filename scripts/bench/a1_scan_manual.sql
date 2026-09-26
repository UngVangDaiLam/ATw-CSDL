-- A1 - KHÔNG RLS: superuser (bỏ qua RLS) tự viết điều kiện lọc chi nhánh.
-- SET LOCAL ROLE giữ lại cho công bằng: cặp A2 cũng có đúng một câu SET.
BEGIN;
SET LOCAL ROLE postgres;
SELECT count(*), sum(length(full_name)) FROM app.customers WHERE branch_id = 1;
COMMIT;
