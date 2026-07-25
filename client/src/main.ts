import QRCode from 'qrcode'

import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_LENGTH,
  type ApiError,
  type MessageDeliverEvent,
  type ServerMessage,
} from '../../shared/protocol.js'
import { TransferClient, type StoredSession } from './transfer-client.js'

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
let messages: MessageDeliverEvent['message'][] = []
let connectionState: 'connecting' | 'online' | 'offline' = 'connecting'
let peerOnline = false
let pendingImage: File | undefined
let pendingImagePreviewUrl: string | undefined
const messageImageUrls = new Set<string>()

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
    const created = await TransferClient.createRoom()
    setSession(created)
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
  try {
    const joined = await TransferClient.joinRoom(input.value)
    setSession(joined)
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
  if (canvas && session.joinUrl) await QRCode.toCanvas(canvas, session.joinUrl, { width: 220, margin: 1, color: { dark: '#141614', light: '#ffffff' } })
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

function startClient(): void {
  if (!session) return
  client = new TransferClient(session)
  client.addEventListener('connected', () => { connectionState = 'online'; updateStatus() })
  client.addEventListener('disconnected', () => { connectionState = 'offline'; updateStatus() })
  client.addEventListener('expired', () => { showToast('会话连接已失效'); leaveSession() })
  client.addEventListener('message', (event) => handleServerMessage((event as CustomEvent<ServerMessage>).detail))
  client.connect()
}

function handleServerMessage(message: ServerMessage): void {
  if (message.type === 'session.ready') {
    messages = message.messages
    peerOnline = message.peerOnline
    if (message.roomStatus === 'paired') renderTransfer()
    renderMessages()
  } else if (message.type === 'room.paired') {
    renderTransfer()
  } else if (message.type === 'peer.online') {
    peerOnline = true; updateStatus()
  } else if (message.type === 'peer.offline') {
    peerOnline = false; updateStatus()
  } else if (message.type === 'message.deliver') {
    if (!messages.some((item) => item.id === message.message.id)) messages.push(message.message)
    renderMessages()
  } else if (message.type === 'session.closed') {
    showToast('对方已结束会话'); leaveSession()
  } else if (message.type === 'error') {
    showToast(message.error.message)
  }
}

function renderTransfer(): void {
  if (!root) return
  root.innerHTML = `
    <main class="workspace">
      <header class="workspace-header"><div class="brand"><span class="brand-mark">T</span><span>临时传送</span></div><div class="connection-pill"><span></span><b>连接中</b></div><button class="text-button end-session" type="button">结束会话</button></header>
      <section class="messages" aria-live="polite"><div class="empty-state"><div class="empty-icon">${icon('send')}</div><h2>传输空间已就绪</h2><p>发送一段文字，或选择一张图片</p></div></section>
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
  renderMessages()
}

function updateStatus(): void {
  const pill = root?.querySelector('.connection-pill')
  if (!pill) return
  const label = pill.querySelector('b')
  pill.className = `connection-pill ${connectionState}`
  if (label) label.textContent = connectionState === 'offline' ? '正在重连' : peerOnline ? '两台设备在线' : '等待对方上线'
}

function renderMessages(): void {
  const container = root?.querySelector<HTMLElement>('.messages')
  if (!container || !client) return
  if (messages.length === 0) return
  for (const url of messageImageUrls) URL.revokeObjectURL(url)
  messageImageUrls.clear()
  container.innerHTML = ''
  for (const message of messages) {
    const item = document.createElement('article')
    item.className = 'message-item'
    const meta = document.createElement('div')
    meta.className = 'message-meta'
    meta.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
      image.innerHTML = `<div class="image-placeholder">${icon('image')}</div><div><strong></strong><small>${formatBytes(message.image.size)}</small></div>`
      image.querySelector('strong')!.textContent = message.image.fileName
      const download = document.createElement('button')
      download.className = 'icon-button message-action'
      download.title = '下载图片'
      download.innerHTML = icon('download')
      download.addEventListener('click', () => downloadImage(message.image!.imageId, message.image!.fileName))
      item.append(image, download)
      void loadImagePreview(image, message.image.imageId)
    }
    container.append(item)
  }
  container.scrollTop = container.scrollHeight
}

async function loadImagePreview(target: HTMLElement, imageId: string): Promise<void> {
  if (!client) return
  try {
    const blob = await client.fetchImage(imageId)
    const url = URL.createObjectURL(blob)
    messageImageUrls.add(url)
    const preview = document.createElement('img')
    preview.src = url
    preview.alt = ''
    preview.addEventListener('load', () => target.querySelector('.image-placeholder')?.replaceWith(preview))
    preview.addEventListener('click', () => window.open(url, '_blank', 'noopener'))
  } catch { /* The session may have ended while loading. */ }
}

async function downloadImage(imageId: string, fileName: string): Promise<void> {
  if (!client) return
  const blob = await client.fetchImage(imageId)
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(blob)
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 1000)
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
    preview.innerHTML = `<div><img src="${pendingImagePreviewUrl}" alt=""><span><strong></strong><small>${formatBytes(file.size)}</small></span><button class="icon-button" title="移除图片">${icon('x')}</button></div>`
    preview.querySelector('strong')!.textContent = file.name
    preview.querySelector('button')?.addEventListener('click', () => {
      pendingImage = undefined
      if (pendingImagePreviewUrl) URL.revokeObjectURL(pendingImagePreviewUrl)
      pendingImagePreviewUrl = undefined
      preview.innerHTML = ''
    })
  }
}

async function sendContent(): Promise<void> {
  const textarea = root?.querySelector<HTMLTextAreaElement>('textarea')
  if (!client || !textarea) return
  const text = textarea.value
  if (!text.trim() && !pendingImage) { showToast('请输入文字或选择图片'); return }
  try {
    if (text.trim()) {
      const clientMessageId = generateUUID()
      const sent = client.send({ type: 'text.send', clientMessageId, text })
      if (!sent) throw new Error('offline')
      textarea.value = ''
      textarea.dispatchEvent(new Event('input'))
    }
    if (pendingImage) {
      const image = await client.uploadImage(pendingImage)
      const sent = client.send({ type: 'image.send', clientMessageId: generateUUID(), image })
      if (!sent) throw new Error('offline')
      pendingImage = undefined
      if (pendingImagePreviewUrl) URL.revokeObjectURL(pendingImagePreviewUrl)
      pendingImagePreviewUrl = undefined
      const preview = document.querySelector('.image-preview')
      if (preview) preview.innerHTML = ''
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
  if (pendingImagePreviewUrl) URL.revokeObjectURL(pendingImagePreviewUrl)
  for (const url of messageImageUrls) URL.revokeObjectURL(url)
  messageImageUrls.clear()
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
    startClient()
  } else renderHome()
} catch {
  setSession()
  renderHome()
}
