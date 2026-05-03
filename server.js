const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 10e6 // 10MB
});

const PORT = process.env.PORT || 3001;

// In-memory data stores (Note: Resets on server sleep in Render free tier)
const messagesByRoom = {};
const userPasswords = {}; // stores: { 'bhavnesh': 'mypass', 'snehal': 'herpass' }

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Auth Endpoint: Set password on first login, check password on subsequent logins
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    
    const userKey = username.toLowerCase().trim();
    
    if (!userPasswords[userKey]) {
        // First time login - set password
        userPasswords[userKey] = password;
        return res.json({ success: true, message: 'Password set successfully!' });
    } else {
        // Subsequent login - verify password
        if (userPasswords[userKey] === password) {
            return res.json({ success: true });
        } else {
            return res.status(401).json({ error: 'Incorrect password' });
        }
    }
});

function getMessages(roomId) { return messagesByRoom[roomId] || []; }
function saveMessage(msg) {
    if (!messagesByRoom[msg.roomId]) messagesByRoom[msg.roomId] = [];
    messagesByRoom[msg.roomId].push(msg);
    if (messagesByRoom[msg.roomId].length > 300) messagesByRoom[msg.roomId].shift();
}

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('join-room', ({ user, peer, roomId }) => {
        socket.join(roomId);
        socket.data.user = user;
        socket.data.roomId = roomId;
        
        // Send existing messages
        socket.emit('init-messages', getMessages(roomId));
        // Notify peer we are online
        socket.to(roomId).emit('peer-online', { user });
    });

    // Messaging
    socket.on('send-message', (data, callback) => {
        const message = {
            id: Date.now().toString(),
            roomId: data.roomId,
            text: data.text || '',
            sender: data.sender,
            type: data.type || 'text',
            fileName: data.fileName || '',
            fileData: data.fileData || '',
            replyTo: data.replyTo || null, // { id, text, sender }
            status: 'sent', // sent, delivered, read
            timestamp: new Date().toISOString()
        };
        saveMessage(message);
        
        // Send to everyone else in room
        socket.to(data.roomId).emit('new-message', message);
        
        // Callback to sender to confirm it hit the server (single tick)
        if (callback) callback({ status: 'sent', id: message.id });
    });

    // Message Status Updates (Delivered / Read)
    socket.on('message-status-update', ({ roomId, messageId, status }) => {
        // Update in DB
        if (messagesByRoom[roomId]) {
            const msg = messagesByRoom[roomId].find(m => m.id === messageId);
            if (msg && (msg.status !== 'read' || status === 'read')) {
                msg.status = status;
                // Broadcast update to the sender of the message
                socket.to(roomId).emit('message-status-changed', { messageId, status });
            }
        }
    });

    // Typing Indicators
    socket.on('typing', ({ roomId, user }) => {
        socket.to(roomId).emit('peer-typing', { user });
    });
    socket.on('stop-typing', ({ roomId, user }) => {
        socket.to(roomId).emit('peer-stop-typing', { user });
    });

    // Delete Chat/Message
    socket.on('delete-message', ({ roomId, messageId, deleteFor }) => {
        if (deleteFor === 'everyone' && messagesByRoom[roomId]) {
            const msg = messagesByRoom[roomId].find(m => m.id === messageId);
            if (msg) msg.isDeleted = true;
            io.to(roomId).emit('message-deleted', { messageId });
        }
    });
    socket.on('clear-chat', ({ roomId }) => {
        if (messagesByRoom[roomId]) messagesByRoom[roomId] = [];
        io.to(roomId).emit('chat-cleared');
    });

    // Video call signaling
    socket.on('call-request', ({ roomId, from }) => socket.to(roomId).emit('incoming-call', { from }));
    socket.on('call-accepted', ({ roomId, from }) => socket.to(roomId).emit('call-accepted', { from }));
    socket.on('call-declined', ({ roomId, from }) => socket.to(roomId).emit('call-declined', { from }));
    socket.on('signal', ({ roomId, sender, signal }) => socket.to(roomId).emit('signal', { sender, signal }));
    socket.on('call-ended', ({ roomId }) => socket.to(roomId).emit('call-ended'));

    socket.on('disconnect', () => {
        const { roomId, user } = socket.data;
        if (roomId) socket.to(roomId).emit('peer-offline', { user });
    });
});

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
