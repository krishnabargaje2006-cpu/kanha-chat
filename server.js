const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3001;

// In-memory storage — works on any host including Render free tier
const messagesByRoom = {};

function getMessages(roomId) {
    return messagesByRoom[roomId] || [];
}

function saveMessage(msg) {
    if (!messagesByRoom[msg.roomId]) {
        messagesByRoom[msg.roomId] = [];
    }
    messagesByRoom[msg.roomId].push(msg);
    // Keep only last 200 messages per room
    if (messagesByRoom[msg.roomId].length > 200) {
        messagesByRoom[msg.roomId].shift();
    }
}

app.use(express.static(path.join(__dirname, 'public')));

// Health check route (keeps Render free instance alive if pinged)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (data) => {
        const { user, peer, roomId } = data;
        socket.join(roomId);
        socket.data.user = user;
        socket.data.roomId = roomId;
        console.log(`${user} joined room: ${roomId}`);

        // Send existing messages for this room
        socket.emit('init-messages', getMessages(roomId));
        
        // Notify peer that user is online
        socket.to(roomId).emit('peer-online', { user });
    });

    socket.on('send-message', (data) => {
        const message = {
            id: Date.now().toString(),
            roomId: data.roomId,
            text: data.text,
            sender: data.sender,
            timestamp: new Date().toISOString()
        };
        saveMessage(message);
        io.to(data.roomId).emit('new-message', message);
    });

    // WebRTC Signaling
    socket.on('signal', (data) => {
        socket.to(data.roomId).emit('signal', {
            sender: data.sender,
            signal: data.signal
        });
    });

    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        const user = socket.data.user;
        if (roomId) {
            socket.to(roomId).emit('peer-offline', { user });
        }
        console.log('User disconnected:', user);
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
