# Lớp 3 - chiều đọc. Hai giai đoạn: build giao diện React bằng Vite, rồi image
# chạy thật chỉ chứa backend Node + thư mục dist đã build.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY --from=build /app/dist ./dist

USER node
# Trong container phải nghe mọi interface để Docker chuyển cổng vào được.
# Giới hạn "chỉ máy này xem được" nằm ở docker-compose.yml: cổng publish ra
# 127.0.0.1:4000, không phải 0.0.0.0.
ENV HOST=0.0.0.0
EXPOSE 4000
CMD ["node", "server/index.js"]
