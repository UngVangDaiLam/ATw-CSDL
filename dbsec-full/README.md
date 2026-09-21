# Bảo mật CSDL nhiều lớp trên PostgreSQL — Đồ án ATTT

Trạng thái hiện tại: **Tuần 1** — hạ tầng Docker chạy được, schema đã thiết kế, extension bảo mật đã bật.

## Cấu trúc thư mục

```
db-security-postgres/
├── docker-compose.yml       # postgres (PostgreSQL 16 + pgcrypto + pgaudit) + pgadmin
├── .env.example             # copy thành .env rồi đổi mật khẩu, KHÔNG commit .env thật
├── db/
│   └── init/
│       ├── 01-extensions.sql   # bật pgcrypto, pgaudit
│       └── 02-schema.sql       # toàn bộ bảng: branches, staff, customers, orders, payments, audit_log
└── docs/
    └── tuan1-nghien-cuu.md  # ghi chú nghiên cứu pgcrypto / pgAudit / RLS cho báo cáo
```

Các phần chưa có (sẽ thêm dần theo lộ trình 8 tuần): app Node/Express (Tuần 2), phân quyền DB user
(Tuần 3), Row-Level Security (Tuần 4), mã hóa cột (Tuần 5), analyzer + dashboard (Tuần 6), backup/PITR
(Tuần 7), data masking (Tuần 8).

## Chạy lần đầu

1. Cài Docker Desktop (nếu chưa có) và bật WSL2 backend.
2. Copy `.env.example` thành `.env`, đổi hai mật khẩu trong đó.
3. Mở terminal (PowerShell) tại thư mục này, chạy:

   ```
   docker compose up -d
   ```

4. Kiểm tra container đã chạy và khỏe mạnh:

   ```
   docker compose ps
   ```

   Cột `STATUS` của `dbsec_postgres` phải hiện `healthy` sau vài giây.

5. Kiểm tra extension đã bật:

   ```
   docker compose exec postgres psql -U dbsec_admin -d dbsec -c "\dx"
   ```

   Kết quả phải liệt kê `pgcrypto` và `pgaudit`.

6. Kiểm tra schema đã tạo:

   ```
   docker compose exec postgres psql -U dbsec_admin -d dbsec -c "\dt"
   ```

   Phải thấy 6 bảng: `branches`, `staff`, `customers`, `orders`, `payments`, `audit_log`.

7. Mở pgAdmin tại http://localhost:5050 (đăng nhập bằng `PGADMIN_EMAIL` / `PGADMIN_PASSWORD` trong `.env`),
   thêm server mới trỏ vào host `postgres`, port `5432`, user/password lấy từ `.env`.

## Lưu ý quan trọng

- Các file trong `db/init/` **chỉ chạy một lần**, lúc volume `pgdata` được tạo lần đầu (database rỗng).
  Nếu sửa file trong đó sau khi đã chạy `docker compose up` một lần, cần xóa volume để chạy lại:

  ```
  docker compose down -v
  docker compose up -d
  ```

  (Lệnh `down -v` sẽ xóa sạch dữ liệu — chỉ dùng lúc đang phát triển, tuyệt đối không dùng sau khi đã
  seed dữ liệu thật ở Tuần 2 mà chưa backup.)

- `pgaudit` được nạp qua `shared_preload_libraries` ngay trong lệnh khởi động container (xem
  `docker-compose.yml`), vì đây là tham số chỉ có thể đặt lúc PostgreSQL khởi động, không thể bật bằng
  `ALTER SYSTEM` sau khi server đã chạy.

## Việc tiếp theo (vẫn trong Tuần 1)

- [ ] Chạy thử theo hướng dẫn trên, xác nhận cả 6 bảng + 2 extension đều lên đúng.
- [ ] Đọc `docs/tuan1-nghien-cuu.md`, có thể chỉnh sửa/viết thêm bằng lời của bạn để dùng cho báo cáo.
- [ ] Cả 3 người trong nhóm nên tự chạy được `docker compose up -d` trên máy mình trước khi sang Tuần 2.
