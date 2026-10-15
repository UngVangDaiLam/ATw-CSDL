# Kết quả đo RTO / RPO

> Sinh tự động bởi `backup/scripts/measure_rto_rpo.sh` — chạy lại sẽ ghi đè file này.

| | |
|---|---|
| Thời điểm | 2026-10-15 11:21 |
| PostgreSQL | 16.15 (Docker, 8 CPU) |
| Dữ liệu | 6011 khách hàng, database 15 MB |
| Bản sao lưu đầy đủ | 8.4M (base backup + pg_dump, đã mã hóa), tạo mất **10.2 s** |
| WAL | segment 16 MB, `archive_timeout = 1min`, mỗi segment mã hóa gpg trước khi vào kho |
| Tải ghi khi đo | 5 giao dịch/giây (bảng thăm dò `rpo_probe.tick`, mỗi dòng một giao dịch) |

## A. Xóa nhầm dữ liệu → PITR về ngay trước sự cố

Superuser xóa sạch `app.orders` + `app.payments`; mốc khôi phục là thời điểm
ngay trước lệnh `DELETE`. Khôi phục bằng `pitr_restore.sh` trên database thật.
Lặp 3 lần, mỗi lần có base backup mới.

**RTO** (từ lúc bắt đầu khôi phục tới khi database nhận lại kết nối TCP):
min **16.3 s**, trung bình **16.8 s**, max **17.2 s**.
Không gồm thời gian phát hiện sự cố và chọn mốc.

| Lần | Đẩy WAL (s) | Dừng dịch vụ (s) | Dựng lại từ base backup (s) | Replay WAL + promote (s) | Dọn cấu hình, chờ TCP (s) | **RTO (s)** | Ghi bù cảnh báo (s) | GD trước mốc bị mất | Giao dịch cuối giữ lại cách mốc (ms) | GD sau mốc / khoảng mất | Dữ liệu nghiệp vụ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1 | 2.0 | 2.5 | 3.9 | 4.0 | 2.3 | **16.3** | 4.1 | 0 / 101 | 98 | 96 (mat 96) / 22.0s | khop, app: ok |
| 2 | 2.9 | 2.3 | 3.8 | 3.7 | 2.4 | **17.0** | 4.4 | 0 / 100 | 112 | 97 (mat 97) / 22.1s | khop, app: ok |
| 3 | 2.9 | 2.4 | 4.1 | 3.9 | 2.2 | **17.2** | 4.5 | 0 / 100 | 95 | 97 (mat 97) / 22.2s | khop, app: ok |

Đọc bảng:

- **GD trước mốc bị mất = 0** nghĩa là mọi giao dịch đã commit trước mốc đều về
  đủ — RPO tính tới mốc bằng 0. "Cách mốc" nhỏ hơn chu kỳ ghi (200 ms)
  nghĩa là PITR dừng đúng tại giao dịch cuối trước mốc.
- **GD sau mốc / khoảng mất** là cái giá của PITR: mọi giao dịch hợp lệ commit
  sau mốc cũng mất, vì PITR quay lui cả cluster. Khoảng mất = từ mốc tới lúc
  bắt đầu khôi phục — càng phát hiện chậm càng mất nhiều.
- Dữ liệu nghiệp vụ: số đơn hàng / thanh toán / tổng tiền sau khôi phục so với
  ngay trước sự cố; `app: ok` là `app_user` kết nối lại được qua TLS.

## B. Mất máy chủ, chỉ còn kho WAL (lấy mẫu, không phá gì)

RPO(t) = t − thời điểm của giao dịch mới nhất mà toàn bộ WAL của nó đã nằm
trong kho archive. Lấy mẫu mỗi ~2 s trong 300 s.

| Số mẫu | Min (s) | Trung vị (s) | Trung bình (s) | p95 (s) | **Max (s)** |
|---:|---:|---:|---:|---:|---:|
| 90 | 1.4 | 29.0 | 30.2 | 58.1 | **60.9** |

Giới hạn lý thuyết: `archive_timeout` (1min) + thời gian mã hóa và ghi
một segment. **Trong lab kho archive nằm cùng máy với database**, nên mất máy
chủ thật là mất cả kho — con số trên là RPO *nếu* kho được đặt ở máy khác.

## C. Khôi phục logic từ `pg_dump`

Giải mã `secdb.dump.gpg` và `pg_restore` vào một database mới, không đụng `secdb`.

| Thời gian (s) | Số dòng khách/đơn/thanh toán | Bản gốc | Giải mã được CCCD trên bản khôi phục |
|---:|---|---|---|
| 1.4 | 6011/10010/4003 | 6011/10010/4003 | t |

Bản dump chỉ là ảnh chụp tại lúc sao lưu: RPO của cách này là khoảng cách tới
lần `full_backup.sh` gần nhất. Giải mã được CCCD vì bản khôi phục chạy trên
cùng server có khóa `pgcrypto_key` — mất khóa thì cột `cccd`/`card_token` vô dụng.

## Giới hạn của phép đo

- Một máy, database vài chục MB, 3 lần lặp — số tuyệt đối phụ thuộc phần cứng
  và tăng theo dung lượng (bước dựng lại từ base backup tỉ lệ với kích thước data).
- Tải ghi tổng hợp, 1 tiến trình; tải thật nhiều client sinh WAL nhanh hơn nên
  segment đầy trước `archive_timeout` và RPO kịch bản B nhỏ hơn.
- RTO không gồm thời gian con người phát hiện sự cố và quyết định mốc.
