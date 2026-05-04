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
let replyingTo = null; // { id, text, sender }
let selectedMessageId = null;
let currentFacingMode = 'user';
let isMuted = false;
let isCamOff = false;
let callTimerInt = null;
let callSeconds = 0;
let audioCtx = null;
let ringToneInt = null;

const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// Socket & WebRTC
const socket = io({ 
    autoConnect: false, 
    transports: ['polling', 'websocket'], // Polling first is more stable for tunnels
    reconnection: true,
    reconnectionDelay: 1000
});
let peerConnection = null; 
let localStream = null;

/* ============================================================
   AUTH & INITIALIZATION
============================================================ */

window.initApp = function(user, peer) {
    currentUser = user.toLowerCase().trim();
    peerUser = peer.toLowerCase().trim();
    roomId = [currentUser, peerUser].sort().join('-');

    // UI Updates
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    
    document.getElementById('peer-name').innerText = peerUser.charAt(0).toUpperCase() + peerUser.slice(1);
    document.getElementById('peer-avatar').innerText = peerUser.charAt(0).toUpperCase();
    document.getElementById('self-name-badge').innerText = `You: ${currentUser.charAt(0).toUpperCase() + currentUser.slice(1)}`;

    // Connect and Join
    if (!socket.connected) {
        socket.connect();
    } else {
        socket.emit('join-room', { user: currentUser, peer: peerUser, roomId });
    }
    
    setupUIListeners();
    showToast(`Logged in as ${currentUser}`);
};

// Check if user clicked before script loaded
if (window.pendingUserChoice) {
    window.initApp(window.pendingUserChoice.user, window.pendingUserChoice.peer);
}

document.getElementById('logout-btn').addEventListener('click', () => {
    if (confirm('Switch user?')) {
        socket.disconnect();
        currentUser = null;
        peerUser = null;
        document.getElementById('app').classList.add('hidden');
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('chat-messages').innerHTML = '';
        if (localStream) endCallUI();
    }
});

document.getElementById('share-btn').addEventListener('click', () => {
    const url = window.location.origin;
    navigator.clipboard.writeText(url).then(() => {
        showToast('Link copied! Share it with your friend.');
    }).catch(() => {
        showToast('Could not copy link. Copy manually.');
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
    socket.emit('join-room', { user: currentUser, peer: peerUser, roomId });
});

socket.on('disconnect', () => {
    document.getElementById('connecting-banner').classList.remove('hidden');
    document.getElementById('status').innerText = 'Offline';
    document.getElementById('status').classList.remove('online');
    document.getElementById('peer-dot').classList.remove('online');
});

socket.on('init-messages', (msgs) => {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    
    if (msgs.length === 0) {
        document.getElementById('empty-state').classList.remove('hidden');
    } else {
        document.getElementById('empty-state').classList.add('hidden');
        msgs.forEach(addMessageToUI);
        scrollToBottom();
    }
    
    // Mark as read
    msgs.filter(m => m.sender !== currentUser && m.status !== 'read').forEach(m => {
        socket.emit('message-status-update', { roomId, messageId: m.id, status: 'read' });
    });
});

socket.on('new-message', (msg) => {
    document.getElementById('empty-state').classList.add('hidden');
    addMessageToUI(msg);
    scrollToBottom();
    
    if (msg.sender !== currentUser) {
        socket.emit('message-status-update', { roomId, messageId: msg.id, status: 'read' });
        playMessageSound();
        // Vibration if supported
        if (navigator.vibrate) navigator.vibrate(100);
    }
});

function playMessageSound() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
        osc.start(); osc.stop(audioCtx.currentTime + 0.1);
    } catch(e) {}
}

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
    showToast(`${user} is online`);
});

socket.on('peer-offline', () => {
    document.getElementById('status').innerText = 'Offline';
    document.getElementById('peer-dot').classList.remove('online');
});

socket.on('peer-typing', () => document.getElementById('typing-indicator').classList.remove('hidden'));
socket.on('peer-stop-typing', () => document.getElementById('typing-indicator').classList.add('hidden'));

socket.on('chat-cleared', () => {
    document.getElementById('chat-messages').innerHTML = '';
    document.getElementById('empty-state').classList.remove('hidden');
    showToast('Chat history cleared');
});

socket.on('message-deleted', ({ messageId }) => {
    const el = document.querySelector(`.message[data-id="${messageId}"]`);
    if (el) {
        el.innerHTML = 'This message was deleted';
        el.className = 'message deleted';
    }
});

/* ============================================================
   CALL SIGNALING
============================================================ */

socket.on('incoming-call', ({ from }) => {
    document.getElementById('caller-name').innerText = from.charAt(0).toUpperCase() + from.slice(1);
    document.getElementById('caller-avatar').innerText = from.charAt(0).toUpperCase();
    document.getElementById('incoming-call-modal').classList.remove('hidden');
    startRingtone();
});

socket.on('call-accepted', async () => {
    stopRingtone();
    document.getElementById('outgoing-status').innerText = 'Connecting...';
    await startCallUI();
    await setupPeerConnection(true);
});

socket.on('call-declined', () => {
    stopRingtone();
    document.getElementById('outgoing-status').innerText = 'Call Declined';
    setTimeout(() => {
        document.getElementById('outgoing-call-modal').classList.add('hidden');
    }, 2000);
});

socket.on('call-ended', () => {
    stopRingtone();
    document.getElementById('outgoing-call-modal').classList.add('hidden');
    document.getElementById('incoming-call-modal').classList.add('hidden');
    endCallUI();
    showToast('Call ended');
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

/* ============================================================
   UI LISTENERS
============================================================ */

function setupUIListeners() {
    const input = document.getElementById('message-input');
    
    document.getElementById('send-btn').onclick = sendMessage;
    input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    };
    
    input.oninput = () => {
        socket.emit('typing', { roomId, user: currentUser });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => socket.emit('stop-typing', { roomId, user: currentUser }), 2000);
    };

    document.getElementById('close-reply-btn').onclick = clearReply;
    
    document.getElementById('clear-chat-btn').onclick = () => {
        if (confirm('Clear entire chat for everyone?')) socket.emit('clear-chat', { roomId });
    };

    document.getElementById('media-btn').onclick = () => document.getElementById('file-input').click();
    document.getElementById('file-input').onchange = handleFileUpload;
    document.getElementById('lightbox-close').onclick = () => document.getElementById('lightbox').classList.add('hidden');

    // Context Menu
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#context-menu')) document.getElementById('context-menu').classList.add('hidden');
    });

    document.getElementById('ctx-reply').onclick = () => {
        const msgEl = document.querySelector(`.message[data-id="${selectedMessageId}"]`);
        if (msgEl) {
            const sender = msgEl.classList.contains('mine') ? 'You' : peerUser;
            let text = msgEl.querySelector('.text')?.innerText || 'Media';
            setReply(selectedMessageId, text, sender);
        }
        document.getElementById('context-menu').classList.add('hidden');
    };

    document.getElementById('ctx-delete-me').onclick = () => {
        const el = document.querySelector(`.message[data-id="${selectedMessageId}"]`);
        if (el) el.remove();
        document.getElementById('context-menu').classList.add('hidden');
    };

    document.getElementById('ctx-delete-all').onclick = () => {
        socket.emit('delete-message', { roomId, messageId: selectedMessageId, deleteFor: 'everyone' });
        document.getElementById('context-menu').classList.add('hidden');
    };

    // Call Buttons
    document.getElementById('video-call-btn').onclick = () => {
        socket.emit('call-request', { roomId, from: currentUser });
        document.getElementById('outgoing-name').innerText = peerUser.charAt(0).toUpperCase() + peerUser.slice(1);
        document.getElementById('outgoing-avatar').innerText = peerUser.charAt(0).toUpperCase();
        document.getElementById('outgoing-status').innerText = 'Calling...';
        document.getElementById('outgoing-call-modal').classList.remove('hidden');
        startRingtone(true);
    };

    document.getElementById('accept-call-btn').onclick = async () => {
        stopRingtone();
        document.getElementById('incoming-call-modal').classList.add('hidden');
        await startCallUI();
        await setupPeerConnection(false);
        socket.emit('call-accepted', { roomId, from: currentUser });
    };

    document.getElementById('decline-call-btn').onclick = () => {
        stopRingtone();
        document.getElementById('incoming-call-modal').classList.add('hidden');
        socket.emit('call-declined', { roomId, from: currentUser });
    };

    document.getElementById('cancel-call-btn').onclick = () => {
        stopRingtone();
        socket.emit('call-ended', { roomId });
        document.getElementById('outgoing-call-modal').classList.add('hidden');
    };

    document.getElementById('btn-end-call').onclick = () => {
        socket.emit('call-ended', { roomId });
        endCallUI();
    };

    document.getElementById('btn-mute').onclick = toggleMute;
    document.getElementById('btn-toggle-cam').onclick = toggleCam;
    document.getElementById('btn-flip-cam').onclick = flipCamera;
    document.getElementById('btn-fullscreen').onclick = toggleFullscreen;

    setupDraggableVideo();
}

/* ============================================================
   CHAT LOGIC
============================================================ */

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
        id: msgId, sender: currentUser, text: text, type: 'text', 
        replyTo: replyData, status: 'pending', timestamp: new Date()
    };
    
    document.getElementById('empty-state').classList.add('hidden');
    addMessageToUI(localMsg);
    scrollToBottom();
    
    input.value = ''; 
    clearReply(); 
    input.focus();
}

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return showToast('File too large (Max 10MB)');

    const reader = new FileReader();
    reader.onload = () => {
        const type = file.type.startsWith('image/') ? 'image' : 'file';
        const msgId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        
        socket.emit('send-message', { 
            id: msgId, roomId, sender: currentUser, type, 
            fileName: file.name, fileData: reader.result 
        });
        
        addMessageToUI({
            id: msgId, sender: currentUser, type, fileName: file.name, 
            fileData: reader.result, status: 'pending', timestamp: new Date()
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
        content += `<a href="${msg.fileData}" download="${msg.fileName}" class="media-file">📁 ${msg.fileName}</a>`;
    }

    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let ticksHtml = '';
    if (isMine) {
        let tClass = 'ticks pending'; let tText = '◷';
        if (msg.status === 'sent') { tClass = 'ticks sent'; tText = '✓'; }
        else if (msg.status === 'delivered') { tClass = 'ticks delivered'; tText = '✓✓'; }
        else if (msg.status === 'read') { tClass = 'ticks read'; tText = '✓✓'; }
        ticksHtml = `<span class="${tClass}" id="ticks-${msg.id}">${tText}</span>`;
    }

    div.innerHTML = `${content}<div class="msg-meta"><span class="timestamp">${time}</span>${ticksHtml}</div>`;

    // Interaction
    div.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e, msg.id, isMine); };
    
    let lp;
    div.ontouchstart = (e) => { lp = setTimeout(() => showContextMenu(e, msg.id, isMine), 600); };
    div.ontouchend = () => clearTimeout(lp);
    div.ontouchmove = () => clearTimeout(lp);

    container.appendChild(div);
}

/* ============================================================
   VIDEO CALL LOGIC
============================================================ */

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
        showToast('Camera access denied');
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
        document.getElementById('local-video').srcObject = localStream;
        if (peerConnection) {
            const senders = peerConnection.getSenders();
            const videoTrack = localStream.getVideoTracks()[0];
            const sender = senders.find(s => s.track.kind === 'video');
            if (sender) sender.replaceTrack(videoTrack);
        }
    } catch (e) { showToast('Flip failed'); }
}

function toggleFullscreen() {
    const el = document.getElementById('video-overlay');
    if (!document.fullscreenElement) el.requestFullscreen().catch(e => {});
    else document.exitFullscreen();
}

/* ============================================================
   UTILITIES
============================================================ */

function showContextMenu(e, id, isMine) {
    selectedMessageId = id;
    const menu = document.getElementById('context-menu');
    menu.classList.remove('hidden');
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
    menu.style.top = `${y}px`;
    document.getElementById('ctx-delete-all').style.display = isMine ? 'block' : 'none';
}

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

function showToast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.classList.add('show');
    t.classList.remove('hidden');
    setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.classList.add('hidden'), 300);
    }, 3000);
}

function showLightbox(src) {
    document.getElementById('lightbox-img').src = src;
    document.getElementById('lightbox').classList.remove('hidden');
}

function escapeHtml(t) {
    return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function scrollToBottom() {
    const c = document.getElementById('chat-messages');
    c.scrollTop = c.scrollHeight;
}

function startRingtone(isOutgoing = false) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    
    stopRingtone();
    ringToneInt = setInterval(() => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.frequency.value = isOutgoing ? 440 : 600;
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
        osc.start(); osc.stop(audioCtx.currentTime + 0.5);
    }, 1000);
}

function stopRingtone() {
    clearInterval(ringToneInt);
}

function setupDraggableVideo() {
    const v = document.getElementById('local-video');
    let dragging = false, sx, sy, ix, iy;
    v.onpointerdown = (e) => {
        dragging = true; sx = e.clientX; sy = e.clientY;
        const r = v.getBoundingClientRect();
        v.style.left = r.left + 'px'; v.style.top = r.top + 'px';
        v.style.right = 'auto'; v.style.bottom = 'auto';
        ix = r.left; iy = r.top;
        v.setPointerCapture(e.pointerId);
    };
    v.onpointermove = (e) => {
        if (!dragging) return;
        v.style.left = (ix + e.clientX - sx) + 'px';
        v.style.top = (iy + e.clientY - sy) + 'px';
    };
    v.onpointerup = (e) => {
        dragging = false;
        v.releasePointerCapture(e.pointerId);
    };
}
