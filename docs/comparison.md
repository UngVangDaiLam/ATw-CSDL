# So sánh với giải pháp thương mại

Đặt từng cơ chế của lab cạnh cơ chế tương ứng của Oracle Database, Microsoft
SQL Server / Azure SQL và PostgreSQL được quản lý trên AWS (RDS / Aurora). Mục
đích không phải chứng minh lab "hơn" — sản phẩm thương mại có hàng chục năm và
đội ngũ phía sau — mà để chỉ đúng **chỗ nào lab làm giống, chỗ nào làm khác có
lý do, và chỗ nào thua**.

## 1. Bảng tổng hợp

| Nhu cầu | Oracle | SQL Server / Azure SQL | AWS RDS / Aurora PostgreSQL | Lab này |
|---|---|---|---|---|
| Lọc theo dòng | Virtual Private Database (`DBMS_RLS`) | Row-Level Security (security predicate) | RLS gốc của PostgreSQL | RLS gốc + `FORCE` + policy bọc InitPlan (`06_rls.sql`) |
| Định danh người dùng cuối qua **một** connection pool | *Secure application context*: chỉ package tin cậy khai báo trong `CREATE CONTEXT ... USING` mới đặt được giá trị | `SESSION_CONTEXT` + `sp_set_session_context @read_only = 1` | Không có sẵn; GUC tùy biến ai cũng `set_config` được | `SET LOCAL ROLE` + **token phiên do DB cấp, policy tự kiểm chứng** (`app.branch_of`) |
| Mã hóa dữ liệu khi lưu | TDE (trong suốt, cả tablespace) | TDE; **Always Encrypted** (khóa ở phía client, DB không thấy plaintext) | Mã hóa lưu trữ bằng KMS (trong suốt) | Mã hóa **cột** `pgcrypto` AES-256; khóa ở Docker secret, chỉ hàm của DB đọc |
| Che dữ liệu khi hiển thị | Data Redaction | Dynamic Data Masking | — | Quyền mức cột (`readonly_user` không đọc được `cccd`) |
| Tách quyền quản trị khỏi dữ liệu | Database Vault | — (một phần qua quyền) | — | `FORCE RLS` khiến `db_owner` đọc ra 0 dòng |
| Nhật ký truy cập | Unified Auditing | SQL Server Audit | `pgaudit`; Database Activity Streams (Aurora) | `pgaudit` (class `read, write, role, ddl, misc_set`) |
| Chống sửa nhật ký / cảnh báo | Unified Audit trail được bảo vệ | **Ledger tables** — chống giả mạo bằng mật mã (hash chain) | DAS mã hóa bằng KMS, đẩy ra ngoài | Phân quyền: `analyzer_user` chỉ `INSERT`, `dashboard_user` chỉ `SELECT` |
| Phân tích hành vi bất thường | Sản phẩm DAM bên thứ ba (Oracle Audit Vault, IBM Guardium, Imperva, DataSunrise…) | như cột bên trái | như cột bên trái | Analyzer tự viết: 11 rule + 2 rule tầng web |
| Bẫy / bản ghi mồi | Không có sẵn trong DB; sản phẩm deception riêng | như cột bên trái | như cột bên trái | Bẫy **trong hàm giải mã** (`HONEYTOKEN_ACCESS`) |
| Khôi phục về thời điểm | RMAN, Flashback | Point-in-time restore | Automated backups + PITR | WAL archive + `pg_basebackup` + PITR, **mã hóa toàn bộ kho sao lưu** (cả từng segment WAL), thử trong sandbox, ghi bù cảnh báo |

## 2. Ba chỗ lab làm khác — và vì sao

### 2a. Định danh qua connection pool: kiểm chứng thay vì tin

Cả ba nền tảng đều gặp chung một bài toán: ứng dụng kết nối bằng **một**
tài khoản, nhưng chính sách dòng cần biết **người dùng cuối** là ai.

- **SQL Server** để ứng dụng đặt `SESSION_CONTEXT` (vd. `user_id = 5`), khóa
  bằng `@read_only = 1` cho hết phiên. Khóa này ngăn đổi giá trị *giữa chừng*,
  nhưng **ai cầm tài khoản ứng dụng cũng tự đặt được bất kỳ giá trị nào lúc mở
  phiên** — database tin ứng dụng.
- **Oracle** chặt hơn: chỉ package tin cậy mới ghi được context, nên package
  có thể kiểm tra trước khi ghi. Nhưng đó là việc người viết package phải tự
  làm; mẫu phổ biến vẫn là nhận giá trị từ tham số.
- **PostgreSQL** không có cơ chế nào tương đương: GUC tùy biến
  (`set_config('app.user_id', ...)`) ai cũng đặt được, và đó là mẫu mà phần
  lớn hướng dẫn RLS cho ứng dụng nhiều người dùng đang dùng.

Lab không tin giá trị được đặt. Policy RLS **tự kiểm chứng**: token phải tồn
tại trong `app.staff_sessions` (chỉ cấp khi nhập đúng mật khẩu nhân viên),
còn hạn, và thuộc đúng role đang `SET ROLE`. Tài khoản ứng dụng bị lộ vẫn không
đọc được gì — và lần thử để lại dấu vết (`IDENTITY_WITHOUT_SESSION`).

Cái giá: thêm một bảng, một lần tra theo khóa chính mỗi câu lệnh (không đo được
khác biệt — `docs/performance.md` mục 6), và một câu `set_config` mỗi request.

### 2b. Khóa nằm ở database, không ở ứng dụng — ngược với Always Encrypted

**Always Encrypted** đặt khóa ở phía client: database không bao giờ thấy
plaintext, nên **quản trị viên database** không đọc được dữ liệu. Lab chọn
ngược lại: khóa ở database (Docker secret), **ứng dụng** không bao giờ cầm khóa.

| | Always Encrypted | Lab |
|---|---|---|
| Kẻ chiếm được DBA / bản dump | Không đọc được | Bản dump: không đọc được (khóa không nằm trong dump). DBA có shell trên máy DB: đọc được khóa |
| Kẻ chiếm được ứng dụng | **Có khóa** → giải mã ngoại tuyến không giới hạn, database không biết | Không có khóa → mọi lần giải mã phải đi qua `app.decrypt_text()`, bị RLS giới hạn theo chi nhánh, **bị đếm** (`BULK_DECRYPT`), **có thể chạm bẫy** (`HONEYTOKEN_ACCESS`) |
| Tìm theo giá trị | Mã hóa tất định (lộ quan hệ bằng nhau) | Blind index HMAC + pepper (cũng lộ quan hệ bằng nhau, nhưng tách khỏi ciphertext) |

Mô hình đe dọa của lab coi **ứng dụng là thứ dễ bị chiếm nhất** (nó có 2 lỗ
hổng cố ý). Always Encrypted coi **người vận hành database** là mối đe dọa.
Hai lựa chọn đúng cho hai mô hình khác nhau — báo cáo nên nói rõ lab chọn mô
hình nào.

### 2c. Bẫy nằm trên đường đi bắt buộc

Honeytoken / canary không mới: sản phẩm deception thương mại và khái niệm
"canary token" đã phổ biến. Điểm khác của lab là **vị trí đặt bẫy**: bên trong
hàm giải mã — đường duy nhất tới plaintext, vì không role nghiệp vụ nào gọi
thẳng được `pgcrypto`. Kẻ tấn công không né được bằng cách đổi công cụ (SQLi,
psql thẳng, endpoint hợp lệ đều phải qua hàm đó), và tín hiệu đến từ **bên
trong database**, không phụ thuộc ứng dụng có ghi log hay không.

## 3. Chỗ lab thua — ghi thẳng

| Khía cạnh | Thương mại | Lab |
|---|---|---|
| Chống sửa bằng chứng | Ledger tables (SQL Server) chống giả mạo **bằng mật mã** — sửa được phát hiện được | Chỉ dựa vào phân quyền: superuser vẫn sửa được `audit.alerts`, và sửa xong không để lại dấu |
| Phân tích hành vi | DAM thương mại: học baseline từng người dùng, hàng trăm mẫu, giao diện điều tra | 11 rule cố định ngưỡng; chưa có baseline theo từng nhân viên (hướng phát triển 3) |
| Quản lý khóa | HSM / KMS, xoay khóa tự động, mã hóa phong bì, tách vai trò quản lý khóa | Ba file khóa riêng (cột, sao lưu, TLS) trên cùng máy chủ; xoay khóa cột hay khóa sao lưu = dựng lại database |
| Mã hóa đường truyền | TLS + chứng chỉ từ CA tin cậy, cấp lại/thu hồi tự động | Có TLS 1.3 bắt buộc và client xác thực server (verify-full), nhưng CA tự ký của lab, cấp lại chứng chỉ bằng tay, không có CRL/OCSP |
| Quy mô | Đã chạy ở môi trường production lớn | Lab một máy, 6 000 khách hàng |
| Hiệu năng giải mã | TDE gần như không tốn chi phí khi đọc | ~1,2–1,4 ms mỗi bản ghi giải mã (đánh đổi có chủ đích — `docs/performance.md` mục 2) |

## 4. Một câu để trả lời "khác gì cái đã có?"

> Các cơ chế riêng lẻ đều có sẵn ở dạng thương mại. Lab khác ở chỗ ghép chúng
> trên PostgreSQL thuần sao cho **lớp này báo động cho lớp kia**: định danh ở
> lớp 1 được kiểm chứng bằng token chứ không tin ứng dụng, mỗi lần giải mã ở
> lớp 2 vừa bị đếm vừa có thể chạm bẫy cho lớp 3, và khôi phục ở lớp 4 không
> làm mất cảnh báo về chính sự cố — mỗi điều có một phép thử chạy được
> (`bash scripts/verify.sh`, 145 phép thử).

## Nguồn

- SQL Server `SESSION_CONTEXT`: [Microsoft Learn](https://learn.microsoft.com/en-za/sql/t-sql/functions/session-context-transact-sql?view=sql-server-2016); RLS và connection pool: [Redgate Simple Talk](https://www.red-gate.com/simple-talk/other/row-level-security-part-3-a-few-more-advanced-scenarios/), [MSSQLTips](https://www.mssqltips.com/sqlservertip/4094/phase-out-contextinfo-in-sql-server-2016-with-sessioncontext)
- Oracle secure application context: [Oracle Database Security Guide 11.1](https://docs.oracle.com/cd/E29505_01/network.1111/e16543/app_context.htm), [Oracle 10g docs](https://www.comp.nus.edu.sg/~oradoc/doc10g/network.102/b14266/apdvcntx.htm)
- AWS RDS bảo mật (KMS, IAM authentication, activity streams): [Amazon RDS security features](https://www.amazonaws.cn/en/rds/features/security/), [DataSunrise — Aurora PostgreSQL activity history](https://www.datasunrise.com/knowledge-center/amazon-aurora-postgresql-data-activity-history/)
