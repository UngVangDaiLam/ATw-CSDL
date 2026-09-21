-- Tạo app_user tối thiểu để app demo (Người A) kết nối được ngay, thay vì
-- dùng superuser dbsec_admin. Đây là bản khởi tạo tạm — B sẽ mở rộng thêm
-- readonly_user, admin_user và làm đúng phần "Phân quyền least privilege"
-- (kiểm tra DROP TABLE bị từ chối, v.v.) ở nhiệm vụ riêng của B.
--
-- File này chạy tự động cùng 01-extensions.sql và 02-schema.sql lúc
-- PostgreSQL khởi tạo volume dữ liệu lần đầu (docker-entrypoint-initdb.d).
-- Nếu volume đã tồn tại từ trước và file này được thêm sau, phải áp dụng
-- thủ công bằng:
--   docker compose exec postgres psql -U dbsec_admin -d dbsec -f /docker-entrypoint-initdb.d/03-app-role.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'doi_mat_khau_nay';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE dbsec TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    branches, staff, customers, orders, payments, audit_log
    TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Không GRANT bất kỳ quyền DDL (CREATE/ALTER/DROP) nào — mặc định role mới
-- không có các quyền này, nên không cần REVOKE tường minh ở bước này.
