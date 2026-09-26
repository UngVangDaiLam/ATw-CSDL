# Kết quả đo hiệu năng

> Sinh tự động bởi `scripts/benchmark.sh` — chạy lại sẽ ghi đè file này.

| | |
|---|---|
| Thời điểm | 2026-09-26 19:44 |
| PostgreSQL | 16.15 (Debian 16.15-1.pgdg13+2) (Docker, 8 CPU) |
| Dữ liệu | 6005 khách hàng (2002 ở chi nhánh 1), 10004 đơn hàng — seed cố định |
| Cách đo | `pgbench`, 1 client, 10 giây mỗi kịch bản, có làm nóng cache trước |

| Nhóm | Phép đo | Kịch bản (`scripts/bench/`) | Latency TB (ms) | TPS | So với dòng mốc |
|---|---|---|---:|---:|---|
| A | Đếm khách 1 chi nhánh — tự viết WHERE, không RLS | `a1_scan_manual.sql` | 0.907 | 1102.4 | mốc |
| A | Đếm khách 1 chi nhánh — RLS tự lọc | `a2_scan_rls.sql` | 1.018 | 982.5 | +12% |
| A | Tra 1 khách theo id — không RLS | `a3_point_manual.sql` | 0.386 | 2590.7 | mốc |
| A | Tra 1 khách theo id — có RLS | `a4_point_rls.sql` | 0.504 | 1984.4 | +31% |
| B | Đọc 100 dòng cột thường (phone) | `b1_read_plain.sql` | 0.628 | 1592.6 | mốc |
| B | Đọc 100 dòng có giải mã CCCD | `b2_read_decrypt.sql` | 142.940 | 7.0 | chậm hơn 228 lần |
| B | Thêm 1 khách không CCCD | `b3_insert_plain.sql` | 0.500 | 1999.1 | mốc |
| B | Thêm 1 khách có mã hóa + blind index | `b4_insert_encrypt.sql` | 3.321 | 301.2 | chậm hơn 7 lần |
| C | Tra CCCD qua blind index | `c1_lookup_blind.sql` | 2.707 | 369.4 | mốc |
| C | Tra CCCD bằng cách giải mã cả chi nhánh | `c2_lookup_decrypt_scan.sql` | 2777.217 | 0.4 | chậm hơn 1026 lần |
| D | Workload backend — pgaudit tắt | `d_workload.sql` | 0.719 | 1390.2 | mốc |
| D | Workload backend — pgaudit bật (cấu hình thật) | `d_workload.sql` | 2.399 | 416.9 | chậm hơn 3 lần |

Số dẫn xuất:

- Mỗi lần giải mã một CCCD: **~1.42 ms** (= (B2 − B1) / 100).
- pgAudit (dòng D bật): sinh **21.9 MB** log cho 4169 giao dịch, tức
  khoảng **5498 byte/giao dịch** (ghi song song `.csv` và `.json`).

Phân tích và các đánh đổi: [`docs/performance.md`](performance.md).

## Đọc bảng này thế nào

- Mỗi nhóm có một dòng **mốc** (không có cơ chế) và dòng ngay dưới **có** cơ
  chế; cột cuối là chênh lệch latency giữa hai dòng.
- A, B, C chạy với `pgaudit.log = none` để cô lập đúng cơ chế đang đo. Chi phí
  pgAudit đo riêng ở D.
- Số tuyệt đối phụ thuộc máy; **tỉ lệ** giữa hai dòng trong cùng nhóm mới là
  thứ đem so sánh được.
