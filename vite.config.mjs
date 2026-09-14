import { defineConfig } from 'vite'
export default defineConfig({css:{postcss:{plugins:[]}},server:{host:'127.0.0.1',port:Number(process.env.DEMO_WEB_PORT||5187),strictPort:true,proxy:{'/api':`http://127.0.0.1:${process.env.DEMO_API_PORT||8788}`}},preview:{host:'127.0.0.1'},build:{outDir:'dist',rollupOptions:{output:{manualChunks:(id)=>id.includes('/recharts/')?'charts':undefined}}}})

