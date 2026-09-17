import { defineConfig } from 'vite';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

export default defineConfig(({ mode }) => {
  const secure = mode === 'https';
  if (secure && (!existsSync('.cert/localhost.pem') || !existsSync('.cert/localhost-key.pem'))) {
    throw new Error('请先按照 README 的手机体感步骤生成 .cert/localhost.pem 和 .cert/localhost-key.pem。');
  }
  return {
    plugins:[{name:'include-licenses',apply:'build',closeBundle(){copyFileSync('THIRD_PARTY_NOTICES.md','dist/THIRD_PARTY_NOTICES.md');}}],
    server: {
      port: 5173, strictPort: true,
      https: secure ? { cert: readFileSync('.cert/localhost.pem'), key: readFileSync('.cert/localhost-key.pem') } : undefined,
    },
    build: { target: 'es2022', rollupOptions:{output:{manualChunks(id){if(id.includes('node_modules/three/'))return 'three';}}} },
  };
});
