-- =============================================================================
-- 01_extensions.sql  -  Cài extension
-- Chạy bởi superuser (postgres) trên database $POSTGRES_DB.
-- =============================================================================

-- Schema riêng cho extension, KHÔNG để pgcrypto trong `public`.
-- Lý do bảo mật: PUBLIC có quyền USAGE mặc định trên schema public, nên nếu
-- pgcrypto nằm ở đó thì MỌI role (kể cả readonly_user) đều gọi được
-- pgp_sym_decrypt() -> lớp mã hóa ở lớp 2 bị vô hiệu ngay từ thiết kế.
CREATE SCHEMA IF NOT EXISTS ext;
REVOKE ALL ON SCHEMA ext FROM PUBLIC;

-- pgcrypto: có sẵn trong postgresql-contrib. Dùng ở bước 2 cho
-- pgp_sym_encrypt / pgp_sym_decrypt (mã hóa cột) và hmac (blind index).
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA ext;

-- pgaudit: cài từ gói postgresql-16-pgaudit trong Dockerfile.
-- Lệnh này CHỈ chạy được khi 'pgaudit' đã nằm trong shared_preload_libraries.
CREATE EXTENSION IF NOT EXISTS pgaudit;

-- CREATE EXTENSION cấp EXECUTE cho PUBLIC trên toàn bộ hàm của extension.
-- Thu hồi lại; sang 04_grants.sql sẽ cấp có chọn lọc cho app_user.
DO $$
DECLARE f record;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS sig
        FROM   pg_proc p
        JOIN   pg_namespace n ON n.oid = p.pronamespace
        WHERE  n.nspname = 'ext'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    END LOOP;
END $$;
