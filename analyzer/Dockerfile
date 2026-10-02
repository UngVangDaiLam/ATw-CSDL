# Lớp 3 - analyzer chạy liên tục (--watch). Đọc log PostgreSQL qua thư mục
# mount CHỈ ĐỌC, ghi cảnh báo bằng analyzer_user (chỉ INSERT audit.alerts).
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

USER node
# docker stop gửi SIGTERM -> watch.js ghi nốt hàng đợi, lưu trạng thái rồi thoát.
CMD ["node", "src/index.js", "--watch"]
