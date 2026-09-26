-- A2 - CÓ RLS: đúng kiểu backend chạy mỗi request. Không có WHERE - policy
-- branch_isolation tự thêm branch_id = app.current_branch_id().
BEGIN;
SET LOCAL ROLE nv_hn01;
SELECT count(*), sum(length(full_name)) FROM app.customers;
COMMIT;
