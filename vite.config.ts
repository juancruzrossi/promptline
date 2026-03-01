import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import apiPlugin from './vite-plugin-api.ts'

const randomPort = 3000 + Math.floor(Math.random() * 7000);

export default defineConfig({
  plugins: [react(), tailwindcss(), apiPlugin()],
  server: {
    port: randomPort,
    open: true,
  },
})
