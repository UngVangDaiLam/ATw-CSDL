# Backend Express (app_user + SET LOCAL ROLE) + giao dien web.
# Hai giai doan: build giao dien React bang Vite, roi image chay that chi chua
# backend + thu muc public/ da build. Cau hinh den tu docker-compose.yml - KHONG
# copy .env vao image (.dockerignore).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=build /app/public ./public

# Lop chan thu hai cho src/errors.js: o che do production, trang loi mac dinh
# cua Express khong kem stack trace.
ENV NODE_ENV=production

# Ma nguon thuoc root, tien trinh chay bang user node: app bi chiem cung khong
# sua duoc chinh code cua no.
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
