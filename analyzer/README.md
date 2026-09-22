# `analyzer/` — Lớp 3: phát hiện bất thường từ log pgAudit

Đọc log JSON của PostgreSQL, quy trách nhiệm từng câu lệnh về đúng nhân viên,
áp các rule phát hiện, rồi ghi cảnh báo vào `audit.alerts`.

Chạy một lần rồi thoát. Muốn theo dõi liên tục thì gọi lại định kỳ — file trạng
thái bảo đảm không sinh cảnh báo trùng.

## Chạy

```bash
cd analyzer
npm install
cp .env.example .env          # sửa DB_PASSWORD cho khớp ANALYZER_PASSWORD trong .env gốc

node src/index.js --dry-run --all   # xem thử, không ghi database
node src/index.js                   # đọc phần log mới, ghi vào audit.alerts
```

| Cờ | Tác dụng |
|----|----------|
| `--dry-run` | chỉ in ra màn hình, không ghi `audit.alerts`, không lưu trạng thái |
| `--all` | bỏ qua file trạng thái, đọc lại toàn bộ log từ đầu |
| `--quiet` | chỉ in phần tổng kết |

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

## Bộ rule

| Rule | Điểm | Bắt cái gì |
|------|------|------------|
| `SQLI_UNION` | 90 | câu lệnh chứa `UNION ... SELECT` — dấu vết khai thác đọc sang bảng khác |
| `BULK_DECRYPT` | 70–95 | một câu lệnh giải mã ≥ `BULK_DECRYPT_THRESHOLD` bản ghi (điểm tăng theo khối lượng) |
| `SQLI_TAUTOLOGY` | 85 | điều kiện luôn đúng kiểu `OR 1=1`, `OR 'a'='a'` |
| `STAFF_CREDENTIAL_READ` | 75 | đọc `app.staff` (chứa `password_hash`) **từ phiên đã `SET ROLE`** |
| `SQLI_SCHEMA_PROBE` | 70 | truy vấn `pg_catalog` / `information_schema` từ phiên ứng dụng |
| `FULL_TABLE_READ` | 60 | `SELECT` trên bảng nhạy cảm mà không có `WHERE` |
| `AFTER_HOURS` | 40 | chạm dữ liệu ngoài 7h–19h hoặc cuối tuần |

Một câu lệnh có thể kích hoạt **nhiều rule cùng lúc**, và đó là chủ đích: một
câu `UNION SELECT` đọc `app.staff` lúc 2 giờ sáng sinh ra ba cảnh báo độc lập.
Ba góc nhìn cùng chỉ vào một hành vi là bằng chứng mạnh hơn một cảnh báo tổng
hợp mơ hồ.

### Vì sao `STAFF_CREDENTIAL_READ` không báo động giả lúc đăng nhập

`app_user` **buộc phải** có `SELECT` trên toàn bộ `app.staff` — chính luồng
đăng nhập cần đọc `password_hash` để so sánh bcrypt. Không thể phân biệt truy
cập hợp lệ với truy cập đáng ngờ bằng câu lệnh, nên rule phân biệt bằng **danh
tính lúc chạy**:

- Lúc đăng nhập, app chưa biết người dùng là ai nên **chưa** `SET ROLE` → bỏ qua.
- Sau khi đã `SET ROLE` sang `nv_xxx`, nhân viên không còn lý do gì để đọc bảng
  nhân viên nữa → cảnh báo.

Tức là dùng chính sự tách bạch giữa *session user* và *vai đã SET ROLE* mà lớp
1 tạo ra để phân loại hành vi — điều mà nhìn vào cột `user` của log thô không
bao giờ làm được.

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
  chứ không đo khối lượng thật. Ngoại lệ duy nhất là `BULK_DECRYPT` — đếm được
  vì mỗi bản ghi giải mã là một lời gọi hàm có thật trong log. Muốn đo chính
  xác hơn phải bổ sung nguồn khác (`pg_stat_statements`, hoặc ứng dụng tự ghi
  số dòng đã trả).
- **Không bắt được IDOR.** Lỗ hổng ở `/orders/:id` sinh ra một truy vấn hợp lệ
  hoàn toàn bình thường, chỉ khác ở *giá trị* `id`. Từ log không thể phân biệt
  "xem đơn hàng của mình" với "xem đơn hàng của người khác". Chặn IDOR là việc
  của RLS, không phải của analyzer — đây chính là minh họa vì sao cần nhiều lớp
  chứ không chỉ một lớp giám sát.
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
   │  logReader.js    đọc theo dòng (stream), bỏ qua phần đã xử lý
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

## Liên quan

- `postgres/init/04_grants.sql` — quyền của `analyzer_user`
- `postgres/conf/postgresql.conf` — `pgaudit.log`, `log_destination`, `log_timezone`
- `scripts/verify.sh` — mục `LOP 3b` (quyền) và `LOP 3c` (phát hiện)
- `CLAUDE.md` mục "Log" — vì sao phải đọc bản `.json` chứ không phải `.csv`
