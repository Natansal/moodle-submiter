import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** GitHub project Pages: `VITE_BASE_PATH=/repo-name/` (leading + trailing slash). Root site: `/`. */
const base =
  process.env.VITE_BASE_PATH !== undefined && process.env.VITE_BASE_PATH !== ''
    ? process.env.VITE_BASE_PATH.endsWith('/')
      ? process.env.VITE_BASE_PATH
      : `${process.env.VITE_BASE_PATH}/`
    : '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    {
      name: 'html-base-placeholder',
      transformIndexHtml(html) {
        return html.replace(/%BASE_URL%/g, base);
      },
    },
  ],
});
