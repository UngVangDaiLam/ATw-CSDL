-- =============================================================================
-- 06_rls.sql  -  LỚP 1d: Row-Level Security
--
-- Ba lớp trước lọc theo BẢNG ("ai được đụng vào customers"). RLS lọc theo
-- DÒNG ("được thấy những khách hàng nào trong đó"). Trục phân tách là
-- branch_id: nhân viên chỉ thấy dữ liệu chi nhánh mình.
--
-- Mô hình định danh: ứng dụng kết nối bằng app_user (một pool duy nhất) rồi
-- `SET ROLE nv_xxx` ở đầu mỗi request. current_user khi đó là nv_xxx, nên
-- policy tra được chi nhánh qua app.staff.db_user.
-- =============================================================================

SET ROLE db_owner;
SET search_path = app, audit, ext, public;

-- -----------------------------------------------------------------------------
-- Hàm tra chi nhánh. Cố ý tách làm HAI hàm - đây không phải chia nhỏ cho vui.
--
-- BẪY: bên trong một hàm SECURITY DEFINER, `current_user` trả về CHỦ SỞ HỮU
-- HÀM chứ không phải người gọi. Viết gộp thành một hàm SECURITY DEFINER dùng
-- `WHERE db_user = current_user` thì nó luôn so với 'db_owner', không bao giờ
-- khớp, và MỌI role đều đọc ra 0 dòng. Triệu chứng nhìn hệt như "RLS chặn
-- đúng", nên rất dễ tưởng là đã xong.
--
--   app.branch_of(text)      SECURITY DEFINER - chạy dưới quyền db_owner nên
--                            đọc được app.staff mà người gọi không cần quyền
--                            SELECT trên bảng đó.
--   app.current_branch_id()  SECURITY INVOKER (mặc định) - giữ đúng danh tính
--                            người gọi, lấy current_user rồi truyền sang.
--
-- STABLE: policy được gọi trên TỪNG DÒNG. Không có STABLE thì Postgres gọi
-- lại hàm cho mỗi dòng thay vì cache trong một câu lệnh.
--
-- SET search_path: BẮT BUỘC với mọi SECURITY DEFINER. Thiếu nó, kẻ tấn công
-- tạo được một bảng tên `staff` ở schema đứng trước trong search_path là
-- chiếm được quyền db_owner.
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.branch_of(p_db_user text) RETURNS int
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = app, pg_catalog
AS $$
    SELECT branch_id
    FROM   app.staff
    WHERE  db_user = p_db_user
      AND  is_active
    LIMIT  1;
$$;

CREATE FUNCTION app.current_branch_id() RETURNS int
    LANGUAGE sql
    STABLE
    SET search_path = app, pg_catalog
AS $$
    SELECT app.branch_of(current_user::text);
$$;

REVOKE ALL ON FUNCTION app.branch_of(text)        FROM PUBLIC;
REVOKE ALL ON FUNCTION app.current_branch_id()    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.branch_of(text)     TO staff_role, app_user, readonly_user;
GRANT EXECUTE ON FUNCTION app.current_branch_id() TO staff_role, app_user, readonly_user;

-- -----------------------------------------------------------------------------
-- Bật RLS.
--
-- ENABLE: áp policy cho mọi role KHÔNG phải chủ sở hữu bảng.
-- FORCE : áp cho cả chủ sở hữu (db_owner). Mặc định owner bỏ qua toàn bộ
--         policy - đây là hiểu lầm phổ biến nhất về RLS, và là lý do nhiều
--         người test bằng owner rồi kết luận "RLS không chạy".
--
-- Hệ quả của FORCE ở đây là CỐ Ý: db_owner không có policy nào nên đọc ra
-- 0 dòng. Tức là người quản trị CSDL không đọc được dữ liệu khách hàng -
-- một dạng phân tách nhiệm vụ (separation of duties). db_owner vẫn làm được
-- DDL bình thường vì RLS chỉ chi phối DML.
--
-- Cần thao tác dữ liệu ở mức quản trị thì dùng superuser qua socket:
--   docker compose exec postgres psql -U postgres -d secdb
-- Superuser bỏ qua RLS. Đó cũng là lý do 07_seed.sql chạy bằng postgres chứ
-- không SET ROLE db_owner như 03_schema.sql.
-- -----------------------------------------------------------------------------
ALTER TABLE app.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customers FORCE  ROW LEVEL SECURITY;

ALTER TABLE app.orders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.orders    FORCE  ROW LEVEL SECURITY;

ALTER TABLE app.payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payments  FORCE  ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Policy phân tách theo chi nhánh.
--
-- USING      -> lọc dòng ĐỌC được (SELECT, và dòng nào được UPDATE/DELETE nhìn thấy)
-- WITH CHECK -> chặn dòng GHI vào (INSERT, và giá trị SAU khi UPDATE)
--
-- Thiếu WITH CHECK là lỗ hổng phổ biến nhất của RLS: nhân viên Hà Nội vẫn
-- đọc đúng dữ liệu của mình, nhưng UPDATE được branch_id sang 2 để đẩy khách
-- hàng sang chi nhánh khác, hoặc INSERT thẳng dữ liệu vào chi nhánh khác.
--
-- app_user nằm trong danh sách TO nhưng KHÔNG có dòng nào trong app.staff,
-- nên app.current_branch_id() trả NULL và `branch_id = NULL` cho ra NULL -
-- không phải TRUE - tức app_user đọc ra 0 dòng. Đây là chủ đích: chiếm được
-- mật khẩu app_user vẫn chưa lấy được dữ liệu, còn phải SET ROLE, mà SET ROLE
-- thì bị pgAudit ghi lại.
--
-- VÌ SAO `(SELECT app.current_branch_id())` CHỨ KHÔNG GỌI HÀM TRỰC TIẾP:
-- Gọi thẳng thì khi planner dùng được index trên branch_id, hàm chạy 1 lần
-- (Index Cond); nhưng khi planner chọn đường khác - vd. quét theo khóa chính
-- cho `ORDER BY id LIMIT 100` - điều kiện RLS thành `Filter` và hàm chạy LẠI
-- CHO TỪNG DÒNG. Mỗi lần là một truy vấn vào app.staff qua hàm SECURITY
-- DEFINER (không inline được), và mỗi truy vấn đó còn sinh thêm một dòng log
-- pgAudit. Bọc trong subquery biến nó thành InitPlan: tính đúng MỘT lần cho
-- mỗi câu lệnh. Ngữ nghĩa không đổi vì current_user cố định trong suốt một
-- câu lệnh. Số đo trước/sau: docs/benchmark-results.md.
-- -----------------------------------------------------------------------------
CREATE POLICY branch_isolation ON app.customers
    FOR ALL
    TO staff_role, app_user, readonly_user
    USING      (branch_id = (SELECT app.current_branch_id()))
    WITH CHECK (branch_id = (SELECT app.current_branch_id()));

CREATE POLICY branch_isolation ON app.orders
    FOR ALL
    TO staff_role, app_user, readonly_user
    USING      (branch_id = (SELECT app.current_branch_id()))
    WITH CHECK (branch_id = (SELECT app.current_branch_id()));

CREATE POLICY branch_isolation ON app.payments
    FOR ALL
    TO staff_role, app_user, readonly_user
    USING      (branch_id = (SELECT app.current_branch_id()))
    WITH CHECK (branch_id = (SELECT app.current_branch_id()));

RESET ROLE;

-- =============================================================================
-- GHI CHÚ CHO BƯỚC SAU
--
-- Trong app/ (Express), mỗi request phải:
--     BEGIN;
--     SET LOCAL ROLE nv_hn01;      -- SET LOCAL: tự hết hiệu lực khi COMMIT
--     ... truy vấn ...
--     COMMIT;
--
-- Dùng SET LOCAL ROLE trong transaction thay vì SET ROLE trần. Lý do: với
-- connection pool, quên RESET ROLE là request kế tiếp mượn lại connection đó
-- sẽ chạy dưới danh tính của người trước - lỗ hổng nghiêm trọng và rất khó
-- phát hiện vì nó chỉ xuất hiện khi pool tái sử dụng connection.
--
-- Giới hạn đã biết của mô hình này: app_user là thành viên của cả ba role
-- nv_*, nên chiếm được app_user thì SET ROLE sang chi nhánh nào cũng được.
-- Không thể loại bỏ hoàn toàn nếu vẫn muốn dùng một pool chung. Giảm thiểu:
-- mọi lần SET ROLE đều nằm trong log pgAudit, và analyzer ở lớp 3 sẽ bắt mẫu
-- bất thường (một phiên đổi vai nhiều lần, đổi vai ngoài giờ làm việc...).
-- =============================================================================
