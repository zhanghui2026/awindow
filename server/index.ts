import { buildApp } from './app.js'
import { readWebRtcConfig } from './webrtc/config.js'

const port = Number(process.env.PORT ?? 3001)
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`
const trustProxy = process.env.TRUST_PROXY === 'true'
const webRtcConfig = readWebRtcConfig(process.env)

try {
  const app = await buildApp({ logger: true, publicBaseUrl, trustProxy, webRtcConfig })
  await app.listen({ host: '127.0.0.1', port })
} catch (error) {
  console.error(error)
  process.exit(1)
}
