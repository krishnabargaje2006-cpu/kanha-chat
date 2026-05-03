// Mobile keyboard fix
function setVH() { document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`); }
setVH(); window.addEventListener('resize', setVH);

const params = new URLSearchParams(window.location.search);
const currentUser = params.get('user')?.toLowerCase().trim();
const peerUser    = params.get('peer')?.toLowerCase().trim();

// State
let roomId = null;
let typingTimeout = null;
let replyingTo = null; // { id, text, sender }
let selectedMessageId = null;

let currentFacingMode = 'user';
let isMuted = false;
let isCamOff = false;
let callTimerInt = null;
let callSeconds = 0;

const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Socket & WebRTC
const socket = io({ autoConnect: false, transports: ['websocket', 'polling'] });
let peerConnection = null; let localStream = null;

if (!currentUser || !peerUser) {
    document.getElementById('setup-overlay').classList.remove('hidden');
} else {
    roomId = [currentUser, peerUser].sort().join('-');
    document.getElementById('peer-name').innerText = peerUser.charAt(0).toUpperCase() + peerUser.slice(1);
    document.getElementById('peer-avatar').innerText = peerUser.charAt(0).toUpperCase();
    
    // Show Login
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('login-password').focus();
    document.getElementById('login-btn').addEventListener('click', attemptLogin);
    document.getElementById('login-password').addEventListener('keydown', (e) => {
        if(e.key === 'Enter') attemptLogin();
    });
}

async function attemptLogin() {
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    if (!password) return;
    
    try {
        const res = await fetch('/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser, password })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('login-overlay').classList.add('hidden');
            document.getElementById('app').classList.remove('hidden');
            startApp();
        } else {
            errEl.innerText = data.error;
            errEl.classList.remove('hidden');
        }
    } catch (e) {
        errEl.innerText = 'Network error. Try again.';
        errEl.classList.remove('hidden');
    }
}

function startApp() {
    socket.connect();
    setupUIListeners();
}

function escapeHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function scrollToBottom() { const c = document.getElementById('chat-messages'); c.scrollTop = c.scrollHeight; }

// --- Socket Events ---
socket.on('connect', () => {
    document.getElementById('connecting-banner').classList.add('hidden');
    document.getElementById('status').innerText = 'Online';
    document.getElementById('status').classList.add('online');
    socket.emit('join-room', { user: currentUser, peer: peerUser, roomId });
});

socket.on('disconnect', () => {
    document.getElementById('connecting-banner').classList.remove('hidden');
    document.getElementById('status').innerText = 'Offline';
    document.getElementById('status').classList.remove('online');
});

socket.on('init-messages', (msgs) => {
    document.getElementById('chat-messages').innerHTML = '';
    msgs.forEach(addMessageToUI);
    scrollToBottom();
    // Mark them all as read if we just loaded them
    msgs.filter(m => m.sender !== currentUser && m.status !== 'read').forEach(m => {
        socket.emit('message-status-update', { roomId, messageId: m.id, status: 'read' });
    });
});

socket.on('new-message', (msg) => {
    addMessageToUI(msg);
    scrollToBottom();
    // Automatically send 'read' receipt since we are in the chat
    if (msg.sender !== currentUser) {
        socket.emit('message-status-update', { roomId, messageId: msg.id, status: 'read' });
    }
});

socket.on('message-status-changed', ({ messageId, status }) => {
    const el = document.getElementById(`ticks-${messageId}`);
    if (el) {
        if (status === 'delivered') { el.innerText = '✓✓'; el.className = 'ticks delivered'; }
        if (status === 'read') { el.innerText = '✓✓'; el.className = 'ticks read'; }
    }
});

socket.on('peer-online',  () => { document.getElementById('status').innerText = 'Online'; document.getElementById('status').classList.add('online'); });
socket.on('peer-offline', () => { document.getElementById('status').innerText = 'Offline'; document.getElementById('status').classList.remove('online'); });

socket.on('peer-typing', () => document.getElementById('typing-indicator').classList.remove('hidden'));
socket.on('peer-stop-typing', () => document.getElementById('typing-indicator').classList.add('hidden'));

socket.on('chat-cleared', () => { document.getElementById('chat-messages').innerHTML = '<div class="date-divider">Chat cleared 🗑️</div>'; });
socket.on('message-deleted', ({ messageId }) => {
    const el = document.querySelector(`.message[data-id="${messageId}"]`);
    if (el) { el.innerHTML = 'This message was deleted'; el.className = 'message deleted'; }
});

// --- Call Signaling Events ---
socket.on('incoming-call', ({ from }) => {
    document.getElementById('caller-name').innerText = from.charAt(0).toUpperCase() + from.slice(1);
    document.getElementById('caller-avatar').innerText = from.charAt(0).toUpperCase();
    document.getElementById('incoming-call-modal').classList.remove('hidden');
});

socket.on('call-accepted', async () => {
    document.getElementById('outgoing-status').innerText = 'Connecting...';
    await startCallUI();
    await setupPeerConnection(true);
});

socket.on('call-declined', () => {
    document.getElementById('outgoing-status').innerText = 'Call Declined';
    setTimeout(() => {
        document.getElementById('outgoing-call-modal').classList.add('hidden');
    }, 2000);
});

socket.on('call-ended', () => {
    document.getElementById('outgoing-call-modal').classList.add('hidden');
    document.getElementById('incoming-call-modal').classList.add('hidden');
    endCallUI();
});

socket.on('signal', async (data) => {
    if (!peerConnection) await setupPeerConnection(false);
    try {
        if (data.signal.type === 'offer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('signal', { roomId, sender: currentUser, signal: answer });
        } else if (data.signal.type === 'answer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.signal));
        } else if (data.signal.candidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.signal));
        }
    } catch (err) { console.error(err); }
});

// --- UI Listeners ---
function setupUIListeners() {
    const input = document.getElementById('message-input');
    
    document.getElementById('send-btn').addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    
    // Typing indicator logic
    input.addEventListener('input', () => {
        socket.emit('typing', { roomId, user: currentUser });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => socket.emit('stop-typing', { roomId, user: currentUser }), 1500);
    });

    input.addEventListener('focus', () => setTimeout(scrollToBottom, 350));
    
    document.getElementById('close-reply-btn').addEventListener('click', clearReply);
    document.getElementById('clear-chat-btn').addEventListener('click', () => {
        if (confirm('Clear entire chat for everyone?')) socket.emit('clear-chat', { roomId });
    });

    // Media
    document.getElementById('media-btn').addEventListener('click', () => document.getElementById('file-input').click());
    document.getElementById('file-input').addEventListener('change', handleFileUpload);
    document.getElementById('lightbox-close').addEventListener('click', () => document.getElementById('lightbox').classList.add('hidden'));

    // Context Menu
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#context-menu')) document.getElementById('context-menu').classList.add('hidden');
    });
    document.getElementById('ctx-reply').addEventListener('click', () => {
        const msgEl = document.querySelector(`.message[data-id="${selectedMessageId}"]`);
        if (msgEl) {
            const sender = msgEl.classList.contains('mine') ? 'You' : peerUser;
            let text = msgEl.querySelector('.text')?.innerText || 'Media';
            setReply(selectedMessageId, text, sender);
        }
        document.getElementById('context-menu').classList.add('hidden');
    });
    document.getElementById('ctx-delete-me').addEventListener('click', () => {
        const el = document.querySelector(`.message[data-id="${selectedMessageId}"]`);
        if (el) el.remove();
    });
    document.getElementById('ctx-delete-all').addEventListener('click', () => {
        socket.emit('delete-message', { roomId, messageId: selectedMessageId, deleteFor: 'everyone' });
        document.getElementById('context-menu').classList.add('hidden');
    });

    // Call UI Buttons
    document.getElementById('accept-call-btn').addEventListener('click', async () => {
        document.getElementById('incoming-call-modal').classList.add('hidden');
        await startCallUI();
        await setupPeerConnection(false);
        socket.emit('call-accepted', { roomId, from: currentUser });
    });
    document.getElementById('decline-call-btn').addEventListener('click', () => {
        document.getElementById('incoming-call-modal').classList.add('hidden');
        socket.emit('call-declined', { roomId, from: currentUser });
    });
    document.getElementById('btn-end-call').addEventListener('click', () => {
        socket.emit('call-ended', { roomId });
        endCallUI();
    });
    document.getElementById('btn-mute').addEventListener('click', toggleMute);
    document.getElementById('btn-toggle-cam').addEventListener('click', toggleCam);
    document.getElementById('btn-flip-cam').addEventListener('click', flipCamera);
    document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
}

// --- Replying ---
function setReply(id, text, sender) {
    replyingTo = { id, text, sender };
    document.getElementById('reply-preview').classList.remove('hidden');
    document.getElementById('reply-sender-name').innerText = sender;
    document.getElementById('reply-text-content').innerText = text;
    document.getElementById('message-input').focus();
}
function clearReply() {
    replyingTo = null;
    document.getElementById('reply-preview').classList.add('hidden');
}

// --- Chat Actions ---
function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !socket.connected) return;
    
    const replyData = replyingTo ? { ...replyingTo } : null;
    const msgId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    
    socket.emit('send-message', { id: msgId, roomId, text, sender: currentUser, type: 'text', replyTo: replyData }, (ack) => {
        const tickEl = document.getElementById(`ticks-${msgId}`);
        if (tickEl) { tickEl.innerText = '✓'; tickEl.className = 'ticks sent'; }
    });
    
    const localMsg = {
        id: msgId,
        sender: currentUser, text: text, type: 'text', replyTo: replyData, status: 'pending', timestamp: new Date()
    };
    addMessageToUI(localMsg);
    
    socket.emit('stop-typing', { roomId, user: currentUser });
    input.value = ''; clearReply(); scrollToBottom(); input.focus();
}

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return alert('File too large (Max 10MB).');

    const reader = new FileReader();
    reader.onload = () => {
        const type = file.type.startsWith('image/') ? 'image' : 'file';
        const msgId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        
        socket.emit('send-message', { id: msgId, roomId, sender: currentUser, type, fileName: file.name, fileData: reader.result }, (ack) => {
             const tickEl = document.getElementById(`ticks-${msgId}`);
             if(tickEl){ tickEl.innerText = '✓'; tickEl.className = 'ticks sent'; }
        });
        
        addMessageToUI({
            id: msgId, sender: currentUser, type, fileName: file.name, fileData: reader.result, status: 'pending', timestamp: new Date()
        });
        scrollToBottom();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
}

function addMessageToUI(msg) {
    const container = document.getElementById('chat-messages');
    
    if (document.querySelector(`.message[data-id="${msg.id}"]`)) return;

    const isMine = msg.sender === currentUser;
    const div = document.createElement('div');
    div.className = `message ${isMine ? 'mine' : 'theirs'}`;
    div.dataset.id = msg.id;

    let content = '';
    
    // Reply block
    if (msg.replyTo) {
        content += `
        <div class="quoted-reply">
            <div class="q-sender">${msg.replyTo.sender}</div>
            <div class="q-text">${escapeHtml(msg.replyTo.text)}</div>
        </div>`;
    }

    if (msg.type === 'text') {
        content += `<span class="text">${escapeHtml(msg.text)}</span>`;
    } else if (msg.type === 'image') {
        content += `<img src="${msg.fileData}" class="media-img" onclick="showLightbox('${msg.fileData}')">`;
    } else if (msg.type === 'file') {
        content += `<a href="${msg.fileData}" download="${msg.fileName}" class="media-file" style="color:white;text-decoration:underline;">📁 ${msg.fileName}</a>`;
    }

    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    // Ticks
    let ticksHtml = '';
    if (isMine) {
        let tClass = 'ticks pending'; let tText = '◷';
        if (msg.status === 'sent') { tClass = 'ticks sent'; tText = '✓'; }
        else if (msg.status === 'delivered') { tClass = 'ticks delivered'; tText = '✓✓'; }
        else if (msg.status === 'read') { tClass = 'ticks read'; tText = '✓✓'; }
        ticksHtml = `<span class="${tClass}" id="ticks-${msg.id}">${tText}</span>`;
    }

    div.innerHTML = `${content}<div class="msg-meta"><span class="timestamp">${time}</span>${ticksHtml}</div>`;

    // Context menu binding
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, msg.id, isMine); });
    let lp;
    div.addEventListener('touchstart', (e) => { lp = setTimeout(() => showContextMenu(e, msg.id, isMine), 600); });
    div.addEventListener('touchend', () => clearTimeout(lp));
    div.addEventListener('touchmove', () => clearTimeout(lp));

    container.appendChild(div);
}

function showContextMenu(e, id, isMine) {
    selectedMessageId = id;
    const menu = document.getElementById('context-menu');
    menu.classList.remove('hidden');
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
    menu.style.top = `${y}px`;
    document.getElementById('ctx-delete-all').style.display = isMine ? 'block' : 'none';
}

function showLightbox(src) { document.getElementById('lightbox-img').src = src; document.getElementById('lightbox').classList.remove('hidden'); }

// --- Video Call Logic ---
document.getElementById('video-call-btn').addEventListener('click', () => {
    socket.emit('call-request', { roomId, from: currentUser });
    document.getElementById('outgoing-name').innerText = peerUser.charAt(0).toUpperCase() + peerUser.slice(1);
    document.getElementById('outgoing-avatar').innerText = peerUser.charAt(0).toUpperCase();
    document.getElementById('outgoing-status').innerText = 'Calling...';
    document.getElementById('outgoing-call-modal').classList.remove('hidden');
});

document.getElementById('cancel-call-btn').addEventListener('click', () => {
    socket.emit('call-ended', { roomId });
    document.getElementById('outgoing-call-modal').classList.add('hidden');
});

async function startCallUI() {
    document.getElementById('outgoing-call-modal').classList.add('hidden');
    document.getElementById('incoming-call-modal').classList.add('hidden');
    document.getElementById('video-overlay').classList.remove('hidden');
    document.getElementById('call-peer-name').innerText = peerUser.charAt(0).toUpperCase() + peerUser.slice(1);
    
    callSeconds = 0;
    document.getElementById('call-timer').innerText = '00:00';
    callTimerInt = setInterval(() => {
        callSeconds++;
        const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
        const s = String(callSeconds % 60).padStart(2, '0');
        document.getElementById('call-timer').innerText = `${m}:${s}`;
    }, 1000);

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode }, audio: true });
        document.getElementById('local-video').srcObject = localStream;
    } catch (err) {
        console.error(err);
        alert('Could not access camera/mic.');
        endCallUI();
    }
}

async function setupPeerConnection(isCaller) {
    peerConnection = new RTCPeerConnection(ICE_CONFIG);
    if (localStream) localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    
    peerConnection.ontrack = (e) => {
        document.getElementById('remote-video').srcObject = e.streams[0];
    };
    peerConnection.onicecandidate = (e) => {
        if (e.candidate) socket.emit('signal', { roomId, sender: currentUser, signal: e.candidate });
    };

    if (isCaller) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { roomId, sender: currentUser, signal: offer });
    }
}

function endCallUI() {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    clearInterval(callTimerInt);
    document.getElementById('video-overlay').classList.add('hidden');
    document.getElementById('local-video').srcObject = null;
    document.getElementById('remote-video').srcObject = null;
    localStream = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});
}

function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    const btn = document.getElementById('btn-mute');
    isMuted ? btn.classList.add('muted') : btn.classList.remove('muted');
}

function toggleCam() {
    if (!localStream) return;
    isCamOff = !isCamOff;
    localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
    const btn = document.getElementById('btn-toggle-cam');
    isCamOff ? btn.classList.add('off') : btn.classList.remove('off');
}

async function flipCamera() {
    if (!localStream) return;
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    
    localStream.getTracks().forEach(t => t.stop());
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode }, audio: !isMuted });
        if (isCamOff) localStream.getVideoTracks().forEach(t => t.enabled = false);
        
        document.getElementById('local-video').srcObject = localStream;
        
        if (peerConnection) {
            const senders = peerConnection.getSenders();
            const videoTrack = localStream.getVideoTracks()[0];
            const audioTrack = localStream.getAudioTracks()[0];
            
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            if (videoSender && videoTrack) videoSender.replaceTrack(videoTrack);
            
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
            if (audioSender && audioTrack) audioSender.replaceTrack(audioTrack);
        }
    } catch (e) {
        console.error(e);
        alert('Could not flip camera.');
    }
}

function toggleFullscreen() {
    const el = document.getElementById('video-overlay');
    if (!document.fullscreenElement) {
        el.requestFullscreen().catch(err => console.error(err));
    } else {
        document.exitFullscreen();
    }
}
