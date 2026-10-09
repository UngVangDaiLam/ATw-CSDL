# Mô hình bảo mật cơ sở dữ liệu nhiều lớp trên PostgreSQL

Môi trường lab chạy local bằng Docker Compose, minh họa 4 lớp bảo vệ dữ liệu:

| Lớp | Nội dung | Trạng thái |
|-----|----------|-----------|
| 1 | Host-based access control, TLS 1.3 bắt buộc, Role/GRANT, Row-Level Security | **Xong** |
| 2 | Mã hóa cột dữ liệu nhạy cảm bằng `pgcrypto` | **Xong** |
| 3 | Giám sát truy cập bằng `pgAudit` + analyzer tự viết | **Xong cả hai** |
| 4 | Sao lưu WAL + `pg_dump` + PITR, mã hóa toàn bộ kho sao lưu | **Xong** (base backup, dump, PITR có demo + thử khôi phục tự động) |

Stack: PostgreSQL 16 · Node.js + Express · Node.js (analyzer) · React + Socket.IO

Chạy thử: `bash scripts/quickstart.sh` (hoặc bấm đúp `quickstart.bat`) — một lệnh
dựng lab và chạy 145 phép thử nghiệm thu. Chi tiết ở mục 2.

---

## Điểm mới

Từng cơ chế riêng lẻ (RLS, `pgcrypto`, `pgAudit`, PITR, TLS) đều là kỹ thuật
có sẵn. Cái lab làm khác là **ghép chúng sao cho lớp này báo động cho lớp
kia**, và chứng minh mỗi khẳng định bằng một lệnh chạy ra kết quả.

| # | Chỗ hở của cách làm thông thường | Lab xử lý thế nào | Xem bằng chứng ở đâu |
|---|----------------------------------|-------------------|----------------------|
| 1 | Ứng dụng dùng **một tài khoản CSDL chung**. Lộ mật khẩu tài khoản đó là lộ dữ liệu của mọi chi nhánh, và CSDL không biết nhân viên nào đang thao tác | Mỗi request mang vai riêng của nhân viên (`SET LOCAL ROLE nv_xxx`), và vai đó **chỉ có hiệu lực khi kèm token phiên đăng nhập của đúng người**. Cầm mật khẩu `app_user` tự `SET ROLE` sang nhân viên: đọc ra 0 dòng, và chính hành vi đó sinh cảnh báo quy cho `app_user` | `demo-attack.sh` bước 4d · `verify.sh` mục LOP 1f |
| 2 | Log CSDL chỉ ghi tài khoản kết nối (`app_user`), nên **không quy được trách nhiệm** cho từng người | Analyzer bám theo từng phiên (`session_id`) và các lệnh `SET ROLE` / `RESET ROLE` trong log pgAudit, quy mỗi câu lệnh về đúng nhân viên | `verify.sh` mục LOP 3c: cảnh báo ghi đúng `nv_dn01`, `nv_hcm01`… |
| 3 | Kẻ có quyền hợp lệ **rút dữ liệu từng ít một** thì lọt dưới mọi ngưỡng cảnh báo | **Bản ghi mồi đặt ngay trong hàm giải mã**: giải mã trúng một khách hàng mồi là báo động (`HONEYTOKEN_ACCESS`), không cần ngưỡng. Mỗi lần giải mã còn để lại một dòng log, nên `BULK_DECRYPT` đếm **đúng số bản ghi** bị lộ (cần cho báo cáo sự cố 72 giờ) | `demo-attack.sh` bước 4c · `verify.sh` mục LOP 3c (kèm đối chứng: khách thật không kích hoạt) |
| 4 | Khôi phục về thời điểm trước sự cố (PITR) **quay lui luôn bảng cảnh báo**, tức là xóa bằng chứng về chính vụ tấn công | Sau khi khôi phục, analyzer đọc lại log (nằm ngoài CSDL) và **ghi bù** các cảnh báo bị quay lui | `backup/scripts/demo_pitr.sh` — bước `[6/6] Ghi bu canh bao` của `pitr_restore.sh` |
| 5 | Kẻ chiếm được ứng dụng **xóa hoặc giả** cảnh báo | Bất đối xứng quyền: `analyzer_user` chỉ ghi (không đọc, không xóa), `dashboard_user` chỉ đọc, `app_user` không chạm được. Dashboard đọc bằng cách hỏi định kỳ chứ không `LISTEN`, nên ứng dụng không nghe lén được là mình vừa bị phát hiện | `verify.sh` mục LOP 3b, 3b' |

**Phòng thủ nhiều lớp có đo đạc, không chỉ mô tả.** Ứng dụng cố ý giữ hai lỗ
hổng (SQL Injection, IDOR) để chứng minh lớp CSDL vẫn chặn được khi code sai
(mục 7f). Mỗi khẳng định có phép thử tự động, nhiều phép có **đối chứng**
để chắc phép thử không đạt vì lý do vô nghĩa (ví dụ: ghi một chuỗi đánh dấu
vào WAL, không thấy nó trong kho sao lưu đã mã hóa, giải mã thì thấy lại).
Chi phí hiệu năng của từng lớp được đo riêng (mục 7d).

**Không tính là điểm mới:** TLS, mã hóa cột, mã hóa bản sao lưu, RLS, PITR là
những thứ một hệ thống nghiêm túc phải có. Lab làm đủ để không có lỗ hổng hiển
nhiên, và đối chiếu với Luật Bảo vệ dữ liệu cá nhân 91/2025 + Nghị định
356/2025 ([`docs/legal-mapping.md`](docs/legal-mapping.md)). So sánh với
Oracle / SQL Server / AWS, kể cả những chỗ lab thua:
[`docs/comparison.md`](docs/comparison.md). Giới hạn đã biết: mục 8.

---

## 1. Cấu trúc thư mục

```
.
├── docker-compose.yml
├── .env.example            # mẫu biến môi trường (copy thành .env)
├── .gitattributes          # ép LF cho .sh/.sql - bắt buộc khi làm trên Windows
├── postgres/
│   ├── Dockerfile          # postgres:16 + postgresql-16-pgaudit
│   ├── tls-entrypoint.sh   # chép khóa TLS từ Docker secret sang quyền 0600
│   ├── backup-crypt.sh     # mã hóa base backup, pg_dump và từng segment WAL
│   ├── conf/
│   │   ├── postgresql.conf # pgaudit, logging, WAL archiving, TLS
│   │   └── pg_hba.conf     # lớp kiểm soát truy cập theo host, bắt buộc TLS
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
│   ├── verify.sh           # chạy toàn bộ 145 phép thử nghiệm thu
│   ├── demo-attack.sh      # demo tấn công qua app -> lớp nào chặn, lớp nào ghi nhận
│   ├── gen-alerts.sh       # diễn lại hành vi xấu + chạy analyzer -> cảnh báo thật cho dashboard
│   ├── benchmark.sh        # đo chi phí từng lớp bảo mật -> docs/benchmark-results.md
│   ├── bench/              # kịch bản pgbench, mỗi cặp chỉ khác đúng một cơ chế
│   ├── reset.sh            # dựng lại lab từ số 0 (dọn cả WAL archive)
│   └── quickstart.sh       # một lệnh: tạo .env + reset + verify (bấm đúp quickstart.bat)
├── backup/
│   ├── full/               # bản sao lưu đầy đủ (pg_basebackup / pg_dump), đã mã hóa .gpg
│   ├── wal_archive/        # đích của archive_command (từng segment đã mã hóa)
│   └── scripts/            # full_backup.sh, pitr_restore.sh, demo_pitr.sh - xem mục 7c
├── logs/                   # log csv + json của PostgreSQL, nguồn cho analyzer
├── docs/
│   ├── threat-model.md     # STRIDE cho app/, ranh giới tin cậy app <-> DB
│   ├── legal-mapping.md    # đối chiếu Luật 91/2025 + NĐ 356/2025 -> cơ chế -> phép thử
│   ├── comparison.md       # so sánh với Oracle, SQL Server, AWS RDS - giống/khác/thua
│   ├── performance.md      # phân tích chi phí hiệu năng từng lớp (viết tay)
│   └── benchmark-results.md # số đo thô, sinh bởi scripts/benchmark.sh
├── app/                    # backend Express + giao diện web - xem app/README.md
│   ├── Dockerfile          # build giao diện (web/ -> public/) rồi chạy backend
│   ├── web/                # giao diện React + Vite
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── db.js  app.js  server.js
│       ├── middleware/     # requireAuth.js, setRole.js (SET LOCAL ROLE nv_xxx)
│       └── routes/         # auth.js, customers.js, orders.js
├── analyzer/               # lớp 3: đọc log pgAudit -> audit.alerts
│   ├── Dockerfile          # chạy --watch, log mount chỉ đọc
│   ├── state/              # vị trí đã đọc - dùng chung host <-> container
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.js        # CLI: chạy một lần (batch), hoặc --watch
│       ├── watch.js        # theo dõi liên tục
│       ├── tail.js         # đọc tăng dần theo vị trí byte
│       ├── pipeline.js     # phần chung hai chế độ: rule, khóa watch
│       ├── auditLine.js    # tách trường CSV bên trong `message` của pgAudit
│       ├── sessions.js     # gom dòng -> câu lệnh, bám session_id để quy trách nhiệm
│       ├── redact.js       # che CCCD/số thẻ trước khi ghi cảnh báo
│       ├── alerts.js       # INSERT bằng analyzer_user
│       └── rules/          # 11 rule trên log PostgreSQL (2 rule tầng web ở src/appEvents.js)
└── dashboard/              # React + Socket.IO, đọc audit.alerts bằng dashboard_user - xem dashboard/README.md
```

## 2. Chạy

**Cách nhanh nhất** — cần Docker Desktop (đang chạy) và Git for Windows, không
cần cài Node hay PostgreSQL:

```bash
bash scripts/quickstart.sh       # hoặc bấm đúp quickstart.bat trên Windows
```

Một lệnh: tạo `.env` với mật khẩu ngẫu nhiên (nếu chưa có), sinh khóa, dựng lab
từ số 0, chạy `verify.sh`, rồi in địa chỉ app/dashboard và tài khoản demo. Mỗi
lần `git pull` xong chạy lại đúng lệnh này. Dữ liệu cũ trong lab bị xóa và sinh
lại (giống hệt nhờ `setseed`); thêm `--yes` để không hỏi, `--no-verify` để chỉ
dựng.

Các bước thủ công tương đương:

```bash
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
# đổi toàn bộ mật khẩu trong .env

bash scripts/init-secrets.sh   # sinh khóa mã hóa - BẮT BUỘC trước lần chạy đầu
docker compose up -d --build
docker compose ps
```

Một lệnh dựng đủ 5 service:

| Service | Địa chỉ | Việc |
|---------|---------|------|
| `postgres` | `localhost:15432` (dbnet `.10`) | PostgreSQL 16 + pgAudit |
| `app` | http://127.0.0.1:3000 (dbnet `.20`) | giao diện web + backend Express, kết nối bằng `app_user` |
| `analyzer` | — (dbnet `.30`) | `--watch`: đọc log liên tục, ghi `audit.alerts` bằng `analyzer_user` |
| `dashboard` | http://127.0.0.1:4000 (dbnet `.40`) | giao diện cảnh báo, đọc bằng `dashboard_user` |
| `pgadmin` | http://localhost:8081 | quản trị |

`app` và `dashboard` chỉ mở trên `127.0.0.1`: app có 2 lỗ hổng cố ý, dashboard
không có đăng nhập. Analyzer đọc log qua thư mục mount **chỉ đọc** — bị chiếm
cũng không xóa được dấu vết. Cả ba container chạy bằng user thường, không phải
root, và không image nào chứa `.env` (cấu hình truyền qua `environment` của
compose). `verify.sh` có phép thử cho từng điều này.

```bash
docker compose logs -f analyzer     # xem cảnh báo được phát hiện theo thời gian thực
```

Vẫn chạy tay từng thư mục được (`npm install` rồi xem README riêng) — khi đó
**tắt service tương ứng trước**, nếu không sẽ có hai tiến trình cùng cổng (xem
CLAUDE.md "Bẫy 8").

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
| SSL mode (tab Parameters) | để mặc định `prefer` hoặc chọn `require`. **Không** chọn `disable` — bị `pg_hba` từ chối |

pgAdmin nằm trong subnet `172.28.0.0/16` nên được `pg_hba.conf` cho phép, nhưng
chỉ với các role nghiệp vụ.

## 4. Mô hình phân quyền

| Role | Đăng nhập | Quyền |
|------|-----------|-------|
| `postgres` | chỉ socket nội bộ | superuser; bỏ qua RLS |
| `db_owner` | có | sở hữu schema `app`, `audit` và toàn bộ bảng. Bị `FORCE RLS` chặn nên **đọc ra 0 dòng** dữ liệu |
| `app_user` | có | `SELECT, INSERT, UPDATE` trên `customers`, `orders`, `payments`. `SELECT` trên `app.staff` **trừ cột `password_hash`** (quyền mức cột); đăng nhập qua `app.verify_staff_login()`. **Không** DELETE, **không** DDL, **không** chạm `audit`. Chưa `SET ROLE` thì **đọc ra 0 dòng** |
| `staff_role` | không | role nhóm, giữ quyền trên bảng cho nhân viên. Cũng không đọc được `password_hash`, không gọi được hàm kiểm tra mật khẩu |
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
SELECT set_config('secdb.staff_token', $1, true);   -- token phiên, THAM SỐ
SELECT * FROM app.customers;
COMMIT;
```

Dùng `SET LOCAL ROLE` trong transaction chứ không phải `SET ROLE` trần: với
connection pool, quên `RESET ROLE` là request sau mượn lại connection đó sẽ
chạy dưới danh tính người trước.

### Vai phải đi kèm phiên đăng nhập (token)

`app_user` phải là thành viên của **mọi** role `nv_*` thì app mới `SET LOCAL
ROLE` được cho từng request. Hệ quả: ai chạy được SQL dưới `app_user` — lộ mật
khẩu `app_user`, hay một lỗi ở tầng app — đều `SET ROLE` được sang chi nhánh
bất kỳ. PostgreSQL không chặn, vì quyền thành viên là hợp lệ. Đây là giới hạn
quen thuộc của mô hình "một pool + `SET ROLE`".

Repo gỡ giới hạn đó bằng **token phiên đăng nhập**:

1. Đăng nhập đúng mật khẩu nhân viên, `app.verify_staff_login()` cấp một token
   ngẫu nhiên 256 bit; bảng `app.staff_sessions` chỉ giữ SHA-256 của nó, hạn
   12 giờ, không role nào được đọc/ghi trực tiếp.
2. App giữ token trong session **phía server** và gắn vào mỗi transaction bằng
   tham số (`set_config('secdb.staff_token', $1, true)`).
3. Policy RLS (`app.branch_of`) chỉ trả chi nhánh khi token còn hạn **và thuộc
   đúng role đang `SET ROLE`**. `SET ROLE` trần, mang token của người khác, hay
   token đã thu hồi khi đăng xuất → 0 dòng.
4. Bị từ chối như vậy thì hàm ghi một dòng `LOG` vào log server (người gọi
   không thấy); analyzer biến nó thành `IDENTITY_WITHOUT_SESSION`, quy cho
   **`app_user`** chứ không cho nhân viên bị mạo danh.

Token lưu ở server thay cho token tự ký (HMAC) là có chủ đích: kiểm chữ ký phải
đọc khóa từ Docker secret mỗi câu lệnh (~0,6 ms), còn tra bảng theo khóa chính
không đo được khác biệt (`docs/performance.md` mục 6); và đăng xuất là thu hồi
tức thì.

Thử trực tiếp:

```bash
psql "postgresql://app_user@localhost:15432/secdb"
```
```sql
SELECT count(*) FROM app.customers;                      -- 0  (chưa SET ROLE)
SET ROLE nv_dn01;  SELECT count(*) FROM app.customers;   -- 0  (SET ROLE được, nhưng không có token phiên)
```

Có token (đăng nhập qua app, hoặc `scripts/staff-token.sh` khi thử nghiệm) thì
`nv_hn01` chỉ thấy chi nhánh 1, và `INSERT` sang chi nhánh khác bị `WITH CHECK`
từ chối (`new row violates row-level security policy`).

Ba điểm dễ hiểu sai, đều là chủ đích chứ không phải lỗi:

- **`app_user` chưa `SET ROLE` đọc ra 0 dòng.** Nó không có dòng nào trong
  `app.staff` nên không thuộc chi nhánh nào. Chiếm được mật khẩu `app_user` vẫn
  chưa lấy được dữ liệu — `SET ROLE` sang nhân viên thì còn thiếu token phiên
  của nhân viên đó (mục trên).
- **`db_owner` cũng đọc ra 0 dòng.** Mặc định chủ sở hữu bảng bỏ qua mọi policy;
  `FORCE` bắt nó phải tuân theo, và nó không có policy nào. Tức người quản trị
  CSDL không đọc được dữ liệu khách hàng. Cần thao tác ở mức quản trị thì dùng
  superuser qua socket.
- **`UPDATE` trúng dòng của chi nhánh khác không báo lỗi**, chỉ trả `UPDATE 0`.
  Dòng đó vô hình chứ không phải bị từ chối.

### TLS — mã hóa đường truyền

Lớp 2 chỉ bảo vệ dữ liệu khi **lưu**: sau `app.decrypt_text()`, CCCD đi từ
database về app. Đoạn đường đó được bảo vệ bằng TLS 1.3:

| Ở đâu | Cái gì |
|-------|--------|
| `pg_hba.conf` | `hostnossl all all all reject` đứng trước mọi dòng cho phép, các role nghiệp vụ dùng `hostssl`. Kết nối không mã hóa bị từ chối **dù đúng mật khẩu** (`no encryption`) |
| `postgresql.conf` | `ssl = on`, `ssl_min_protocol_version = 'TLSv1.3'` |
| `scripts/init-secrets.sh` | Sinh CA riêng của lab + chứng chỉ server (SAN: `172.28.0.10`, `postgres`, `localhost`, `127.0.0.1`). **Khóa CA bị xóa ngay sau khi ký**: lộ thư mục `secrets/` cũng không ký thêm được chứng chỉ giả |
| `postgres/tls-entrypoint.sh` | Chép khóa server từ Docker secret sang `/etc/postgresql/tls/` quyền `0600` — PostgreSQL từ chối khóa mà nhóm/người khác đọc được, còn bind mount trên Windows hiện ra `0777` |
| app / analyzer / dashboard | Tin **đúng CA của lab** (`DB_SSL_ROOT_CERT`), kiểm tên server trong chứng chỉ — tương đương `sslmode=verify-full`. Thiếu file CA thì dừng lại, không lùi về kết nối không mã hóa |

Vì sao không dừng ở `sslmode=require`: `require` có mã hóa nhưng không xác thực
server, nên kẻ xen giữa tự ký một chứng chỉ bất kỳ là đọc được hết.
`verify.sh` có phép thử giả lập đúng tình huống này (gọi server bằng tên khác,
bị từ chối với `does not match host name`). Log PostgreSQL ghi giao thức của
từng kết nối: `SSL enabled (protocol=TLSv1.3, cipher=TLS_AES_256_GCM_SHA384)`.

Cấp lại chứng chỉ không ảnh hưởng dữ liệu (khác với `pgcrypto_key`):

```bash
bash scripts/init-secrets.sh --force-tls && docker compose up -d --force-recreate
```

Kết nối qua unix socket (superuser trong container) không đi qua TLS. Đó là
kênh nội bộ của container, không qua mạng.

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

### Bản ghi mồi (honeytoken) — lớp 2 báo động cho lớp 3

Sáu khách hàng giả (2 mỗi chi nhánh) nằm lẫn trong `app.customers`, trông y
hệt khách thật — kể cả có đơn hàng. SHA-256 ciphertext CCCD của họ nằm trong
`audit.honeytokens`, bảng **không role nào ngoài `db_owner` đọc được**.

`app.decrypt_text()` tự tra mỗi ciphertext; trúng mồi thì vẫn trả đúng CCCD
(người gọi không nhận ra gì) nhưng để lại một dòng riêng trong log pgAudit.
Analyzer biến dòng đó thành `HONEYTOKEN_ACCESS` (98 điểm).

Vì sao đáng giá: mọi rule khác cần **ngưỡng** hoặc **dấu hiệu bất thường trong
câu lệnh**. Kẻ có quyền thật mở từng hồ sơ một qua endpoint hợp lệ không để lại
cả hai — `BULK_DECRYPT` (≥ 50 bản ghi/câu lệnh) không bao giờ thấy. Mồi bắt
được ngay lần chạm đầu tiên, và vì bẫy nằm **trong hàm giải mã** — đường duy
nhất tới plaintext — nên đi vòng qua SQLi hay `psql` thẳng bằng mật khẩu
`app_user` bị lộ cũng không tránh được. Chi phí: ~4,4 µs mỗi lần giải mã
(`docs/performance.md` mục 5).

> **Đừng chạy `scripts/init-secrets.sh --force` trên database đang có dữ liệu.**
> `pgp_sym_encrypt` gắn chặt với khóa: sinh khóa mới thì `cccd`, `card_token`
> cũ không giải mã được nữa. Đổi khóa phải đi kèm `scripts/reset.sh`.

## 5. Nghiệm thu

```bash
bash scripts/verify.sh
```

Chạy 145 phép thử trên cả 4 lớp: `pg_hba` chặn superuser qua TCP, **kết nối
không TLS bị từ chối và cả ba client xác thực server bằng CA của lab**, `app_user` bị
từ chối DELETE/DROP/TRUNCATE/CREATE và schema `audit`, `readonly_user` không
đọc được `payments`, RLS phân tách đúng chi nhánh theo cả chiều đọc lẫn chiều
ghi, `FORCE RLS` chặn cả `db_owner`, **`SET ROLE` không kèm token phiên đúng
người đọc ra 0 dòng** (không token, token người khác, hết hạn, đã thu hồi; token
không lọt vào log), mã hóa/giải mã/blind index hoạt động đúng,
role nghiệp vụ không chạm được khóa, `readonly_user` không đọc được cột `cccd`,
**không role nghiệp vụ nào đọc được `password_hash`** (SQLi UNION bị từ chối,
đăng nhập vẫn chạy qua hàm, mật khẩu không rò vào log),
**`pg_dump` không chứa CCCD hay số thẻ ở dạng rõ**, khóa không rò vào log,
pgAudit ghi được câu lệnh và cả `SET ROLE`, analyzer bắt được giải mã hàng
loạt, **giải mã dù chỉ một bản ghi mồi** (còn khách thật thì không, và không
role nào ngoài chủ sở hữu đọc được danh sách mồi), SQLi (kể cả lần bị chặn), leo thang đặc quyền (tắt RLS, `GRANT ... TO
PUBLIC`, hàm `SECURITY DEFINER`, thử `SUPERUSER`) và quy đúng người,
`analyzer_user` ghi được cảnh báo
nhưng không đọc/sửa/xóa được, `dashboard_user` đọc được cảnh báo nhưng không
ghi được kể cả khi tự mở transaction READ WRITE, dữ liệu đủ khối lượng đề bài yêu cầu và trải đều
ba chi nhánh, segment WAL vừa đóng được archive ra `backup/wal_archive/` **ở dạng mã hóa** (bản sao lưu, `pg_dump` cũng vậy; sai khóa hay sửa 1 byte đều bị từ chối),
replication qua TCP bị `pg_hba` từ chối, bản `pg_dump` đọc được, và **một lần
PITR thật trong container sandbox** dừng đúng tại thời điểm chỉ định (không
đụng tới database đang chạy).

Kết quả mong đợi: `DAT: 145    TRUOT: 0`.

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
còn nguyên file cùng tên của cluster cũ. `archive_command` (`backup-crypt.sh wal-archive`, không ghi đè file đã có)
thấy file đã tồn tại, trả về 1, và **archiving chết hẳn** — kẹt ở segment đầu
tiên, `failed_count` tăng không ngừng, trong khi server vẫn chạy bình thường
nên không có dấu hiệu nào. Luôn dùng `bash scripts/reset.sh`, nó dọn cả
`wal_archive`.

Đừng gỡ điều kiện "không ghi đè" đó cho tiện: nó chính là cái chặn ghi đè WAL. Gỡ đi thì archive
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

Đã có: đăng nhập bằng `app.staff.username` + `app.verify_staff_login()` (so
bcrypt trong database, app không đọc được `password_hash`), `SET
LOCAL ROLE nv_xxx` cho từng request theo mô hình ở mục 4, CRUD tối thiểu cho
`customers`/`orders`, giải mã `cccd` qua `app.decrypt_text()`. Kèm 2 lỗ hổng
**cố ý** (SQL Injection ở `/customers/search`, IDOR ở `/orders/:id`) để đo
thực nghiệm luận điểm defense-in-depth — chi tiết và cách khai thác ở
[`app/README.md`](app/README.md), threat model STRIDE ở
[`docs/threat-model.md`](docs/threat-model.md).

Chạy sẵn trong Docker (service `app`, http://127.0.0.1:3000). Chạy tay khi
đang sửa code — tắt container trước để khỏi trùng cổng:

```bash
docker compose stop app
cd app && npm install && cp .env.example .env && npm run dev
```

## 7b. `analyzer/` — lớp 3

Đọc `logs/*.json`, bám `session_id` để quy trách nhiệm cho đúng nhân viên theo
`SET ROLE`, áp 11 rule trên log pgAudit (cộng 2 rule tầng web), ghi cảnh báo vào `audit.alerts` bằng
`analyzer_user` (chỉ `INSERT`).

Chạy sẵn trong Docker ở chế độ `--watch` (service `analyzer`): mọi hành vi
trên app thành cảnh báo sau 1–4 giây, không ai phải gõ lệnh.

```bash
docker compose logs -f analyzer      # xem phát hiện theo thời gian thực

# Chạy tay trên host (dùng chung trạng thái với container qua analyzer/state/):
cd analyzer && npm install && cp .env.example .env
node src/index.js --dry-run --all    # xem thử, không ghi database
node src/index.js                    # đọc phần log mới, ghi cảnh báo
```

Batch trên host tự nhường (mã thoát 3, không ghi) khi watch đang chạy — ở host
hay trong container — để không ghi trùng.

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
| `full_backup.sh` | Tạo `backup/full/<YYYYMMDD_HHMMSS>/`: `base.tar.gz.gpg` + `pg_wal.tar.gz.gpg` + `backup_manifest` (pg_basebackup, bản vật lý — điểm xuất phát của PITR), `secdb.dump.gpg` (pg_dump -Fc, bản logic), `backup_info` (thời điểm hoàn tất). |
| `pitr_restore.sh` | Đẩy WAL còn lại ra archive → dừng postgres → cất data hiện tại (mã hóa) vào `backup/full/pre_pitr_*.tar.gz.gpg` → giải mã và giải nén base backup mới nhất hoàn tất *trước* thời điểm đích → `pg_verifybackup` → replay WAL tới `recovery_target_time` → promote sang timeline mới → dọn cấu hình recovery → analyzer ghi bù cảnh báo bị quay lui (xem dưới). Tạm dừng service `analyzer` suốt quá trình. |
| `demo_pitr.sh` | Ghi mốc T → `app_user` thử `DELETE` (lớp 1 chặn) → superuser xóa nhầm toàn bộ `orders`/`payments` → PITR về T → so khớp số dòng và tổng tiền. |
| `_restore_inner.sh` | Phần chạy **bên trong** container (`pitr-restore` hoặc `pitr-sandbox` trong `docker-compose.yml`, profile `tools`). Không gọi trực tiếp. |
| `lib.sh` | Hàm dùng chung: chọn base backup, flush WAL, đọc timeline. |

### Mã hóa bản sao lưu

Lớp 2 chỉ mã hóa `cccd`/`card_token`. Họ tên, số điện thoại, đơn hàng vẫn rõ
trong bản sao lưu — và WAL archive chứa **nguyên văn mọi dòng từng được ghi**.
Kho sao lưu lại là thứ được chép đi nơi khác, giữ lâu nhất và ít được canh nhất.
Nên **mọi thứ chứa dữ liệu rời database đều được mã hóa** bằng
[`postgres/backup-crypt.sh`](postgres/backup-crypt.sh) (OpenPGP đối xứng,
AES-256, `gpg` có sẵn trong image):

| Cái gì | Mã hóa ở đâu |
|--------|--------------|
| Từng segment WAL | `archive_command = 'backup-crypt.sh wal-archive %p %f'` — nén zlib rồi mã hóa, ghi file tạm rồi đổi tên (không bao giờ có segment dở dang mang tên thật). `restore_command` giải mã ngược lại |
| Base backup, `pg_wal` đi kèm | `pg_basebackup` ghi vào `/tmp` **trong container**, mã hóa xong mới sang `backup/full/` |
| `pg_dump` | Đi thẳng qua pipe `pg_dump -Fc \| backup-crypt.sh encrypt` — bản rõ không thành file ở đâu cả |
| Bản cất `pre_pitr_*` trước khi PITR ghi đè | `tar \| backup-crypt.sh encrypt` |

Chỉ `backup_manifest` (tên file + checksum) và `backup_info` (mốc thời gian) để
rõ — không chứa dữ liệu, và script chọn base backup cần đọc chúng.

- **Khóa riêng** (`secrets/backup_key`, Docker secret), không dùng chung
  `pgcrypto_key`: lộ khóa sao lưu thì CCCD bên trong vẫn là ciphertext của lớp
  2; lộ khóa cột thì bản sao lưu vẫn khóa. Chỉ `postgres` và hai container PITR
  nhận khóa này.
- **Có kiểm tra toàn vẹn (MDC)**: sửa một byte là giải mã báo `encrypted message
  has been manipulated` và dừng khôi phục. Kẻ ghi được vào kho WAL vì vậy cũng
  không cấy được segment giả cho PITR replay — không có khóa thì không tạo được
  file hợp lệ. `restore_command` cố ý **không** chấp nhận segment ở dạng rõ.
- **Mất khóa = mất mọi bản sao lưu.** Trong lab khóa nằm cạnh bản sao lưu trên
  cùng máy; ngoài thực tế phải cất một bản ở nơi khác (két, KMS).
- Đọc lại một bản dump bằng tay:
  ```bash
  docker compose exec -T postgres bash -c \
    "backup-crypt.sh decrypt /backup/full/<ten>/secdb.dump.gpg - | pg_restore -l"
  ```
- Nâng cấp từ bản chưa mã hóa: chạy `bash scripts/reset.sh` (hoặc
  `quickstart.sh`) — kho WAL và bản sao lưu cũ ở dạng rõ không dùng chung được.

`verify.sh` ghi một chuỗi đánh dấu ngẫu nhiên vào WAL rồi kiểm tra: **không**
tìm thấy nó trong segment ở kho archive, nhưng giải mã bằng khóa thì **thấy lại**
(đối chứng — để chắc phép thử đầu không đạt vì lý do vô nghĩa). Thêm: không có
file sao lưu rõ nào trong `backup/full/`, `pg_restore` đọc thẳng bản mã hóa bị
lỗi, sai khóa bị từ chối, sửa 1 byte bị phát hiện, client không có khóa.

Những điều cần biết:

- **Chỉ quay về được thời điểm SAU lần `full_backup.sh` gần nhất có trước nó.**
  Chưa có base backup thì không có PITR, dù WAL archive đầy đủ.
- **PITR quay lui cả cluster**, kể cả `audit.alerts`. Log pgAudit ở `./logs/`
  thì còn nguyên vì nằm ngoài database — nên `pitr_restore.sh` cho analyzer
  **ghi bù** cảnh báo của các sự kiện sau mốc khôi phục (`--replay-after`).
  Thiếu bước này, khôi phục để gỡ hậu quả một vụ tấn công sẽ xóa luôn chính
  các cảnh báo về vụ đó (đã tái hiện và sửa). Dashboard không đọc DB khi nó
  đang replay WAL, và bắt trình duyệt tải lại sau khi khôi phục xong.
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

## 7e. `dashboard/` — lớp 3, chiều đọc

Giao diện React hiển thị `audit.alerts` theo thời gian thực. Backend Node kết
nối bằng `dashboard_user` (chỉ `SELECT` trên đúng bảng đó), poll theo `id` mỗi
2 giây rồi đẩy xuống trình duyệt qua Socket.IO — không dùng `LISTEN/NOTIFY`, lý
do ở [`dashboard/README.md`](dashboard/README.md) mục 5.

Chạy sẵn trong Docker: mở http://127.0.0.1:4000, rồi chạy
`bash scripts/demo-attack.sh` hoặc `bash scripts/gen-alerts.sh` để thấy cảnh
báo hiện lên. Sửa giao diện thì xem `dashboard/README.md` mục 0 (`npm run dev`).

Dashboard không có nút "chạy phân tích": nó chỉ đọc được cảnh báo, còn ghi là
việc của analyzer (`analyzer_user`, chỉ `INSERT`). Không tiến trình nào vừa đọc
vừa ghi được `audit.alerts`.

## 7f. Demo tấn công đầu-cuối

```bash
bash scripts/demo-attack.sh          # dừng chờ Enter giữa các bước
bash scripts/demo-attack.sh --yes    # chạy một mạch
```

Diễn lại hai lỗ hổng **cố ý** của `app/` qua đúng HTTP endpoint, rồi cho thấy
tầng database vẫn giữ — bài thực nghiệm trung tâm cho luận điểm defense-in-depth:

| Bước | Tấn công (tầng app) | Lớp chặn (tầng DB) | Kết quả |
|------|---------------------|---------------------|---------|
| 3 | SQLi UNION đọc `app.staff.password_hash` | Quyền mức cột (`staff` không bật RLS) | **Bị chặn**: `permission denied for table staff`. Trước khi có quyền mức cột thì lộ hash của cả 3 chi nhánh. |
| 3b | SQLi UNION đọc `app.customers` chi nhánh khác | RLS (FORCE) + mã hóa cột | Chỉ kéo được chi nhánh mình; `cccd` là ciphertext `\x…` |
| 4 | IDOR `/orders/:id` chi nhánh khác | RLS `branch_isolation` | `404` dù code không kiểm tra quyền |
| 4b | `admin_user` bị chiếm: `SET ROLE db_owner`, tắt RLS, `GRANT ... TO PUBLIC`, hàm `SECURITY DEFINER`, thử `SUPERUSER` | Lớp 1 **không** chặn (chủ sở hữu có quyền) — trừ `SUPERUSER` bị từ chối | Chỉ lớp 3 thấy: `PRIVILEGE_ESCALATION`. Chạy trong transaction rồi `ROLLBACK`. |
| 4c | Kẻ có quyền thật mở lần lượt 15 hồ sơ cuối danh sách qua `GET /customers/:id` hợp lệ — mỗi request giải mã 1 CCCD | Không lớp nào chặn (quyền hợp lệ); `BULK_DECRYPT` không thấy (dưới ngưỡng) | Chạm 2 bản ghi mồi → `HONEYTOKEN_ACCESS` (98), quy cho `nv_hn01` |
| 4d | Mật khẩu `app_user` bị lộ: kết nối thẳng, `SET ROLE nv_dn01` | Token phiên (RLS đòi token của đúng nhân viên) | `SET ROLE` được nhưng đọc ra **0 dòng** → `IDENTITY_WITHOUT_SESSION` (90), quy cho `app_user` |
| 5–6 | (log các hành vi trên) | pgAudit + analyzer | `HONEYTOKEN_ACCESS`, `IDENTITY_WITHOUT_SESSION`, `SQLI_UNION`, `ACCESS_DENIED` (lần thử bị chặn), `PRIVILEGE_ESCALATION`… quy về đúng người |

Script tự khởi động `app/` nếu chưa chạy (và tự tắt khi xong), chạy analyzer,
rồi đọc cảnh báo bằng `dashboard_user`. Mở `dashboard/` song song để xem cảnh
báo hiện realtime. Giới hạn trung thực: analyzer **không** bắt được IDOR (truy
vấn hợp lệ về cú pháp) — chính RLS mới chặn nó.

## 8. Hạn chế và hướng phát triển

Những điểm dưới đây là giới hạn **đã biết và có chủ đích** của lab, không phải
lỗi bị bỏ sót.

**Chưa làm — hướng phát triển:**

- **Xóa dữ liệu theo yêu cầu chủ thể** (Luật Bảo vệ dữ liệu cá nhân 91/2025,
  Điều 14). `app_user` cố ý không có `DELETE`, và bản sao lưu vẫn giữ dữ liệu
  cũ. Hướng làm: hàm xóa có kiểm soát + crypto-shredding (mỗi khách một khóa
  con). Toàn bộ đối chiếu pháp lý, kể cả các chỗ chưa đáp ứng:
  [`docs/legal-mapping.md`](docs/legal-mapping.md). So sánh với Oracle /
  SQL Server / AWS: [`docs/comparison.md`](docs/comparison.md).

- **Quản lý chứng chỉ TLS.** TLS đã bắt buộc (mục 4, "TLS"), nhưng CA là CA
  tự ký của lab, cấp lại chứng chỉ bằng tay (`init-secrets.sh --force-tls`),
  không có thu hồi (CRL/OCSP) và client chưa trình chứng chỉ của mình (mTLS).
- **Xoay khóa mã hóa** (cả `pgcrypto_key` lẫn `backup_key`). Hiện đổi một
  trong hai khóa đồng nghĩa với `scripts/reset.sh`. Hướng làm:
  - Khóa cột: thêm cột `key_version`, giữ khóa cũ trong lúc chuyển tiếp, mã hóa
    lại từng lô (`UPDATE ... SET cccd = app.encrypt_text(app.decrypt_text(cccd))`)
    rồi mới bỏ khóa cũ. Blind index cũng phải tính lại nếu đổi pepper.
  - Khóa sao lưu: **mã hóa phong bì** — mỗi bản sao lưu một khóa dữ liệu ngẫu
    nhiên, khóa đó được mã hóa bằng khóa chủ. Xoay khóa chủ chỉ cần mã hóa lại
    các khóa dữ liệu nhỏ, không đụng tới hàng GB dữ liệu; bản cũ hết hạn lưu
    trữ thì xóa khóa dữ liệu của nó (crypto-shredding).
  - Khóa nên nằm trong KMS/HSM thay vì file trên cùng máy chủ.

**Giới hạn của lớp giám sát (chi tiết ở [`analyzer/README.md`](analyzer/README.md)):**

- Không bắt được IDOR — câu lệnh hợp lệ về cú pháp, chỉ khác giá trị `id`.
  RLS mới là thứ chặn nó.
- pgAudit ghi câu lệnh, không ghi số dòng trả về; `FULL_TABLE_READ` đoán theo
  hình dạng câu lệnh. Riêng `BULK_DECRYPT` và `HONEYTOKEN_ACCESS` đếm được số
  bản ghi giải mã thật.
- Bản ghi mồi chỉ bắt được kẻ **giải mã**: đọc tên, số điện thoại của khách
  mồi không chạm bẫy. Ai đọc được `audit.honeytokens` (superuser, `admin_user`
  qua `SET ROLE db_owner`) biết mồi nằm đâu.
- pgAudit không ghi `COMMIT`/`ROLLBACK`: phải `RESET ROLE` sau mỗi transaction
  (app đã làm) thì việc quy trách nhiệm mới đúng.
- Phiên superuser qua unix socket trong container bị bỏ qua — ai có shell
  trong container database đã ra ngoài mô hình.

**Rủi ro còn lại ở tầng ứng dụng:**

- SQLi ở `/customers/search` vẫn đọc được các cột không nhạy cảm của
  `app.staff` (`username`, `db_user`). Phân quyền và RLS không thay thế được
  parameterized query.
- Token phiên nằm trong GUC của transaction, nên SQL Injection trong một request
  đọc được bằng `current_setting()` — nhưng đó là token của **chính người gửi
  request**, không thêm quyền gì. Token có hạn tuyệt đối 12 giờ (không gia hạn
  theo hoạt động); session web lưu trong bộ nhớ của app nên app khởi động lại là
  mọi người phải đăng nhập lại, token cũ tự hết hạn.
- Ai cầm mật khẩu của chính `app_user` gọi được `app.verify_staff_login()` để
  thử mật khẩu, vòng qua bộ đếm đăng nhập sai của tầng web — nhưng không lấy
  được hash để dò ngoại tuyến, và mỗi lần thử tốn một lần bcrypt.
