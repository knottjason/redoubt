import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { app } from './app.ts'
import { config } from './config.ts'

app.use('/*', serveStatic({ root: './dist/web' }))
app.get('/*', serveStatic({ path: './dist/web/index.html' }))
serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? '127.0.0.1' }, (i) => console.log(`Redoubt on ${i.port}`))
