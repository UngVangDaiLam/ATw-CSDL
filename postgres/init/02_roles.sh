#!/bin/bash
# =============================================================================
# 02_roles.sh  -  LỚP 1b: Tạo role
#
# Viết bằng .sh chứ không phải .sql vì psql KHÔNG đọc được biến môi trường
# trong file .sql thuần. Script này nhận mật khẩu từ environment (do
# docker-compose nạp từ .env) rồi truyền vào psql dưới dạng biến `-v`.
# Kết quả: không có mật khẩu nào bị hardcode trong repo.
#
# Vì sao dùng -v + :'var' mà không nội suy chuỗi trong bash:
# psql tự escape giá trị của :'var' thành string literal hợp lệ, nên mật khẩu
# chứa dấu nháy đơn cũng không làm hỏng câu lệnh (tránh SQL injection ngay
# trong chính script khởi tạo).
# =============================================================================
set -Eeuo pipefail

: "${DB_OWNER_PASSWORD:?DB_OWNER_PASSWORD chưa được set trong .env}"
: "${APP_USER_PASSWORD:?APP_USER_PASSWORD chưa được set trong .env}"
: "${READONLY_PASSWORD:?READONLY_PASSWORD chưa được set trong .env}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD chưa được set trong .env}"
: "${ANALYZER_PASSWORD:?ANALYZER_PASSWORD chưa được set trong .env}"

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname   "$POSTGRES_DB" \
     -v dbname="$POSTGRES_DB" \
     -v owner_pw="$DB_OWNER_PASSWORD" \
     -v app_pw="$APP_USER_PASSWORD" \
     -v ro_pw="$READONLY_PASSWORD" \
     -v admin_pw="$ADMIN_PASSWORD" \
     -v analyzer_pw="$ANALYZER_PASSWORD" <<-'EOSQL'

    -- =========================================================================
    -- ROLE SỞ HỮU
    -- Tách chủ sở hữu ra khỏi role mà ứng dụng dùng hằng ngày. Đây là điều kiện
    -- ĐỦ để app_user không thể DROP/ALTER bảng: owner của một object luôn có
    -- toàn quyền trên object đó bất kể GRANT/REVOKE, nên chỉ cần app_user
    -- không phải owner.
    -- NOINHERIT: quyền của role được GRANT vào phải kích hoạt bằng SET ROLE,
    -- không tự động có hiệu lực -> tránh leo thang quyền ngoài ý muốn.
    -- =========================================================================
    CREATE ROLE db_owner
        LOGIN PASSWORD :'owner_pw'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        CONNECTION LIMIT 5;

    -- =========================================================================
    -- ROLE ỨNG DỤNG - quyền hẹp nhất, dùng bởi backend Express ở bước sau
    -- =========================================================================
    CREATE ROLE app_user
        LOGIN PASSWORD :'app_pw'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        CONNECTION LIMIT 20;

    -- =========================================================================
    -- ROLE BÁO CÁO - chỉ đọc
    -- =========================================================================
    CREATE ROLE readonly_user
        LOGIN PASSWORD :'ro_pw'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        CONNECTION LIMIT 5;

    -- =========================================================================
    -- ROLE QUẢN TRỊ - KHÔNG phải superuser.
    -- Muốn làm DDL thì phải `SET ROLE db_owner`, thao tác đó để lại dấu vết
    -- trong log pgAudit (pgaudit.log có bật 'role').
    -- =========================================================================
    CREATE ROLE admin_user
        LOGIN PASSWORD :'admin_pw'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        CONNECTION LIMIT 5;

    GRANT db_owner TO admin_user;

    -- =========================================================================
    -- ROLE PHÂN TÍCH LOG - LỚP 3
    --
    -- Danh tính riêng cho analyzer/, KHÔNG dùng lại app_user. Lý do: bộ phân
    -- tích đọc log ở ngoài database rồi ghi cảnh báo vào audit.alerts, nên nó
    -- không có nhu cầu chạm vào một bảng nghiệp vụ nào. Cho nó dùng app_user
    -- là tự tay nới quyền của tiến trình phân tích lên bằng quyền của cả ứng
    -- dụng - hỏng đúng nguyên tắc đặc quyền tối thiểu mà lớp 1 đang chứng minh.
    --
    -- Quyền của role này hẹp tới mức CHỈ CÓ INSERT trên đúng một bảng
    -- (xem 04_grants.sql). Không SELECT, không UPDATE, không DELETE:
    --   - Không SELECT -> chiếm được analyzer_user cũng không đọc được mình đã
    --     bị phát hiện những gì. Analyzer tự nhớ vị trí đã đọc bằng offset file
    --     phía ngoài, không cần truy vấn ngược lại bảng.
    --   - Không UPDATE/DELETE -> bảng cảnh báo là APPEND-ONLY. Bằng chứng đã
    --     ghi thì không sửa hay xóa được, kể cả bởi chính tiến trình đã ghi nó.
    -- Vai trò ĐỌC alerts (cho dashboard ở bước 4) sẽ là một role khác nữa.
    -- =========================================================================
    CREATE ROLE analyzer_user
        LOGIN PASSWORD :'analyzer_pw'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        CONNECTION LIMIT 5;

    -- =========================================================================
    -- ROLE NHÂN VIÊN - trục định danh cho Row-Level Security
    --
    -- staff_role là role NHÓM: giữ toàn bộ quyền trên bảng, các role nhân viên
    -- kế thừa từ đây. Thêm nhân viên mới chỉ cần CREATE ROLE ... IN ROLE
    -- staff_role, không phải cấp lại quyền từng bảng.
    --
    -- Các role nv_* đều NOLOGIN. Đây là điểm quan trọng: chúng KHÔNG có mật
    -- khẩu và KHÔNG kết nối trực tiếp được, nên không có gì để đánh cắp.
    -- Ứng dụng kết nối bằng app_user (một connection pool duy nhất) rồi
    -- `SET ROLE nv_xxx` ở đầu mỗi request. SET ROLE hoạt động với cả role
    -- NOLOGIN.
    --
    -- Nhờ vậy current_user trả về đúng tên nhân viên, nên:
    --   - policy RLS lọc được theo chi nhánh của người đó
    --   - pgAudit ghi đúng ai làm gì (điều kiện sống còn cho analyzer ở lớp 3)
    -- =========================================================================
    CREATE ROLE staff_role NOLOGIN;

    CREATE ROLE nv_hn01  NOLOGIN IN ROLE staff_role;   -- chi nhánh Hà Nội
    CREATE ROLE nv_dn01  NOLOGIN IN ROLE staff_role;   -- chi nhánh Đà Nẵng
    CREATE ROLE nv_hcm01 NOLOGIN IN ROLE staff_role;   -- chi nhánh TP.HCM

    -- app_user được làm thành viên để SET ROLE sang từng nhân viên.
    -- app_user là NOINHERIT nên KHÔNG tự động có quyền của các role này -
    -- bắt buộc phải SET ROLE tường minh, và mỗi lần SET ROLE đều bị pgAudit
    -- ghi lại (pgaudit.log có bật 'role').
    GRANT nv_hn01, nv_dn01, nv_hcm01 TO app_user;

    -- Không cần ALTER ROLE ... SET search_path cho các role nv_*: tham số gắn
    -- theo role chỉ áp dụng khi role đó ĐĂNG NHẬP, còn SET ROLE không nạp lại
    -- chúng. search_path của phiên vẫn là của app_user (đã set ở trên).

    -- =========================================================================
    -- SCHEMA
    -- app   : bảng nghiệp vụ
    -- audit : bảng cảnh báo do analyzer ghi. Để RIÊNG schema nhằm đảm bảo
    --         app_user (nếu bị chiếm) không đọc/sửa/xóa được bằng chứng.
    -- ext   : extension (đã tạo ở 01)
    -- =========================================================================
    CREATE SCHEMA app   AUTHORIZATION db_owner;
    CREATE SCHEMA audit AUTHORIZATION db_owner;

    -- =========================================================================
    -- QUYỀN Ở MỨC DATABASE
    -- Mặc định PUBLIC có CONNECT + TEMP trên mọi database. Thu hồi rồi cấp lại
    -- đích danh: role lạ (hoặc role tạo nhầm) sẽ không connect được.
    -- =========================================================================
    REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
    GRANT CONNECT ON DATABASE :"dbname" TO db_owner, app_user, readonly_user, admin_user, analyzer_user;

    -- =========================================================================
    -- THAM SỐ MẶC ĐỊNH THEO ROLE
    -- search_path đặt cố định để chống tấn công search_path hijacking
    -- (kẻ tấn công tạo hàm/bảng trùng tên ở schema đứng trước trong path).
    -- statement_timeout hạn chế truy vấn quét toàn bảng kéo dài - vừa là
    -- chống DoS, vừa làm chậm ý đồ rút dữ liệu hàng loạt.
    -- =========================================================================
    -- search_path KHÔNG có `ext`: role nghiệp vụ không được cấp USAGE trên
    -- schema đó (xem 04_grants.sql), mọi thao tác mã hóa đi qua hàm bọc sẵn.
    ALTER ROLE app_user      SET search_path = app;
    ALTER ROLE app_user      SET statement_timeout = '30s';
    ALTER ROLE app_user      SET idle_in_transaction_session_timeout = '60s';
    ALTER ROLE app_user      SET application_name = 'secdb-app';

    ALTER ROLE readonly_user SET search_path = app;
    ALTER ROLE readonly_user SET statement_timeout = '60s';
    ALTER ROLE readonly_user SET default_transaction_read_only = on;

    ALTER ROLE db_owner      SET search_path = app, audit, ext;
    ALTER ROLE admin_user    SET search_path = app, audit, ext;

    -- search_path CHỈ có audit: analyzer không có việc gì với schema app.
    ALTER ROLE analyzer_user SET search_path = audit;
    ALTER ROLE analyzer_user SET statement_timeout = '15s';
    ALTER ROLE analyzer_user SET application_name = 'secdb-analyzer';

EOSQL

echo "02_roles.sh: da tao db_owner / app_user / readonly_user / admin_user / analyzer_user"
