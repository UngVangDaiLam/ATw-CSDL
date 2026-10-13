# Kết quả đo khôi phục (RTO / RPO) — lớp 4

> File này do `backup/scripts/demo_pitr.sh` sinh ra; chạy lại script là ghi đè.

## Điều kiện đo

| Mục | Giá trị |
|-----|---------|
| Ngày đo | 2026-10-13 10:20 (giờ VN) |
| Máy | 16 CPU, 15.4 GB RAM cấp cho Docker; Docker Desktop |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg13+2) |
| Dữ liệu | 6011 khách, 10010 đơn, 4003 thanh toán; database 13 MB |
| Base backup dùng | `backup/full/20261013_101758` (7.4M, đã mã hóa) |
| Kịch bản | superuser xóa toàn bộ `app.payments` + `app.orders`, khôi phục cả cluster về mốc T ngay trước đó |

## RTO — thời gian khôi phục

| Bước của `pitr_restore.sh` | Giây |
|----------------------------|-----:|
| [1/6] Day WAL con lai ra kho archive | 1.9 |
| [2/6] Dung analyzer (neu co) va postgres | 1.9 |
| [3/6] Dung lai data directory tu base backup | 2.8 |
| [4/6] Khoi dong postgres - replay WAL toi 2026-10-13 10:20:06.878695+07 | 3.1 |
| [5/6] Xoa cau hinh recovery khoi postgresql.auto.conf | 1.5 |
| [6/6] Ghi bu canh bao cua cac su kien sau moc khoi phuc | 2.2 |
| **RTO: bước 1–5, database nhận kết nối trở lại** | **11.2** |
| Tổng, kể cả bước 6 (ghi bù cảnh báo, chạy khi dịch vụ đã lên) | 13.4 |

## RPO — dữ liệu mất

| Chỉ số | Giá trị |
|--------|--------:|
| Số dòng (customers + orders + payments) tại mốc T | 20024 |
| Số dòng ngay sau sự cố | 6011 |
| Số dòng sau khôi phục | 20024 |
| **Dòng mất so với mốc T** | **0** |
| Giao dịch commit sau T bị bỏ (gồm cả giao dịch sự cố) | 2 |
| Cửa sổ thời gian bị quay lui (T → lúc bắt đầu khôi phục) | 19.5 giây |

## Đọc số đo thế nào

- Kho WAL còn nguyên nên PITR dừng đúng tại T: RPO so với mốc T là số dòng mất ở bảng trên.
  Cái giá là mọi giao dịch commit **sau** T cũng bị bỏ, kể cả giao dịch hợp lệ — chọn T càng sát sự cố thì mất càng ít.
- Số trên đo trường hợp **máy chủ còn, kho WAL còn**. Mất cả máy chủ thì chỉ khôi phục được tới segment WAL cuối cùng đã archive:
  `archive_timeout = 1min` nên RPO xấu nhất theo cấu hình là chừng đó. Con số này là **cấu hình, chưa đo**.
- RTO tăng theo kích thước base backup và lượng WAL phải replay từ base backup tới T; số ở đây ứng với khối lượng dữ liệu ở mục điều kiện đo.
- Một lần đo, không phải trung bình nhiều lần.
