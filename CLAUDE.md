# CLAUDE.md

Hướng dẫn làm việc trong repo này. Đọc trước khi sửa bất cứ thứ gì trong
`postgres/`.

## Dự án là gì

Lab local (Docker Compose) cho đồ án *"Xây dựng mô hình bảo mật cơ sở dữ liệu
nhiều lớp trên PostgreSQL"*. **Không phải hệ thống production** — mục tiêu là
minh họa và đo đạc được 4 lớp bảo vệ, nên mọi thay đổi phải giữ được tính
*chứng minh được*: mỗi cơ chế phải có một lệnh chạy ra kết quả nhìn thấy được.

| Lớp | Nội dung | Trạng thái |
|-----|----------|-----------|
| 1 | `pg_hba` + Role/GRANT + Row-Level Security | **Xong cả ba** |
| 2 | Mã hóa cột bằng `pgcrypto` | **Xong** (khóa qua Docker secret) |
| 3 | `pgAudit` + analyzer tự viết | pgAudit xong; **`analyzer/` chưa có code** |
| 4 | WAL archive + `pg_dump` + PITR | Archiving xong; **`backup/scripts/` rỗng** |

Nghiệm thu bằng một lệnh: `bash scripts/verify.sh` (30 phép thử, phải đạt hết).
Dựng lại từ số 0: `bash scripts/reset.sh`.

Thứ tự file init: `01_extensions` → `02_roles` → `03_schema` → `04_grants` →
`05_crypto` → `06_rls` → `07_seed`.

Stack dự kiến: PostgreSQL 16 · Node.js + Express (`app/`) · Node.js
(`analyzer/`) · React + Socket.IO (`dashboard/`). `app/` đã có code (xem mục
"app/ — quy ước" bên dưới và `app/README.md`); `analyzer/` và `dashboard/`
hiện chỉ có README giữ chỗ.

## Lệnh thường dùng

```bash
docker compose up -d --build
docker compose ps
docker compose logs postgres          # gần như trống, xem mục "Log" bên dưới

# Superuser — CHỈ qua socket trong container
docker compose exec postgres psql -U postgres -d secdb

# Role nghiệp vụ, từ trong container (chú ý IP, xem "Bẫy 4")
docker compose exec postgres psql "postgresql://app_user:<mk>@172.28.0.10:5432/secdb"

# Từ máy host — cổng 55432, KHÔNG phải 5432
psql "postgresql://app_user@localhost:55432/secdb"
```

Mật khẩu nằm trong `.env` (không commit). Lấy ra để chạy test:

```bash
set -a && . ./.env && set +a
```

## Bẫy — đọc kỹ trước khi sửa

**1. Sửa file trong `postgres/init/` KHÔNG có tác dụng nếu volume đã có dữ liệu.**
`docker-entrypoint.sh` chỉ chạy các script đó khi `$PGDATA` còn trống. Dùng:

```bash
bash scripts/reset.sh
```

**Đừng gõ `docker compose down -v` trần.** `down -v` xóa volume `pgdata` nên
cluster mới đánh số WAL lại từ `000000010000000000000001`, nhưng
`./backup/wal_archive` nằm trên host nên vẫn còn file cùng tên của cluster cũ.
`archive_command` có `test ! -f ...` sẽ thấy file đã tồn tại, trả về 1, và
**archiving hỏng vĩnh viễn** — kẹt ở segment đầu tiên, `failed_count` tăng
không ngừng, trong khi server vẫn chạy bình thường nên không có dấu hiệu gì.
`scripts/reset.sh` dọn luôn `wal_archive`, `backup/full` và `logs`.

Điều kiện `test ! -f` không phải thứ nên gỡ cho tiện: nó chính là cái chặn ghi
đè WAL. Gỡ đi thì archive trộn WAL của hai cluster khác nhau và mọi lần PITR
sau đó cho ra dữ liệu rác — hỏng âm thầm, nguy hiểm hơn nhiều.

Nếu chỉ cần chạy thêm SQL trên DB đang sống thì `psql` trực tiếp, đừng sửa file
init rồi tưởng nó tự chạy.

**2. Đừng bỏ `-c config_file=/etc/postgresql/postgresql.conf` trong
`docker-compose.yml`.**
Config nằm ngoài `$PGDATA` là có chủ đích: entrypoint truyền nguyên tham số CMD
cho cả *temp server* dùng khi chạy init script, nhờ vậy
`shared_preload_libraries = 'pgaudit'` đã có hiệu lực trước khi
`01_extensions.sql` gọi `CREATE EXTENSION pgaudit`. Chuyển config vào `$PGDATA`
hoặc append từ init script thì lệnh đó sẽ lỗi
*"pgaudit must be loaded via shared_preload_libraries"*.
Hệ quả kèm theo: `hba_file` và `ident_file` phải khai báo tường minh trong
`postgresql.conf`, vì mặc định Postgres tìm chúng cạnh `config_file`.

**3. Superuser `postgres` không đăng nhập được qua TCP.**
`pg_hba.conf` có `host all postgres all reject`. Dùng
`docker compose exec postgres psql -U postgres` (socket, method `trust`).
Dòng `local all postgres trust` là **bắt buộc** — entrypoint cần nó để chạy
initdb và các script init. Đừng đổi thành `scram-sha-256`.

**4. Bên trong container, kết nối TCP phải dùng `172.28.0.10`, không dùng
`127.0.0.1`.**
Loopback không thuộc `172.28.0.0/16` nên rơi vào luật `reject` cuối cùng của
`pg_hba.conf`. Subnet được ghim cứng trong `docker-compose.yml`; nếu đổi subnet
thì phải sửa `pg_hba.conf` cho khớp.

**5. Cổng host là `55432` (`POSTGRES_HOST_PORT` trong `.env`).**
Máy dev thường đã cài PostgreSQL native chiếm `5432`. Khi trùng, Docker **vẫn
bind thành công, không báo lỗi**, nhưng kết nối `localhost:5432` lại đi vào
instance native — triệu chứng rất đánh lừa ("sai mật khẩu", "không có bảng
`app.customers`", "pg_hba không có tác dụng"). Cách phân biệt chắc chắn:

```sql
SELECT current_setting('server_version'), inet_server_addr();
-- phải ra 16.x và 172.28.0.10
```

Hoặc kiểm tra log container có ghi nhận lần kết nối đó không — không thấy nghĩa
là đã đi nhầm server.

**6. Script `.sh` phải có line ending LF.**
Repo phát triển trên Windows, chạy trong container Linux. CRLF làm bash báo
`\r: command not found` và init thất bại. Đã chặn hai lớp (`.gitattributes` và
`sed -i 's/\r$//'` trong Dockerfile) — đừng gỡ lớp nào.

## Quy ước phải giữ

**Thêm bảng mới → phải thêm `GRANT` tường minh vào `04_grants.sql`.**
Repo **cố tình không** dùng `ALTER DEFAULT PRIVILEGES ... ON TABLES`, vì nó sẽ
tự động cấp quyền cho mọi bảng tương lai — đúng thứ mô hình whitelist cần
tránh. Default privileges chỉ áp cho SEQUENCES. Quên `GRANT` thì `app_user` sẽ
báo `permission denied`; đó là hành vi mong muốn, không phải bug.

**Tạo object phải `SET ROLE db_owner` trước** (xem đầu `03_schema.sql`). Nếu
tạo dưới quyền `postgres`, bảng sẽ thuộc superuser và mô hình tách chủ sở hữu
bị phá. `app_user` không thể `DROP`/`ALTER` chính vì nó không phải owner — chỉ
`REVOKE` thôi là không đủ.

**Schema:**
- `app` — bảng nghiệp vụ (`branches`, `staff`, `customers`, `orders`, `payments`)
- `audit` — `alerts`. **Không cấp quyền gì cho `app_user`**: nếu `app_user` bị
  chiếm, kẻ tấn công không được đọc hay xóa bằng chứng phát hiện.
- `ext` — `pgcrypto`. Để riêng vì `PUBLIC` có `USAGE` mặc định trên `public`;
  đặt pgcrypto ở đó thì mọi role đều gọi được `pgp_sym_decrypt()`. Gọi hàm phải
  qualify `ext.` (hoặc dựa vào `search_path` đã set sẵn cho `app_user`).

**Mã hóa (lớp 2) — chỉ dùng ba hàm này, đừng gọi pgcrypto trực tiếp:**

```
app.encrypt_text(text)  -> bytea    app.decrypt_text(bytea) -> text
app.blind_index(text)   -> bytea
```

- **Khóa nằm ở Docker secret, database tự đọc.** `ext.master_key()` và
  `ext.index_pepper()` (SECURITY DEFINER, chủ sở hữu `postgres`) đọc
  `/run/secrets/`. Chỉ `db_owner` có EXECUTE trên chúng. **Đừng truyền khóa từ
  ứng dụng vào truy vấn**, và tuyệt đối đừng dùng `SET LOCAL app.enc_key = ...`
  — `pgaudit.log` đã bật class `misc_set` nên câu `SET` đó đi thẳng vào file log.
- **Không role nghiệp vụ nào có `USAGE` trên schema `ext`.** Đừng "sửa cho
  tiện" bằng cách cấp lại — đó là thứ chặn việc gọi thẳng `pgp_sym_decrypt()`
  và ép mọi lần giải mã thành một lời gọi hàm có tên trong log pgAudit.
- **BẪY — hàm giải mã KHÔNG được tự truy vấn bảng.** Viết kiểu
  `app.reveal_cccd(customer_id)` rồi `SELECT ... FROM app.customers` bên trong
  là hỏng: hàm SECURITY DEFINER chạy dưới quyền `db_owner`, mà `db_owner` đang
  bị `FORCE ROW LEVEL SECURITY` chặn nên đọc ra 0 dòng và hàm **luôn trả NULL**.
  Hàm chỉ nhận ciphertext và trả plaintext; câu `SELECT` nằm ở phía người gọi
  để RLS áp đúng chi nhánh của họ.
- `pgp_sym_encrypt()` **không tất định** — không `WHERE cccd = ...`, không
  index, không UNIQUE. Tra cứu qua `customers.cccd_hash` = `app.blind_index()`
  (HMAC-SHA256 + pepper, có chuẩn hóa bỏ ký tự không phải chữ/số).
- **`scripts/init-secrets.sh --force` làm hỏng toàn bộ dữ liệu cũ.**
  `pgp_sym_encrypt` gắn chặt với khóa; sinh khóa mới thì `cccd` và `card_token`
  cũ không giải mã được nữa, blind index cũ cũng không tra cứu được. Đổi khóa
  phải đi kèm `scripts/reset.sh` hoặc quy trình mã hóa lại toàn bộ.
- File khóa **không được có ký tự xuống dòng ở cuối** — thừa một `\n` là ra một
  khóa khác. `init-secrets.sh` dùng `printf` chứ không `echo`, và
  `ext.master_key()` còn `trim()` thêm một lớp nữa.
- **Không bật `pgaudit.log_parameter`.** Bật lên là giá trị CCCD bị ghi
  plaintext vào log, phá vỡ toàn bộ lớp 2. Dòng AUDIT kết thúc bằng
  `<not logged>` là dấu hiệu tham số này đang tắt đúng.
- `readonly_user` bị chặn ở **mức cột** (không đọc được `cccd`, `cccd_hash`).
  Nên `SELECT *` với role đó sẽ lỗi — đó là chủ đích, phải liệt kê cột.

**RLS — đã bật, `FORCE` trên `customers`, `orders`, `payments`:**

- **Mô hình định danh là `SET ROLE`.** App kết nối bằng `app_user` (một pool),
  rồi `SET LOCAL ROLE nv_xxx` trong transaction cho từng request. Các role
  `nv_hn01` / `nv_dn01` / `nv_hcm01` đều `NOLOGIN` — không có mật khẩu, không
  kết nối trực tiếp được, chỉ vào được qua `SET ROLE`.
- Dùng **`SET LOCAL ROLE` trong transaction**, không dùng `SET ROLE` trần. Với
  connection pool, quên `RESET ROLE` là request sau mượn lại connection đó sẽ
  chạy dưới danh tính người trước — lỗ hổng nặng và chỉ xuất hiện khi pool tái
  sử dụng connection nên rất khó tái hiện.
- **`app_user` chưa `SET ROLE` thì đọc ra 0 dòng** (nó không có dòng nào trong
  `app.staff` nên `current_branch_id()` trả NULL). Đây là chủ đích, không phải
  lỗi: chiếm được mật khẩu `app_user` vẫn chưa lấy được dữ liệu.
- **`db_owner` cũng đọc ra 0 dòng** vì `FORCE` + không có policy nào cho nó.
  Cũng là chủ đích (phân tách nhiệm vụ). Cần thao tác dữ liệu ở mức quản trị
  thì dùng superuser qua socket — superuser bỏ qua RLS.
- **BẪY `SECURITY DEFINER`:** bên trong hàm `SECURITY DEFINER`, `current_user`
  trả về **chủ sở hữu hàm**, không phải người gọi. Vì vậy `app.branch_of(text)`
  nhận user qua **tham số**, còn `app.current_branch_id()` là `SECURITY INVOKER`
  để lấy đúng `current_user` rồi truyền sang. Gộp làm một hàm `SECURITY DEFINER`
  là mọi role đều đọc ra 0 dòng — triệu chứng nhìn hệt như "RLS chặn đúng".
- `USING` lọc dòng đọc được; `WITH CHECK` chặn ghi. Thiếu `WITH CHECK` là lỗ
  hổng phổ biến nhất của RLS.
- `UPDATE` trúng dòng của chi nhánh khác **không báo lỗi**, chỉ trả `UPDATE 0`.
  Dòng đó vô hình chứ không phải bị từ chối.

## app/ — quy ước

Backend Express, đã port từ prototype của một thành viên trong nhóm
(`github.com/UngVangDaiLam/ATw-CSDL`) sang đúng mô hình định danh của repo
này. Đọc `app/README.md` trước khi sửa — dưới đây chỉ là phần dễ quên nhất.

- **Định danh qua `SET LOCAL ROLE`, không phải GUC tùy biến.** Middleware
  `app/src/middleware/setRole.js` xin 1 connection riêng từ pool, `BEGIN`,
  `SET LOCAL ROLE <db_user>` (đọc từ `req.session.staff.db_user`, tra ra lúc
  đăng nhập ở `routes/auth.js`), rồi `COMMIT`/`ROLLBACK` theo status code khi
  response kết thúc. **Đừng** quay lại kiểu `set_config('app.branch_id', ...)`
  của bản gốc — RLS ở `06_rls.sql` không đọc GUC đó, nó đọc `current_user`.
- **`SET LOCAL ROLE ...` không tham số hóa được.** Giao thức parameterized
  query của PostgreSQL không hỗ trợ `$1` cho câu `SET`, nên phải nối chuỗi tên
  role. An toàn vì `db_user` không phải input trực tiếp từ client — nó đến từ
  `app.staff.db_user` lúc login, lưu vào session phía server. Middleware vẫn
  whitelist bằng regex (`/^[a-z][a-z0-9_]*$/`) làm lớp phòng vệ cuối.
- **`app.staff` có `username`/`password_hash` (bcrypt) nhưng KHÔNG bật RLS.**
  Đây là mục tiêu thật của demo SQL Injection ở `/customers/search`: `app_user`
  vốn đã có `SELECT` trên toàn bảng `app.staff` để phục vụ chính luồng đăng
  nhập, nên UNION-based SQLi đọc được `password_hash` bất kể `SET ROLE` đang
  là chi nhánh nào — RLS trên `customers`/`orders`/`payments` không cứu được
  vì `staff` không nằm trong phạm vi của nó.
- **2 lỗ hổng cố ý — đừng "sửa cho sạch".** `/customers/search` (SQL
  Injection, nối chuỗi trực tiếp) và `/orders/:id` (IDOR, không kiểm tra
  branch_id) tồn tại có chủ đích để chứng minh RLS vẫn chặn được rò rỉ dù code
  app sai — xem "Lỗ hổng cố ý" trong `app/README.md`. Nếu vá chúng, phần demo
  defense-in-depth trong báo cáo mất luôn dẫn chứng thực nghiệm.
- **Không có `ENCRYPTION_KEY` trong `app/.env`.** `app/` chỉ gọi
  `app.encrypt_text()`/`app.decrypt_text()`/`app.blind_index()`, không bao giờ
  tự tay gọi `pgp_sym_encrypt`/`pgp_sym_decrypt` hay tự cầm khóa — khóa chỉ
  database đọc được, xem mục "Mã hóa (lớp 2)" ở trên.
- **`branch_id` khi tạo `customers`/`orders` lấy từ `req.session.staff`,
  không nhận từ body request.** RLS (`WITH CHECK`) là lớp chặn thứ hai nếu quy
  tắc này ở app bị sửa sai sau này, không phải lớp chặn duy nhất.

**Log.** `logging_collector = on` nên `docker compose logs postgres` gần như
trống — log thật ở `./logs/`, ghi song song `.csv` (yêu cầu của đề bài) và
`.json`. **Analyzer phải parse bản `.json`**: câu SQL trong CSV có thể chứa dấu
phẩy, dấu nháy và cả ký tự xuống dòng ngay trong trường `message`.
`log_timezone = 'Asia/Ho_Chi_Minh'` — rule "truy cập ngoài giờ hành chính" phụ
thuộc vào điều này.

**Cột `user` trong log LUÔN là `app_user`, không bao giờ là `nv_xxx`.** Đó là
*session user* (role đã xác thực), `SET ROLE` không đổi được nó. Muốn quy trách
nhiệm theo từng nhân viên, analyzer phải **bám theo `pid` của phiên**: gặp dòng
`AUDIT: ...,MISC,SET,,,SET ROLE nv_dn01;` thì mọi câu lệnh sau đó trong cùng
`pid` được quy cho `nv_dn01`, cho tới dòng `SET ROLE` kế tiếp hoặc
`disconnection`.

Chính vì vậy `pgaudit.log` **phải có class `misc_set`** — đừng gỡ để cho log
gọn. Class `role` chỉ bắt GRANT/REVOKE/CREATE ROLE, không bắt `SET ROLE`. Thiếu
`misc_set` thì log chỉ thấy "app_user đọc bảng customers" và lớp 3 mất hoàn
toàn khả năng quy trách nhiệm.

Lưu ý khi parse: khi client gửi nhiều câu trong một query string, dòng AUDIT
của **mỗi** câu đều chứa nguyên văn cả chuỗi. Nên lọc theo trường class
(`MISC,SET`, `READ,SELECT`...) chứ đừng tìm theo chuỗi câu lệnh.

**Thiếu `secrets/` thì init sẽ fail.** Lần chạy đầu trên một máy mới phải
`bash scripts/init-secrets.sh` trước (`scripts/reset.sh` đã tự gọi). Hàm đọc
khóa cố ý `RAISE EXCEPTION` kèm HINT thay vì im lặng dùng khóa mặc định.

**Không commit `.env`, `secrets/`, nội dung `logs/` và `backup/`.** Đã có trong
`.gitignore`. Kiểm tra trước khi commit:

```bash
git diff --cached --name-only | grep -E '^\.env$|^secrets/'   # phải không ra gì
```

## Nghiệm thu

Sau mỗi thay đổi ở `postgres/`:

```bash
bash scripts/reset.sh --yes    # nếu có sửa postgres/init/
bash scripts/verify.sh         # 21 phép thử, phải đạt hết
```

Thêm cơ chế bảo mật mới thì **thêm phép thử tương ứng vào `scripts/verify.sh`**
— nguyên tắc của repo này là mỗi lớp phải có một lệnh chạy ra kết quả nhìn
thấy được, không chỉ có code.

Báo kết quả thật: tiêu chí nào trượt thì nói rõ kèm output, đừng bỏ qua.
