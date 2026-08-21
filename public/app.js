// ============================================
// VIDEO CALL APP — Bulletproof Edition
// Fixes: Glare, ICE queue, PC leak, reconnect ghosts,
//        iOS autoplay, audio fallback, visibility resume
// ============================================

const socket = io(window.location.origin, {
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  autoConnect: true
});

// === DOM Elements ===
const pinScreen = document.getElementById('pin-screen');
const previewScreen = document.getElementById('preview-screen');
const waitingScreen = document.getElementById('waiting-screen');
const callScreen = document.getElementById('call-screen');
const reconnectScreen = document.getElementById('reconnect-screen');

const pinInput = document.getElementById('pin-input');
const joinBtn = document.getElementById('join-btn');
const errorMsg = document.getElementById('error-msg');

const previewVideo = document.getElementById('preview-video');
const previewToggleAudio = document.getElementById('preview-toggle-audio');
const previewToggleVideo = document.getElementById('preview-toggle-video');
const cancelPreviewBtn = document.getElementById('cancel-preview-btn');
const confirmJoinBtn = document.getElementById('confirm-join-btn');
const recordingDot = document.getElementById('recording-dot');

const waitingPin = document.getElementById('waiting-pin');
const cancelWaitBtn = document.getElementById('cancel-wait-btn');

const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const toggleAudioBtn = document.getElementById('toggle-audio-btn');
const toggleVideoBtn = document.getElementById('toggle-video-btn');
const screenShareBtn = document.getElementById('screen-share-btn');
const endCallBtn = document.getElementById('end-call-btn');
const connectionStatus = document.getElementById('connection-status');
const remoteMuted = document.getElementById('remote-muted');
const remoteScreenIndicator = document.getElementById('remote-screen-share-indicator');
const callTimer = document.getElementById('call-timer');
const localRecDot = document.getElementById('local-rec-dot');
const connectionQuality = document.getElementById('connection-quality');

const reconnectBtn = document.getElementById('reconnect-btn');
const reconnectCancelBtn = document.getElementById('reconnect-cancel-btn');

// === State ===
let localStream = null;
let peerConnection = null;
let currentPin = null;
let isAudioEnabled = true;
let isVideoEnabled = true;
let isScreenSharing = false;
let screenStream = null;
let originalVideoTrack = null;
let remoteAudioEnabled = true;
let callStartTime = null;
let timerInterval = null;
let isInCall = false;
let makingOffer = false;
let ignoreOffer = false;
let polite = false;
let iceCandidateQueue = [];
let isAudioOnly = false;

// Hide screen share on mobile (no getDisplayMedia support)
if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
  screenShareBtn.classList.add('hidden');
}

// === TURN + STUN Servers ===
const servers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:80?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
};

// ============================================
// PIN INPUT
// ============================================

pinInput.addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  joinBtn.disabled = e.target.value.length !== 4;
  errorMsg.textContent = '';
});

pinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && pinInput.value.length === 4) {
    startPreview();
  }
});

joinBtn.addEventListener('click', startPreview);

// ============================================
// PREVIEW SCREEN
// ============================================

async function startPreview() {
  const pin = pinInput.value.trim();
  if (!/^\d{4}$/.test(pin)) {
    errorMsg.textContent = 'Please enter exactly 4 digits';
    return;
  }
  currentPin = pin;

  try {
    stopLocalStream();
    localStream = await getMediaStream();
    isAudioOnly = false;
  } catch (err) {
    console.error('Video access denied, trying audio-only:', err);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      isAudioOnly = true;
    } catch (err2) {
      errorMsg.textContent = 'Microphone access denied. Please allow access in browser settings.';
      return;
    }
  }

  previewVideo.srcObject = localStream;
  recordingDot.classList.toggle('hidden', isAudioOnly || !isVideoEnabled);
  showScreen('preview');
}

function getMediaStream() {
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user'
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000
    }
  });
}

previewToggleAudio.addEventListener('click', () => {
  if (!localStream) return;
  isAudioEnabled = !isAudioEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = isAudioEnabled);
  previewToggleAudio.classList.toggle('active', isAudioEnabled);
});

previewToggleVideo.addEventListener('click', () => {
  if (!localStream || isAudioOnly) return;
  isVideoEnabled = !isVideoEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = isVideoEnabled);
  previewToggleVideo.classList.toggle('active', isVideoEnabled);
  recordingDot.classList.toggle('hidden', !isVideoEnabled);
});

cancelPreviewBtn.addEventListener('click', () => {
  stopLocalStream();
  resetToPinScreen();
});

confirmJoinBtn.addEventListener('click', () => {
  showScreen('waiting');
  waitingPin.textContent = currentPin;
  socket.emit('join-room', currentPin);
});

// ============================================
// WAITING SCREEN
// ============================================

cancelWaitBtn.addEventListener('click', () => {
  if (currentPin) socket.emit('end-call', currentPin);
  cleanup();
  resetToPinScreen();
});

// ============================================
// RECONNECT SCREEN
// ============================================

reconnectBtn.addEventListener('click', () => {
  if (currentPin) {
    socket.connect();
    socket.emit('join-room', currentPin);
    showScreen('waiting');
  }
});

reconnectCancelBtn.addEventListener('click', () => {
  cleanup();
  resetToPinScreen();
});

// ============================================
// CALL CONTROLS
// ============================================

toggleAudioBtn.addEventListener('click', () => {
  if (!localStream) return;
  isAudioEnabled = !isAudioEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = isAudioEnabled);
  toggleAudioBtn.classList.toggle('active', isAudioEnabled);
  socket.emit('toggle-audio', { pin: currentPin, enabled: isAudioEnabled });
});

toggleVideoBtn.addEventListener('click', () => {
  if (!localStream || isAudioOnly) return;
  isVideoEnabled = !isVideoEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = isVideoEnabled);
  toggleVideoBtn.classList.toggle('active', isVideoEnabled);
  localRecDot.classList.toggle('hidden', !isVideoEnabled);
  socket.emit('toggle-video', { pin: currentPin, enabled: isVideoEnabled });
});

screenShareBtn.addEventListener('click', toggleScreenShare);
endCallBtn.addEventListener('click', () => {
  socket.emit('end-call', currentPin);
  endCallLocal();
});

// ============================================
// SCREEN SHARING
// ============================================

async function toggleScreenShare() {
  if (!navigator.mediaDevices.getDisplayMedia) return;

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: false
      });

      const screenTrack = screenStream.getVideoTracks()[0];
      const senders = peerConnection?.getSenders() || [];
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');

      if (videoSender && localStream) {
        originalVideoTrack = localStream.getVideoTracks()[0];
        await videoSender.replaceTrack(screenTrack);
        localStream.removeTrack(originalVideoTrack);
        localStream.addTrack(screenTrack);
        localVideo.srcObject = localStream;
      }

      isScreenSharing = true;
      screenShareBtn.classList.add('active');
      socket.emit('screen-share', { pin: currentPin, enabled: true });

      screenTrack.onended = () => stopScreenShare();
    } catch (err) {
      console.error('Screen share failed:', err);
    }
  } else {
    stopScreenShare();
  }
}

async function stopScreenShare() {
  if (!isScreenSharing) return;

  const screenTrack = screenStream?.getVideoTracks()[0];
  if (screenTrack) screenTrack.stop();

  if (originalVideoTrack && peerConnection && localStream) {
    const senders = peerConnection.getSenders();
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if (videoSender) await videoSender.replaceTrack(originalVideoTrack);

    const currentScreenTrack = localStream.getVideoTracks()[0];
    if (currentScreenTrack) localStream.removeTrack(currentScreenTrack);
    localStream.addTrack(originalVideoTrack);
    localVideo.srcObject = localStream;
  }

  screenStream = null;
  originalVideoTrack = null;
  isScreenSharing = false;
  screenShareBtn.classList.remove('active');
  socket.emit('screen-share', { pin: currentPin, enabled: false });
}

// ============================================
// WEBRTC — Perfect Negotiation Pattern
// ============================================

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.onnegotiationneeded = null;
    peerConnection.close();
    peerConnection = null;
  }
  iceCandidateQueue = [];
  makingOffer = false;
  ignoreOffer = false;
}

async function createPeerConnection() {
  closePeerConnection();

  peerConnection = new RTCPeerConnection(servers);

  // Add tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // Remote stream
  peerConnection.ontrack = (event) => {
    const [remoteStream] = event.streams;
    if (remoteStream) {
      remoteVideo.srcObject = remoteStream;
      remoteVideo.play().catch(() => {});
      updateConnectionStatus('Connected');
    }
  };

  // ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && currentPin) {
      socket.emit('ice-candidate', { pin: currentPin, candidate: event.candidate });
    }
  };

  // Connection state
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('Connection state:', state);
    if (state === 'connected') {
      updateConnectionStatus('Connected');
      startCallTimer();
    } else if (state === 'disconnected') {
      updateConnectionStatus('Reconnecting...');
    } else if (state === 'failed') {
      updateConnectionStatus('Connection failed');
    }
  };

  // ICE state for quality indicator
  peerConnection.oniceconnectionstatechange = () => {
    const iceState = peerConnection.iceConnectionState;
    console.log('ICE state:', iceState);
  };

  // Perfect negotiation: onnegotiationneeded
  peerConnection.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      const offer = await peerConnection.createOffer();
      if (peerConnection.signalingState !== 'stable') return;
      await peerConnection.setLocalDescription(offer);
      socket.emit('offer', { pin: currentPin, offer: offer });
    } catch (err) {
      console.error('Negotiation error:', err);
    } finally {
      makingOffer = false;
    }
  };
}

async function flushIceQueue() {
  while (iceCandidateQueue.length > 0 && peerConnection && peerConnection.remoteDescription) {
    const c = iceCandidateQueue.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(c));
    } catch (err) {
      console.error('Error adding queued ICE candidate:', err);
    }
  }
}

async function handleOffer(offer, from) {
  const readyForOffer = !makingOffer &&
    (peerConnection ? peerConnection.signalingState === 'stable' : true);

  ignoreOffer = !polite && !readyForOffer;

  if (ignoreOffer) {
    console.log('Ignoring impolite offer');
    return;
  }

  if (!peerConnection) await createPeerConnection();

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  await flushIceQueue();

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('answer', { pin: currentPin, answer: answer });
}

async function handleAnswer(answer) {
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  await flushIceQueue();
}

async function handleIceCandidate(candidate) {
  if (!peerConnection) {
    iceCandidateQueue.push(candidate);
    return;
  }
  if (!peerConnection.remoteDescription) {
    iceCandidateQueue.push(candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    if (!ignoreOffer) {
      console.error('Error adding ICE candidate:', err);
    }
  }
}

// ============================================
// CALL TIMER
// ============================================

function startCallTimer() {
  if (timerInterval) return;
  callStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    callTimer.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  callStartTime = null;
  callTimer.textContent = '00:00';
}

// ============================================
// CLEANUP
// ============================================

function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (previewVideo) previewVideo.srcObject = null;
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
}

function cleanup() {
  closePeerConnection();
  stopLocalStream();
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  originalVideoTrack = null;
  isScreenSharing = false;
  screenShareBtn.classList.remove('active');
  currentPin = null;
  isAudioEnabled = true;
  isVideoEnabled = true;
  isAudioOnly = false;
  isInCall = false;
  polite = false;
  stopCallTimer();
  updateConnectionStatus('Connecting...');
  remoteMuted.classList.add('hidden');
  remoteScreenIndicator.classList.add('hidden');
  connectionQuality.classList.add('hidden');
  toggleAudioBtn.classList.add('active');
  toggleVideoBtn.classList.add('active');
  localRecDot.classList.remove('hidden');
  recordingDot.classList.add('hidden');
}

function endCallLocal() {
  cleanup();
  resetToPinScreen();
}

function resetToPinScreen() {
  showScreen('pin');
  pinInput.value = '';
  joinBtn.disabled = true;
  waitingPin.textContent = '';
  errorMsg.textContent = '';
}

function showScreen(name) {
  [pinScreen, previewScreen, waitingScreen, callScreen, reconnectScreen].forEach(s => s.classList.remove('active'));
  if (name === 'pin') pinScreen.classList.add('active');
  if (name === 'preview') previewScreen.classList.add('active');
  if (name === 'waiting') waitingScreen.classList.add('active');
  if (name === 'call') callScreen.classList.add('active');
  if (name === 'reconnect') reconnectScreen.classList.add('active');
}

function updateConnectionStatus(text) {
  connectionStatus.textContent = text;
  connectionStatus.style.display = text ? 'block' : 'none';
  if (text === 'Connected') {
    setTimeout(() => { connectionStatus.style.display = 'none'; }, 2500);
  }
}

// ============================================
// VISIBILITY CHANGE — Resume camera
// ============================================

document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !isInCall || isAudioOnly) return;

  const videoTrack = localStream?.getVideoTracks()[0];
  if (videoTrack && videoTrack.readyState === 'ended') {
    console.log('Camera stopped in background, re-acquiring...');
    try {
      const newStream = await getMediaStream();
      const newTrack = newStream.getVideoTracks()[0];
      const oldTrack = localStream.getVideoTracks()[0];

      if (peerConnection) {
        const sender = peerConnection.getSenders().find(s => s.track === oldTrack);
        if (sender) await sender.replaceTrack(newTrack);
      }

      localStream.removeTrack(oldTrack);
      oldTrack.stop();
      localStream.addTrack(newTrack);
      localVideo.srcObject = localStream;
    } catch (err) {
      console.error('Failed to re-acquire camera:', err);
    }
  }
});

// ============================================
// SOCKET EVENTS
// ============================================

socket.on('waiting', (msg) => {
  console.log(msg);
});

socket.on('user-joined', async (data) => {
  console.log('User joined:', data.from, 'shouldOffer:', data.shouldOffer);
  showScreen('call');
  isInCall = true;
  polite = !data.shouldOffer; // First user = impolite (waits for offer), second = polite

  if (data.shouldOffer) {
    await createPeerConnection();
  }
  // If shouldOffer is false, we wait for the offer to arrive
});

socket.on('offer', async (data) => {
  console.log('Received offer from:', data.from);
  await handleOffer(data.offer, data.from);
});

socket.on('answer', async (data) => {
  console.log('Received answer from:', data.from);
  await handleAnswer(data.answer);
});

socket.on('ice-candidate', async (data) => {
  await handleIceCandidate(data.candidate);
});

socket.on('toggle-audio', (data) => {
  remoteAudioEnabled = data.enabled;
  remoteMuted.classList.toggle('hidden', remoteAudioEnabled);
});

socket.on('toggle-video', (data) => {
  // Visual feedback if needed
});

socket.on('screen-share', (data) => {
  remoteScreenIndicator.classList.toggle('hidden', !data.enabled);
});

socket.on('call-ended', () => {
  alert('The other person ended the call');
  endCallLocal();
});

socket.on('user-left', () => {
  updateConnectionStatus('Other person left');
  closePeerConnection();
  remoteVideo.srcObject = null;
  stopCallTimer();
});

socket.on('error', (msg) => {
  if (msg.includes('full')) {
    cleanup();
    resetToPinScreen();
  }
  errorMsg.textContent = msg;
});

socket.on('disconnect', (reason) => {
  console.log('Socket disconnected:', reason);
  if (isInCall) {
    showScreen('reconnect');
  }
});

socket.on('reconnect', () => {
  console.log('Socket reconnected');
});

socket.on('reconnect_failed', () => {
  showScreen('reconnect');
});

// ============================================
// SAFETY: Warn before closing tab
// ============================================

window.addEventListener('beforeunload', (e) => {
  if (isInCall) {
    e.preventDefault();
    e.returnValue = '';
  }
});
