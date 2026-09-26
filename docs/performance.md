# Chi phí hiệu năng của các lớp bảo mật

Số liệu thô mới nhất: [`benchmark-results.md`](benchmark-results.md) (sinh bởi
`bash scripts/benchmark.sh`). File này là phần **phân tích**, viết tay, dùng số
của lượt đo ngày 2026-09-26 (PostgreSQL 16.15 trong Docker Desktop/Windows,
8 CPU, 6005 khách / 10004 đơn, 1 client, 10 giây mỗi kịch bản).

> Số tuyệt đối dao động ±30% giữa các lượt đo trên cùng máy. Chỉ so **tỉ lệ
> trong cùng một lượt**, không so số tuyệt đối giữa hai lượt khác nhau.

## Tóm tắt

| Lớp | Cơ chế | Chi phí đo được | Đánh giá |
|---|---|---|---|
| 1 | Row-Level Security | +12% (quét theo chi nhánh), +31% (tra 1 dòng) — tức **~0,1 ms/câu lệnh** | Rẻ. Cố định mỗi câu lệnh, không tăng theo số dòng (sau tối ưu ở mục 1) |
| 2 | Giải mã `pgcrypto` | **~1,4 ms mỗi bản ghi** giải mã | Đắt, tăng tuyến tính theo số dòng. Chỉ giải mã khi thật sự hiển thị |
| 2 | Mã hóa khi ghi (+ blind index) | 0,5 → 3,3 ms mỗi INSERT (×7) | Chấp nhận được — ghi khách hàng mới không phải thao tác tần suất cao |
| 2 | Blind index so với giải mã để tìm | 2,7 ms so với **2 777 ms** (×1 000) | Blind index là **bắt buộc**, không phải tối ưu |
| 3 | pgAudit | ×3 latency, **~5,5 KB log/giao dịch** | Chi phí lớn nhất ở tầng I/O log, cần kế hoạch lưu trữ |

## 1. RLS — phát hiện và sửa một lỗi hiệu năng

Lượt đo đầu tiên cho kết quả lạ: đọc 100 dòng cột thường **mất 7,9 ms**, trong
khi đếm cả 2002 dòng của chi nhánh chỉ mất 0,9 ms. `EXPLAIN ANALYZE`:

```
Limit (actual time=0.070..6.900 rows=100)
  ->  Index Scan using customers_pkey on customers
        Filter: (branch_id = app.current_branch_id())     <- chạy lại cho TỪNG dòng
        Rows Removed by Filter: 199
```

Policy ban đầu là `USING (branch_id = app.current_branch_id())`. Khi planner
dùng được index trên `branch_id` (truy vấn đếm), điều kiện thành `Index Cond`
và hàm chạy một lần. Nhưng với `ORDER BY id LIMIT 100`, planner quét theo khóa
chính rồi **lọc**, và hàm bị gọi lại cho mỗi dòng đi qua — 299 lần, mỗi lần là
một truy vấn vào `app.staff` qua hàm `SECURITY DEFINER` không inline được.

Sửa trong `postgres/init/06_rls.sql`: bọc hàm trong subquery.

```sql
USING (branch_id = (SELECT app.current_branch_id()))
```

Planner biến nó thành `InitPlan` — tính **đúng một lần mỗi câu lệnh**. Ngữ nghĩa
bảo mật không đổi (`current_user` cố định trong một câu lệnh), `verify.sh` vẫn
đạt toàn bộ phép thử RLS.

| | Trước | Sau |
|---|---:|---:|
| Đọc 100 dòng (`b1_read_plain.sql`) | 7,94 ms | **0,63 ms** (×12,6 nhanh hơn) |
| Log pgAudit mỗi giao dịch (`d_workload.sql`) | 9 803 byte | **5 498 byte** (−44%) |
| Chậm đi khi bật pgAudit | ×5,2 | **×3,3** |

Lỗi này không làm sai kết quả nên không phép thử chức năng nào bắt được — chỉ
đo đạc mới lộ ra. Nó còn kéo theo lớp 3: mỗi lần gọi hàm thừa sinh thêm một
dòng log pgAudit.

## 2. Mã hóa — tiền nằm ở đâu

Tách chi phí giải mã 100 bản ghi (đo riêng lẻ bằng `\timing` trong psql, chỉ
để thấy **tỉ lệ** giữa hai thành phần):

| Thành phần | Thời gian / 100 dòng |
|---|---:|
| `pgp_sym_decrypt` với khóa có sẵn (AES-256 + dẫn xuất khóa S2K) | ~74 ms |
| `ext.master_key()` — đọc khóa từ `/run/secrets/pgcrypto_key` | ~214 ms |

Phần lớn chi phí là **đọc lại file khóa cho mỗi bản ghi**. Trên Docker Desktop
cho Windows, file secret được chia sẻ từ ổ đĩa host nên mỗi lần đọc chậm; trên
Linux thật, Docker secret nằm trên tmpfs (RAM) và rẻ hơn nhiều.

Đây là **đánh đổi có chủ đích, không tối ưu**: cách duy nhất để tránh đọc lại
là giữ khóa trong phiên (`SET app.key = ...`), nhưng câu `SET` bị pgAudit ghi
vào log (class `misc_set`) và `current_setting('app.key')` thì role gọi đọc
được — tức là phá vỡ đúng lớp 2. Khóa chỉ sống trong phạm vi một lời gọi hàm.

Hệ quả cho cách viết ứng dụng:

- Chỉ giải mã cột được **hiển thị**, và chỉ trên trang dữ liệu đang xem
  (`LIMIT`/phân trang). 20 dòng ≈ 30 ms là ổn; 2 000 dòng ≈ 3 giây thì không.
- Không bao giờ đặt `decrypt_text()` trong `WHERE` — xem mục 3.
- Chi phí cao cũng có mặt tốt: rút dữ liệu hàng loạt bị **chậm lại** đáng kể
  (giải mã cả 6 000 CCCD mất ~9 giây), và rule `BULK_DECRYPT` của analyzer có
  thời gian để bắt.

## 3. Blind index — không có thì không tra cứu được

`pgp_sym_encrypt` không tất định (cùng CCCD mã hóa hai lần ra hai ciphertext
khác nhau), nên không thể `WHERE cccd = encrypt(...)`. Không có blind index thì
tìm một CCCD phải giải mã toàn bộ chi nhánh rồi so sánh:

| | Latency |
|---|---:|
| `WHERE cccd_hash = app.blind_index('...')` | 2,7 ms |
| `WHERE app.decrypt_text(cccd) = '...'` | 2 777 ms |

Chênh **~1 000 lần**, và tăng tuyến tính theo số khách hàng. Blind index là
điều kiện để hệ thống dùng được, không phải một tối ưu tùy chọn. 2,7 ms của
blind index phần lớn cũng là đọc file pepper — cùng lý do như mục 2.

## 4. pgAudit — chi phí nằm ở I/O log

Cùng một workload backend (`SET LOCAL ROLE` + đọc 1 khách + đọc đơn hàng của
khách đó), bật pgAudit làm latency tăng **×3,3** và sinh **~5,5 KB log mỗi giao
dịch**. Một giao dịch sinh 7 dòng AUDIT:

```
MISC,SET   SET LOCAL ROLE nv_hn01
READ       app.customers                 <- câu lệnh của client
READ       SELECT app.branch_of(...)     <- lồng: policy RLS
READ       app.staff                     <- lồng: bên trong branch_of
READ       app.orders                    <- câu lệnh của client
READ       SELECT app.branch_of(...)
READ       app.staff
```

— rồi nhân đôi vì ghi song song `.csv` (đề bài yêu cầu) và `.json` (analyzer
đọc). Ước lượng dung lượng: ở 100 giao dịch/giây liên tục là ~2 GB log mỗi
giờ.

Các cách giảm và cái giá phải trả:

| Cách | Giá |
|---|---|
| Bỏ `csvlog`, chỉ giữ `jsonlog` | Giảm ~một nửa, nhưng trái yêu cầu đề bài |
| `pgaudit.log_statement_once = on` | Dòng sau không lặp lại câu lệnh; analyzer phải ghép ngữ cảnh — dễ sai |
| Bỏ class `read` | Mất khả năng phát hiện đọc trộm dữ liệu — vô nghĩa với mục tiêu của lớp 3 |
| Xoay vòng + nén + đẩy log sang máy khác | Không giảm chi phí ghi, nhưng giải quyết chuyện dung lượng — **cách nên dùng** |

Lab giữ nguyên cấu hình: mục tiêu là quan sát được đầy đủ, và chi phí đã được
đo, không phải ước đoán.

## Chạy lại

```bash
bash scripts/benchmark.sh                  # 10 giây mỗi kịch bản, ~2-3 phút
BENCH_SECONDS=30 bash scripts/benchmark.sh # ổn định hơn
```

Benchmark chạy bằng superuser qua socket, nên analyzer bỏ qua (không sinh cảnh
báo rác), và chỉ đọc hoặc `ROLLBACK` (không để lại dữ liệu). Các kịch bản nằm ở
`scripts/bench/*.sql` — mỗi cặp chỉ khác nhau đúng ở cơ chế đang đo.
