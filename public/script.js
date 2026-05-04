// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(reg => console.log('SW Registered')).catch(err => console.log('SW Error', err));
    });
}

// Mobile keyboard fix
function setVH() { 
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`); 
}
setVH(); 
window.addEventListener('resize', setVH);

// State
let currentUser = null;
let peerUser = null;
let roomId = null;
let typingTimeout = null;
let replyingTo = null;
let selectedMessageId = null;
let currentFacingMode = 'user';
let isMuted = false;
let isCamOff = false;
let callTimerInt = null;
let callSeconds = 0;
let audioCtx = null;
let ringToneInt = null;
let messageQueue = []; // Queue for unsent messages

// Socket Configuration (Ultra-aggressive for tunnels)
const socket = io({ 
    autoConnect: false, 
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2000,
    timeout: 10000
});

/* ============================================================
   AUTH & INITIALIZATION
============================================================ */

window.initApp = function(user, peer) {
    currentUser = user.toLowerCase().trim();
    peerUser = peer.toLowerCase().trim();
    roomId = [currentUser, peerUser].sort().join('-');

    // Save to localStorage for persistence (Like WhatsApp)
    localStorage.setItem('chat_user', currentUser);
    localStorage.setItem('chat_peer', peerUser);

    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    
    document.getElementById('peer-name').innerText = peerUser.charAt(0).toUpperCase() + peerUser.slice(1);
    document.getElementById('peer-avatar').innerText = peerUser.charAt(0).toUpperCase();
    document.getElementById('self-name-badge').innerText = `You: ${currentUser.charAt(0).toUpperCase() + currentUser.slice(1)}`;

    // Load cached messages while connecting
    const cached = localStorage.getItem(`cache_${roomId}`);
    if (cached) {
        const msgs = JSON.parse(cached);
        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById('chat-messages').innerHTML = '';
        msgs.forEach(addMessageToUI);
        scrollToBottom();
    }

    socket.connect();
    setupUIListeners();
    showToast(`Welcome back, ${currentUser}`);
};

// Auto-Login on startup
window.addEventListener('load', () => {
    const savedUser = localStorage.getItem('chat_user');
    const savedPeer = localStorage.getItem('chat_peer');
    if (savedUser && savedPeer) {
        window.initApp(savedUser, savedPeer);
    }
});

if (window.pendingUserChoice) {
    window.initApp(window.pendingUserChoice.user, window.pendingUserChoice.peer);
}

document.getElementById('logout-btn').addEventListener('click', () => {
    if (confirm('Switch user?')) {
        socket.disconnect();
        localStorage.clear();
        window.location.reload();
    }
});

document.getElementById('share-btn').addEventListener('click', () => {
    const url = window.location.origin;
    navigator.clipboard.writeText(url).then(() => {
        showToast('Link copied! Share it.');
    }).catch(() => {
        showToast('Copy URL manually.');
    });
});

/* ============================================================
   SOCKET EVENTS
============================================================ */

socket.on('connect', () => {
    document.getElementById('connecting-banner').classList.add('hidden');
    document.getElementById('status').innerText = 'Online';
    document.getElementById('status').classList.add('online');
    document.getElementById('peer-dot').classList.add('online');
    
    if (currentUser) {
        socket.emit('join-room', { user: currentUser, peer: peerUser, roomId });
        // Send queued messages
        processMessageQueue();
    }
});

socket.on('disconnect', () => {
    document.getElementById('connecting-banner').classList.remove('hidden');
    document.getElementById('status').innerText = 'Connecting...';
    document.getElementById('status').classList.remove('online');
    document.getElementById('peer-dot').classList.remove('online');
});

socket.on('init-messages', (msgs) => {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    if (msgs.length > 0) {
        document.getElementById('empty-state').classList.add('hidden');
        msgs.forEach(addMessageToUI);
        scrollToBottom();
        // Update local cache
        localStorage.setItem(`cache_${roomId}`, JSON.stringify(msgs));
    }
});

socket.on('new-message', (msg) => {
    document.getElementById('empty-state').classList.add('hidden');
    addMessageToUI(msg);
    scrollToBottom();
    
    // Update local cache
    const cached = JSON.parse(localStorage.getItem(`cache_${roomId}`) || '[]');
    cached.push(msg);
    localStorage.setItem(`cache_${roomId}`, JSON.stringify(cached.slice(-200)));

    if (msg.sender !== currentUser) {
        socket.emit('message-status-update', { roomId, messageId: msg.id, status: 'read' });
        playMessageSound();
        if (navigator.vibrate) navigator.vibrate(80);
    }
});

socket.on('message-status-changed', ({ messageId, status }) => {
    const el = document.getElementById(`ticks-${messageId}`);
    if (el) {
        el.className = `ticks ${status}`;
        if (status === 'delivered' || status === 'read') el.innerText = '✓✓';
    }
});

socket.on('peer-online', ({ user }) => {
    document.getElementById('status').innerText = 'Online';
    document.getElementById('peer-dot').classList.add('online');
});

socket.on('peer-typing', () => document.getElementById('typing-indicator').classList.remove('hidden'));
socket.on('peer-stop-typing', () => document.getElementById('typing-indicator').classList.add('hidden'));

/* ============================================================
   MESSAGE ACTIONS
============================================================ */

function sendMessage() {
    try {
        const input = document.getElementById('message-input');
        const text = input.value.trim();
        if (!text) return;
        
        const msgId = 'm-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
        const msg = {
            id: msgId, 
            roomId, 
            text, 
            sender: currentUser, 
            type: 'text', 
            replyTo: replyingTo ? { ...replyingTo } : null,
            status: 'pending', 
            timestamp: new Date().toISOString()
        };
        
        // Clear UI immediately for speed
        input.value = '';
        input.style.height = 'auto';
        clearReply();
        
        // Optimistic UI Update
        document.getElementById('empty-state').classList.add('hidden');
        addMessageToUI(msg);
        scrollToBottom();
        
        // Send or Queue
        if (socket.connected) {
            emitMessage(msg);
        } else {
            messageQueue.push(msg);
            showToast('Message will send when online...');
            socket.connect(); // Force reconnect attempt
        }
    } catch (err) {
        console.error(err);
        showToast('Error sending message. Please refresh.');
    }
}

function emitMessage(msg) {
    socket.emit('send-message', msg, (ack) => {
        if (ack && ack.status === 'sent') {
            const el = document.getElementById(`ticks-${msg.id}`);
            if (el) { el.innerText = '✓'; el.className = 'ticks sent'; }
        }
    });
}

function processMessageQueue() {
    while (messageQueue.length > 0) {
        const msg = messageQueue.shift();
        emitMessage(msg);
    }
}

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        const type = file.type.startsWith('image/') ? 'image' : 'file';
        const msgId = 'f-' + Date.now();
        const msg = { id: msgId, roomId, sender: currentUser, type, fileName: file.name, fileData: reader.result, status: 'pending', timestamp: new Date() };
        addMessageToUI(msg);
        socket.emit('send-message', msg);
    };
    reader.readAsDataURL(file);
}

function addMessageToUI(msg) {
    if (document.querySelector(`.message[data-id="${msg.id}"]`)) return;
    const container = document.getElementById('chat-messages');
    const isMine = msg.sender === currentUser;
    const div = document.createElement('div');
    div.className = `message ${isMine ? 'mine' : 'theirs'}`;
    div.dataset.id = msg.id;

    let content = '';
    if (msg.replyTo) {
        content += `<div class="quoted-reply"><div class="q-sender">${msg.replyTo.sender}</div><div class="q-text">${escapeHtml(msg.replyTo.text)}</div></div>`;
    }
    if (msg.type === 'text') content += `<span class="text">${escapeHtml(msg.text)}</span>`;
    else if (msg.type === 'image') content += `<img src="${msg.fileData}" class="media-img" onclick="showLightbox('${msg.fileData}')">`;
    else if (msg.type === 'file') content += `<a href="${msg.fileData}" download="${msg.fileName}" class="media-file">📁 ${msg.fileName}</a>`;

    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let ticksHtml = isMine ? `<span class="ticks ${msg.status}" id="ticks-${msg.id}">${msg.status === 'pending' ? '◷' : '✓'}</span>` : '';
    div.innerHTML = `${content}<div class="msg-meta"><span class="timestamp">${time}</span>${ticksHtml}</div>`;
    
    div.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e, msg.id, isMine); };
    container.appendChild(div);
}

/* ============================================================
   UTILITIES & CALLS (Kept same)
============================================================ */
function setupUIListeners() {
    const input = document.getElementById('message-input');
    document.getElementById('send-btn').onclick = sendMessage;
    input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
    input.oninput = () => { socket.emit('typing', { roomId, user: currentUser }); clearTimeout(typingTimeout); typingTimeout = setTimeout(() => socket.emit('stop-typing', { roomId, user: currentUser }), 2000); };
    document.getElementById('close-reply-btn').onclick = clearReply;
    document.getElementById('media-btn').onclick = () => document.getElementById('file-input').click();
    document.getElementById('file-input').onchange = handleFileUpload;
    document.getElementById('lightbox-close').onclick = () => document.getElementById('lightbox').classList.add('hidden');
    document.getElementById('video-call-btn').onclick = startCall;
    document.getElementById('accept-call-btn').onclick = acceptCall;
    document.getElementById('decline-call-btn').onclick = declineCall;
    document.getElementById('btn-end-call').onclick = endCall;
    document.getElementById('btn-mute').onclick = toggleMute;
    document.getElementById('btn-toggle-cam').onclick = toggleCam;
    document.getElementById('btn-flip-cam').onclick = flipCamera;
    document.getElementById('btn-fullscreen').onclick = toggleFullscreen;
    setupDraggableVideo();
}

async function startCall() { socket.emit('call-request', { roomId, from: currentUser }); document.getElementById('outgoing-name').innerText = peerUser; document.getElementById('outgoing-call-modal').classList.remove('hidden'); startRingtone(true); }
async function acceptCall() { stopRingtone(); document.getElementById('incoming-call-modal').classList.add('hidden'); await startCallUI(); await setupPeerConnection(false); socket.emit('call-accepted', { roomId, from: currentUser }); }
function declineCall() { stopRingtone(); document.getElementById('incoming-call-modal').classList.add('hidden'); socket.emit('call-declined', { roomId, from: currentUser }); }
function endCall() { socket.emit('call-ended', { roomId }); endCallUI(); }

async function startCallUI() {
    document.getElementById('outgoing-call-modal').classList.add('hidden');
    document.getElementById('video-overlay').classList.remove('hidden');
    callSeconds = 0; callTimerInt = setInterval(() => { callSeconds++; const m = String(Math.floor(callSeconds / 60)).padStart(2, '0'); const s = String(callSeconds % 60).padStart(2, '0'); document.getElementById('call-timer').innerText = `${m}:${s}`; }, 1000);
    try { localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode }, audio: true }); document.getElementById('local-video').srcObject = localStream; } catch (err) { showToast('Camera Error'); endCallUI(); }
}

async function setupPeerConnection(isCaller) {
    peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    if (localStream) localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    peerConnection.ontrack = (e) => document.getElementById('remote-video').srcObject = e.streams[0];
    peerConnection.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { roomId, sender: currentUser, signal: e.candidate }); };
    if (isCaller) { const offer = await peerConnection.createOffer(); await peerConnection.setLocalDescription(offer); socket.emit('signal', { roomId, sender: currentUser, signal: offer }); }
}

function endCallUI() { if (localStream) localStream.getTracks().forEach(t => t.stop()); if (peerConnection) peerConnection.close(); clearInterval(callTimerInt); document.getElementById('video-overlay').classList.add('hidden'); localStream = null; }
function toggleMute() { isMuted = !isMuted; localStream.getAudioTracks().forEach(t => t.enabled = !isMuted); document.getElementById('btn-mute').classList.toggle('muted', isMuted); }
function toggleCam() { isCamOff = !isCamOff; localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff); document.getElementById('btn-toggle-cam').classList.toggle('off', isCamOff); }
async function flipCamera() { currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user'; endCallUI(); startCallUI(); }
function toggleFullscreen() { const el = document.getElementById('video-overlay'); if (!document.fullscreenElement) el.requestFullscreen().catch(()=>{}); else document.exitFullscreen(); }

function showContextMenu(e, id, isMine) { selectedMessageId = id; const menu = document.getElementById('context-menu'); menu.classList.remove('hidden'); const x = e.touches ? e.touches[0].clientX : e.clientX; const y = e.touches ? e.touches[0].clientY : e.clientY; menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`; menu.style.top = `${y}px`; document.getElementById('ctx-delete-all').style.display = isMine ? 'block' : 'none'; }
function clearReply() { replyingTo = null; document.getElementById('reply-preview').classList.add('hidden'); }
function showToast(msg) { const t = document.getElementById('toast'); t.innerText = msg; t.classList.add('show'); t.classList.remove('hidden'); setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 300); }, 3000); }
function showLightbox(src) { document.getElementById('lightbox-img').src = src; document.getElementById('lightbox').classList.remove('hidden'); }
function escapeHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function scrollToBottom() { const c = document.getElementById('chat-messages'); c.scrollTop = c.scrollHeight; }
function startRingtone(isOutgoing) { if (!audioCtx) audioCtx = new AudioContext(); stopRingtone(); ringToneInt = setInterval(() => { const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain(); osc.connect(gain); gain.connect(audioCtx.destination); osc.frequency.value = isOutgoing ? 440 : 600; gain.gain.setValueAtTime(0.1, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5); osc.start(); osc.stop(audioCtx.currentTime + 0.5); }, 1000); }
function stopRingtone() { clearInterval(ringToneInt); }
function setupDraggableVideo() { const v = document.getElementById('local-video'); let dragging = false, sx, sy, ix, iy; v.onpointerdown = (e) => { dragging = true; sx = e.clientX; sy = e.clientY; const r = v.getBoundingClientRect(); v.style.left = r.left + 'px'; v.style.top = r.top + 'px'; v.style.right = 'auto'; v.style.bottom = 'auto'; ix = r.left; iy = r.top; v.setPointerCapture(e.pointerId); }; v.onpointermove = (e) => { if (!dragging) return; v.style.left = (ix + e.clientX - sx) + 'px'; v.style.top = (iy + e.clientY - sy) + 'px'; }; v.onpointerup = (e) => { dragging = false; v.releasePointerCapture(e.pointerId); }; }

function playMessageSound() { try { if (!audioCtx) audioCtx = new AudioContext(); const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain(); osc.connect(gain); gain.connect(audioCtx.destination); osc.type = 'sine'; osc.frequency.setValueAtTime(880, audioCtx.currentTime); gain.gain.setValueAtTime(0.1, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1); osc.start(); osc.stop(audioCtx.currentTime + 0.1); } catch(e) {} }
