// Fix mobile viewport height (keyboard)
function setViewportHeight() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
}
setViewportHeight();
window.addEventListener('resize', setViewportHeight);

// --- Parse URL params ---
const urlParams = new URLSearchParams(window.location.search);
const currentUser = urlParams.get('user') ? urlParams.get('user').toLowerCase().trim() : null;
const peerUser    = urlParams.get('peer')  ? urlParams.get('peer').toLowerCase().trim()  : null;

if (!currentUser || !peerUser) {
    document.getElementById('setup-overlay').classList.remove('hidden');
}

// --- State ---
let roomId         = null;
let peerConnection = null;
let localStream    = null;

const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// --- Create socket immediately ---
const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket', 'polling']
});

// --- Helpers ---
function joinRoom() {
    if (roomId && socket.connected) {
        socket.emit('join-room', { user: currentUser, peer: peerUser, roomId });
    }
}

function setStatus(text, online) {
    const el = document.getElementById('status');
    el.innerText = text;
    el.className = online ? 'online' : '';
}

function showBanner(text) {
    const b = document.getElementById('connecting-banner');
    b.innerText = text;
    b.classList.remove('hidden');
}

function hideBanner() {
    document.getElementById('connecting-banner').classList.add('hidden');
}

function escapeHtml(t) {
    return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function scrollToBottom() {
    const c = document.getElementById('chat-messages');
    c.scrollTop = c.scrollHeight;
}

// --- Socket event listeners ---
socket.on('connect', () => {
    hideBanner();
    setStatus('Online', true);
    joinRoom(); // always re-join after connect/reconnect
});

socket.on('disconnect', () => {
    showBanner('Reconnecting...');
    setStatus('Offline', false);
});

socket.on('connect_error', () => {
    showBanner('⚠️ Connection failed. Retrying...');
    setStatus('Offline', false);
});

socket.on('init-messages', (messages) => {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    if (messages.length === 0) {
        const d = document.createElement('div');
        d.className = 'date-divider';
        const name = peerUser ? peerUser.charAt(0).toUpperCase() + peerUser.slice(1) : 'them';
        d.innerText = `Say hi to ${name}! 👋`;
        container.appendChild(d);
    } else {
        messages.forEach(addMessageToUI);
    }
    scrollToBottom();
});

socket.on('new-message', (msg) => {
    const placeholder = document.querySelector('.date-divider');
    if (placeholder) placeholder.remove();
    addMessageToUI(msg);
    scrollToBottom();
});

socket.on('peer-online',  () => setStatus('Online', true));
socket.on('peer-offline', () => setStatus('Offline', false));

socket.on('chat-cleared', () => {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'date-divider';
    d.innerText = 'Chat cleared 🗑️';
    container.appendChild(d);
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
    } catch (err) { console.error('Signal error:', err); }
});

// --- Init app (only if params exist) ---
function initApp() {
    roomId = [currentUser, peerUser].sort().join('-');

    const peerName = peerUser.charAt(0).toUpperCase() + peerUser.slice(1);
    document.getElementById('peer-name').innerText = peerName;
    document.getElementById('peer-avatar').innerText = peerName.charAt(0).toUpperCase();

    // If socket already connected by the time we get here, join immediately
    if (socket.connected) {
        hideBanner();
        setStatus('Online', true);
        joinRoom();
    }

    setupUIListeners();
}

if (currentUser && peerUser) initApp();

// --- UI ---
function setupUIListeners() {
    const sendBtn      = document.getElementById('send-btn');
    const msgInput     = document.getElementById('message-input');
    const videoBtn     = document.getElementById('video-call-btn');
    const endBtn       = document.getElementById('end-call-btn');
    const clearChatBtn = document.getElementById('clear-chat-btn');

    sendBtn.addEventListener('click', sendMessage);
    msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    msgInput.addEventListener('focus', () => setTimeout(scrollToBottom, 350));

    videoBtn.addEventListener('click', () => startCall(true));
    endBtn.addEventListener('click', endCall);

    clearChatBtn.addEventListener('click', () => {
        if (confirm('Clear entire chat for both of you?')) {
            socket.emit('clear-chat', { roomId });
        }
    });
}

function sendMessage() {
    const input = document.getElementById('message-input');
    const text  = input.value.trim();
    if (!text || !socket.connected) return;
    socket.emit('send-message', { roomId, text, sender: currentUser });
    input.value = '';
    input.focus();
}

function addMessageToUI(msg) {
    const container = document.getElementById('chat-messages');
    const isMine    = msg.sender === currentUser;
    const div       = document.createElement('div');
    div.className   = `message ${isMine ? 'mine' : 'theirs'}`;
    div.dataset.id  = msg.id;
    const time      = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML   = `<span class="text">${escapeHtml(msg.text)}</span><span class="timestamp">${time}</span>`;
    container.appendChild(div);
}

// --- Video / WebRTC ---
async function startCall(isCaller) {
    document.getElementById('video-container').classList.remove('hidden');
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        document.getElementById('local-video').srcObject = localStream;
        await setupPeerConnection(isCaller);
    } catch (err) {
        console.error('Media error:', err);
        alert('Could not access camera/mic. Please allow permissions and try again.');
        document.getElementById('video-container').classList.add('hidden');
    }
}

async function setupPeerConnection(isCaller) {
    peerConnection = new RTCPeerConnection(ICE_CONFIG);
    if (localStream) localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    peerConnection.ontrack = (e) => { document.getElementById('remote-video').srcObject = e.streams[0]; };
    peerConnection.onicecandidate = (e) => {
        if (e.candidate) socket.emit('signal', { roomId, sender: currentUser, signal: e.candidate });
    };
    if (isCaller) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { roomId, sender: currentUser, signal: offer });
    }
}

function endCall() {
    if (localStream)    localStream.getTracks().forEach(t => t.stop());
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    document.getElementById('video-container').classList.add('hidden');
    document.getElementById('local-video').srcObject  = null;
    document.getElementById('remote-video').srcObject = null;
    localStream = null;
}
