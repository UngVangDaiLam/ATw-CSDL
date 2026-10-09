# Đối chiếu với pháp luật Việt Nam về bảo vệ dữ liệu cá nhân

Mỗi yêu cầu pháp lý dưới đây được ghép với **cơ chế cụ thể trong repo** và
**lệnh/phép thử chứng minh nó**. Chỗ nào lab chưa đáp ứng thì ghi thẳng là
chưa — mục cuối.

## 0. Khung pháp lý hiện hành (tính đến 10/2026)

| Văn bản | Hiệu lực | Ghi chú |
|---|---|---|
| **Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15** | 01/01/2026 | Quốc hội thông qua 26/6/2025 |
| **Nghị định 356/2025/NĐ-CP** (31/12/2025) | 01/01/2026 | Quy định chi tiết Luật 91; 5 chương, 42 điều |
| ~~Nghị định 13/2023/NĐ-CP~~ | hết hiệu lực | **Bị Nghị định 356/2025 thay thế.** Nhiều tài liệu và đồ án trước 2026 còn trích NĐ 13 — đừng dùng làm căn cứ chính trong báo cáo |

> **Độ tin cậy của trích dẫn.** Số điều/khoản dưới đây đã đối chiếu qua ít nhất
> hai nguồn thứ cấp (lawplayer.com, luatvietnam.vn, thuvienphapluat.vn — liệt
> kê cuối file). Phần trích *nguyên văn* là trích ngắn từ các nguồn đó. Trước
> khi đưa vào báo cáo nộp, đối chiếu lại với văn bản trên Cổng thông tin điện
> tử Chính phủ / Công báo, đặc biệt **số điểm (a, b, c…)** trong Điều 3 và
> Điều 4 Nghị định 356.

## 1. Dữ liệu của lab thuộc loại nào

Nghị định 356 chia dữ liệu cá nhân làm hai loại. Áp vào `app.customers` /
`app.payments`:

| Cột trong lab | Loại theo NĐ 356 | Lab xử lý thế nào |
|---|---|---|
| `customers.cccd` (số định danh cá nhân) | **Cơ bản** — Điều 3 liệt kê "số định danh cá nhân, số hộ chiếu…" | Mã hóa AES-256 + blind index — **cao hơn mức pháp luật đòi hỏi** |
| `payments.card_token` (số thẻ đầy đủ) | **Nhạy cảm** — Điều 4 khoản 1, nhóm "thông tin thẻ ngân hàng… thông tin tài chính, tín dụng" | Mã hóa AES-256, chỉ giải mã qua hàm có tên trong log |
| `payments.card_last4` | Một phần của thông tin thẻ | Để rõ để hiển thị — cùng thông lệ PCI DSS (4 số cuối được phép hiển thị) |
| `full_name`, `phone`, `email` | **Cơ bản** — Điều 3 | Không mã hóa; bảo vệ bằng phân quyền + RLS |
| `staff.password_hash` | Dữ liệu đăng nhập của nhân viên | bcrypt; không role nghiệp vụ nào đọc được cột này |

**Điểm nên nói khi bảo vệ:** CCCD *không* thuộc nhóm nhạy cảm theo NĐ 356 —
câu hỏi "sao lại mã hóa CCCD?" là câu hội đồng dễ hỏi. Lý do lab vẫn mã hóa:
CCCD là khóa để mạo danh (mở tài khoản, vay tiền) — lộ CCCD cùng họ tên và số
điện thoại là đủ bộ cho lừa đảo. Mức bảo vệ chọn theo **hậu quả khi lộ**, không
chỉ theo nhãn pháp lý. Thông tin thẻ thì đúng là nhạy cảm theo luật, và lab mã
hóa nó.

## 2. Ma trận yêu cầu → cơ chế → bằng chứng

| Căn cứ | Yêu cầu (tóm tắt) | Cơ chế trong lab | Bằng chứng chạy được |
|---|---|---|---|
| Luật 91, **Điều 3 khoản 4** | Thực hiện **đồng bộ** biện pháp về thể chế, kỹ thuật, con người | Bốn lớp độc lập, mỗi lớp giả định lớp kia có thể thủng (SQLi, IDOR cố ý trong app) | `bash scripts/demo-attack.sh` — 6 kịch bản tấn công, lớp nào chặn/ghi nhận cái gì |
| NĐ 356, **Điều 4 khoản 2** | Dữ liệu nhạy cảm: thiết lập **phân quyền giới hạn truy cập**, quy trình xử lý, biện pháp bảo mật | Whitelist GRANT từng bảng (`04_grants.sql`), quyền mức **cột** (`readonly_user` không đọc `cccd`; không ai đọc `password_hash`), RLS theo chi nhánh có `FORCE` | `verify.sh` mục LOP 1b–1e |
| Luật 91, **Điều 12** | Mã hóa: chuyển dữ liệu sang dạng không nhận biết được; tổ chức tự quyết định việc mã hóa/giải mã phù hợp hoạt động xử lý | `pgcrypto` AES-256, khóa ở Docker secret (không nằm trong DB, không nằm trong app); giải mã **chỉ** qua `app.decrypt_text()` | `verify.sh`: "pg_dump KHÔNG chứa CCCD, số thẻ hay khóa ở dạng rõ" |
| Luật 91, **Điều 12** — mở rộng cho bản sao lưu | Bản sao lưu cũng là dữ liệu được xử lý, phải mã hóa như dữ liệu gốc | Mọi thứ rời database đều mã hóa (`postgres/backup-crypt.sh`, AES-256, khóa sao lưu riêng): từng segment WAL, base backup, `pg_dump`, bản cất trước PITR. Có kiểm tra toàn vẹn: sửa 1 byte là bị từ chối | `verify.sh` mục LOP 4/4b: chuỗi đánh dấu ghi vào WAL không thấy trong kho archive, giải mã thì thấy lại; sai khóa, sửa byte đều bị từ chối |
| NĐ 356 — dữ liệu phải mã hóa **khi lưu và khi truyền** | Kênh truyền giữa ứng dụng và CSDL phải được mã hóa | TLS 1.3 bắt buộc (`hostnossl ... reject` trong `pg_hba.conf`); app/analyzer/dashboard xác thực server bằng CA riêng của lab (tương đương `verify-full`) — chặn cả nghe lén lẫn kẻ xen giữa. Khi lưu: lớp 2 | `verify.sh` mục "LOP 1a - TLS" (9 phép thử); log PostgreSQL ghi `SSL enabled (protocol=TLSv1.3 ...)` cho từng kết nối |
| NĐ 356, **Điều 4 khoản 2** (phân quyền) — mở rộng | Người được cấp quyền phải là đúng người | Token phiên đăng nhập: `SET ROLE` sang nhân viên mà không có phiên của họ → 0 dòng | `verify.sh` mục LOP 1f (7 phép thử) |
| Luật 91, **Điều 23 khoản 1** | Phát hiện vi phạm → thông báo cơ quan chuyên trách **chậm nhất 72 giờ** | Lớp 3: cảnh báo trong 1–4 giây (analyzer `--watch` + dashboard). Thông báo cần biết **phạm vi**: `BULK_DECRYPT` đếm **đúng số bản ghi bị giải mã**, `HONEYTOKEN_ACCESS` xác nhận rò rỉ thật | `verify.sh` mục LOP 3c; dashboard `http://127.0.0.1:4000` |
| Luật 91, Điều 23 (hồ sơ vi phạm) | Lập biên bản, xác định hành vi | Bằng chứng **chỉ ghi thêm**: `analyzer_user` chỉ `INSERT`, không ai trong app sửa/xóa được `audit.alerts`; quy trách nhiệm theo **từng nhân viên** dù log chỉ ghi `app_user` | `verify.sh` mục LOP 3b |
| NĐ 356, Điều 4 khoản 1 (nhóm tài chính) + Luật 91, **Điều 27 khoản 1** | Lĩnh vực tài chính, ngân hàng: thực hiện đầy đủ bảo vệ dữ liệu nhạy cảm, tiêu chuẩn an toàn bảo mật | `card_token` mã hóa; chỉ `card_last4` để rõ | `verify.sh`: số thẻ `4242…` không có trong `pg_dump` |
| Luật 91, **Điều 3 khoản 3** | Lưu trữ trong thời gian phù hợp mục đích | Token phiên hết hạn 12 giờ và bị dọn khi đăng nhập kế tiếp. **Dữ liệu khách hàng: chưa** (xem mục 3) | — |
| Luật 91, Điều 3 + Điều 37 (biện pháp kỹ thuật của bên kiểm soát) | Bảo đảm tính sẵn sàng, khôi phục được | WAL archive liên tục, `pg_basebackup`, PITR tới từng giây; thử khôi phục trong sandbox, không động vào DB thật | `verify.sh` mục LOP 4, 4b; `bash backup/scripts/demo_pitr.sh` |
| Luật 91, **Điều 8 khoản 4–5** | Phạt tới 5% doanh thu (chuyển dữ liệu xuyên biên giới), tới 3 tỷ đồng (vi phạm khác) | Không phải cơ chế — là **lý do** chi phí của các lớp (đo ở `docs/performance.md`) đáng bỏ ra | — |

## 3. Chỗ lab CHƯA đáp ứng

Ghi vào báo cáo, đừng để hội đồng tự tìm ra:

| Căn cứ | Thiếu gì | Hướng làm |
|---|---|---|
| Luật 91, **Điều 14** — xóa, hủy dữ liệu khi chủ thể yêu cầu / hết mục đích | `app_user` cố ý **không có `DELETE`** (chống phá hoại), nên chưa có luồng xóa theo yêu cầu. Bản sao lưu và WAL archive vẫn giữ dữ liệu cũ | Hàm `SECURITY DEFINER` xóa có kiểm soát, ghi vết; **crypto-shredding**: mỗi khách một khóa con, xóa khóa là mọi bản sao lưu chứa ciphertext đó vô dụng |
| Luật 91, Điều 3 khoản 3 — thời hạn lưu trữ | Không có chính sách hết hạn cho `customers`, `orders` | Cột `retention_until` + job dọn định kỳ |
| Luật 91, Điều 12 — quản lý khóa mã hóa | Ba khóa (cột, sao lưu, TLS) là file trên cùng máy chủ với dữ liệu; chưa xoay khóa được mà không dựng lại database | KMS/HSM; mã hóa phong bì cho bản sao lưu; cột `key_version` cho khóa cột — README mục 8 |
| NĐ 356 — nhân sự bảo vệ dữ liệu, đánh giá tác động xử lý dữ liệu | Yêu cầu tổ chức, không phải kỹ thuật | Ngoài phạm vi đồ án; nhắc tên trong báo cáo |
| Luật 91, Điều 23 — nội dung thông báo cho chủ thể | Lab phát hiện và đo phạm vi, nhưng không tự sinh hồ sơ thông báo | Dashboard xuất báo cáo sự cố (thời điểm, người, số bản ghi) — dữ liệu đã có sẵn trong `audit.alerts.detail` |

## Nguồn

- Luật 91/2025/QH15, toàn văn: [lawplayer.com](https://lawplayer.com/vn/act/vn-vbpl-179252), [antoanthongtin.vn](https://antoanthongtin.vn/tin/luat-so-91-2025-qh15-luat-bao-ve-du-lieu-ca-nhan-2025)
- Nghị định 356/2025/NĐ-CP: [thuvienphapluat.vn](https://thuvienphapluat.vn/van-ban/Quyen-dan-su/Nghi-dinh-356-2025-ND-CP-huong-dan-Luat-Bao-ve-du-lieu-ca-nhan-687428.aspx), [luatnguyen.vn](https://luatnguyen.vn/van-ban-phap-luat/nghi-dinh-356-2025-nd-cp-huong-dan-luat-bao-ve-du-lieu-ca-nhan-2574.html), [luatvietnam.vn](https://luatvietnam.vn/thong-tin/nghi-dinh-356-2025-nd-cp-quy-dinh-chi-tiet-luat-bao-ve-du-lieu-ca-nhan-422896-d1.html)
- Danh mục dữ liệu nhạy cảm từ 01/01/2026: [thuvienphapluat.vn](https://thuvienphapluat.vn/chinh-sach-phap-luat-moi/vn/ho-tro-phap-luat/chinh-sach-moi/102178/bo-sung-danh-muc-du-lieu-ca-nhan-nhay-cam-tu-01-01-2026)
