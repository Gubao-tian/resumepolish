import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// V1.0：纯静态前端（GitHub Pages 可托管），API 走同源 /api 代理。
// 开发态：vite(5173) 将 /api 代理到本地 Serverless 服务器(8787)；
// 生产态：由 server/dev-server.js 或 Vercel Functions 直接提供服务。
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
