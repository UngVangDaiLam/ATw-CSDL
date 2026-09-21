# Tuần 1 — Ghi chú nghiên cứu: pgcrypto, pgAudit, Row-Level Security

Mục này dùng cho phần "nghiên cứu" của báo cáo. Đây là bản tóm tắt để hiểu và trình bày lại bằng lời
của nhóm — không nên copy nguyên văn vào báo cáo.

## 1. pgcrypto

`pgcrypto` là extension chính thức của PostgreSQL cung cấp các hàm mã hóa/băm chạy ngay trong database:
băm mật khẩu (`crypt`, `gen_salt`), mã hóa đối xứng (`pgp_sym_encrypt` / `pgp_sym_decrypt`), mã hóa bất
đối xứng bằng khóa PGP (`pgp_pub_encrypt` / `pgp_pub_decrypt`), và các hàm băm/HMAC thông thường.

Đồ án dùng `pgp_sym_encrypt(plaintext, key)` để mã hóa cột `cccd` và `so_the`. Đây là mã hóa **ở tầng
cột** (column-level): chỉ giá trị trong cột đó bị mã hóa, các cột khác trong cùng bảng vẫn đọc được
bình thường. Điểm mấu chốt cần nhớ khi trình bày: **khóa giải mã không được lưu trong database** — nếu
lưu trong database thì kẻ tấn công dump được database là có luôn khóa, mã hóa trở nên vô nghĩa. Khóa sẽ
nằm ở biến môi trường của service `app` (xem lại từ Tuần 5).

Đánh đổi cần nêu trong báo cáo: một cột đã mã hóa bằng `pgp_sym_encrypt` không thể đánh index để tìm
kiếm hiệu quả (`WHERE cccd = ...` sẽ phải giải mã từng dòng, hoặc không tìm được), và không thể lọc theo
khoảng giá trị. Đây là lý do chỉ mã hóa cột thực sự nhạy cảm, không mã hóa toàn bộ bảng.

## 2. pgAudit

`pgAudit` là extension mã nguồn mở ghi log chi tiết các câu lệnh SQL chạy trên database — chi tiết hơn
nhiều so với log mặc định của PostgreSQL (`log_statement`). Nó phải được nạp qua tham số khởi động
`shared_preload_libraries` (không bật được bằng `ALTER SYSTEM` sau khi server đã chạy, vì đây là tham
số chỉ đọc lúc PostgreSQL khởi động tiến trình).

Các mức log chính:
- `read` — câu lệnh SELECT/COPY đọc dữ liệu
- `write` — INSERT/UPDATE/DELETE
- `ddl` — CREATE/ALTER/DROP
- `role` — thay đổi quyền, tạo/xóa user

Đồ án bật `write, ddl, role` mặc định (không bật `read` toàn bộ ngay từ đầu vì lưu lượng log sẽ rất lớn
khi có traffic thật — đây là điểm cần cân nhắc và nêu trong báo cáo ở phần "chi phí audit"). Việc bật
`read` có chọn lọc theo bảng nhạy cảm sẽ được cấu hình ở Tuần 6 khi xây analyzer, thay vì bật toàn bộ.

Log của pgAudit là **nguồn dữ liệu chính cho analyzer tự viết** (Tuần 6), không phải bảng `audit_log`
trong schema — bảng đó chỉ ghi một số sự kiện ở tầng ứng dụng.

## 3. Row-Level Security (RLS)

RLS là cơ chế của PostgreSQL cho phép định nghĩa **policy** quyết định một câu lệnh SELECT/UPDATE/DELETE
được nhìn thấy/tác động lên những dòng nào, dựa trên điều kiện do người quản trị định nghĩa — hoàn toàn
độc lập với việc ứng dụng có kiểm tra quyền đúng hay không.

Cơ chế cơ bản:
1. `ALTER TABLE customers ENABLE ROW LEVEL SECURITY;`
2. Tạo policy, ví dụ: chỉ cho thấy dòng có `branch_id` khớp với một session variable:
   ```sql
   CREATE POLICY branch_isolation ON customers
       USING (branch_id = current_setting('app.branch_id')::int);
   ```
3. Ứng dụng, sau khi xác thực nhân viên, chạy `SET app.branch_id = '<branch của nhân viên đó>'` trên
   đúng connection sẽ dùng để truy vấn.

Điểm cần lưu ý kỹ thuật (sẽ xử lý chi tiết ở Tuần 4): nếu ứng dụng dùng **connection pool** (rất phổ
biến với thư viện `pg` của Node.js), một connection có thể được nhiều nhân viên khác nhau dùng lại theo
thời gian. Nếu dùng `SET app.branch_id = ...` thông thường mà không cẩn thận, giá trị có thể bị "dính"
từ request trước sang request sau. Cách an toàn là dùng `SET LOCAL` bên trong một transaction cho mỗi
request, để giá trị tự động hết hiệu lực khi transaction kết thúc.

RLS mặc định áp dụng cho mọi user thường; **chủ sở hữu bảng (table owner) và superuser bỏ qua RLS** trừ
khi bảng được `FORCE ROW LEVEL SECURITY`. Đây chính là lý do đồ án nhấn mạnh app tuyệt đối không được
kết nối bằng superuser hay bằng chính user sở hữu bảng — nếu không RLS coi như vô hiệu.

## Tài liệu gốc để trích dẫn trong báo cáo

- PostgreSQL Documentation — Row Security Policies: phần "CREATE POLICY" và "Row Security Policies"
  trong chương DDL của tài liệu chính thức PostgreSQL 16.
- PostgreSQL Documentation — pgcrypto (chương Additional Supplied Modules).
- pgAudit — README chính thức của dự án trên GitHub (pgaudit/pgaudit), phần cấu hình `pgaudit.log`.
