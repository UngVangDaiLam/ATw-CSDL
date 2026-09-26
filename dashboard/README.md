# dashboard/ — hiển thị cảnh báo lớp 3

React + Socket.IO, hiển thị bảng `audit.alerts` theo thời gian thực.

Phần database đã chuẩn bị sẵn — **không cần động vào `postgres/`**. File này
là mọi thứ cần biết để code giao diện.

## 1. Chuẩn bị (một lần)

```bash
# ở gốc repo, sau khi pull
# .env gốc phải có DASHBOARD_PASSWORD (xem .env.example), rồi dựng lại DB:
bash scripts/reset.sh --yes
bash scripts/verify.sh                 # mục "dashboard_user" phải DAT hết

cp dashboard/.env.example dashboard/.env
# điền DB_PASSWORD = giá trị DASHBOARD_PASSWORD trong .env gốc
```

Kiểm tra kết nối được:

```bash
psql "postgresql://dashboard_user@localhost:15432/secdb" -c "SELECT count(*) FROM audit.alerts;"
```

## 2. Có dữ liệu để hiển thị

```bash
cd analyzer && npm install && cp .env.example .env && cd ..   # một lần, điền ANALYZER_PASSWORD
bash scripts/gen-alerts.sh
```

Script diễn lại 5 hành vi xấu (giải mã hàng loạt, UNION SELECT, `OR 1=1`, dò
`information_schema`, đọc toàn bảng) rồi chạy analyzer → mỗi lần chạy thêm 7
cảnh báo mức cam/đỏ **thật** vào bảng (cộng vài cảnh báo `AFTER_HOURS` nếu chạy
ngoài giờ hành chính). Lần chạy đầu tiên ra nhiều hơn vì analyzer đọc cả log
cũ. Chạy nó trong lúc dashboard đang mở là thấy cảnh báo mới "nhảy" lên —
đúng cảnh cần demo.

## 3. Kết nối

| | |
|---|---|
| Host / cổng (từ máy host) | `localhost:15432` |
| Database | `secdb` |
| Role | `dashboard_user` |
| Được làm | `SELECT` trên `audit.alerts`. **Chỉ vậy.** |
| Không được | ghi/sửa/xóa `alerts`, đọc bất cứ gì trong schema `app` |
| Mặc định phiên | `search_path = audit`, read-only, `statement_timeout = 5s` |

Role chỉ đọc là **chủ đích**, đối xứng với `analyzer_user` chỉ ghi: không tiến
trình nào vừa đọc vừa ghi được cảnh báo. Nếu cần tính năng "đánh dấu đã xử
lý", đừng xin thêm quyền `UPDATE` — báo lại để tạo bảng riêng.

## 4. Cấu trúc `audit.alerts`

| Cột | Kiểu | Ý nghĩa |
|-----|------|---------|
| `id` | bigint | tăng dần — dùng làm con trỏ khi poll |
| `db_user` | text | **nhân viên thật** (`nv_hn01`, `nv_dn01`, `nv_hcm01`), không phải `app_user` |
| `rule_triggered` | text | mã rule, xem bảng dưới |
| `risk_score` | smallint | 0–100 |
| `detail` | jsonb | chi tiết, xem dưới |
| `created_at` | timestamptz | lúc analyzer ghi (≠ lúc hành vi xảy ra, xem `detail.thoi_diem`) |

Các rule và gợi ý màu:

| `rule_triggered` | Điểm | Nghĩa |
|------|------|------|
| `SQLI_UNION` | 90 | câu lệnh có `UNION ... SELECT` |
| `BULK_DECRYPT` | 70–95 | một câu lệnh giải mã hàng loạt CCCD |
| `SQLI_TAUTOLOGY` | 85 | `OR 1=1`, `OR 'a'='a'` |
| `STAFF_CREDENTIAL_READ` | 75 | nhân viên đọc bảng chứa `password_hash` |
| `SQLI_SCHEMA_PROBE` | 70 | dò `information_schema` / `pg_catalog` |
| `FULL_TABLE_READ` | 60 | đọc bảng nhạy cảm không có `WHERE` |
| `AFTER_HOURS` | 40 | truy cập ngoài 7h–19h hoặc cuối tuần |

Gợi ý phân mức: `>= 80` đỏ, `60–79` cam, `< 60` vàng.

Các khóa thường có trong `detail`:

| Khóa | Ví dụ |
|------|-------|
| `mo_ta` | `"Cau lenh chua UNION SELECT - dau hieu khai thac..."` — câu mô tả để hiển thị |
| `cau_lenh` | câu SQL **đã che** số CCCD/số thẻ (`<12_chu_so_da_che>`) |
| `thoi_diem` | thời điểm hành vi xảy ra, lấy từ log, giờ VN |
| `session_user` | luôn là `app_user` — hiển thị cạnh `db_user` để thấy giá trị của việc bám phiên |
| `client` | IP nguồn |
| `session_id`, `pid` | đối chiếu với log thô |
| `bang` | các bảng câu lệnh chạm tới, vd. `["app.customers"]` |
| `so_ban_ghi_giai_ma` | chỉ có ở `BULK_DECRYPT` — số bản ghi đã bị giải mã |
| `gio`, `thu_trong_tuan` | chỉ có ở `AFTER_HOURS` |

`detail` được analyzer ghi — **coi như dữ liệu không tin cậy** khi render: câu
SQL trong `cau_lenh` do kẻ tấn công viết ra. Hiển thị bằng text node của React
(`{alert.detail.cau_lenh}`), **không** dùng `dangerouslySetInnerHTML`. Nếu
không, payload kiểu `' UNION SELECT '<img src=x onerror=...>'` sẽ thành XSS
ngay trên màn hình của người giám sát.

## 5. Realtime: poll, KHÔNG dùng LISTEN/NOTIFY

Backend Node của dashboard nên hỏi định kỳ:

```sql
SELECT id, db_user, rule_triggered, risk_score, detail, created_at
FROM audit.alerts
WHERE id > $1            -- id lớn nhất đã gửi cho client
ORDER BY id
LIMIT 200;
```

rồi `io.emit('alerts', rows)` nếu có dòng mới. Lúc client mới kết nối thì gửi
50 dòng mới nhất (`ORDER BY id DESC LIMIT 50`).

**Vì sao không dùng trigger + `pg_notify`?** Trong PostgreSQL, `LISTEN` **không
cần quyền gì** — role nào cũng nghe được mọi kênh. Nếu có trigger bắn
`NOTIFY` mỗi khi có cảnh báo, kẻ chiếm được `app_user` chỉ cần `LISTEN` là
biết ngay mình vừa bị phát hiện — đúng thứ mà việc tách schema `audit` và
chặn `app_user` khỏi nó đang ngăn. Poll 2 giây/lần trên khóa chính là đủ nhanh
cho demo và không rò gì ra ngoài.

## 6. Đừng

- Đừng dùng `app_user` / `db_owner` / `postgres` để kết nối.
- Đừng thêm `GRANT` hay sửa file trong `postgres/` — cần gì thêm thì báo, để
  giữ `scripts/verify.sh` đạt hết.
- Đừng commit `dashboard/.env`.
