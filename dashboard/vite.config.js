import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Lúc dev: Vite phục vụ giao diện ở 5173, mọi lời gọi /api và kết nối
// Socket.IO được chuyển sang backend ở 4000. Lúc chạy thật (`npm run build`
// rồi `npm start`) thì chính backend phục vụ thư mục dist/ — một cổng duy nhất.
const backend = `http://127.0.0.1:${process.env.PORT || 4000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
});
