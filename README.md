# Mô hình bảo mật cơ sở dữ liệu nhiều lớp trên PostgreSQL

Môi trường lab chạy local bằng Docker Compose, minh họa 4 lớp bảo vệ dữ liệu:

| Lớp | Nội dung | Trạng thái |
|-----|----------|-----------|
| 1 | Host-based access control, Role/GRANT, Row-Level Security | **Xong cả ba** |
| 2 | Mã hóa cột dữ liệu nhạy cảm bằng `pgcrypto` | **Xong** |
| 3 | Giám sát truy cập bằng `pgAudit` + analyzer tự viết | **Xong cả hai** |
| 4 | Sao lưu WAL + `pg_dump` + PITR | **Xong** (base backup, dump, PITR có demo + thử khôi phục tự động) |

Stack: PostgreSQL 16 · Node.js + Express · Node.js (analyzer) · React + Socket.IO

---

## 1. Cấu trúc thư mục

```
.
├── docker-compose.yml
├── .env.example            # mẫu biến môi trường (copy thành .env)
├── .gitattributes          # ép LF cho .sh/.sql - bắt buộc khi làm trên Windows
├── postgres/
│   ├── Dockerfile          # postgres:16 + postgresql-16-pgaudit
│   ├── conf/
│   │   ├── postgresql.conf # pgaudit, logging, WAL archiving
│   │   └── pg_hba.conf     # lớp kiểm soát truy cập theo host
│   └── init/               # chạy 1 lần khi volume dữ liệu còn trống
│       ├── 01_extensions.sql
│       ├── 02_roles.sh
│       ├── 03_schema.sql
│       ├── 04_grants.sql
│       ├── 05_crypto.sql   # hàm mã hóa, khóa đọc từ Docker secret
│       ├── 06_rls.sql      # policy phân tách theo chi nhánh
│       └── 07_seed.sql
├── secrets/                # KHÔNG commit - sinh bằng scripts/init-secrets.sh
├── scripts/
│   ├── init-secrets.sh     # sinh khóa mã hóa + pepper
│   ├── verify.sh           # chạy toàn bộ 62 phép thử nghiệm thu
│   ├── gen-alerts.sh       # diễn lại hành vi xấu + chạy analyzer -> cảnh báo thật cho dashboard
│   ├── benchmark.sh        # đo chi phí từng lớp bảo mật -> docs/benchmark-results.md
│   ├── bench/              # kịch bản pgbench, mỗi cặp chỉ khác đúng một cơ chế
│   └── reset.sh            # dựng lại lab từ số 0 (dọn cả WAL archive)
├── backup/
│   ├── full/               # bản sao lưu đầy đủ (pg_basebackup / pg_dump)
│   ├── wal_archive/        # đích của archive_command
│   └── scripts/            # full_backup.sh, pitr_restore.sh, demo_pitr.sh - xem mục 7c
├── logs/                   # log csv + json của PostgreSQL, nguồn cho analyzer
├── docs/
│   ├── threat-model.md     # STRIDE cho app/, ranh giới tin cậy app <-> DB
│   ├── performance.md      # phân tích chi phí hiệu năng từng lớp (viết tay)
│   └── benchmark-results.md # số đo thô, sinh bởi scripts/benchmark.sh
├── app/                    # backend Express - xem app/README.md
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── db.js  app.js  server.js
│       ├── middleware/     # requireAuth.js, setRole.js (SET LOCAL ROLE nv_xxx)
│       └── routes/         # auth.js, customers.js, orders.js
├── analyzer/               # lớp 3: đọc log pgAudit -> audit.alerts
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js        # CLI, chạy một lần rồi thoát
│       ├── auditLine.js    # tách trường CSV bên trong `message` của pgAudit
│       ├── sessions.js     # gom dòng -> câu lệnh, bám session_id để quy trách nhiệm
│       ├── redact.js       # che CCCD/số thẻ trước khi ghi cảnh báo
│       ├── alerts.js       # INSERT bằng analyzer_user
│       └── rules/          # 6 rule phát hiện
└── dashboard/              # chưa có code; phía DB đã sẵn - xem dashboard/README.md
```

## 2. Chạy

```bash
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
# đổi toàn bộ mật khẩu trong .env

bash scripts/init-secrets.sh   # sinh khóa mã hóa - BẮT BUỘC trước lần chạy đầu
docker compose up -d --build
docker compose ps
```

Thiếu bước `init-secrets.sh` thì container khởi động được nhưng script seed sẽ
báo lỗi rõ ràng (`Khong doc duoc /run/secrets/pgcrypto_key`) — cố ý fail to
chứ không im lặng dùng khóa mặc định.

Kiểm tra mọi thứ chạy đúng:

```bash
bash scripts/verify.sh
```

Các script trong `postgres/init/` **chỉ chạy khi volume `pgdata` còn trống**.
Sửa file init rồi muốn áp dụng lại thì dựng lại từ số 0:

```bash
bash scripts/reset.sh
```

> **Đừng gõ `docker compose down -v` trần.** Xem mục 6 — nó làm hỏng WAL
> archiving một cách âm thầm.

## 3. Kết nối theo từng role

### Superuser — chỉ qua socket bên trong container

`pg_hba.conf` có dòng `host all postgres all reject`, nên `postgres` **không**
đăng nhập được qua cổng 5432. Đây là chủ đích: kẻ tấn công chỉ chạm được tới
cổng mạng sẽ không có đường nào tới superuser.

```bash
docker compose exec postgres psql -U postgres -d secdb
```

### Các role nghiệp vụ — từ máy host

> **Cổng là `15432`, không phải `5432`.** Xem mục 6 để biết lý do.

```bash
# app_user: SELECT/INSERT/UPDATE trên customers, orders, payments
psql "postgresql://app_user@localhost:15432/secdb"

# readonly_user: chỉ SELECT customers, orders
psql "postgresql://readonly_user@localhost:15432/secdb"

# admin_user: quản trị, phải SET ROLE db_owner để làm DDL
psql "postgresql://admin_user@localhost:15432/secdb"

# db_owner: chủ sở hữu schema app/audit
psql "postgresql://db_owner@localhost:15432/secdb"
```

Kiểm tra mình đang nói chuyện với đúng server:

```sql
SELECT current_setting('server_version'), inet_server_addr();
-- phải ra 16.x và 172.28.0.10
```

Không có `psql` trên Windows thì dùng client trong container. Phải trỏ tới
**`172.28.0.10`** (IP của chính container trong `dbnet`), không dùng
`127.0.0.1`: loopback bên trong container không thuộc `172.28.0.0/16` nên rơi
vào luật `reject` cuối cùng của `pg_hba.conf`.

```bash
docker compose exec postgres psql "postgresql://app_user:<mat_khau>@172.28.0.10:5432/secdb"
```

### pgAdmin

<http://localhost:8081> — đăng nhập bằng `PGADMIN_EMAIL` / `PGADMIN_PASSWORD`.

Khi thêm server, dùng:

| Trường | Giá trị |
|--------|---------|
| Host | `postgres` |
| Port | `5432` |
| Database | `secdb` |
| Username | `admin_user` (**không phải** `postgres`) |

pgAdmin nằm trong subnet `172.28.0.0/16` nên được `pg_hba.conf` cho phép, nhưng
chỉ với các role nghiệp vụ.

## 4. Mô hình phân quyền

| Role | Đăng nhập | Quyền |
|------|-----------|-------|
| `postgres` | chỉ socket nội bộ | superuser; bỏ qua RLS |
| `db_owner` | có | sở hữu schema `app`, `audit` và toàn bộ bảng. Bị `FORCE RLS` chặn nên **đọc ra 0 dòng** dữ liệu |
| `app_user` | có | `SELECT, INSERT, UPDATE` trên `customers`, `orders`, `payments`. **Không** DELETE, **không** DDL, **không** chạm `audit`. Chưa `SET ROLE` thì **đọc ra 0 dòng** |
| `staff_role` | không | role nhóm, giữ quyền trên bảng cho nhân viên |
| `nv_hn01` `nv_dn01` `nv_hcm01` | **không** (`NOLOGIN`) | nhân viên từng chi nhánh. Chỉ vào được bằng `SET ROLE` từ `app_user` |
| `readonly_user` | có | `SELECT` trên `customers`, `orders` của chi nhánh mình. Bị ép `default_transaction_read_only = on` |
| `admin_user` | có | không có quyền trực tiếp trên bảng; `SET ROLE db_owner` để làm DDL |
| `analyzer_user` | có | **chỉ `INSERT` trên `audit.alerts`** — không đọc, không sửa, không xóa; không chạm được schema `app` |
| `dashboard_user` | có | **chỉ `SELECT` trên `audit.alerts`** — không ghi (không chèn được cảnh báo giả); không chạm được schema `app`. Phiên mặc định read-only |

Ba cơ chế xếp chồng khiến `app_user` không thể DROP bảng:

1. `app_user` không sở hữu object nào — owner mới có toàn quyền bất chấp GRANT.
2. `REVOKE CREATE ON SCHEMA public FROM PUBLIC` — không tạo được object mới.
3. `NOINHERIT` — có được GRANT role khác thì cũng phải `SET ROLE` tường minh.

Schema `audit` (chứa bảng `alerts`) không cấp cho `app_user` một quyền nào. Nếu
`app_user` bị chiếm, kẻ tấn công vẫn không đọc được mình đã bị phát hiện, cũng
không xóa được bằng chứng.

### Row-Level Security — phân tách theo chi nhánh

Ba cơ chế trên lọc theo **bảng**. RLS lọc theo **dòng**: nhân viên chỉ thấy dữ
liệu chi nhánh mình. Đã bật `FORCE ROW LEVEL SECURITY` trên `customers`,
`orders`, `payments`.

Ứng dụng kết nối bằng `app_user` (một connection pool duy nhất) rồi đổi vai cho
từng request:

```sql
BEGIN;
SET LOCAL ROLE nv_hn01;     -- SET LOCAL: tự hết hiệu lực khi COMMIT
SELECT * FROM app.customers;
COMMIT;
```

Dùng `SET LOCAL ROLE` trong transaction chứ không phải `SET ROLE` trần: với
connection pool, quên `RESET ROLE` là request sau mượn lại connection đó sẽ
chạy dưới danh tính người trước.

Thử trực tiếp:

```bash
psql "postgresql://app_user@localhost:15432/secdb"
```
```sql
SELECT count(*) FROM app.customers;               -- 0  (chưa SET ROLE)
SET ROLE nv_hn01;  SELECT count(*) FROM app.customers;   -- 2  (chi nhánh Hà Nội)
SET ROLE nv_dn01;  SELECT count(*) FROM app.customers;   -- 2  (chi nhánh Đà Nẵng)
SET ROLE nv_hn01;  INSERT INTO app.customers(branch_id, full_name) VALUES (2, 'X');
-- ERROR: new row violates row-level security policy for table "customers"
```

Ba điểm dễ hiểu sai, đều là chủ đích chứ không phải lỗi:

- **`app_user` chưa `SET ROLE` đọc ra 0 dòng.** Nó không có dòng nào trong
  `app.staff` nên không thuộc chi nhánh nào. Chiếm được mật khẩu `app_user` vẫn
  chưa lấy được dữ liệu — còn phải `SET ROLE`, mà thao tác đó bị pgAudit ghi lại.
- **`db_owner` cũng đọc ra 0 dòng.** Mặc định chủ sở hữu bảng bỏ qua mọi policy;
  `FORCE` bắt nó phải tuân theo, và nó không có policy nào. Tức người quản trị
  CSDL không đọc được dữ liệu khách hàng. Cần thao tác ở mức quản trị thì dùng
  superuser qua socket.
- **`UPDATE` trúng dòng của chi nhánh khác không báo lỗi**, chỉ trả `UPDATE 0`.
  Dòng đó vô hình chứ không phải bị từ chối.

## 4b. Lớp 2 — Mã hóa cột

`customers.cccd` và `payments.card_token` là `BYTEA` chứa ciphertext của
`pgp_sym_encrypt` (AES-256, không nén). Khóa nằm trong Docker secret, mount vào
container database ở `/run/secrets/`.

### Khóa không bao giờ rời khỏi server

Cách làm thường gặp là để ứng dụng đọc khóa rồi truyền vào mỗi truy vấn. Ở đây
làm ngược lại: database tự đọc khóa qua `ext.master_key()`, ứng dụng chỉ gọi ba
hàm bọc sẵn và **không bao giờ thấy khóa**.

| Hàm | Dùng để |
|---|---|
| `app.encrypt_text(text) → bytea` | mã hóa khi ghi |
| `app.decrypt_text(bytea) → text` | giải mã khi đọc |
| `app.blind_index(text) → bytea` | sinh giá trị tra cứu |

```sql
-- Thêm khách hàng
INSERT INTO app.customers (branch_id, full_name, cccd, cccd_hash)
VALUES ($1, $2, app.encrypt_text($3), app.blind_index($3));

-- Tra cứu theo CCCD
SELECT id, full_name FROM app.customers WHERE cccd_hash = app.blind_index($1);

-- Hiện CCCD
SELECT app.decrypt_text(cccd) FROM app.customers WHERE id = $1;
```

Ba lý do khóa không đi qua ứng dụng: nó sẽ đi qua dây mạng trong từng truy vấn;
nó nằm trong bộ nhớ tiến trình ứng dụng — nơi dễ bị tấn công hơn database; và
nếu ai đó bật `pgaudit.log_parameter` thì khóa vào thẳng file log. Biến thể
`SET LOCAL app.enc_key = ...` còn tệ hơn ở repo này, vì `pgaudit.log` đã bật
class `misc_set` nên **câu `SET` đó sẽ được ghi vào log nguyên văn**.

### Blind index — vì sao bắt buộc phải có

`pgp_sym_encrypt` **không tất định**: mã hóa cùng một số CCCD hai lần ra hai
ciphertext khác nhau. Nên không thể `WHERE cccd = ...`, không thể đánh index,
không thể ràng buộc `UNIQUE`. Cột `cccd_hash` lưu `HMAC-SHA256(cccd, pepper)` —
tất định nên tra cứu và chống trùng được, nhưng không đảo ngược ra số gốc.

Dùng HMAC chứ không phải `sha256()` thuần: CCCD chỉ có 12 chữ số (~10¹² khả
năng), một GPU dò cạn bảng băm thuần rất nhanh. Pepper bí mật nằm ở Docker
secret, **không nằm trong database**, nên người lấy được bản dump vẫn bế tắc.

Hạn chế đã biết: blind index làm lộ quan hệ bằng nhau (hai dòng cùng CCCD ra
cùng hash). Với CCCD thì chấp nhận được vì nó vốn là định danh duy nhất, nhưng
đừng áp cách này lên trường ít giá trị khác nhau (giới tính, tỉnh thành) — khi
đó hash gần như tương đương plaintext.

### Ai chạm được vào cái gì

- `nv_hn01` / `nv_dn01` / `nv_hcm01` — giải mã được, **nhưng chỉ trên các dòng
  RLS cho phép thấy**. Hai lớp xếp chồng.
- `app_user` — có `EXECUTE` trên ba hàm, nhưng chưa `SET ROLE` thì RLS không
  cho thấy dòng nào để mà giải mã.
- `readonly_user` — **không đọc được cả cột `cccd`**. Đây là phân quyền ở mức
  cột, nằm trước cả mã hóa. Hệ quả: `SELECT *` bị từ chối, phải liệt kê cột.
- Không role nghiệp vụ nào có `USAGE` trên schema `ext`, nên **không ai gọi
  trực tiếp được `pgp_sym_decrypt()`** dù có đoán ra khóa. Mọi thao tác đi qua
  hàm có tên rõ ràng → xuất hiện trong log pgAudit → lớp 3 phát hiện được hành
  vi giải mã hàng loạt.

### Xoay khóa

Chưa triển khai. `pgp_sym_encrypt` gắn chặt với khóa đang dùng, nên
`scripts/init-secrets.sh --force` sẽ làm **toàn bộ dữ liệu cũ không giải mã
được nữa**. Đổi khóa thật phải đi kèm mã hóa lại toàn bộ dữ liệu trong một
transaction, và cần thêm cột `key_version` để hỗ trợ giai đoạn hai khóa.

## 5. Nghiệm thu

```bash
bash scripts/verify.sh
```

Chạy 62 phép thử trên cả 4 lớp: `pg_hba` chặn superuser qua TCP, `app_user` bị
từ chối DELETE/DROP/TRUNCATE/CREATE và schema `audit`, `readonly_user` không
đọc được `payments`, RLS phân tách đúng chi nhánh theo cả chiều đọc lẫn chiều
ghi, `FORCE RLS` chặn cả `db_owner`, mã hóa/giải mã/blind index hoạt động đúng,
role nghiệp vụ không chạm được khóa, `readonly_user` không đọc được cột `cccd`,
**`pg_dump` không chứa CCCD hay số thẻ ở dạng rõ**, khóa không rò vào log,
pgAudit ghi được câu lệnh và cả `SET ROLE`, `analyzer_user` ghi được cảnh báo
nhưng không đọc/sửa/xóa được, `dashboard_user` đọc được cảnh báo nhưng không
ghi được kể cả khi tự mở transaction READ WRITE, dữ liệu đủ khối lượng đề bài yêu cầu và trải đều
ba chi nhánh, segment WAL vừa đóng được archive ra `backup/wal_archive/`,
replication qua TCP bị `pg_hba` từ chối, bản `pg_dump` đọc được, và **một lần
PITR thật trong container sandbox** dừng đúng tại thời điểm chỉ định (không
đụng tới database đang chạy).

Kết quả mong đợi: `DAT: 62    TRUOT: 0`.

## 6. Ghi chú vận hành

**Log.** `logging_collector = on` nên `docker compose logs postgres` gần như
trống sau khi server khởi động xong — log thật nằm ở `./logs/`. Hai định dạng
được ghi song song: `.csv` (đúng yêu cầu đề bài) và `.json` (analyzer bước 3
dùng, vì câu SQL trong CSV có thể chứa dấu phẩy, dấu nháy và cả ký tự xuống
dòng ngay trong trường `message`).

**Múi giờ.** `log_timezone = 'Asia/Ho_Chi_Minh'`. Để mặc định UTC thì rule
"truy cập ngoài giờ hành chính" ở bước 3 sẽ lệch 7 tiếng.

**Cổng host là 15432.** Nếu máy đã cài PostgreSQL native (trên Windows là
service `postgresql-x64-NN` nghe `0.0.0.0:5432`) thì cổng 5432 đã bị chiếm.
Éo le là Docker **vẫn bind thành công và không báo lỗi gì**, nhưng kết nối tới
`localhost:5432` lại rơi vào instance native. Vì cả hai đều là PostgreSQL và
đều trả lời bình thường, triệu chứng nhìn rất giống lỗi cấu hình của lab:
"sai mật khẩu app_user", "không có bảng app.customers", "pg_hba không có tác
dụng"... Đổi cổng host tránh hẳn lớp nhầm lẫn này.

Cổng mới phải **dưới 49152**: từ 49152 trở lên là dải cổng động của Windows,
Hyper-V/WinNAT giữ chỗ ngẫu nhiên từng khối trong dải đó sau mỗi lần khởi động
và Docker sẽ báo `bind: An attempt was made to access a socket in a way
forbidden by its access permissions` (cổng cũ 55432 đã gặp lỗi này). Xem các
khối đang bị giữ: `netsh interface ipv4 show excludedportrange protocol=tcp`.

Kiểm tra PostgreSQL native bằng PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 5432 -State Listen
Get-Service postgresql*
```

**Subnet cố định.** `docker-compose.yml` ghim `172.28.0.0/16`. Nếu để Docker tự
cấp phát, dải mạng đổi sau mỗi lần recreate và các luật trong `pg_hba.conf` sẽ
không còn khớp. Kết nối từ máy host qua cổng publish đi vào container bằng IP
gateway `172.28.0.1`, vẫn nằm trong subnet này nên được chấp nhận.

**`archive_timeout = 60s`.** Ép đóng WAL segment mỗi phút kể cả khi DB nhàn
rỗi. Không có tham số này, lượng WAL ít sẽ nằm mãi trong segment đang mở và
PITR chỉ khôi phục được tới lần archive gần nhất. Lưu ý nó chỉ kích hoạt khi
*có* WAL được ghi — DB nhàn rỗi thật thì không sinh file rác.

**`down -v` làm hỏng WAL archiving.** Đây là cái bẫy nặng nhất của lab. `down -v`
xóa volume `pgdata` nên cluster mới đánh số WAL lại từ
`000000010000000000000001`, nhưng `./backup/wal_archive` nằm trên host nên vẫn
còn nguyên file cùng tên của cluster cũ. `archive_command` có `test ! -f ...`
thấy file đã tồn tại, trả về 1, và **archiving chết hẳn** — kẹt ở segment đầu
tiên, `failed_count` tăng không ngừng, trong khi server vẫn chạy bình thường
nên không có dấu hiệu nào. Luôn dùng `bash scripts/reset.sh`, nó dọn cả
`wal_archive`.

Đừng gỡ `test ! -f` cho tiện: nó chính là cái chặn ghi đè WAL. Gỡ đi thì archive
trộn WAL của hai cluster khác nhau và mọi lần PITR sau đó cho ra dữ liệu rác —
hỏng âm thầm, nguy hiểm hơn nhiều.

**Log luôn ghi `user=app_user`, không bao giờ ghi `nv_xxx`.** Đó là *session
user* (role đã xác thực); `SET ROLE` không đổi được nó. Vì vậy `pgaudit.log`
phải có class `misc_set` để `SET ROLE` xuất hiện trong log, và analyzer ở lớp 3
sẽ bám theo `pid` của phiên để quy trách nhiệm: gặp
`AUDIT: ...,MISC,SET,,,SET ROLE nv_dn01;` thì mọi câu lệnh sau đó trong cùng
`pid` thuộc về `nv_dn01`.

**CRLF.** Repo phát triển trên Windows, chạy trong container Linux. `.sh` bị
checkout với CRLF sẽ khiến bash báo `\r: command not found` và init thất bại.
Đã chặn hai lớp: `.gitattributes` (`eol=lf`) và `sed -i 's/\r$//'` trong
`Dockerfile`.

**Khóa mã hóa.** Không nằm trong `.env`, không nằm trong database, không nằm
trong code. Bước 2 sẽ nạp qua Docker secret. Lý do: khóa để cùng chỗ với dữ
liệu đã mã hóa thì việc mã hóa mất ý nghĩa — ai lấy được dump là có luôn khóa.
`.env` cũng bị nạp thành biến môi trường của container nên `docker inspect`
đọc được, trong khi Docker secret nằm ở tmpfs với quyền hạn chế.

## 7. `app/` — backend Express

Đã có: đăng nhập bằng `app.staff.username`/`password_hash` (bcrypt), `SET
LOCAL ROLE nv_xxx` cho từng request theo mô hình ở mục 4, CRUD tối thiểu cho
`customers`/`orders`, giải mã `cccd` qua `app.decrypt_text()`. Kèm 2 lỗ hổng
**cố ý** (SQL Injection ở `/customers/search`, IDOR ở `/orders/:id`) để đo
thực nghiệm luận điểm defense-in-depth — chi tiết và cách khai thác ở
[`app/README.md`](app/README.md), threat model STRIDE ở
[`docs/threat-model.md`](docs/threat-model.md).

```bash
cd app && npm install && cp .env.example .env && npm run dev
```

## 7b. `analyzer/` — lớp 3

Đọc `logs/*.json`, bám `session_id` để quy trách nhiệm cho đúng nhân viên theo
`SET ROLE`, áp 6 rule phát hiện, ghi cảnh báo vào `audit.alerts` bằng
`analyzer_user` (chỉ `INSERT`).

```bash
cd analyzer && npm install && cp .env.example .env
node src/index.js --dry-run --all    # xem thử, không ghi database
node src/index.js                    # đọc phần log mới, ghi cảnh báo
```

Điểm cốt lõi: cột `user` trong log **luôn** là `app_user`, nên nhìn log thô thì
không quy được trách nhiệm cho ai. Analyzer bám theo từng phiên để biết câu lệnh
nào thuộc về `nv_hn01`, câu nào thuộc `nv_dn01`. Cách làm, bộ rule và **các giới
hạn đã biết** (không đo được số dòng trả về, không bắt được IDOR) nằm ở
[`analyzer/README.md`](analyzer/README.md).

## 7c. `backup/scripts/` — lớp 4

```bash
bash backup/scripts/full_backup.sh                                # base backup + pg_dump
bash backup/scripts/pitr_restore.sh "2026-09-26 14:30:00+07"      # khôi phục DB đang chạy về thời điểm đó
bash backup/scripts/demo_pitr.sh                                  # kịch bản demo, dừng chờ Enter từng bước
```

| File | Việc |
|------|------|
| `full_backup.sh` | Tạo `backup/full/<YYYYMMDD_HHMMSS>/`: `base.tar.gz` + `pg_wal.tar.gz` + `backup_manifest` (pg_basebackup, bản vật lý — điểm xuất phát của PITR), `secdb.dump` (pg_dump -Fc, bản logic), `backup_info` (thời điểm hoàn tất). |
| `pitr_restore.sh` | Đẩy WAL còn lại ra archive → dừng postgres → cất data hiện tại vào `backup/full/pre_pitr_*.tar.gz` → giải nén base backup mới nhất hoàn tất *trước* thời điểm đích → `pg_verifybackup` → replay WAL tới `recovery_target_time` → promote sang timeline mới → dọn cấu hình recovery. |
| `demo_pitr.sh` | Ghi mốc T → `app_user` thử `DELETE` (lớp 1 chặn) → superuser xóa nhầm toàn bộ `orders`/`payments` → PITR về T → so khớp số dòng và tổng tiền. |
| `_restore_inner.sh` | Phần chạy **bên trong** container (`pitr-restore` hoặc `pitr-sandbox` trong `docker-compose.yml`, profile `tools`). Không gọi trực tiếp. |
| `lib.sh` | Hàm dùng chung: chọn base backup, flush WAL, đọc timeline. |

Những điều cần biết:

- **Chỉ quay về được thời điểm SAU lần `full_backup.sh` gần nhất có trước nó.**
  Chưa có base backup thì không có PITR, dù WAL archive đầy đủ.
- **PITR quay lui cả cluster**, kể cả `audit.alerts`. Log pgAudit ở `./logs/`
  thì còn nguyên vì nằm ngoài database.
- Sau mỗi lần khôi phục, cluster sang **timeline mới** (`00000002...`). WAL của
  timeline cũ vẫn nằm trong archive và không bị ghi đè vì khác tên, nên chọn
  nhầm thời điểm thì vẫn khôi phục lại được về sau sự cố.
- `verify.sh` thử khôi phục thật trong container **`pitr-sandbox`** (volume
  riêng, archive gắn read-only, `archive_mode=off`, dừng ở `pause` chứ không
  promote) nên không ảnh hưởng database đang chạy và không sinh timeline ma
  trong kho WAL.
- Backup chạy bằng superuser qua socket (`local replication postgres trust` ở
  `pg_hba.conf`). Qua TCP không có dòng `replication` nào nên mọi role đều bị
  từ chối. Role backup riêng qua TCP cần `REPLICATION` + `BYPASSRLS` (vì
  `FORCE RLS` chặn `pg_dump`), tức là quyền đọc toàn bộ dữ liệu — không hẹp
  hơn superuser-qua-socket là bao, nên lab không tạo.

## 7d. Hiệu năng

```bash
bash scripts/benchmark.sh     # ~2-3 phút, ghi docs/benchmark-results.md
```

Đo từng cặp có/không cơ chế bằng `pgbench`. Kết quả chính (phân tích đầy đủ ở
[`docs/performance.md`](docs/performance.md)):

| Cơ chế | Chi phí |
|---|---|
| RLS | ~0,1 ms/câu lệnh (+12–31%), không tăng theo số dòng |
| Giải mã CCCD | ~1,4 ms **mỗi bản ghi** — chỉ giải mã dòng đang hiển thị |
| Blind index so với giải mã để tìm | 2,7 ms so với 2 777 ms (×1 000) |
| pgAudit | ×3 latency, ~5,5 KB log mỗi giao dịch |

Chính việc đo đã tìm ra một lỗi hiệu năng trong policy RLS (hàm bị gọi lại cho
từng dòng, chậm ×12) mà không phép thử chức năng nào bắt được — xem mục 1 của
`docs/performance.md`.

## 8. Bước tiếp theo

- **`dashboard/`** — React + Socket.IO hiển thị `audit.alerts` realtime.
