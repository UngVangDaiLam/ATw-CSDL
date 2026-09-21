-- Chạy tự động lúc khởi tạo database lần đầu (docker-entrypoint-initdb.d).
-- pgaudit đã được nạp qua shared_preload_libraries trong docker-compose.yml (command),
-- ở đây chỉ cần bật extension trong database "dbsec".

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgaudit;

-- Kiểm tra nhanh (chỉ để xem log lúc container khởi động lần đầu):
DO $$
BEGIN
  RAISE NOTICE 'pgcrypto, pgaudit da duoc bat cho database %', current_database();
END $$;
