const socket = io();
const urlParams = new URLSearchParams(window.location.search);
const currentUser = urlParams.get('user');
const peerUser = urlParams.get('peer');

if (!currentUser || !peerUser) {
    document.getElementById('setup-overlay').classList.remove('hidden');
} else {
    initApp();
}

let roomId;
let peerConnection;
let localStream;

const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

function initApp() {
    roomId = [currentUser, peerUser].sort().join("-");
    document.getElementById('peer-name').innerText = peerUser;
    document.getElementById('peer-avatar').innerText = peerUser[0].toUpperCase();
    
    socket.emit('join-room', { user: currentUser, peer: peerUser, roomId });

    setupSocketListeners();
    setupUIListeners();
}

function setupSocketListeners() {
    socket.on('init-messages', (messages) => {
        const container = document.getElementById('chat-messages');
        container.innerHTML = '';
        messages.forEach(addMessageToUI);
        scrollToBottom();
    });

    socket.on('new-message', (msg) => {
        addMessageToUI(msg);
        scrollToBottom();
    });

    socket.on('incoming-call', async (data) => {
        if (confirm(`${data.from} is calling. Answer?`)) {
            await startCall(false);
        }
    });

    socket.on('signal', async (data) => {
        if (!peerConnection) await startCall(false);

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
    });
}

function setupUIListeners() {
    const sendBtn = document.getElementById('send-btn');
    const msgInput = document.getElementById('message-input');
    const videoBtn = document.getElementById('video-call-btn');
    const endCallBtn = document.getElementById('end-call-btn');

    sendBtn.addEventListener('click', sendMessage);
    msgInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    videoBtn.addEventListener('click', () => startCall(true));
    endCallBtn.addEventListener('click', endCall);
}

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text) return;

    socket.emit('send-message', {
        roomId,
        text,
        sender: currentUser
    });
    input.value = '';
}

function addMessageToUI(msg) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    const isMine = msg.sender === currentUser;
    
    div.className = `message ${isMine ? 'mine' : 'theirs'}`;
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    div.innerHTML = `
        <span class="text">${msg.text}</span>
        <span class="timestamp">${time}</span>
    `;
    container.appendChild(div);
}

function scrollToBottom() {
    const container = document.getElementById('chat-messages');
    container.scrollTop = container.scrollHeight;
}

async function startCall(isCaller) {
    document.getElementById('video-container').classList.remove('hidden');
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        document.getElementById('local-video').srcObject = localStream;

        peerConnection = new RTCPeerConnection(config);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

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

    } catch (err) {
        console.error("Media error:", err);
        alert("Could not access camera/mic.");
    }
}

function endCall() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    document.getElementById('video-container').classList.add('hidden');
    document.getElementById('local-video').srcObject = null;
    document.getElementById('remote-video').srcObject = null;
}
