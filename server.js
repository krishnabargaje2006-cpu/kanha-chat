const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 10e6 // 10MB for media
});

const PORT = process.env.PORT || 3001;
const messagesByRoom = {};

function getMessages(roomId) { return messagesByRoom[roomId] || []; }
function saveMessage(msg) {
    if (!messagesByRoom[msg.roomId]) messagesByRoom[msg.roomId] = [];
    messagesByRoom[msg.roomId].push(msg);
    if (messagesByRoom[msg.roomId].length > 300) messagesByRoom[msg.roomId].shift();
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('join-room', ({ user, peer, roomId }) => {
        socket.join(roomId);
        socket.data.user = user;
        socket.data.roomId = roomId;
        socket.emit('init-messages', getMessages(roomId));
        socket.to(roomId).emit('peer-online', { user });
        console.log(`${user} joined ${roomId}`);
    });

    socket.on('send-message', (data) => {
        const message = {
            id: Date.now().toString(),
            roomId: data.roomId,
            text: data.text || '',
            sender: data.sender,
            type: data.type || 'text',     // 'text' | 'image' | 'file'
            fileName: data.fileName || '',
            fileData: data.fileData || '',  // base64
            timestamp: new Date().toISOString()
        };
        saveMessage(message);
        io.to(data.roomId).emit('new-message', message);
    });

    socket.on('delete-message', ({ roomId, messageId, deleteFor }) => {
        if (deleteFor === 'everyone' && messagesByRoom[roomId]) {
            messagesByRoom[roomId] = messagesByRoom[roomId].filter(m => m.id !== messageId);
            io.to(roomId).emit('message-deleted', { messageId });
        }
        // 'for-me' is purely client-side
    });

    socket.on('clear-chat', ({ roomId }) => {
        if (messagesByRoom[roomId]) messagesByRoom[roomId] = [];
        io.to(roomId).emit('chat-cleared');
    });

    // Video call signaling
    socket.on('call-request', ({ roomId, from }) => {
        socket.to(roomId).emit('incoming-call', { from });
    });
    socket.on('call-accepted', ({ roomId, from }) => {
        socket.to(roomId).emit('call-accepted', { from });
    });
    socket.on('call-declined', ({ roomId, from }) => {
        socket.to(roomId).emit('call-declined', { from });
    });
    socket.on('signal', ({ roomId, sender, signal }) => {
        socket.to(roomId).emit('signal', { sender, signal });
    });
    socket.on('call-ended', ({ roomId }) => {
        socket.to(roomId).emit('call-ended');
    });

    socket.on('disconnect', () => {
        const { roomId, user } = socket.data;
        if (roomId) socket.to(roomId).emit('peer-offline', { user });
        console.log('Disconnected:', user);
    });
});

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
