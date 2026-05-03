const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// Initialize messages file if not exists
if (!fs.existsSync(MESSAGES_FILE)) {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify([]));
}

app.use(express.static(path.join(__dirname, 'public')));

function getMessages(roomId) {
    try {
        const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
        const allMessages = JSON.parse(data);
        return allMessages.filter(m => m.roomId === roomId);
    } catch (err) {
        return [];
    }
}

function saveMessage(msg) {
    try {
        const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
        const allMessages = JSON.parse(data);
        allMessages.push(msg);
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(allMessages, null, 2));
    } catch (err) {
        console.error("Error saving message:", err);
    }
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (data) => {
        const { user, peer, roomId } = data;
        socket.join(roomId);
        console.log(`${user} joined room: ${roomId}`);
        
        // Send history for this room
        socket.emit('init-messages', getMessages(roomId));
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
        // Broadcast to others in the room
        socket.to(data.roomId).emit('signal', {
            sender: data.sender,
            signal: data.signal
        });
    });

    socket.on('call-user', (data) => {
        socket.to(data.roomId).emit('incoming-call', { from: data.from });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
