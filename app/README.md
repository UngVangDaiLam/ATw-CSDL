# app/

Backend Express demo, kết nối PostgreSQL bằng `app_user` rồi `SET LOCAL ROLE
nv_xxx` cho từng request, kèm **token phiên đăng nhập** của nhân viên đó
(mô hình định danh ở `postgres/init/06_rls.sql` và CLAUDE.md mục "RLS").
Token do `app.verify_staff_login()` cấp lúc đăng nhập, nằm trong session phía
server (`req.session.dbToken`, KHÔNG trong `req.session.staff` vì đối tượng đó
trả về client), gắn vào transaction bằng `set_config('secdb.staff_token', $1,
true)` ở `middleware/setRole.js`, thu hồi bằng `app.end_staff_session()` khi
đăng xuất. Thiếu token thì RLS trả 0 dòng. Cố ý còn 2 lỗ hổng ở tầng ứng dụng để chứng minh các lớp
bảo vệ ở tầng database (RLS, whitelist bảng, mã hóa cột) vẫn chặn được ngay cả
khi code app có lỗi — xem "Lỗ hổng cố ý" bên dưới.

## Chạy

Mặc định chạy trong Docker (service `app`, http://127.0.0.1:3000, IP `.20`
trên dbnet), cấu hình từ `.env` gốc qua `docker-compose.yml`. Chạy tay khi đang
sửa code — **`docker compose stop app` trước**, nếu không sẽ có hai tiến trình
cùng cổng 3000 và request đi nhầm (CLAUDE.md "Bẫy 8"):

```bash
cd app
npm install
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
npm run dev                # http://127.0.0.1:3000
```

**`DB_PASSWORD` trong `app/.env` phải khớp `APP_USER_PASSWORD` trong `.env` ở
thư mục gốc** — `.env.example` chỉ để giá trị mẫu (`doi_mat_khau_nay_3`), sai
mật khẩu thì `/health` báo `password authentication failed for user
"app_user"` chứ không phải lỗi kết nối.

Yêu cầu DB đã chạy (`docker compose up -d` ở thư mục gốc) và đã seed dữ liệu
(`postgres/init/07_seed.sql` chạy tự động lúc khởi tạo volume — xem README gốc
mục "Chạy").

Kiểm tra kết nối đúng role:

```bash
curl http://127.0.0.1:3000/health
# current_user phải là "app_user", KHÔNG phải "postgres" hay "db_owner"
```

## Giao diện web

Mở http://127.0.0.1:3000. Mã nguồn ở `web/` (React + Vite), build ra `public/`
và do chính Express phục vụ — **cùng origin với API**, điều kiện để cookie
`SameSite=Strict` và CSRF token hoạt động mà không cần bật CORS. Điều hướng
bằng hash (`#/customers`, `#/orders`) vì API đã chiếm `/customers`, `/orders`.

```bash
npm run build      # build lại public/ (Docker tự build trong image)
npm run dev:web    # sửa giao diện: http://127.0.0.1:5173, API chuyển sang :3000
```

| Trang | Gọi API |
|---|---|
| Đăng nhập (nút điền nhanh 3 tài khoản demo) | `GET /auth/csrf`, `POST /auth/login` |
| Khách hàng: danh sách 50 dòng/trang | `GET /customers` |
| Khách hàng: ô "Tìm theo tên" | `GET /customers/search?name=` |
| Khách hàng: bấm một dòng → chi tiết, có CCCD đã giải mã | `GET /customers/:id` |
| Khách hàng: "Thêm khách hàng" | `POST /customers` |
| Đơn hàng: danh sách | `GET /orders` |
| Đơn hàng: ô "Tra mã đơn" | `GET /orders/:id` |
| Đơn hàng: "Tạo đơn hàng" | `POST /orders` |

Giao diện gọi đúng các endpoint trong bảng "Endpoint" bên dưới, kể cả 2
endpoint có lỗ hổng cố ý — nên các thí nghiệm ở mục "Lỗ hổng cố ý" làm được
ngay trên giao diện, không chỉ bằng `curl`. Mọi dữ liệu từ API được hiển thị
dưới dạng văn bản (text node của React), không render HTML.

Đã kiểm thử trên Edge thật (điều khiển qua DevTools Protocol): đăng nhập sai và
đúng, xem danh sách và chi tiết, tìm kiếm, thêm khách hàng (POST qua CSRF
token), tra đơn chi nhánh khác (RLS trả 404), đăng xuất — ở chế độ sáng, tối và
màn hình điện thoại. Không có vi phạm CSP hay lỗi JavaScript nào. Client giữ CSRF token
trong bộ nhớ trang (không cất vào `localStorage`), lấy token mới sau khi đăng
nhập, và tự lấy lại một lần nếu gặp `403`. Cookie phiên `HttpOnly` nên
JavaScript của trang không đọc được — và không cần đọc.

## Tài khoản demo (từ `07_seed.sql`)

| username | password      | db_user (role CSDL) | chi nhánh |
|----------|---------------|----------------------|-----------|
| `hn01`   | `Demo@123456` | `nv_hn01`            | Hà Nội |
| `dn01`   | `Demo@123456` | `nv_dn01`            | Đà Nẵng |
| `hcm01`  | `Demo@123456` | `nv_hcm01`           | Hồ Chí Minh |

Dùng `127.0.0.1`, không dùng `localhost` (CLAUDE.md "Bẫy 8"). Mọi request ghi
dữ liệu, kể cả đăng nhập, phải mang CSRF token — lấy trước qua `/auth/csrf`:

```bash
TOKEN=$(curl -s -c cookies.txt -b cookies.txt http://127.0.0.1:3000/auth/csrf \
        | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)

curl -c cookies.txt -b cookies.txt -X POST http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $TOKEN" \
  -d '{"username":"hn01","password":"Demo@123456"}'
# phản hồi có csrfToken MỚI (phiên mới) - dùng nó cho các POST sau

curl -b cookies.txt http://127.0.0.1:3000/customers
```

## Endpoint

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/health` | không cần đăng nhập |
| GET | `/auth/csrf` | lấy CSRF token cho phiên hiện tại (tạo phiên nếu chưa có) |
| POST | `/auth/login` | `{ username, password }` + header `X-CSRF-Token`; trả về token mới |
| GET | `/auth/me` | ai đang đăng nhập |
| POST | `/auth/logout` | + header `X-CSRF-Token` |
| GET | `/customers` | parameterized, RLS tự lọc theo chi nhánh |
| GET | `/customers/search?name=...` | **CỐ Ý dính SQL Injection** — xem bên dưới |
| GET | `/customers/:id` | giải mã `cccd` qua `app.decrypt_text()` |
| POST | `/customers` | `branch_id` lấy từ session, không nhận từ body |
| GET | `/orders` | parameterized, RLS tự lọc theo chi nhánh |
| GET | `/orders/:id` | **CỐ Ý không kiểm tra quyền (IDOR)** — xem bên dưới |
| POST | `/orders` | `branch_id` lấy từ session, không nhận từ body |

## Lỗ hổng cố ý

Hai endpoint dưới đây **cố tình** không an toàn ở tầng code, để chứng minh mô
hình *defense-in-depth*: lớp RLS + whitelist bảng ở tầng database (đã xong,
xem CLAUDE.md) vẫn chặn được rò rỉ ngay cả khi tầng ứng dụng có lỗi kinh điển.
Không sao chép cách viết này vào code thật.

### 1. SQL Injection — `GET /customers/search?name=...`

Nối chuỗi SQL trực tiếp thay vì tham số hóa:

```bash
curl -b cookies.txt \
  "http://127.0.0.1:3000/customers/search?name=x' UNION SELECT id, username, password_hash, db_user, branch_id FROM app.staff -- -"
```

Kết quả: **`500 permission denied for table staff`**. Lỗ hổng trong code vẫn
còn nguyên (câu `UNION` chạy tới database), nhưng PostgreSQL từ chối cả câu.

`app.staff` **không bật RLS** (chỉ `customers` / `orders` / `payments` mới
`FORCE ROW LEVEL SECURITY`), nên RLS không cứu được bảng này. Chốt chặn là
**quyền mức cột** (`postgres/init/04_grants.sql`): `app_user` và `staff_role`
chỉ được `SELECT` các cột khác `password_hash`. Đăng nhập không cần đọc hash:
`routes/auth.js` gọi `app.verify_staff_login($1, $2)` (`05_crypto.sql`), hàm
`SECURITY DEFINER` tự so bằng `crypt()` của pgcrypto và chỉ trả về nhân viên khi
đúng mật khẩu. Hash không bao giờ rời khỏi database, kể cả tới chính app.

**Trước/sau (cho báo cáo):** trước khi có quyền mức cột, payload trên đọc được
`password_hash` (bcrypt) của cả 3 chi nhánh, bất kể người tấn công đã `SET ROLE`
sang chi nhánh nào — bằng chứng rằng RLS chỉ bảo vệ các bảng có khai báo policy.

Còn lại: SQLi vẫn đọc được các cột không nhạy cảm của `app.staff` (`username`,
`db_user`). RLS và phân quyền không thay thế được parameterized query — chúng là
các lớp bổ sung khi code sai.

Lớp 3 vẫn thấy lần tấn công bị chặn: câu lệnh bị từ chối quyền không có dòng
AUDIT, nhưng có dòng `ERROR` (SQLSTATE `42501`) trong log; analyzer đọc nó và
sinh `ACCESS_DENIED` + `SQLI_UNION`, quy về đúng nhân viên.

### 2. IDOR — `GET /orders/:id`

Không kiểm tra đơn hàng có thuộc chi nhánh của người đang đăng nhập hay
không. Trước khi có RLS, dò tuần tự `id` sẽ đọc được đơn hàng của chi nhánh
khác. Với RLS đã bật (`branch_isolation` policy trên `app.orders`), cùng một
đoạn code này tự động trả `404` cho `id` không thuộc chi nhánh hiện tại —
không phải vì code đã sửa, mà vì tầng database lọc mất dòng đó trước khi app
kịp đọc:

```bash
# Đăng nhập hn01, thử đọc 1 đơn hàng KHÔNG thuộc chi nhánh Hà Nội
curl -b cookies.txt http://127.0.0.1:3000/orders/3   # -> 404, không phải 200 kèm dữ liệu
```

## Khóa ký cookie phiên (`SESSION_SECRET`)

Ai biết khóa này thì tự ký được cookie phiên hợp lệ. Bản gốc có giá trị mặc
định viết thẳng trong code: thiếu cấu hình là app vẫn chạy, với một khóa ai
cũng đọc được trên GitHub. Giờ `src/sessionSecret.js` **từ chối khởi động** nếu
khóa thiếu, là giá trị mẫu, hoặc ngắn hơn 32 ký tự.

- **Trong Docker:** Docker secret `secrets/session_secret` (sinh bởi
  `scripts/init-secrets.sh`), app đọc qua `SESSION_SECRET_FILE`. Không dùng
  biến môi trường vì `docker inspect` đọc được.
- **Chạy tay trên host:** `SESSION_SECRET` trong `app/.env`, sinh bằng
  `openssl rand -hex 32`.

`verify.sh` thử cả hai: app từ chối giá trị mẫu, và khóa không nằm trong biến
môi trường của container.

## Header bảo mật và cookie phiên

`src/httpHeaders.js` gắn cho mọi phản hồi:

| Header | Để làm gì |
|---|---|
| `Content-Security-Policy` | chỉ chạy script của chính app, không script inline; `frame-ancestors 'none'` chặn nhúng trang vào iframe (clickjacking) |
| `X-Content-Type-Options: nosniff` | trình duyệt không đoán kiểu nội dung (vd. coi JSON là HTML) |
| `X-Frame-Options: DENY` | bản cũ của `frame-ancestors` |
| `Referrer-Policy: no-referrer` | không lộ đường dẫn (có thể chứa `?name=...`) sang trang khác |
| `Cache-Control: no-store` | trên `/auth`, `/customers`, `/orders`: không lưu bản sao dữ liệu khách hàng |

Bỏ `X-Powered-By` (không quảng cáo Express). Body JSON tối đa 10 KB.

Cookie phiên tên `secdb.sid` (thay `connect.sid` mặc định): `HttpOnly`
(JavaScript trên trang không đọc được — XSS không lấy được phiên),
`SameSite=Strict` (không đi theo request từ trang khác), hết hạn sau 30 phút
không hoạt động, `Secure` khi đặt `COOKIE_SECURE=true` (cần HTTPS thật). Đăng
nhập thành công thì **cấp mã phiên mới** (chống session fixation); đăng xuất
xóa phiên phía server và xóa cookie.

### Chống CSRF (`src/csrf.js`)

`SameSite=Strict` đã chặn cookie đi theo request từ trang khác trên trình duyệt
hiện đại. Thêm hai lớp nữa cho trình duyệt cũ và cho trường hợp `SameSite` bị
nới về sau:

- **Synchronizer token:** token ngẫu nhiên lưu trong phiên phía server, client
  lấy qua `GET /auth/csrf` và gửi lại ở header `X-CSRF-Token` với mọi
  `POST`/`PUT`/`PATCH`/`DELETE`. Sai hoặc thiếu → `403`. Trang lạ không đọc
  được token (same-origin policy). Áp dụng cả cho `/auth/login` (chống login
  CSRF); đăng nhập xong nhận token mới, token cũ hết hiệu lực.
- **Chỉ nhận JSON:** request ghi không phải `application/json` → `415`. Form
  HTML — cách CSRF cổ điển — không gửi được JSON sang trang khác nếu không qua
  CORS preflight, mà app không bật CORS.

### Giới hạn đăng nhập sai (`src/loginLimiter.js`)

| Ngưỡng | Cửa sổ | Khi vượt |
|---|---|---|
| 5 lần sai cho một cặp (IP, username) | 15 phút | cặp đó bị khóa tới hết cửa sổ — `429` + `Retry-After` |
| 100 lần sai từ một IP (mọi username) | 15 phút | mọi đăng nhập từ IP đó bị khóa |

Chỉ đếm lần **sai**; đăng nhập đúng xóa bộ đếm của cặp đó. Đang bị khóa thì từ
chối ngay cả khi mật khẩu đúng — nếu không, phản hồi khác nhau vẫn cho biết
mật khẩu nào trúng. Username không phân biệt hoa thường.

Username không tồn tại cũng chạy `crypt()` (với một salt giả cùng cost
`$2a$06$`, bên trong `app.verify_staff_login()`) để thời gian phản hồi không
cho biết username nào có thật — đo trong database được ~3–4 ms cho cả hai
trường hợp.

Bộ đếm nằm trong bộ nhớ tiến trình: `docker compose restart app` là xóa hết.
Mỗi lần chạy `verify.sh` cộng 5 lần sai vào ngưỡng theo IP của máy host (với
một username ngẫu nhiên) — chạy liên tục hơn 20 lần trong 15 phút thì máy host
bị khóa đăng nhập; restart app để gỡ.

### Thông báo lỗi không lộ chi tiết nội bộ (`src/errors.js`)

Trước đây lỗi 500 trả nguyên thông báo của PostgreSQL (tên bảng, tên cột, tên
ràng buộc — đủ để vẽ lại sơ đồ CSDL), còn JSON hỏng thì Express trả **nguyên
stack trace** kèm đường dẫn `/app/node_modules/...`. Giờ:

| Trường hợp | Client nhận |
|---|---|
| Lỗi CSDL / lỗi không lường trước | `500` + `Loi may chu. Ma tham chieu: 46c0d919` |
| Body không phải JSON hợp lệ | `400` thông báo ngắn |
| Body quá 10 KB | `413` |
| Route không tồn tại | `404` JSON |

Chi tiết đầy đủ ghi vào log server cùng mã tham chiếu — tra bằng
`docker compose logs app | grep 46c0d919`. Image chạy với `NODE_ENV=production`
làm lớp chặn thứ hai. **Hai endpoint cố ý vẫn trả nguyên lỗi PostgreSQL** (giữ
đúng cách viết ban đầu).

### Sự kiện bảo mật lên dashboard (`src/securityLog.js`)

Bị khóa vì dò mật khẩu và request bị chặn vì CSRF không để lại dấu vết gì
trong log pgAudit. App ghi chúng ra `logs/app/security-YYYY-MM-DD.jsonl`
(không ghi mật khẩu; username cắt còn 64 ký tự); analyzer đọc **chỉ đọc** và
ghi cảnh báo `LOGIN_BRUTE_FORCE` / `CSRF_BLOCKED` bằng `analyzer_user` — hiện
trên dashboard sau 1–4 giây. App vẫn **không có quyền gì** trên `audit.alerts`.
Mỗi lần khóa chỉ ghi **một** sự kiện, không ghi lặp mỗi lần bị từ chối.

Không biện pháp nào ở đây vá được 2 lỗ hổng cố ý: SQLi là lỗi nối chuỗi trong
truy vấn, IDOR là thiếu kiểm tra quyền — không header hay cờ cookie nào chặn
được. Bảo vệ tầng web không thay được việc viết code đúng.

## Không có `ENCRYPTION_KEY` trong `.env`

Khác với thiết kế thường gặp (app đọc khóa rồi tự gọi `pgp_sym_encrypt`/
`pgp_sym_decrypt`), ở đây khóa **không bao giờ rời khỏi database**: nằm trong
Docker secret, chỉ `ext.master_key()`/`ext.index_pepper()` (SECURITY DEFINER,
chỉ `db_owner` gọi được) đọc tới. `app/` chỉ gọi ba hàm bọc sẵn
`app.encrypt_text()` / `app.decrypt_text()` / `app.blind_index()` — xem
`postgres/init/05_crypto.sql`. Nhờ vậy `app_user` không có `USAGE` trên schema
`ext` cũng đủ để không role nào gọi thẳng `pgp_sym_decrypt()` được, kể cả nếu
đoán ra khóa.
