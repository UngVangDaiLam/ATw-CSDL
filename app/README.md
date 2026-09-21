# app/

Backend Express demo, kết nối PostgreSQL bằng `app_user` rồi `SET LOCAL ROLE
nv_xxx` cho từng request (mô hình định danh ở `postgres/init/06_rls.sql` và
CLAUDE.md mục "RLS"). Cố ý còn 2 lỗ hổng ở tầng ứng dụng để chứng minh các lớp
bảo vệ ở tầng database (RLS, whitelist bảng, mã hóa cột) vẫn chặn được ngay cả
khi code app có lỗi — xem "Lỗ hổng cố ý" bên dưới.

## Chạy

```bash
cd app
npm install
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
npm run dev                # http://localhost:3000
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
curl http://localhost:3000/health
# current_user phải là "app_user", KHÔNG phải "postgres" hay "db_owner"
```

## Tài khoản demo (từ `07_seed.sql`)

| username | password      | db_user (role CSDL) | chi nhánh |
|----------|---------------|----------------------|-----------|
| `hn01`   | `Demo@123456` | `nv_hn01`            | Hà Nội |
| `dn01`   | `Demo@123456` | `nv_dn01`            | Đà Nẵng |
| `hcm01`  | `Demo@123456` | `nv_hcm01`           | Hồ Chí Minh |

```bash
curl -c cookies.txt -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"hn01","password":"Demo@123456"}'

curl -b cookies.txt http://localhost:3000/customers
```

## Endpoint

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/health` | không cần đăng nhập |
| POST | `/auth/login` | `{ username, password }` |
| GET | `/auth/me` | ai đang đăng nhập |
| POST | `/auth/logout` | |
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
  "http://localhost:3000/customers/search?name=x' UNION SELECT id, username, password_hash, db_user, branch_id FROM app.staff -- -"
```

Khai thác thành công vì `app.staff` **không bật RLS** (chỉ `customers` /
`orders` / `payments` mới `FORCE ROW LEVEL SECURITY`), và `app_user` vốn có
`SELECT` trên toàn bộ bảng đó để phục vụ chính luồng đăng nhập
(`postgres/init/04_grants.sql`). Kết quả: đọc được `password_hash` (bcrypt,
không phải plaintext) của cả 3 chi nhánh, bất kể người tấn công đã `SET ROLE`
sang chi nhánh nào.

Điểm cần nêu trong báo cáo: RLS không thay thế parameterized query — nó chỉ là
lớp phòng thủ bổ sung, và chỉ áp dụng cho các bảng đã khai báo policy.

### 2. IDOR — `GET /orders/:id`

Không kiểm tra đơn hàng có thuộc chi nhánh của người đang đăng nhập hay
không. Trước khi có RLS, dò tuần tự `id` sẽ đọc được đơn hàng của chi nhánh
khác. Với RLS đã bật (`branch_isolation` policy trên `app.orders`), cùng một
đoạn code này tự động trả `404` cho `id` không thuộc chi nhánh hiện tại —
không phải vì code đã sửa, mà vì tầng database lọc mất dòng đó trước khi app
kịp đọc:

```bash
# Đăng nhập hn01, thử đọc 1 đơn hàng KHÔNG thuộc chi nhánh Hà Nội
curl -b cookies.txt http://localhost:3000/orders/3   # -> 404, không phải 200 kèm dữ liệu
```

## Không có `ENCRYPTION_KEY` trong `.env`

Khác với thiết kế thường gặp (app đọc khóa rồi tự gọi `pgp_sym_encrypt`/
`pgp_sym_decrypt`), ở đây khóa **không bao giờ rời khỏi database**: nằm trong
Docker secret, chỉ `ext.master_key()`/`ext.index_pepper()` (SECURITY DEFINER,
chỉ `db_owner` gọi được) đọc tới. `app/` chỉ gọi ba hàm bọc sẵn
`app.encrypt_text()` / `app.decrypt_text()` / `app.blind_index()` — xem
`postgres/init/05_crypto.sql`. Nhờ vậy `app_user` không có `USAGE` trên schema
`ext` cũng đủ để không role nào gọi thẳng `pgp_sym_decrypt()` được, kể cả nếu
đoán ra khóa.
