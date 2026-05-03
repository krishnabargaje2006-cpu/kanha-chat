# Bhavnesh & Snehal Chat

A private, real-time, peer-to-peer communication platform built exclusively for two users. This project features instant text messaging, file/media sharing, and a robust WebRTC video calling experience with advanced mobile-friendly features.

## 🚀 Features

### 1. Real-Time Chat & Message Management
*   **Instant Messaging:** Powered by WebSockets (`Socket.io`) for zero-latency communication.
*   **Media Sharing:** Send images, videos, and files up to 10MB natively via base64 data URIs. Images open in a custom full-screen lightbox.
*   **Message Status (Read Receipts):** WhatsApp-style indicators:
    *   ◷ Sending...
    *   ✓ Sent to Server
    *   ✓✓ Delivered to Peer
    *   <span style="color:#38bdf8">✓✓</span> Read by Peer
*   **Typing Indicators:** Real-time "typing..." animation when the other user is typing.
*   **Quoted Replies:** Long-press/right-click a message to quote and reply directly to it.
*   **Delete for Everyone:** Context menu allows deleting specific messages for both parties, instantly removing them from both screens.
*   **Clear Chat:** A master wipe button to instantly clear the entire room's history.

### 2. High-End Video Calling (WebRTC)
*   **P2P Video Streaming:** Utilizes the WebRTC `RTCPeerConnection` API and Google STUN servers for direct, low-latency video and audio streaming.
*   **Premium Call UI:** Full-screen incoming and outgoing call modals with animated pulsing avatars, eliminating native browser `alert()` popups.
*   **Synthesized Ringtones:** Uses the browser's native **Web Audio API** (`AudioContext`) to synthesize European-style ringtones and US-style dial tones, avoiding bulky external MP3 files.
*   **Advanced Controls:**
    *   **Draggable Local Video:** The user's self-camera view is fully draggable around the screen using Pointer Events to avoid blocking the peer's face.
    *   **Camera Toggle & Flip:** Disable video to enter "voice only" mode, or dynamically replace the WebRTC video track to switch between front and back mobile cameras.
    *   **Mute Mic:** Instantly mute the local audio track.
    *   **Audio Routing (Speaker Toggle):** A "Spkr" button utilizes the `setSinkId()` API on supported browsers to switch between the loud speaker and earpiece. On iOS Safari, turning off the camera automatically forces the OS to route audio to the earpiece.

### 3. Progressive & Responsive UI
*   **Dark Mode Native:** A premium Slate/Blue color palette designed for OLED screens and low-light environments.
*   **Mobile-First viewport:** Uses `100dvh` and `interactive-widget=resizes-content` meta tags so the UI never breaks when the mobile software keyboard opens.

---

## 🛠️ Tech Stack & Technologies Used

### Frontend (Client-Side)
*   **HTML5 & CSS3:** Vanilla implementations without heavy frameworks. Features CSS variables, flexbox, and complex keyframe animations (pulsing rings, blinking indicators).
*   **Vanilla JavaScript:** Handles complex DOM manipulation, state management, and async browser APIs without React/Vue overhead.
*   **WebRTC API:** `navigator.mediaDevices.getUserMedia` for camera/mic access, `RTCPeerConnection` for streaming, and `RTCSessionDescription`/`RTCIceCandidate` for P2P signaling.
*   **Web Audio API:** `window.AudioContext` and `OscillatorNode` for generating mathematical sound waves (ringtones) on the fly.
*   **FileReader API:** Converts media files to base64 Data URLs for easy socket transmission.

### Backend (Server-Side)
*   **Node.js & Express:** Serves the static client files and sets up the foundational HTTP server.
*   **Socket.io:** The core engine of the app. Handles:
    *   Room isolation (so only Bhavnesh and Snehal see the messages).
    *   P2P WebRTC Signaling (relaying Offers, Answers, and ICE candidates).
    *   Broadcasting typing states and read receipts.
*   **In-Memory Storage:** Due to Render Web Service's ephemeral file system on the free tier, message history is kept in a JavaScript memory array (`messagesByRoom`). Note: This means messages reset if the server sleeps.

---

## 💻 Local Setup & Deployment

1. **Clone & Install:**
   ```bash
   git clone https://github.com/Bhavneshgaddi/bhavnesh-snehal-chat.git
   cd bhavnesh-snehal-chat
   npm install
   ```
2. **Run Locally:**
   ```bash
   npm start
   ```
   Open `http://localhost:3001/?user=bhavnesh&peer=snehal` in one tab, and `http://localhost:3001/?user=snehal&peer=bhavnesh` in another.

3. **Deployment (Render):**
   * This project is deployed on **Render.com** as a Web Service.
   * Node version: 18+ (or default).
   * Build command: `npm install`
   * Start command: `node server.js`
   * *Note: On the free tier, the app goes to sleep after 15 minutes of inactivity. The first request upon waking will take ~50 seconds, and chat history is wiped upon waking.*
