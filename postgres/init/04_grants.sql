-- =============================================================================
-- 04_grants.sql  -  LỚP 1c: Phân quyền theo nguyên tắc đặc quyền tối thiểu
--
-- Mô hình WHITELIST: mặc định không ai có gì, quyền được cấp đích danh
-- từng bảng một.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Dọn quyền mặc định của PUBLIC
-- Từ PG15 thì `CREATE ON SCHEMA public` đã bị thu hồi sẵn, nhưng vẫn khai báo
-- tường minh: cluster nâng cấp từ bản cũ hơn sẽ không có mặc định này, và
-- câu lệnh cũng là bằng chứng kiểm thử cho đồ án.
-- -----------------------------------------------------------------------------
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL    ON SCHEMA app    FROM PUBLIC;
REVOKE ALL    ON SCHEMA audit  FROM PUBLIC;
REVOKE ALL    ON SCHEMA ext    FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- USAGE ON SCHEMA: điều kiện cần để chạm được tới bất kỳ object nào bên trong.
-- Không có USAGE thì dù có GRANT SELECT trên bảng cũng vẫn bị từ chối.
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA app TO app_user, readonly_user;

-- KHÔNG role nghiệp vụ nào có USAGE trên schema `ext`.
-- Nghĩa là app_user và nhân viên không gọi trực tiếp được pgp_sym_decrypt()
-- dù có đoán ra khóa. Mọi thao tác mã hóa phải đi qua ba hàm bọc sẵn trong
-- 05_crypto.sql - chúng là SECURITY DEFINER nên tự chạy dưới quyền db_owner.
-- Nhờ vậy mỗi lần giải mã là một lời gọi hàm có tên rõ ràng trong log pgAudit.
--
-- audit: không cấp cho ai ngoài db_owner. Role cho analyzer sẽ thêm ở bước 3.

-- =============================================================================
-- app_user
-- SELECT / INSERT / UPDATE trên đúng 3 bảng nghiệp vụ.
-- KHÔNG có DELETE  -> dữ liệu chỉ được đánh dấu hủy (orders.status), không bị
--                     xóa vật lý; kẻ tấn công chiếm được app_user cũng không
--                     phá hủy được dữ liệu.
-- KHÔNG có TRUNCATE -> chặn đường xóa hàng loạt vòng qua DELETE.
-- KHÔNG có DDL      -> đã bảo đảm bằng việc app_user không sở hữu object nào.
-- =============================================================================
GRANT SELECT, INSERT, UPDATE ON app.customers TO app_user;
GRANT SELECT, INSERT, UPDATE ON app.orders    TO app_user;
GRANT SELECT, INSERT, UPDATE ON app.payments  TO app_user;

-- Bảng tham chiếu: chỉ đọc
GRANT SELECT ON app.branches TO app_user;
GRANT SELECT ON app.staff    TO app_user;

-- INSERT vào cột BIGSERIAL cần USAGE trên sequence tương ứng.
-- Cấp USAGE (nextval/currval) chứ không cấp ALL (tránh setval - đặt lại bộ đếm
-- có thể gây trùng khóa chính).
GRANT USAGE ON SEQUENCE app.customers_id_seq TO app_user;
GRANT USAGE ON SEQUENCE app.orders_id_seq    TO app_user;
GRANT USAGE ON SEQUENCE app.payments_id_seq  TO app_user;

-- Quyền trên hàm mã hóa được cấp ở 05_crypto.sql, cùng chỗ với định nghĩa hàm
-- (app.encrypt_text / app.decrypt_text / app.blind_index).

-- =============================================================================
-- staff_role  (các role nv_* kế thừa quyền từ đây)
--
-- Quyền trên bảng giống hệt app_user. Khác biệt nằm ở chỗ khác: nhờ SET ROLE
-- mà current_user là nv_xxx, nên policy RLS ở 06_rls.sql mới lọc được theo
-- chi nhánh, và pgAudit mới ghi được đúng tên nhân viên.
-- =============================================================================
GRANT USAGE ON SCHEMA app TO staff_role;

GRANT SELECT, INSERT, UPDATE ON app.customers TO staff_role;
GRANT SELECT, INSERT, UPDATE ON app.orders    TO staff_role;
GRANT SELECT, INSERT, UPDATE ON app.payments  TO staff_role;
GRANT SELECT ON app.branches TO staff_role;
GRANT SELECT ON app.staff    TO staff_role;

GRANT USAGE ON SEQUENCE app.customers_id_seq TO staff_role;
GRANT USAGE ON SEQUENCE app.orders_id_seq    TO staff_role;
GRANT USAGE ON SEQUENCE app.payments_id_seq  TO staff_role;

ALTER DEFAULT PRIVILEGES FOR ROLE db_owner IN SCHEMA app
    GRANT USAGE ON SEQUENCES TO staff_role;

-- =============================================================================
-- readonly_user
-- Chỉ SELECT trên customers và orders (theo đặc tả). Không đụng được payments
-- - nơi chứa card_token - và không đụng được audit.alerts.
-- Role này còn bị ép default_transaction_read_only = on ở 02_roles.sh, nên kể
-- cả khi ai đó lỡ GRANT nhầm quyền ghi thì giao dịch vẫn bị từ chối.
-- =============================================================================
-- Phân quyền ở mức CỘT, không phải mức bảng.
-- readonly_user thậm chí không đọc được cột `cccd` (ciphertext) lẫn
-- `cccd_hash` (blind index). Đây là lớp phòng thủ nằm TRƯỚC cả mã hóa: dữ
-- liệu tốt nhất là dữ liệu mà role đó không chạm tới được, kể cả ở dạng đã
-- mã hóa. Hệ quả: `SELECT * FROM app.customers` sẽ bị từ chối với role này,
-- phải liệt kê cột - đó là chủ đích.
GRANT SELECT (id, branch_id, full_name, phone, email, created_at, updated_at)
    ON app.customers TO readonly_user;

GRANT SELECT ON app.orders TO readonly_user;

-- =============================================================================
-- admin_user
-- KHÔNG cấp quyền trực tiếp trên bảng. Muốn thao tác thì `SET ROLE db_owner`.
-- Lý do: mọi hành động quản trị đều đi qua một lần chuyển vai rõ ràng, và
-- pgaudit.log = '...role...' ghi lại được bước chuyển đó.
-- =============================================================================

-- =============================================================================
-- DEFAULT PRIVILEGES
-- CỐ Ý chỉ áp cho SEQUENCES, KHÔNG áp cho TABLES.
-- Nếu đặt default privileges cho TABLES thì mọi bảng tạo ra về sau sẽ TỰ ĐỘNG
-- được cấp quyền - đúng thứ mà mô hình whitelist cần tránh. Đổi lại, thêm bảng
-- mới thì phải khai báo GRANT ở ngay khối trên; đó là chủ đích.
-- =============================================================================
ALTER DEFAULT PRIVILEGES FOR ROLE db_owner IN SCHEMA app
    GRANT USAGE ON SEQUENCES TO app_user;
