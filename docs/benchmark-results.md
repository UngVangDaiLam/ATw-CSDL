# Kết quả đo hiệu năng

> Sinh tự động bởi `scripts/benchmark.sh` — chạy lại sẽ ghi đè file này.

| | |
|---|---|
| Thời điểm | 2026-10-13 10:23 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg13+2) (Docker, 16 CPU) |
| Dữ liệu | 6011 khách hàng (2004 ở chi nhánh 1), 10010 đơn hàng — seed cố định |
| Cách đo | `pgbench`, 1 client, 10 giây mỗi kịch bản, có làm nóng cache trước |

| Nhóm | Phép đo | Kịch bản (`scripts/bench/`) | Latency TB (ms) | TPS | So với dòng mốc |
|---|---|---|---:|---:|---|
| A | Đếm khách 1 chi nhánh — tự viết WHERE, không RLS | `a1_scan_manual.sql` | 0.421 | 2377.4 | mốc |
| A | Đếm khách 1 chi nhánh — RLS tự lọc | `a2_scan_rls.sql` | 0.500 | 1998.4 | +19% |
| A | Tra 1 khách theo id — không RLS | `a3_point_manual.sql` | 0.175 | 5723.4 | mốc |
| A | Tra 1 khách theo id — có RLS | `a4_point_rls.sql` | 0.242 | 4130.9 | +38% |
| B | Đọc 100 dòng cột thường (phone) | `b1_read_plain.sql` | 0.270 | 3707.0 | mốc |
| B | Đọc 100 dòng có giải mã CCCD | `b2_read_decrypt.sql` | 109.229 | 9.2 | chậm hơn 405 lần |
| B | Thêm 1 khách không CCCD | `b3_insert_plain.sql` | 0.270 | 3709.4 | mốc |
| B | Thêm 1 khách có mã hóa + blind index | `b4_insert_encrypt.sql` | 2.043 | 489.5 | chậm hơn 8 lần |
| C | Tra CCCD qua blind index | `c1_lookup_blind.sql` | 1.735 | 576.3 | mốc |
| C | Tra CCCD bằng cách giải mã cả chi nhánh | `c2_lookup_decrypt_scan.sql` | 1967.725 | 0.5 | chậm hơn 1134 lần |
| D | Workload backend — pgaudit tắt | `d_workload.sql` | 0.338 | 2961.8 | mốc |
| D | Workload backend — pgaudit bật (cấu hình thật) | `d_workload.sql` | 7.423 | 134.7 | chậm hơn 22 lần |

Số dẫn xuất:

- Mỗi lần giải mã một CCCD: **~1.09 ms** (= (B2 − B1) / 100).
- pgAudit (dòng D bật): sinh **11.2 MB** log cho 1347 giao dịch, tức
  khoảng **8684 byte/giao dịch** (ghi song song `.csv` và `.json`).

Phân tích và các đánh đổi: [`docs/performance.md`](performance.md).

## Đọc bảng này thế nào

- Mỗi nhóm có một dòng **mốc** (không có cơ chế) và dòng ngay dưới **có** cơ
  chế; cột cuối là chênh lệch latency giữa hai dòng.
- A, B, C chạy với `pgaudit.log = none` để cô lập đúng cơ chế đang đo. Chi phí
  pgAudit đo riêng ở D.
- Số tuyệt đối phụ thuộc máy; **tỉ lệ** giữa hai dòng trong cùng nhóm mới là
  thứ đem so sánh được.
