// Fix for mobile viewport height (keyboard pushing content)
function setViewportHeight() {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
}
setViewportHeight();
window.addEventListener('resize', setViewportHeight);

// --- Parse URL params ---
const urlParams = new URLSearchParams(window.location.search);
const currentUser = urlParams.get('user') ? urlParams.get('user').toLowerCase().trim() : null;
const peerUser = urlParams.get('peer') ? urlParams.get('peer').toLowerCase().trim() : null;

// Show setup overlay if no params
if (!currentUser || !peerUser) {
    document.getElementById('setup-overlay').classList.remove('hidden');
} else {
    initApp();
}

// --- State ---
let roomId;
let peerConnection;
let localStream;

const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// --- Socket.io ---
const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket', 'polling']
});

function initApp() {
    roomId = [currentUser, peerUser].sort().join('-');

    // Set peer info in header immediately
    const peerName = peerUser.charAt(0).toUpperCase() + peerUser.slice(1);
    document.getElementById('peer-name').innerText = peerName;
    document.getElementById('peer-avatar').innerText = peerName.charAt(0).toUpperCase();

    setupSocketListeners();
    setupUIListeners();
}

// --- Socket Events ---
function setupSocketListeners() {
    socket.on('connect', () => {
        console.log('Connected to server');
        document.getElementById('connecting-banner').classList.add('hidden');
        document.getElementById('status').innerText = 'Online';
        document.getElementById('status').className = 'online';
        // Re-join room on reconnect
        socket.emit('join-room', { user: currentUser, peer: peerUser, roomId });
    });

    socket.on('disconnect', () => {
        document.getElementById('connecting-banner').innerText = 'Reconnecting...';
        document.getElementById('connecting-banner').classList.remove('hidden');
        document.getElementById('status').innerText = 'Offline';
        document.getElementById('status').className = '';
    });

    socket.on('connect_error', (err) => {
        console.error('Connection error:', err.message);
        document.getElementById('connecting-banner').innerText = '⚠️ Connection failed. Retrying...';
        document.getElementById('connecting-banner').classList.remove('hidden');
    });

    socket.on('init-messages', (messages) => {
        const container = document.getElementById('chat-messages');
        container.innerHTML = '';
        if (messages.length === 0) {
            const placeholder = document.createElement('div');
            placeholder.className = 'date-divider';
            placeholder.innerText = `Chat with ${peerUser.charAt(0).toUpperCase() + peerUser.slice(1)} — say hi! 👋`;
            container.appendChild(placeholder);
        } else {
            messages.forEach(addMessageToUI);
        }
        scrollToBottom();
    });

    socket.on('new-message', (msg) => {
        // Remove placeholder if present
        const placeholder = document.querySelector('.date-divider');
        if (placeholder) placeholder.remove();
        addMessageToUI(msg);
        scrollToBottom();
    });

    socket.on('peer-online', (data) => {
        document.getElementById('status').innerText = 'Online';
        document.getElementById('status').className = 'online';
    });

    socket.on('peer-offline', (data) => {
        document.getElementById('status').innerText = 'Offline';
        document.getElementById('status').className = '';
    });

    // WebRTC signals
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
        } catch (err) {
            console.error('Signal error:', err);
        }
    });
}

// --- UI Listeners ---
function setupUIListeners() {
    const sendBtn = document.getElementById('send-btn');
    const msgInput = document.getElementById('message-input');
    const videoBtn = document.getElementById('video-call-btn');
    const endCallBtn = document.getElementById('end-call-btn');

    sendBtn.addEventListener('click', sendMessage);

    msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // On mobile, scroll to bottom when keyboard opens
    msgInput.addEventListener('focus', () => {
        setTimeout(scrollToBottom, 300);
    });

    videoBtn.addEventListener('click', () => startCall(true));
    endCallBtn.addEventListener('click', endCall);
}

// --- Messaging ---
function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !socket.connected) return;

    socket.emit('send-message', { roomId, text, sender: currentUser });
    input.value = '';
    input.focus();
}

function addMessageToUI(msg) {
    const container = document.getElementById('chat-messages');
    const isMine = msg.sender === currentUser;
    const div = document.createElement('div');
    div.className = `message ${isMine ? 'mine' : 'theirs'}`;
    div.dataset.id = msg.id;

    const time = new Date(msg.timestamp).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit'
    });

    div.innerHTML = `<span class="text">${escapeHtml(msg.text)}</span><span class="timestamp">${time}</span>`;
    container.appendChild(div);
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function scrollToBottom() {
    const container = document.getElementById('chat-messages');
    container.scrollTop = container.scrollHeight;
}

// --- Video/WebRTC ---
async function startCall(isCaller) {
    document.getElementById('video-container').classList.remove('hidden');
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        document.getElementById('local-video').srcObject = localStream;
        await setupPeerConnection(isCaller);
    } catch (err) {
        console.error('Media error:', err);
        alert('Could not access camera/mic. Please allow permissions.');
        document.getElementById('video-container').classList.add('hidden');
    }
}

async function setupPeerConnection(isCaller) {
    peerConnection = new RTCPeerConnection(ICE_CONFIG);

    if (localStream) {
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }

    peerConnection.ontrack = (event) => {
        document.getElementById('remote-video').srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { roomId, sender: currentUser, signal: event.candidate });
        }
    };

    if (isCaller) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { roomId, sender: currentUser, signal: offer });
    }
}

function endCall() {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    document.getElementById('video-container').classList.add('hidden');
    document.getElementById('local-video').srcObject = null;
    document.getElementById('remote-video').srcObject = null;
    localStream = null;
}
