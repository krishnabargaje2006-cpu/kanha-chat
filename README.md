# Bhavnesh & Snehal Chat - Technical Architecture Documentation

A highly optimized, real-time, peer-to-peer communication platform built exclusively for two users. This project implements advanced networking protocols (WebSockets & WebRTC) using a lightweight vanilla technology stack to ensure zero-latency communication, direct media streaming, and robust state management.

This document provides a deep, technical explanation of exactly how the system is engineered, what technologies were used, and the internal workflows of the application.

---

## 🏛️ System Architecture Overview

The system is built on a **Client-Server-Client** model for text and media, and a **Peer-to-Peer (P2P)** model for video calling. 

1. **The Signaling Server (Backend):** A Node.js/Express server running `Socket.io`. It acts as the "switchboard." It does not process heavy data; instead, it manages connections, routes text messages to the correct user, and handles the "handshakes" required to set up direct video calls.
2. **The Client (Frontend):** A Vanilla HTML/CSS/JS application. It handles DOM manipulation, captures audio/video from device hardware using `navigator.mediaDevices`, and synthesizes audio using the `Web Audio API`.
3. **The P2P Mesh (WebRTC):** Once the server helps the two clients find each other, video and audio streams bypass the server completely and flow directly between the two users' devices.

---

## ⚙️ Detailed Component Breakdown

### 1. Real-Time Messaging (Socket.io)
**Where it's used:** `server.js` and `public/script.js`
**How it works:**
Unlike traditional HTTP requests where the client must constantly "ask" the server for new data, WebSockets maintain an open, persistent tunnel. 
*   **Rooms:** When a user connects (`/?user=bhavnesh&peer=snehal`), the server dynamically creates a unique "Room ID" by alphabetically sorting the two names (`bhavnesh-snehal`). Both users are placed in this isolated Socket.io room.
*   **The Message Flow:**
    1. User A types a message and hits send. The client generates a mathematically unique `msgId`.
    2. The client emits a `send-message` event to the server.
    3. The server receives it, saves it to memory, and immediately broadcasts it to User B using `socket.to(roomId).emit(...)`.
    4. The server simultaneously sends an "Acknowledgment" (Ack) back to User A, changing the UI tick mark to **✓ (Sent)**.

### 2. Read Receipts & State Management
**How it works:**
The system uses a 3-tier state tracker to mimic WhatsApp.
*   **Pending (◷):** The message is rendered in the local DOM before the server even responds.
*   **Sent (✓):** The server's callback acknowledges receipt.
*   **Delivered (✓✓):** When User B receives the socket broadcast, their device automatically fires a `message-status-update` back to the server with `status: 'delivered'`.
*   **Read (<span style="color:#38bdf8">✓✓</span>):** When User B's browser window is in focus and the message is rendered, it fires a `status: 'read'` event. The server updates its memory and broadcasts this back to User A to turn the ticks blue.

### 3. Media Handling (Base64 Encoding)
**Where it's used:** `handleFileUpload()` in `script.js`
**How it works:**
Instead of using complex multipart form data and AWS S3 buckets (which cost money), this app uses the browser's native `FileReader API`.
*   When a user selects an image or PDF, the browser reads the file natively and converts it into a **Base64 Data URI** (a massive string of text representing the file's binary data).
*   Because `Socket.io` allows large buffer sizes (configured to `10MB` in `server.js`), this string is sent directly over the WebSocket connection.
*   The receiving browser takes this string and places it directly into the `src` attribute of an `<img>` tag or the `href` of an `<a>` tag, rendering the file instantly without downloading it from a server database.

### 4. Storage Strategy (In-Memory Database)
**Where it's used:** `const messagesByRoom = {}` in `server.js`
**How it works:**
Because this project is hosted on Render's Free Web Service tier, the server's hard drive is ephemeral (read-only/wiped frequently). 
*   Instead of writing to a `messages.json` file (which causes crashes on Render), all messages are stored in a JavaScript RAM Object. 
*   **Limitation & Benefit:** The memory is capped at 300 messages per room to prevent RAM overflow. If the server goes to sleep due to 15 minutes of inactivity, the memory is wiped, ensuring complete privacy and zero hosting costs.

### 5. WebRTC Video Calling & Signaling
**Where it's used:** `setupPeerConnection()` and signaling socket events.
**How it works:**
WebRTC (Web Real-Time Communication) requires devices to know each other's public IP addresses. Firewalls usually block this. We bypass this using **STUN Servers** and a process called **Signaling**:
1.  **The Call:** User A clicks Call. `script.js` sends a `call-request` to the server, which forwards it to User B to trigger the ringing UI.
2.  **The Accept:** User B clicks Accept.
3.  **The Offer (SDP):** User A's browser generates a "Session Description Protocol" (Offer) containing its video/audio codecs and asks Google's free STUN servers (`stun.l.google.com:19302`) to find its public IP address (ICE Candidates).
4.  **The Relay:** User A sends this Offer and IP data to the Node.js server, which blindly relays it to User B.
5.  **The Answer:** User B's browser processes the offer, generates an "Answer", finds its own IP, and relays it back through the Node.js server.
6.  **The P2P Connection:** Both browsers now have each other's direct IP addresses. They punch a hole through their firewalls and stream the video bytes directly to each other. The Node.js server is completely removed from the video loop.

### 6. Synthesized Ringtones (Web Audio API)
**Where it's used:** `playRingtone()` in `script.js`
**How it works:**
To avoid loading heavy `.mp3` audio files which delay call connection times, the app generates its own sound waves using pure mathematics.
*   We initialize an `AudioContext`.
*   We create two `OscillatorNodes` generating sine waves at specific frequencies (e.g., 440Hz and 480Hz).
*   We route these waves through a `GainNode` (volume control).
*   Using `setTimeout`, we rapidly toggle the volume up and down in specific patterns to mimic a European phone ring (`[400ms ON, 200ms OFF]`) or a US dial tone (`[2000ms ON, 3000ms OFF]`).

### 7. UI / UX Micro-interactions
*   **Draggable Video:** Uses `pointerdown`, `pointermove`, and `pointerup` event listeners. When the user taps their self-camera view, the app calculates the bounding client rectangle, unbinds CSS constraints, and recalculates the absolute `X` and `Y` coordinates based on finger movement (`e.clientX`).
*   **Mobile Keyboard Prevention:** Mobile browsers shrink the screen when the keyboard opens, often breaking chat UIs. We solved this using the modern CSS `100dvh` viewport unit combined with the `<meta name="viewport" content="... interactive-widget=resizes-content">` tag, ensuring the chat input box naturally rests precisely on top of the keyboard.

---

## 🛠️ Complete Tech Stack Summary

*   **HTML5 / CSS3:** Structure, styling, flexbox layouts, CSS variables, and keyframe animations.
*   **Vanilla JavaScript (ES6+):** Client-side logic, DOM manipulation, async/await functionality.
*   **Node.js & Express.js:** Server runtime and HTTP routing.
*   **Socket.io:** Real-time event-driven bidirectional communication.
*   **WebRTC (`RTCPeerConnection`):** Direct Peer-to-Peer video/audio streaming.
*   **Web Audio API (`AudioContext`):** Mathematical sound wave generation.
*   **Render Web Services:** Cloud hosting platform.
