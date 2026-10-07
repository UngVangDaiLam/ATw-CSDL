# `analyzer/` — Lớp 3: phát hiện bất thường từ log pgAudit

Đọc log JSON của PostgreSQL, quy trách nhiệm từng câu lệnh về đúng nhân viên,
áp các rule phát hiện, rồi ghi cảnh báo vào `audit.alerts`.

Hai chế độ: chạy một lần rồi thoát (batch), hoặc theo dõi liên tục (`--watch`)
để cảnh báo hiện trên dashboard mà không ai phải gõ lệnh. Cả hai dùng chung rule
và file trạng thái, chuyển qua lại không sinh cảnh báo trùng.

## Chạy

Mặc định chạy trong Docker ở chế độ `--watch` (service `analyzer` của
`docker-compose.yml`): log mount **chỉ đọc**, user `node` đọc được nhờ nhóm 999
(xem CLAUDE.md "Bẫy 9"), trạng thái ở `analyzer/state/` dùng chung với bản
chạy tay trên host. `docker compose logs -f analyzer` để xem.

Chạy tay trên host:

```bash
cd analyzer
npm install
cp .env.example .env          # sửa DB_PASSWORD cho khớp ANALYZER_PASSWORD trong .env gốc

node src/index.js --dry-run --all   # xem thử, không ghi database
node src/index.js                   # đọc phần log mới, ghi vào audit.alerts
node src/index.js --watch           # theo dõi liên tục, Ctrl+C để dừng
```

| Cờ | Tác dụng |
|----|----------|
| `--dry-run` | chỉ in ra màn hình, không ghi `audit.alerts`, không lưu trạng thái |
| `--all` | bỏ qua file trạng thái, đọc lại toàn bộ log từ đầu |
| `--quiet` | không in chi tiết từng cảnh báo |
| `--watch` | theo dõi liên tục, xem mục bên dưới |
| `--interval=<ms>` | chu kỳ đọc của `--watch` (mặc định 2000, hoặc `WATCH_INTERVAL_MS`) |
| `--since="YYYY-MM-DD HH:MM:SS"` | chỉ xét log từ thời điểm đó (giờ VN), bỏ qua file trạng thái. **Bắt buộc kèm `--dry-run`** — dành cho `verify.sh` |
| `--replay-after="YYYY-MM-DD HH:MM:SS"` | **ghi bù** cảnh báo cho các câu lệnh SAU thời điểm đó, rồi đặt vị trí đọc về cuối log. `pitr_restore.sh` tự gọi sau khi khôi phục — xem bên dưới |

Mã thoát: `0` xong, `1` lỗi, `3` = đang có `--watch` chạy nên lần batch này
**nhường, không ghi** (xem "Không chạy song song" bên dưới).

## Chế độ theo dõi liên tục (`--watch`)

Cảnh báo vào `audit.alerts` sau **1–4 giây** kể từ lúc hành vi xảy ra (đo thật:
`UNION SELECT` ~1 giây; giải mã hàng loạt 2.001 bản ghi ~4 giây, vì phải chờ một
nhịp im lặng để chắc đã gom đủ các dòng lồng nhau).

**Không phải "gọi lại batch mỗi 2 giây"** — làm vậy sẽ sai:

- **Mất danh tính.** Mỗi lần chạy batch tạo `SessionTracker` mới, quên mất
  `SET ROLE` của lần trước. Ranh giới hai lần đọc rơi vào giữa `SET LOCAL ROLE
  nv_hn01` và câu `SELECT` ngay sau nó là câu đó bị quy cho `app_user`. Watch
  giữ **một** tracker suốt tiến trình.
- **Tách đôi câu lệnh.** Batch `flushAll()` ở cuối file — cắt ngang một câu
  đang ghi dở thì đếm trùng, hoặc chia đôi số bản ghi bị giải mã và
  `BULK_DECRYPT` bỏ sót. Watch chỉ coi một câu là xong khi phiên đó **không có
  dòng mới nào trong cả một nhịp** (`sessions.js` `flushIdle()`).
- **Quét lại cả file.** `logReader.js` bỏ qua phần đã đọc bằng cách đếm dòng từ
  đầu file (có file 26 MB). Watch nhớ vị trí **byte** và chỉ đọc phần mới
  (`tail.js`).

**Lưu trạng thái an toàn.** Chỉ lưu khi mọi cảnh báo đã ghi xong, và không lưu
vượt qua dòng đầu của câu lệnh còn đang gom dở. File được ghi ra file tạm rồi
đổi tên, nên dừng giữa chừng cũng không làm hỏng nó. Bị kill đột ngột thì lần
sau đọc lại một đoạn — có thể trùng vài cảnh báo, không bao giờ mất (cùng
nguyên tắc với batch: thà trùng còn hơn sót).

**Database chết thì không chết theo.** Cảnh báo được giữ trong hàng đợi, thử
lại mỗi nhịp, ghi đúng một lần khi DB sống lại. Lỗi chỉ in một lần, không spam.
Đã thử: restart PostgreSQL khi đang giữ kết nối mở, và tắt hẳn DB ngay sau một
lần tấn công — không mất, không trùng. PostgreSQL tạo file log mới sau mỗi lần
khởi động lại; watch tự chuyển sang file đó.

**Không chạy song song với batch.** Watch giữ vị trí đọc trong bộ nhớ, batch
đọc từ file trạng thái — chạy cùng lúc thì cả hai xử lý một đoạn log và **ghi
trùng** (đã tái hiện: một câu `UNION` ra 6 cảnh báo thay vì 3). Watch ghi PID
vào `.analyzer-state.json.watch.lock`; batch thấy watch còn sống thì thoát mã
`3` mà không ghi. `gen-alerts.sh` và `demo-attack.sh` hiểu mã này và chờ watch
tự ghi. Watch thứ hai cũng bị từ chối. Watch bị kill cưỡng bức thì file khóa
còn đó nhưng PID đã chết → tự coi như bỏ, không ai phải xóa tay. `--dry-run`
không ghi gì nên vẫn chạy được.

`verify.sh` dùng `--dry-run --since=<mốc lấy từ database>` thay vì đọc tiếp
từ file trạng thái: nếu không, một watch đang chạy có thể đã lưu vị trí vượt
qua các câu tấn công mà verify vừa tạo, và dry-run không thấy gì.

**Sau PITR: ghi bù bằng `--replay-after`.** PITR quay lui cả `audit.alerts`,
nhưng file trạng thái (ngoài DB) vẫn ghi là "đã xử lý" — cảnh báo của các sự
kiện sau mốc khôi phục mất hẳn dù log còn nguyên. `pitr_restore.sh` tạm dừng
analyzer, khôi phục, lấy `thoi_diem` lớn nhất trong các cảnh báo **còn lại**
(superuser đọc), rồi gọi `--replay-after` với mốc đó: sự kiện tới mốc đã có
cảnh báo, sự kiện sau mốc (so sánh nghiêm ngặt) thì chưa. Đã thử: 12 cảnh báo
bị quay lui được ghi lại đúng, không trùng dòng nào. Giới hạn: một câu lệnh
đang gom dở có thể được ghi sau câu mới hơn của phiên khác (lệch tối đa một
nhịp ~2 s); mốc khôi phục rơi đúng vào khe đó thì câu cũ hơn có thể bị sót.

Lọc theo thời gian (`--since`, `--replay-after`) làm ở cấp **câu lệnh**, không
ở cấp dòng log: mọi dòng vẫn qua `SessionTracker`, nếu không dòng `SET ROLE`
nằm ngay trước mốc bị bỏ và câu sau mốc bị quy nhầm cho `app_user`.

**Giới hạn:** vai đã `SET ROLE` của một phiên chỉ nằm trong bộ nhớ. Khởi động
lại watch giữa chừng một phiên đang mở thì các câu sau đó của phiên ấy bị quy
cho session user tới lần `SET ROLE` kế tiếp. Với `app/` mỗi request đều `SET
LOCAL ROLE` lại nên lệch tối đa một request.

Đọc cảnh báo đã ghi (cần superuser — `analyzer_user` không có `SELECT`):

```bash
docker compose exec postgres psql -U postgres -d secdb -c \
  "SELECT db_user, rule_triggered, risk_score, detail->>'mo_ta' FROM audit.alerts ORDER BY id DESC LIMIT 10;"
```

## Hai vấn đề phải giải trước khi viết được rule nào

### 1. Cột `user` trong log luôn là `app_user`

App dùng **một** connection pool (`app_user`) rồi `SET LOCAL ROLE nv_xxx` cho
từng request. `user` trong log là *session user* — danh tính đã xác thực lúc
bắt tay — nên `SET ROLE` không đổi được nó. Nhìn log thô thì mọi hành động đều
là "app_user", không quy được trách nhiệm cho ai.

Cách gỡ: bám theo từng **phiên**. Gặp dòng `MISC,SET` chứa `SET [LOCAL] ROLE
nv_dn01` thì mọi câu lệnh sau đó trong cùng phiên được tính cho `nv_dn01`, cho
tới dòng `SET ROLE` kế tiếp hoặc khi phiên đóng. Đây cũng là lý do
`pgaudit.log` **phải** có class `misc_set`: class `role` chỉ bắt
GRANT/REVOKE/CREATE ROLE, không bắt `SET ROLE`.

Khóa để gom phiên là `session_id`, **không phải `pid`**. Hệ điều hành cấp phát
lại pid sau khi backend kết thúc, nên hai phiên cách nhau vài phút hoàn toàn có
thể mang cùng pid — và khi đó danh tính của phiên trước rỉ sang phiên sau, đúng
kiểu lỗi mà `SET LOCAL ROLE` ở tầng app đã cất công tránh. `session_id` của
PostgreSQL là `<hex thời điểm mở phiên>.<hex pid>` nên duy nhất theo thời gian.
pid vẫn được giữ trong `detail` để đối chiếu với log thô.

### 2. Một câu lệnh sinh ra rất nhiều dòng log

Lần seed 6000 khách hàng để lại **47.017 dòng** `READ,SELECT` trong log. Gần
như toàn bộ là *thân hàm* `app.encrypt_text()` / `app.blind_index()`: đó là các
hàm SQL `SECURITY DEFINER`, và pgAudit ghi lại từng lời gọi như một câu lệnh
lồng nhau.

Phân biệt bằng trường `substatement_id`:

| Giá trị | Ý nghĩa |
|---------|---------|
| `= 1` | câu lệnh **client** gửi lên |
| `> 1` | câu lồng nhau bên trong (thân hàm) |

Các dòng lồng nhau không bị vứt đi mà được **đếm**: số lần thân hàm có chứa
`pgp_sym_decrypt` trong phạm vi một câu lệnh chính là **số bản ghi đã bị giải
mã**. Đó là cách rule `BULK_DECRYPT` biết được khối lượng thật thay vì phải
đoán qua hình dạng câu lệnh.

Ngoài ra `pgaudit.log_relation = on` khiến câu lệnh chạm 2 bảng sinh ra 2 dòng
cùng `statement_id` — cũng phải gom lại, nếu không sẽ đếm trùng.

**pgAudit tự giấu một phần câu lồng nhau.** Câu lồng nhau **có chạm bảng**
bên trong hàm `SECURITY DEFINER` chỉ được ghi khi *session user* là thành viên
của chủ hàm. Với phiên `app_user` thì thân `app.branch_of()` (đọc `app.staff`)
không bao giờ xuất hiện, trong khi phiên superuser qua socket thì có — thử
bằng `psql -U postgres` sẽ thấy log khác hẳn log của app. Câu lồng nhau
**không** chạm bảng (thân `app.decrypt_text()`) thì luôn được ghi. Mọi dấu
vết analyzer cần từ bên trong hàm đều phải nằm ở loại câu thứ hai.

### Mạo danh vai — `IDENTITY_WITHOUT_SESSION`

`app_user` là thành viên mọi `nv_*`, nên `SET ROLE nv_dn01` trong log **không**
chứng minh nv_dn01 đang làm việc. RLS đòi thêm token phiên đăng nhập của chính
nhân viên đó (`postgres/init/06_rls.sql`); thiếu thì `app.current_branch_id()`
trả NULL và `RAISE LOG 'SECDB_IDENTITY_WITHOUT_SESSION role=<current_user>
ly_do=<...>'` — dòng chỉ vào log server, người gọi không thấy.

`sessions.js` gắn dòng đó vào câu lệnh đang gom (nó xuất hiện sau các dòng
AUDIT của chính câu đó). Với ba lý do mạo danh, vai của phiên thành **vai mạo
danh** cho tới lần đổi vai kế tiếp: mọi cảnh báo trong khoảng đó quy cho
**session user** (`app_user`), tên vai vào `detail.vai_khong_co_phien` — không
đổ lỗi cho nhân viên bị mạo danh.

| `ly_do` | Điểm | Nghĩa | Coi là mạo danh? |
|---|---|---|---|
| `token_cua_nguoi_khac` | 95 | token hợp lệ nhưng của nhân viên khác | có |
| `khong_co_token`, `token_khong_ton_tai` | 90 | không có / token đoán bừa / đã thu hồi khi đăng xuất | có |
| `nhan_vien_bi_khoa` | 70 | nhân viên đã bị khóa vẫn dùng token cũ | không — vẫn quy cho nhân viên |
| `token_het_han` | 50 | quá 12 giờ (app bắt đăng nhập lại trước mốc này) | không |

Ba điều kiện để tin một dòng như vậy — mỗi điều có phép thử trong `verify.sh`:

1. `context` bắt đầu `PL/pgSQL function current_branch_id() `. Khối `DO` tự
   `RAISE LOG` mang `inline_code_block`; hàm trùng tên trong `pg_temp` không
   tạo được vì PUBLIC không có quyền `TEMP`.
2. `role` trong dòng LOG **trùng** vai analyzer đang thấy phiên mang. Lệch thì
   bỏ — không được dùng dòng đó để đổi người chịu trách nhiệm.
3. Hàm ghi LOG lấy `current_user`, **không nhận tên role từ ngoài**. Bản đầu
   tiên để `app.branch_of(role, token)` — hàm ai cũng gọi được với tên role
   tùy ý — tự ghi LOG: ai cũng sinh được cảnh báo "nv_hcm01 bị mạo danh", và
   một nhân viên có token chèn `branch_of('nv_dn01', ...)` vào câu SQL của
   mình là đẩy được trách nhiệm sang `app_user`.

### Bản ghi mồi (honeytoken) — `HONEYTOKEN_ACCESS`

Sáu khách hàng giả (2 mỗi chi nhánh, `07_seed.sql` PHẦN C) trông y hệt khách
thật — tên, điện thoại, email nối tiếp dãy số, có đơn hàng. Ciphertext CCCD
của họ được băm vào `audit.honeytokens`, bảng mà **không role nào ngoài
`db_owner`** đọc được (kể cả `analyzer_user`).

`app.decrypt_text()` tra mỗi ciphertext trong bảng đó; trúng thì gọi
`audit.honeytoken_tripped()` — hàm trả nguyên plaintext nhưng thân của nó
(`SELECT p_plain AS honeytoken_tripwire`) thành một dòng lồng nhau trong log.
`sessions.js` đếm các dòng **lồng nhau** chứa dấu mốc đó (`HONEYTOKEN_MARKER`).
Chỉ xét `substatement_id > 1`: kẻ tấn công viết `honeytoken_tripwire` vào câu
SQL của mình thì nó nằm ở substatement 1 và không được đếm.

Khác mọi rule còn lại: không ngưỡng, không đoán theo hình dạng câu lệnh. Rút
**từng** hồ sơ một qua endpoint hợp lệ (mỗi request 1 bản ghi — `BULK_DECRYPT`
không bao giờ thấy) vẫn bị bắt ngay lần chạm mồi đầu tiên. Bằng chứng nằm ở
`demo-attack.sh` bước 4c.

## Bộ rule

| Rule | Điểm | Bắt cái gì |
|------|------|------------|
| `IDENTITY_WITHOUT_SESSION` | 50–95 | `SET ROLE` sang vai nhân viên mà **không có token phiên** của người đó (RLS trả 0 dòng); quy cho session user — mục "Mạo danh vai" |
| `HONEYTOKEN_ACCESS` | 98 | giải mã CCCD của **bản ghi mồi** — dù chỉ một dòng, dù quyền hợp lệ (mục "Bản ghi mồi" ở trên) |
| `SQLI_UNION` | 90 | câu lệnh chứa `UNION ... SELECT` — dấu vết khai thác đọc sang bảng khác |
| `BULK_DECRYPT` | 70–95 | một câu lệnh giải mã ≥ `BULK_DECRYPT_THRESHOLD` bản ghi (điểm tăng theo khối lượng) |
| `SQLI_TAUTOLOGY` | 85 | điều kiện luôn đúng kiểu `OR 1=1`, `OR 'a'='a'` |
| `PRIVILEGE_ESCALATION` | 75–95 | leo thang đặc quyền / gỡ lớp bảo vệ bằng câu lệnh hợp lệ (class `ROLE`/`DDL`), kể cả lần thử bị từ chối — chi tiết bên dưới |
| `ACCESS_DENIED` | 65–85 | câu lệnh bị PostgreSQL **từ chối quyền** (SQLSTATE `42501`); 85 nếu nhắm vào `password_hash` / `app.staff` |
| `STAFF_CREDENTIAL_READ` | 75 | đọc `app.staff` **từ phiên đã `SET ROLE`** |
| `SQLI_SCHEMA_PROBE` | 70 | truy vấn `pg_catalog` / `information_schema` từ phiên ứng dụng |
| `FULL_TABLE_READ` | 60 | `SELECT` trên bảng nhạy cảm mà không có `WHERE` |
| `AFTER_HOURS` | 40 | chạm dữ liệu ngoài 7h–19h hoặc cuối tuần |
| `LOGIN_BRUTE_FORCE` | 80–90 | **tầng web:** đăng nhập sai tới mức bị khóa tạm (90 nếu khóa cả IP) |
| `CSRF_BLOCKED` | 50–70 | **tầng web:** request ghi bị chặn vì gửi dạng form (70) hoặc thiếu/sai CSRF token (50) |

### Hai rule cuối đến từ tầng web, không từ log pgAudit

Ở tầng database, một lần đăng nhập sai trông y hệt lần đăng nhập đúng (cùng
câu `SELECT` trên `app.staff`), còn request CSRF bị chặn thì không tới DB. Vì
vậy `app/src/securityLog.js` ghi các sự kiện này ra `logs/app/security-*.jsonl`
và `src/appEvents.js` biến chúng thành cảnh báo. Cảnh báo mang `db_user = web`
(chưa xác định được nhân viên). App **không** được ghi thẳng vào
`audit.alerts`: `app_user` cố ý không có quyền gì trên schema `audit`.

Nội dung file là **dữ liệu không tin cậy** — app bị chiếm thì ghi được bất cứ
gì: kiểm tra kiểu từng trường, cắt ngắn, che chuỗi số dài, sự kiện lạ bị bỏ
qua. Giới hạn: app bị chiếm cũng có thể im lặng hoặc ghi sự kiện giả — nguồn
này bổ sung cho log pgAudit, không thay thế.

Một câu lệnh có thể kích hoạt **nhiều rule cùng lúc**, và đó là chủ đích: một
câu `UNION SELECT` đọc `app.staff` lúc 2 giờ sáng sinh ra ba cảnh báo độc lập.
Ba góc nhìn cùng chỉ vào một hành vi là bằng chứng mạnh hơn một cảnh báo tổng
hợp mơ hồ.

### `ACCESS_DENIED` — tấn công bị chặn vẫn phải nhìn thấy được

Không role nghiệp vụ nào đọc được `app.staff.password_hash` (quyền mức cột,
`postgres/init/04_grants.sql`), nên SQLi `UNION SELECT password_hash ...` bị
PostgreSQL từ chối. Nhưng **pgAudit không ghi dòng AUDIT nào cho câu bị từ chối
quyền**: PostgreSQL kiểm tra quyền trước khi gọi hook của pgAudit. Trong log chỉ
còn một dòng `ERROR` có `state_code = 42501` kèm nguyên văn câu lệnh (đã kiểm
chứng). Chỉ đọc dòng AUDIT thì mọi lần tấn công bị lớp 1 chặn đều vô hình với
lớp 3.

`sessions.js` vì vậy bắt riêng dòng `ERROR` + `42501` và phát ra một sự kiện
câu lệnh `class = 'DENIED'`. Vai vẫn lấy từ phiên (`SET ROLE` trước đó), nên
cảnh báo quy về đúng `nv_xxx`. `SQLI_*` cũng xét class này: khai thác thất bại
vẫn là khai thác.

Rule này cũng bắt cả các phép thử âm của `verify.sh` (`DROP TABLE`, `DELETE`…
bằng `app_user`) — đúng, đó là những lần thử thật bị từ chối.

### `PRIVILEGE_ESCALATION` — tài khoản quản trị bị chiếm

`admin_user` và `db_owner` đăng nhập được qua TCP. `admin_user` không phải
superuser, nhưng `SET ROLE db_owner` là thành chủ sở hữu mọi bảng — và chủ sở
hữu **có quyền** tắt RLS, xóa policy, `GRANT` cho `PUBLIC`, tạo hàm `SECURITY
DEFINER`. Lớp 1 không chặn được vì đó là câu lệnh hợp lệ; chỉ lớp 3 nhìn thấy.
pgAudit đã ghi chúng nhờ class `role` + `ddl` trong `pgaudit.log`.

| Hành vi | Điểm | Nhận diện (theo `command` + câu lệnh) |
|---|---|---|
| Thuộc tính role nguy hiểm | 95 | `ALTER/CREATE ROLE ... SUPERUSER / CREATEROLE / CREATEDB / BYPASSRLS / REPLICATION` |
| Đổi cấu hình pgAudit | 95 | `SET` / `ALTER SYSTEM` / `ALTER ROLE` / `ALTER DATABASE` chạm `pgaudit.*` |
| Cấp role thành viên | 90 | `GRANT <role> TO ...` (command `GRANT ROLE`) |
| Tắt RLS | 90 | `ALTER TABLE ... DISABLE / NO FORCE ROW LEVEL SECURITY` |
| Xóa/sửa policy | 85 | `DROP POLICY`, `ALTER POLICY` |
| Cấp quyền cho PUBLIC | 85 | `GRANT ... TO PUBLIC` |
| Hàm `SECURITY DEFINER` | 80 | `CREATE/ALTER FUNCTION/PROCEDURE ... SECURITY DEFINER` |
| Default privileges cho bảng | 75 | `ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES` (repo cố ý tránh) |

Mỗi mẫu gắn với `command` của chính dòng log, không chỉ tìm chuỗi — client gửi
nhiều câu trong một chuỗi thì dòng AUDIT của mọi câu đều chứa cả chuỗi.

Lần **thử** vượt quyền hạn (`ALTER ROLE admin_user SUPERUSER` của một role
không phải superuser) bị PostgreSQL từ chối, không có dòng AUDIT — đi vào qua
nhánh `DENIED` giống `ACCESS_DENIED`, `mo_ta` ghi thêm `(BI TU CHOI)`.

Giới hạn:
- Phiên qua unix socket (superuser trong container) bị bỏ qua theo
  `IGNORE_LOCAL_SOCKET`. Ai có shell trong container database đã ra ngoài mô
  hình này.
- Quy trách nhiệm dựa trên `SET ROLE` như mọi rule khác: dùng `SET LOCAL ROLE`
  mà không `RESET ROLE` sau `ROLLBACK`/`COMMIT` thì câu kế tiếp trong cùng phiên
  vẫn bị quy cho vai cũ (pgAudit không ghi `COMMIT`). Cột `session_user` của
  cảnh báo vẫn là role đã đăng nhập thật (`admin_user`).

### Vì sao `STAFF_CREDENTIAL_READ` không báo động giả lúc đăng nhập

Đăng nhập không còn đọc `app.staff` trực tiếp: nó gọi
`app.verify_staff_login($1, $2)` và việc đọc bảng nằm trong thân hàm
(`substatement_id > 1`), không tính vào `relations`. Nhưng `app_user` vẫn có
`SELECT` trên các cột không nhạy cảm của `app.staff`, và một lần đọc bảng nhân
viên vẫn có thể hợp lệ hay đáng ngờ tùy ngữ cảnh. Rule phân biệt bằng **danh
tính lúc chạy**:

- Lúc đăng nhập, app chưa biết người dùng là ai nên **chưa** `SET ROLE` → bỏ qua.
- Sau khi đã `SET ROLE` sang `nv_xxx`, nhân viên không còn lý do gì để đọc bảng
  nhân viên nữa → cảnh báo.

Tức là dùng chính sự tách bạch giữa *session user* và *vai đã SET ROLE* mà lớp
1 tạo ra để phân loại hành vi — điều mà nhìn vào cột `user` của log thô không
bao giờ làm được.

**Điều kiện để lập luận trên đúng: app phải `RESET ROLE` sau mỗi request.**
`app/` dùng `SET LOCAL ROLE`, tự hết hiệu lực khi `COMMIT` — nhưng pgAudit
**không ghi `COMMIT`**, nên analyzer không biết vai đã hết. Connection pool lại
tái sử dụng kết nối: request của `nv_hn01` xong, cùng kết nối đó phục vụ lượt
đăng nhập của `dn01` (đọc `app.staff`, không `SET ROLE`) → analyzer vẫn tưởng
vai `nv_hn01` còn hiệu lực → **cảnh báo `STAFF_CREDENTIAL_READ` 75 điểm giả,
gán nhầm người**. Đã tái hiện được lỗi này qua app thật.

Cách sửa: `app/src/middleware/setRole.js` gọi `RESET ROLE` sau mỗi
`COMMIT`/`ROLLBACK`. Câu đó không đổi gì trong database (vai đã hết từ trước)
nhưng vào log, là mốc để analyzer trả vai. Lưu ý pgAudit ghi nó thành
**`MISC,RESET`**, không phải `MISC,SET` — `sessions.js` phải nhận cả hai, thiếu
là lỗi vẫn nguyên mà không có dấu hiệu gì. `verify.sh` có cặp phép thử: một
phép **đối chứng** (thiếu `RESET ROLE` → gán nhầm thật, chứng minh phép thử
không vô nghĩa) và một phép thử chính (có `RESET ROLE` → không gán nhầm).

## Cảnh báo không được chứa dữ liệu thật

`pgaudit.log_parameter = off` nên tham số của prepared statement không bị ghi.
Nhưng giá trị viết **thẳng** vào câu SQL thì vẫn nằm nguyên trong log:

```sql
SELECT full_name FROM app.customers WHERE cccd_hash = app.blind_index('001201000001');
```

Nếu chép nguyên câu lệnh vào `audit.alerts` thì lớp 2 bị thủng ngay tại lớp 3:
số CCCD vốn được mã hóa kỹ trong `app.customers` lại nằm rõ trong
`audit.alerts` — một bảng không hề được mã hóa. Vì vậy `src/redact.js` thay mọi
chuỗi ≥ 9 chữ số liên tiếp bằng thẻ đánh dấu trước khi ghi. `scripts/verify.sh`
có phép thử riêng cho việc này.

## Quyền: chỉ `INSERT`, không `SELECT`

`analyzer_user` có đúng một động từ trên đúng một bảng
(`postgres/init/04_grants.sql`). Hai hệ quả khi sửa code:

1. **Không dùng `RETURNING id`** — `RETURNING` đọc giá trị cột nên đòi quyền
   `SELECT` trên cột đó. Muốn xác nhận đã ghi thì `RETURNING` một hằng số.
2. **Không thể truy vấn bảng để lọc cảnh báo trùng** — đó là lý do analyzer tự
   ghi nhớ vị trí đã đọc bằng `.analyzer-state.json` thay vì hỏi lại database.

Đổi lại được tính chất quan trọng hơn: `audit.alerts` là **append-only** kể cả
với chính tiến trình sinh ra nó. Chiếm được `analyzer_user` cũng không đọc được
đã phát hiện những gì, và không xóa được bằng chứng.

## Giới hạn đã biết

Ghi rõ trong báo cáo, đừng để người chấm tự phát hiện:

- **Không đo được số dòng trả về.** pgAudit ghi *câu lệnh*, không ghi số bản
  ghi. `FULL_TABLE_READ` vì vậy đo **hình dạng** câu lệnh (không có `WHERE`)
  chứ không đo khối lượng thật. Ngoại lệ là `BULK_DECRYPT` và
  `HONEYTOKEN_ACCESS` — đếm được vì mỗi bản ghi giải mã là một lời gọi hàm có
  thật trong log. Muốn đo chính
  xác hơn phải bổ sung nguồn khác (`pg_stat_statements`, hoặc ứng dụng tự ghi
  số dòng đã trả).
- **Không bắt được IDOR.** Lỗ hổng ở `/orders/:id` sinh ra một truy vấn hợp lệ
  hoàn toàn bình thường, chỉ khác ở *giá trị* `id`. Từ log không thể phân biệt
  "xem đơn hàng của mình" với "xem đơn hàng của người khác". Chặn IDOR là việc
  của RLS, không phải của analyzer — đây chính là minh họa vì sao cần nhiều lớp
  chứ không chỉ một lớp giám sát.
- **Bản ghi mồi chỉ bắt được kẻ giải mã.** Đọc các cột không mã hóa (tên,
  điện thoại) của khách mồi, hay sao chép ciphertext ra ngoài để giải mã nơi
  khác (cần khóa — đã nằm ngoài mô hình) đều không chạm bẫy. Ai đọc được
  `audit.honeytokens` (superuser, `admin_user` qua `SET ROLE db_owner`) biết
  mồi nằm đâu. Nhân viên thật lỡ mở hồ sơ một khách mồi cũng sinh cảnh báo —
  chấp nhận được vì đó là người họ không phục vụ.
- **`AFTER_HOURS` ồn.** Nó đánh dấu cả hành vi hợp lệ của người làm ngoài giờ.
  Điểm rủi ro để thấp (40) vì nó được thiết kế để **cộng dồn** với rule khác,
  không phải để dùng một mình.
- **Bỏ qua phiên qua unix socket** (`IGNORE_LOCAL_SOCKET=true`). Đó là đường của
  superuser và của script khởi tạo. Đặt `false` để soi cả hoạt động quản trị,
  nhưng lưu ý riêng lần seed đã để lại ~47.000 dòng log.
- **Phụ thuộc `log_timezone`.** Giờ được đọc thẳng từ chuỗi timestamp trong log
  (cố ý không dùng `new Date()` để khỏi bị múi giờ của máy chạy analyzer làm
  lệch). Đổi `log_timezone` trong `postgresql.conf` là đổi luôn ý nghĩa của
  `AFTER_HOURS`.

## Luồng xử lý

```
logs/*.json
   │  logReader.js    batch: đọc theo dòng (stream), bỏ qua phần đã xử lý
   │  tail.js         watch: đọc tăng dần theo vị trí byte, chỉ phần mới ghi
   ▼
auditLine.js          tách trường CSV bên trong `message` của pgAudit
   │
   ▼
sessions.js           gom dòng → câu lệnh; bám session_id để quy trách nhiệm
   │                  (lọc substatement_id > 1, đếm số lần giải mã)
   ▼
rules/*.js            mỗi rule soi một góc, một câu lệnh có thể trúng nhiều rule
   │
   ▼
redact.js             che dữ liệu nhạy cảm trong câu lệnh
   │
   ▼
alerts.js             INSERT vào audit.alerts bằng analyzer_user
```

`index.js` là điểm vào (batch), `watch.js` là vòng lặp của `--watch`;
`pipeline.js` chứa phần hai chế độ dùng chung (đánh giá rule, in, đọc/ghi
trạng thái) để một rule sửa ở chế độ này không lặng lẽ khác ở chế độ kia.

## Liên quan

- `postgres/init/04_grants.sql` — quyền của `analyzer_user`
- `postgres/conf/postgresql.conf` — `pgaudit.log`, `log_destination`, `log_timezone`
- `scripts/verify.sh` — mục `LOP 3b` (quyền) và `LOP 3c` (phát hiện)
- `CLAUDE.md` mục "Log" — vì sao phải đọc bản `.json` chứ không phải `.csv`
