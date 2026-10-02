import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Giao dien cua app/: ma nguon o web/, build ra public/ - Express (src/app.js)
// phuc vu thu muc do, CUNG origin voi API. Cung origin la dieu kien de cookie
// SameSite=Strict va CSRF token hoat dong ma khong can bat CORS.
//
// Luc dev (`npm run dev:web`): Vite o 5173, chuyen moi loi goi API sang app o
// 3000 - trinh duyet van thay mot origin duy nhat.
const root = fileURLToPath(new URL('.', import.meta.url));
const backend = `http://127.0.0.1:${process.env.PORT || 3000}`;

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../public', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/auth': backend,
      '/customers': backend,
      '/orders': backend,
      '/health': backend,
    },
  },
});
