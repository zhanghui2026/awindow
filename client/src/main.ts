import QRCode from 'qrcode'

import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_LENGTH,
  VERIFICATION_TTL_MS,
  type ApiError,
  type DeviceRole,
  type KeyExchangeEvent,
  type ServerMessage,
} from '../../shared/protocol.js'
import { CryptoSession } from './crypto-session.js'
import { isGroupedWithPrevious, trimOverflow } from './message-list.js'
import { PeerTransport, type PeerSignal, type PeerTransportState } from './peer-transport.js'
import { TransferClient, type StoredSession } from './transfer-client.js'
import {
  TransferProtocol,
  type TransferImageEvent,
  type TransferImageProgressEvent,
  type TransferTextEvent,
} from './transfer-protocol.js'

function generateUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const values = new Uint8Array(1)
    const byte = typeof globalThis.crypto?.getRandomValues === 'function'
      ? globalThis.crypto.getRandomValues(values)[0] ?? 0
      : Math.floor(Math.random() * 256)
    const r = (byte & 15) >> (c === 'x' ? 0 : 3)
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}
import './styles.css'

const SESSION_KEY = 'temporary-transfer-session'
const root = document.querySelector<HTMLElement>('#app')
let client: TransferClient | undefined
let session: StoredSession | undefined
let cryptoSession: CryptoSession | undefined
let safetyNumber: string | undefined
let verificationStatus: 'pending' | 'verified' | 'failed' = 'pending'
let locallyConfirmed = false
let verificationTimer: number | undefined
let peerTransport: PeerTransport | undefined
let transferProtocol: TransferProtocol | undefined
let peerTransportState: PeerTransportState = 'connecting'
let peerSetupGeneration = 0
const pendingPeerSignals: PeerSignal[] = []
const invitationSecretFromFragment = consumeInvitationSecret()
interface DisplayMessage {
  id: string
  kind: 'text' | 'image'
  senderRole: DeviceRole
  text?: string
  image?: { fileName: string; mimeType: string; bytes: Uint8Array<ArrayBuffer> }
  createdAt: number
}

let messages: DisplayMessage[] = []
let sendQueue: Promise<void> = Promise.resolve()
let connectionState: 'connecting' | 'online' | 'offline' = 'connecting'
let peerOnline = false
let pendingImage: File | undefined
let pendingImagePreviewUrl: string | undefined
const messageImageUrlsById = new Map<string, string>()
const renderedMessageIds: string[] = []

function icon(name: string): string {
  const paths: Record<string, string> = {
    arrow: '<path d="m9 18 6-6-6-6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  }
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name] ?? ''}</svg>`
}

function setSession(value?: StoredSession): void {
  session = value
  if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value))
  else sessionStorage.removeItem(SESSION_KEY)
}

function consumeInvitationSecret(): string | undefined {
  const secret = new URLSearchParams(location.hash.slice(1)).get('k') ?? undefined
  if (location.hash) history.replaceState({}, '', `${location.pathname}${location.search}`)
  return secret
}

function qrJoinUrl(): string | undefined {
  if (!session?.joinUrl || !session.crypto?.invitationSecret) return undefined
  const url = new URL(session.joinUrl, location.href)
  url.hash = `k=${session.crypto.invitationSecret}`
  return url.toString()
}

function normalizeJoinUrl(joinUrl: string): string {
  const source = new URL(joinUrl, location.href)
  return new URL(`${source.pathname}${source.search}`, location.origin).toString()
}

async function persistCryptoSession(): Promise<void> {
  if (!session || !cryptoSession) return
  session.crypto = await cryptoSession.export()
  setSession(session)
}

function errorMessage(error: unknown): string {
  const candidate = error as ApiError
  return candidate?.message || '操作失败，请稍后重试'
}

function showToast(text: string): void {
  document.querySelector('.toast')?.remove()
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.textContent = text
  document.body.append(toast)
  window.setTimeout(() => toast.remove(), 2600)
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    showToast('已复制')
  } catch {
    showToast('复制失败，请手动选择文字')
  }
}

function renderHome(joinCode = new URLSearchParams(location.search).get('code') ?? ''): void {
  if (!root) return
  root.innerHTML = `
    <main class="shell home-shell">
      <header class="brand"><span class="brand-mark">T</span><span>临时传送</span></header>
      <section class="home-grid">
        <div class="intro">
          <p class="eyebrow">DIRECT DEVICE TRANSFER</p>
          <h1>让文字和图片<br>在设备间自然流动</h1>
          <p class="lead">创建一个临时会话，在两个设备之间即时传递内容。会话结束后，数据随即清除。</p>
          <div class="privacy-note"><span class="live-dot"></span>无需登录 · 仅在会话期间保存</div>
        </div>
        <div class="action-panel">
          <button class="primary action-create" type="button"><span>创建传输房间</span>${icon('arrow')}</button>
          <div class="divider"><span>或使用配对码加入</span></div>
          <form class="join-form">
            <label for="pairing-code">6 位配对码</label>
            <div class="join-row">
              <input id="pairing-code" maxlength="6" autocomplete="one-time-code" value="${joinCode.replace(/[^A-Z0-9]/gi, '')}" placeholder="ABC234" />
              <button class="secondary" type="submit">加入</button>
            </div>
            <p class="form-error" role="alert"></p>
          </form>
        </div>
      </section>
      <footer>端到端临时空间 <span>·</span> 最多连接两台设备</footer>
    </main>`
  root.querySelector('.action-create')?.addEventListener('click', createRoom)
  root.querySelector('.join-form')?.addEventListener('submit', joinRoom)
  const input = root.querySelector<HTMLInputElement>('#pairing-code')
  input?.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })
}

async function createRoom(): Promise<void> {
  const button = root?.querySelector<HTMLButtonElement>('.action-create')
  if (button) button.disabled = true
  try {
    const invitationSecret = CryptoSession.generateInvitationSecret()
    const created = await TransferClient.createRoom()
    cryptoSession = await CryptoSession.create(created.roomId, 'creator', invitationSecret)
    setSession({ ...created, joinUrl: normalizeJoinUrl(created.joinUrl), crypto: await cryptoSession.export() })
    renderPairing()
    startClient()
  } catch (error) {
    showToast(errorMessage(error))
    if (button) button.disabled = false
  }
}

async function joinRoom(event: Event): Promise<void> {
  event.preventDefault()
  const input = root?.querySelector<HTMLInputElement>('#pairing-code')
  const error = root?.querySelector<HTMLElement>('.form-error')
  if (!input || input.value.length !== 6) {
    if (error) error.textContent = '请输入完整的 6 位配对码'
    return
  }
  if (invitationSecretFromFragment && !CryptoSession.isInvitationSecret(invitationSecretFromFragment)) {
    if (error) error.textContent = '二维码邀请密钥无效'
    return
  }
  try {
    const joined = await TransferClient.joinRoom(input.value)
    cryptoSession = await CryptoSession.create(joined.roomId, 'joiner', invitationSecretFromFragment)
    setSession({ ...joined, crypto: await cryptoSession.export() })
    renderTransfer()
    startClient()
  } catch (reason) {
    if (error) error.textContent = errorMessage(reason)
  }
}

async function renderPairing(): Promise<void> {
  if (!root || !session) return
  root.innerHTML = `
    <main class="shell pairing-shell">
      <header class="topbar"><div class="brand"><span class="brand-mark">T</span><span>临时传送</span></div><button class="icon-button end-session" title="关闭房间">${icon('x')}</button></header>
      <section class="pairing-layout">
        <div class="pairing-copy"><p class="eyebrow">ROOM READY</p><h1>用另一台设备加入</h1><p>扫描二维码，或输入下方配对码。成功连接后会自动进入传输空间。</p><div class="status-line"><span class="pulse"></span><span>正在等待另一台设备</span><strong class="countdown">05:00</strong></div></div>
        <div class="qr-panel"><div class="qr-frame"><canvas id="qr"></canvas></div><p>配对码</p><button class="code-copy" type="button" title="复制配对码"><strong>${session.pairingCode}</strong>${icon('copy')}</button><small>配对码将在 5 分钟后失效</small></div>
      </section>
    </main>`
  const canvas = root.querySelector<HTMLCanvasElement>('#qr')
  const joinUrl = qrJoinUrl()
  if (canvas && joinUrl) await QRCode.toCanvas(canvas, joinUrl, { width: 220, margin: 1, color: { dark: '#141614', light: '#ffffff' } })
  root.querySelector('.code-copy')?.addEventListener('click', async () => {
    await copyText(session?.pairingCode ?? '')
  })
  root.querySelector('.end-session')?.addEventListener('click', endSession)
  updateCountdown()
}

function updateCountdown(): void {
  const element = root?.querySelector('.countdown')
  if (!element || !session?.expiresAt) return
  const remaining = Math.max(0, session.expiresAt - Date.now())
  element.textContent = `${String(Math.floor(remaining / 60_000)).padStart(2, '0')}:${String(Math.floor((remaining % 60_000) / 1000)).padStart(2, '0')}`
  if (remaining > 0) window.setTimeout(updateCountdown, 1000)
  else showToast('配对码已失效，请重新创建房间')
}

async function startClient(): Promise<void> {
  if (!session) return
  try {
    cryptoSession ??= session.crypto ? await CryptoSession.restore(session.crypto) : undefined
  } catch {
    showToast('无法恢复端到端加密会话')
    leaveSession()
    return
  }
  if (!cryptoSession) {
    showToast('端到端加密会话不可用')
    leaveSession()
    return
  }
  client = new TransferClient(session)
  transferProtocol = new TransferProtocol({
    cryptoSession,
    sendDirect: frame => peerTransport?.send(frame) ?? false,
    sendDirectBinary: frame => peerTransport?.sendWithBackpressure(frame) ?? Promise.resolve(false),
    sendFallback: envelope => client?.send({ type: 'transfer.fallback', envelope }) ?? false,
    sendImageFallback: async (transferId, bytes) => {
      if (!client) throw new Error('图片回退通道不可用')
      const image = await client.uploadEncryptedImage(transferId, bytes)
      if (!client.send({ type: 'image.fallback', transferId, imageId: image.imageId })) {
        throw new Error('图片回退通知发送失败')
      }
    },
    onText: addTextMessage,
    onImage: addImageMessage,
    onImageProgress: updateImageProgress,
    onError: () => showToast('加密内容认证失败'),
    persistCryptoSession,
    createMessageId: generateUUID,
  })
  client.addEventListener('connected', () => {
    connectionState = 'online'
    updateStatus()
  })
  client.addEventListener('disconnected', () => { connectionState = 'offline'; updateStatus() })
  client.addEventListener('expired', () => { showToast('会话连接已失效'); leaveSession() })
  client.addEventListener('message', (event) => handleServerMessage((event as CustomEvent<ServerMessage>).detail))
  client.connect()
}

function isPeerSignal(message: ServerMessage): message is PeerSignal {
  return message.type === 'webrtc.offer'
    || message.type === 'webrtc.answer'
    || message.type === 'webrtc.ice'
    || message.type === 'webrtc.restart'
}

async function setupPeerTransport(reset = false): Promise<void> {
  if (!client || !cryptoSession || verificationStatus !== 'verified' || !peerOnline) return
  if (peerTransport && !reset) return
  const generation = ++peerSetupGeneration
  peerTransport?.close()
  peerTransport = undefined
  peerTransportState = 'connecting'
  updateStatus()
  try {
    const config = await client.webRtcConfig()
    if (generation !== peerSetupGeneration || !client || !cryptoSession) return
    const transport = new PeerTransport({
      role: cryptoSession.role,
      iceServers: config.iceServers,
      negotiationTimeoutMs: config.negotiationTimeoutMs,
      sendSignal: message => client?.send(message) ?? false,
      createNegotiationId: generateUUID,
    })
    peerTransport = transport
    transport.addEventListener('statechange', () => {
      peerTransportState = transport.state
      void transferProtocol?.handleTransportState(transport.state)
      updateStatus()
    })
    transport.addEventListener('message', event => {
      void transferProtocol?.handleDirect((event as MessageEvent).data)
    })
    for (const signal of pendingPeerSignals.splice(0)) await transport.handleSignal(signal)
    await transport.start()
  } catch {
    if (generation !== peerSetupGeneration) return
    peerTransportState = 'fallback'
    updateStatus()
  }
}

async function sendKeyExchange(): Promise<void> {
  if (!client || !cryptoSession) return
  const proof = await cryptoSession.publicKeyProof()
  client.send({ type: 'key.exchange', publicKey: cryptoSession.publicKey(), ...(proof ? { proof } : {}) })
}

async function initializeKeyExchange(exchanges: KeyExchangeEvent[]): Promise<void> {
  await sendKeyExchange()
  for (const exchange of exchanges) await handleKeyExchange(exchange)
}

async function handleKeyExchange(message: KeyExchangeEvent): Promise<void> {
  if (!cryptoSession || message.senderRole === cryptoSession.role) return
  const hasInvitationSecret = Boolean(session?.crypto?.invitationSecret)
  const usesQrVerification = hasInvitationSecret && Boolean(message.proof)
  if (usesQrVerification && !await cryptoSession.verifyPublicKeyProof(message.senderRole, message.publicKey, message.proof!)) {
    failVerification('密钥验证失败，会话已关闭')
    return
  }
  try {
    if (hasInvitationSecret && !message.proof) cryptoSession.useManualVerification()
    safetyNumber = await cryptoSession.establish(message.publicKey)
    await persistCryptoSession()
    if (usesQrVerification) client?.send({ type: 'verification.confirm', matched: true })
    renderVerificationState()
  } catch {
    failVerification('密钥验证失败，会话已关闭')
  }
}

function startVerificationTimeout(): void {
  if (!session || verificationStatus !== 'pending') return
  session.verificationExpiresAt ??= Date.now() + VERIFICATION_TTL_MS
  setSession(session)
  window.clearTimeout(verificationTimer)
  verificationTimer = window.setTimeout(
    () => failVerification('验证码确认超时，会话已关闭'),
    Math.max(0, session.verificationExpiresAt - Date.now()),
  )
}

function confirmSafetyNumber(matched: boolean): void {
  if (!safetyNumber || verificationStatus !== 'pending') return
  client?.send({ type: 'verification.confirm', matched })
  if (!matched) failVerification('验证码不一致，会话已关闭')
  else {
    locallyConfirmed = true
    renderVerificationState()
  }
}

function failVerification(message: string): void {
  verificationStatus = 'failed'
  client?.send({ type: 'verification.confirm', matched: false })
  showToast(message)
  void client?.close()
  leaveSession()
}

function handleServerMessage(message: ServerMessage): void {
  if (message.type === 'session.ready') {
    messages = []
    peerOnline = message.peerOnline
    verificationStatus = message.verificationStatus
    if (message.roomStatus === 'paired') renderTransfer()
    renderMessages()
    if (message.verificationStatus === 'pending') {
      if (message.roomStatus === 'paired') startVerificationTimeout()
      void initializeKeyExchange(message.keyExchanges)
    } else if (message.verificationStatus === 'verified') {
      void restoreTransferHistory(message.messages)
      void setupPeerTransport(true)
    }
  } else if (message.type === 'room.paired') {
    renderTransfer()
    startVerificationTimeout()
  } else if (message.type === 'key.exchange') {
    void handleKeyExchange(message)
  } else if (message.type === 'verification.status') {
    verificationStatus = message.status
    if (message.status === 'verified') {
      window.clearTimeout(verificationTimer)
      if (session) {
        session.verificationExpiresAt = undefined
        setSession(session)
      }
      void setupPeerTransport()
    }
    renderVerificationState()
  } else if (message.type === 'peer.online') {
    peerOnline = true
    updateStatus()
    if (verificationStatus === 'verified') {
      if (cryptoSession?.role === 'creator' && peerTransport) void peerTransport.restart()
      else void setupPeerTransport()
    }
  } else if (message.type === 'peer.offline') {
    peerOnline = false; updateStatus()
  } else if (isPeerSignal(message)) {
    if (peerTransport) void peerTransport.handleSignal(message)
    else {
      pendingPeerSignals.push(message)
      void setupPeerTransport()
    }
  } else if (message.type === 'message.deliver') {
    void transferProtocol?.handleFallback(message.message)
  } else if (message.type === 'image.deliver') {
    void handleImageDelivery(message)
  } else if (message.type === 'session.closed') {
    showToast('对方已结束会话'); leaveSession()
  } else if (message.type === 'error') {
    showToast(message.error.message)
  }
}

async function handleImageDelivery(message: Extract<ServerMessage, { type: 'image.deliver' }>): Promise<void> {
  if (!client || !transferProtocol) return
  try {
    const bytes = await client.fetchEncryptedImage(message.imageId)
    await transferProtocol.handleImageFallback(bytes, message.senderRole, message.createdAt, message.transferId)
  } catch {
    showToast('加密图片回退接收失败')
  }
}

async function restoreTransferHistory(records: Extract<ServerMessage, { type: 'session.ready' }>['messages']): Promise<void> {
  for (const record of [...records].sort((left, right) => left.createdAt - right.createdAt)) {
    await transferProtocol?.handleFallback(record, true)
  }
  renderMessages()
}

function addTextMessage(event: TransferTextEvent): void {
  ingestMessage({
    id: event.id,
    kind: 'text',
    senderRole: event.senderRole,
    text: event.text,
    createdAt: event.createdAt,
  })
}

function addImageMessage(event: TransferImageEvent): void {
  ingestMessage({
    id: event.id,
    kind: 'image',
    senderRole: event.senderRole,
    image: { fileName: event.fileName, mimeType: event.mimeType, bytes: event.bytes },
    createdAt: event.createdAt,
  })
}

function ingestMessage(message: DisplayMessage): void {
  if (messages.some(existing => existing.id === message.id)) return
  messages.push(message)
  messages.sort(compareDisplayMessages)
  trimRenderedMessages()
  const index = messages.findIndex(existing => existing.id === message.id)
  const list = root?.querySelector<HTMLElement>('.message-list')
  if (list && index === messages.length - 1 && renderedMessageIds.length === messages.length - 1) {
    appendMessageNode(message, messages[index - 1])
    renderedMessageIds.push(message.id)
    toggleEmptyState()
    scrollMessages()
    return
  }
  renderMessages()
}

function trimRenderedMessages(): void {
  const removed = trimOverflow(messages)
  if (!removed.length) return
  const list = root?.querySelector<HTMLElement>('.message-list')
  for (const message of removed) {
    releaseMessageImage(message.id)
    list?.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)?.remove()
    renderedMessageIds.shift()
  }
}

function compareDisplayMessages(left: DisplayMessage, right: DisplayMessage): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

function updateImageProgress(event: TransferImageProgressEvent): void {
  if (event.direction !== 'sending') return
  const progress = root?.querySelector<HTMLElement>('.image-preview .transfer-progress')
  if (progress) progress.textContent = `${formatBytes(event.transferredBytes)} / ${formatBytes(event.totalBytes)}`
}

function renderTransfer(): void {
  if (!root) return
  root.innerHTML = `
    <main class="workspace">
      <header class="workspace-header"><div class="brand"><span class="brand-mark">T</span><span>临时传送</span></div><div class="connection-pill"><span></span><b>连接中</b></div><button class="text-button end-session" type="button">结束会话</button></header>
      <section class="messages" aria-live="polite"><div class="verification-panel"></div><div class="empty-state"><div class="empty-icon">${icon('send')}</div><h2>传输空间已就绪</h2><p>发送一段文字，或选择一张图片</p></div><div class="message-list"></div></section>
      <section class="composer">
        <div class="image-preview"></div>
        <div class="composer-row">
          <label class="icon-button file-button" title="选择图片">${icon('image')}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" /></label>
          <div class="text-box"><textarea maxlength="${MAX_TEXT_LENGTH}" rows="1" placeholder="输入要传送的文字"></textarea><span class="counter">0/${MAX_TEXT_LENGTH}</span></div>
          <button class="send-button" type="button" title="发送">${icon('send')}</button>
        </div>
      </section>
    </main>`
  root.querySelector('.end-session')?.addEventListener('click', endSession)
  root.querySelector<HTMLInputElement>('input[type=file]')?.addEventListener('change', selectImage)
  const textarea = root.querySelector<HTMLTextAreaElement>('textarea')
  textarea?.addEventListener('input', () => {
    const counter = root.querySelector('.counter')
    if (counter) counter.textContent = `${textarea.value.length}/${MAX_TEXT_LENGTH}`
  })
  textarea?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendContent() }
  })
  root.querySelector('.send-button')?.addEventListener('click', sendContent)
  updateStatus()
  renderVerificationState()
  renderMessages()
}

function renderVerificationState(): void {
  const panel = root?.querySelector<HTMLElement>('.verification-panel')
  const controls = root?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('.composer input, .composer textarea, .composer .send-button')
  const verified = verificationStatus === 'verified'
  controls?.forEach(control => { control.disabled = !verified })
  if (!panel) return
  if (verified) {
    panel.className = 'verification-panel verified'
    panel.textContent = '端到端加密已验证'
    return
  }
  if (session?.crypto?.invitationSecret) {
    panel.className = 'verification-panel pending'
    panel.textContent = safetyNumber ? '正在等待双方完成二维码密钥验证' : '正在建立端到端加密会话'
    return
  }
  panel.className = 'verification-panel pending'
  if (!safetyNumber) {
    panel.textContent = '正在生成安全验证码'
    return
  }
  panel.innerHTML = `<p>请在两台设备上核对安全验证码</p><strong>${safetyNumber}</strong><div><button class="secondary safety-match" type="button">验证码一致</button><button class="text-button safety-mismatch" type="button">验证码不一致</button></div>${locallyConfirmed ? '<small>已确认，正在等待另一台设备</small>' : ''}`
  panel.querySelector('.safety-match')?.addEventListener('click', () => confirmSafetyNumber(true))
  panel.querySelector('.safety-mismatch')?.addEventListener('click', () => confirmSafetyNumber(false))
}

function updateStatus(): void {
  const pill = root?.querySelector('.connection-pill')
  if (!pill) return
  const label = pill.querySelector('b')
  const state = peerTransportState === 'direct' ? 'online' : connectionState
  pill.className = `connection-pill ${state}`
  if (!label) return
  if (peerTransportState === 'direct') label.textContent = '设备直连'
  else if (connectionState === 'offline') label.textContent = '信令重连中'
  else if (!peerOnline) label.textContent = '等待对方上线'
  else if (peerTransportState === 'fallback') label.textContent = '加密中转'
  else label.textContent = '正在建立直连'
}

function renderMessages(): void {
  const container = root?.querySelector<HTMLElement>('.messages')
  const list = root?.querySelector<HTMLElement>('.message-list')
  if (!container || !list || !client) return
  for (const url of messageImageUrlsById.values()) URL.revokeObjectURL(url)
  messageImageUrlsById.clear()
  list.innerHTML = ''
  renderedMessageIds.length = 0
  toggleEmptyState()
  let previous: DisplayMessage | undefined
  for (const message of messages) {
    appendMessageNode(message, previous)
    renderedMessageIds.push(message.id)
    previous = message
  }
  scrollMessages()
}

function appendMessageNode(message: DisplayMessage, previous: DisplayMessage | undefined): void {
  const list = root?.querySelector<HTMLElement>('.message-list')
  if (!list) return
  const mine = message.senderRole === cryptoSession?.role
  const grouped = isGroupedWithPrevious(previous, message)
  const item = document.createElement('article')
  item.className = `message-item ${mine ? 'mine' : 'theirs'}${grouped ? ' grouped' : ''}`
  item.dataset.messageId = message.id
  const meta = document.createElement('div')
  meta.className = 'message-meta'
  meta.textContent = `${mine ? '我' : '对方'} · ${new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  item.append(meta)
  if (message.kind === 'text') {
    const content = document.createElement('pre')
    content.textContent = message.text ?? ''
    const copy = document.createElement('button')
    copy.className = 'icon-button message-action'
    copy.title = '复制文字'
    copy.innerHTML = icon('copy')
    copy.addEventListener('click', () => { void copyText(message.text ?? '') })
    item.append(content, copy)
  } else if (message.image) {
    const image = document.createElement('div')
    image.className = 'image-message'
    image.innerHTML = `<div class="image-placeholder">${icon('image')}</div><div><strong></strong><small>${formatBytes(message.image.bytes.length)}</small></div>`
    image.querySelector('strong')!.textContent = message.image.fileName
    const download = document.createElement('button')
    download.className = 'icon-button message-action'
    download.title = '下载图片'
    download.innerHTML = icon('download')
    download.addEventListener('click', () => downloadImage(message.image!))
    item.append(image, download)
    loadImagePreview(message.id, image, message.image)
  }
  list.append(item)
}

function toggleEmptyState(): void {
  root?.querySelector('.empty-state')?.toggleAttribute('hidden', messages.length > 0)
}

function scrollMessages(): void {
  const container = root?.querySelector<HTMLElement>('.messages')
  if (container) container.scrollTop = container.scrollHeight
}

function releaseMessageImage(messageId: string): void {
  const url = messageImageUrlsById.get(messageId)
  if (!url) return
  URL.revokeObjectURL(url)
  messageImageUrlsById.delete(messageId)
}

function loadImagePreview(messageId: string, target: HTMLElement, image: NonNullable<DisplayMessage['image']>): void {
  const url = URL.createObjectURL(new Blob([image.bytes], { type: image.mimeType }))
  messageImageUrlsById.set(messageId, url)
  const preview = document.createElement('img')
  preview.src = url
  preview.alt = image.fileName
  target.querySelector('.image-placeholder')?.replaceWith(preview)
}

function downloadImage(image: NonNullable<DisplayMessage['image']>): void {
  const url = URL.createObjectURL(new Blob([image.bytes], { type: image.mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = image.fileName
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function selectImage(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > MAX_IMAGE_BYTES) { showToast('图片大小不能超过 10 MB'); return }
  if (pendingImagePreviewUrl) URL.revokeObjectURL(pendingImagePreviewUrl)
  pendingImagePreviewUrl = URL.createObjectURL(file)
  pendingImage = file
  const preview = root?.querySelector<HTMLElement>('.image-preview')
  if (preview) {
    preview.innerHTML = `<div><img src="${pendingImagePreviewUrl}" alt=""><span><strong></strong><small class="transfer-progress">${formatBytes(file.size)}</small></span><button class="icon-button" title="移除图片">${icon('x')}</button></div>`
    preview.querySelector('strong')!.textContent = file.name
    preview.querySelector('button')?.addEventListener('click', () => {
      pendingImage = undefined
      if (pendingImagePreviewUrl) URL.revokeObjectURL(pendingImagePreviewUrl)
      pendingImagePreviewUrl = undefined
      preview.innerHTML = ''
    })
  }
}

function sendContent(): Promise<void> {
  sendQueue = sendQueue.then(sendContentNow, sendContentNow)
  return sendQueue
}

async function sendContentNow(): Promise<void> {
  const textarea = root?.querySelector<HTMLTextAreaElement>('textarea')
  if (!client || !textarea) return
  const text = textarea.value
  if (!text.trim() && !pendingImage) { showToast('请输入文字或选择图片'); return }
  try {
    if (text.trim()) {
      await transferProtocol?.sendText(text)
      textarea.value = ''
      const counter = root?.querySelector('.counter')
      if (counter) counter.textContent = `0/${MAX_TEXT_LENGTH}`
    }
    if (pendingImage) {
      const image = pendingImage
      await transferProtocol?.sendImage(image)
      pendingImage = undefined
      if (pendingImagePreviewUrl) URL.revokeObjectURL(pendingImagePreviewUrl)
      pendingImagePreviewUrl = undefined
      const preview = root?.querySelector<HTMLElement>('.image-preview')
      if (preview) preview.innerHTML = ''
      const input = root?.querySelector<HTMLInputElement>('input[type=file]')
      if (input) input.value = ''
    }
  } catch (error) {
    showToast(errorMessage(error) === '操作失败，请稍后重试' ? '连接中断，内容发送失败' : errorMessage(error))
  }
}

async function endSession(): Promise<void> {
  await client?.close()
  leaveSession()
}

function leaveSession(): void {
  window.clearTimeout(verificationTimer)
  peerSetupGeneration += 1
  peerTransport?.close()
  peerTransport = undefined
  transferProtocol?.close()
  transferProtocol = undefined
  peerTransportState = 'connecting'
  pendingPeerSignals.length = 0
  client?.disconnect()
  cryptoSession?.destroy()
  cryptoSession = undefined
  safetyNumber = undefined
  verificationStatus = 'pending'
  locallyConfirmed = false
  if (pendingImagePreviewUrl) URL.revokeObjectURL(pendingImagePreviewUrl)
  for (const url of messageImageUrlsById.values()) URL.revokeObjectURL(url)
  messageImageUrlsById.clear()
  renderedMessageIds.length = 0
  pendingImagePreviewUrl = undefined
  pendingImage = undefined
  client = undefined
  messages = []
  setSession()
  history.replaceState({}, '', '/')
  renderHome()
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

try {
  const stored = sessionStorage.getItem(SESSION_KEY)
  if (stored) {
    setSession(JSON.parse(stored) as StoredSession)
    session?.pairingCode ? void renderPairing() : renderTransfer()
    void startClient()
  } else renderHome()
} catch {
  setSession()
  renderHome()
}

window.addEventListener('pagehide', () => {
  peerTransport?.close()
  transferProtocol?.close()
  client?.disconnect()
  cryptoSession?.destroy()
})
