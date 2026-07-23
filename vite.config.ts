import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望的前端开发配置
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // Vite 静态资源从相对路径加载,适配 Tauri 打包
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 忽略 Rust 侧变更,避免不必要重载
      ignored: ["**/src-tauri/**"],
    },
  },
  // Tauri webview 需要的较老目标
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
} as any);
