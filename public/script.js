// Viewport fix for mobile keyboards
function setVH() { document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`); }
setVH(); window.addEventListener('resize', setVH);

// --- URL Params ---
const params = new URLSearchParams(window.location.search);
const currentUser = params.get('user')?.toLowerCase().trim();
const peerUser    = params.get('peer')?.toLowerCase().trim();

if (!currentUser || !peerUser) {
    document.getElementById('setup-overlay').classList.remove('hidden');
}

// --- State ---
let roomId = null;
let peerConnection = null;
let localStream = null;
let currentFacingMode = 'user'; // 'user' or 'environment'
let isMuted = false;
let isCamOff = false;
let callTimerInt = null;
let callSeconds = 0;
let longPressTimer = null;
let selectedMessageId = null;

const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

const socket = io({ transports: ['websocket', 'polling'] });

// --- Helpers ---
function joinRoom() { if (roomId && socket.connected) socket.emit('join-room', { user: currentUser, peer: peerUser, roomId }); }
function setStatus(txt, online) { const el = document.getElementById('status'); el.innerText = txt; el.className = online ? 'online' : ''; }
function hideBanner() { document.getElementById('connecting-banner').classList.add('hidden'); }
function scrollToBottom() { const c = document.getElementById('chat-messages'); c.scrollTop = c.scrollHeight; }
function escapeHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// --- Socket Events ---
socket.on('connect', () => { hideBanner(); setStatus('Online', true); joinRoom(); });
socket.on('disconnect', () => { document.getElementById('connecting-banner').classList.remove('hidden'); setStatus('Offline', false); });

socket.on('init-messages', (msgs) => {
    const c = document.getElementById('chat-messages'); c.innerHTML = '';
    msgs.forEach(addMessageToUI);
    scrollToBottom();
});

socket.on('new-message', (msg) => { addMessageToUI(msg); scrollToBottom(); });
socket.on('peer-online',  () => setStatus('Online', true));
socket.on('peer-offline', () => setStatus('Offline', false));

socket.on('chat-cleared', () => {
    document.getElementById('chat-messages').innerHTML = '<div class="date-divider">Chat cleared 🗑️</div>';
});

socket.on('message-deleted', ({ messageId }) => {
    const el = document.querySelector(`.message[data-id="${messageId}"]`);
    if (el) {
        el.innerHTML = 'This message was deleted';
        el.classList.add('deleted');
    }
});

// --- Call Signaling ---
socket.on('incoming-call', ({ from }) => {
    document.getElementById('caller-name').innerText = from.charAt(0).toUpperCase() + from.slice(1);
    document.getElementById('caller-avatar').innerText = from.charAt(0).toUpperCase();
    document.getElementById('incoming-call-modal').classList.remove('hidden');
});

socket.on('call-accepted', async () => {
    // Other person accepted. We start WebRTC as the caller
    await startCallUI();
    await setupPeerConnection(true);
});

socket.on('call-declined', () => {
    alert('Call declined.');
    endCallUI();
});

socket.on('call-ended', () => {
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

// --- Init ---
if (currentUser && peerUser) {
    roomId = [currentUser, peerUser].sort().join('-');
    document.getElementById('peer-name').innerText = peerUser.charAt(0).toUpperCase() + peerUser.slice(1);
    document.getElementById('peer-avatar').innerText = peerUser.charAt(0).toUpperCase();
    if (socket.connected) { hideBanner(); setStatus('Online', true); joinRoom(); }
    setupUIListeners();
}

// --- UI Listeners ---
function setupUIListeners() {
    // Chat UI
    document.getElementById('send-btn').addEventListener('click', sendMessage);
    document.getElementById('message-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    document.getElementById('message-input').addEventListener('focus', () => setTimeout(scrollToBottom, 350));
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
    document.getElementById('ctx-delete-me').addEventListener('click', () => {
        const el = document.querySelector(`.message[data-id="${selectedMessageId}"]`);
        if (el) el.remove();
    });
    document.getElementById('ctx-delete-all').addEventListener('click', () => {
        socket.emit('delete-message', { roomId, messageId: selectedMessageId, deleteFor: 'everyone' });
        document.getElementById('context-menu').classList.add('hidden');
    });

    // Calling UI
    document.getElementById('video-call-btn').addEventListener('click', () => {
        socket.emit('call-request', { roomId, from: currentUser });
        // Show wait state locally if needed, but for now just wait for accepted
        alert(`Calling ${peerUser}...`);
    });
    document.getElementById('accept-call-btn').addEventListener('click', async () => {
        document.getElementById('incoming-call-modal').classList.add('hidden');
        await startCallUI();
        await setupPeerConnection(false); // We are the answerer
        socket.emit('call-accepted', { roomId, from: currentUser });
    });
    document.getElementById('decline-call-btn').addEventListener('click', () => {
        document.getElementById('incoming-call-modal').classList.add('hidden');
        socket.emit('call-declined', { roomId, from: currentUser });
    });

    // Video Controls
    document.getElementById('btn-end-call').addEventListener('click', () => {
        socket.emit('call-ended', { roomId });
        endCallUI();
    });
    document.getElementById('btn-mute').addEventListener('click', toggleMute);
    document.getElementById('btn-toggle-cam').addEventListener('click', toggleCam);
    document.getElementById('btn-flip-cam').addEventListener('click', flipCamera);
    document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
}

// --- Chat Actions ---
function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !socket.connected) return;
    socket.emit('send-message', { roomId, text, sender: currentUser, type: 'text' });
    input.value = ''; input.focus();
}

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return alert('File too large (Max 10MB).');

    const reader = new FileReader();
    reader.onload = () => {
        const type = file.type.startsWith('image/') ? 'image' : 'file';
        socket.emit('send-message', { roomId, sender: currentUser, type, fileName: file.name, fileData: reader.result });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
}

function addMessageToUI(msg) {
    const container = document.getElementById('chat-messages');
    const isMine = msg.sender === currentUser;
    const div = document.createElement('div');
    div.className = `message ${isMine ? 'mine' : 'theirs'}`;
    div.dataset.id = msg.id;

    let content = '';
    if (msg.type === 'text') {
        content = `<span class="text">${escapeHtml(msg.text)}</span>`;
    } else if (msg.type === 'image') {
        content = `<img src="${msg.fileData}" class="media-img" onclick="showLightbox('${msg.fileData}')">`;
    } else if (msg.type === 'file') {
        content = `<a href="${msg.fileData}" download="${msg.fileName}" class="media-file">📁 ${msg.fileName}</a>`;
    }

    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `${content}<span class="timestamp">${time}</span>`;

    // Context menu binding
    div.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, msg.id, isMine); });
    // Long press for mobile
    div.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => showContextMenu(e, msg.id, isMine), 600);
    });
    div.addEventListener('touchend', () => clearTimeout(longPressTimer));
    div.addEventListener('touchmove', () => clearTimeout(longPressTimer));

    container.appendChild(div);
}

function showContextMenu(e, id, isMine) {
    selectedMessageId = id;
    const menu = document.getElementById('context-menu');
    menu.classList.remove('hidden');
    
    // Position menu
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
    menu.style.top = `${y}px`;

    document.getElementById('ctx-delete-all').style.display = isMine ? 'block' : 'none';
}

function showLightbox(src) {
    document.getElementById('lightbox-img').src = src;
    document.getElementById('lightbox').classList.remove('hidden');
}

// --- Video Call Logic ---
async function startCallUI() {
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
        
        // Replace tracks in peer connection
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
