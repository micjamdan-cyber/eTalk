const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const ROOM_TTL_MS = 5 * 60 * 1000;

function validatePin(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

function getOtherUser(room, myId) {
  for (const id of room.users) {
    if (id !== myId) return id;
  }
  return null;
}

function scheduleRoomCleanup(pin) {
  const room = rooms.get(pin);
  if (!room) return;
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const r = rooms.get(pin);
    if (r && r.users.size === 0) {
      rooms.delete(pin);
      console.log(`Room ${pin} expired and deleted`);
    }
  }, ROOM_TTL_MS);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  let currentRoom = null;

  function leaveCurrentRoom() {
    if (!currentRoom) return;
    socket.leave(currentRoom);
    const room = rooms.get(currentRoom);
    if (room) {
      room.users.delete(socket.id);
      socket.to(currentRoom).emit('user-left', socket.id);
      if (room.users.size === 0) {
        scheduleRoomCleanup(currentRoom);
      }
    }
    currentRoom = null;
  }

  socket.on('join-room', (pin) => {
    if (!validatePin(pin)) {
      socket.emit('error', 'PIN must be exactly 4 digits');
      return;
    }

    leaveCurrentRoom();

    currentRoom = pin;
    socket.join(pin);

    if (!rooms.has(pin)) {
      rooms.set(pin, { users: new Set(), createdAt: Date.now(), cleanupTimer: null });
    }

    const room = rooms.get(pin);
    room.users.add(socket.id);

    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }

    const userCount = room.users.size;

    if (userCount === 1) {
      socket.emit('waiting', 'Waiting for someone to join with PIN: ' + pin);
    } else if (userCount === 2) {
      const otherId = getOtherUser(room, socket.id);
      // The existing user waits for an offer (shouldOffer: false)
      socket.to(pin).emit('user-joined', { from: socket.id, shouldOffer: false });
      // The new user creates the offer (shouldOffer: true)
      socket.emit('user-joined', { from: otherId, shouldOffer: true });
    } else {
      room.users.delete(socket.id);
      socket.leave(pin);
      currentRoom = null;
      socket.emit('error', 'Room is full (max 2 users)');
      return;
    }

    console.log(`User ${socket.id} joined room ${pin} (${userCount}/2)`);
  });

  socket.on('offer', (data) => {
    if (!data || !validatePin(data.pin) || !data.offer) return;
    socket.to(data.pin).emit('offer', { offer: data.offer, from: socket.id });
  });

  socket.on('answer', (data) => {
    if (!data || !validatePin(data.pin) || !data.answer) return;
    socket.to(data.pin).emit('answer', { answer: data.answer, from: socket.id });
  });

  socket.on('ice-candidate', (data) => {
    if (!data || !validatePin(data.pin) || !data.candidate) return;
    socket.to(data.pin).emit('ice-candidate', { candidate: data.candidate, from: socket.id });
  });

  socket.on('toggle-audio', (data) => {
    if (!data || !validatePin(data.pin)) return;
    socket.to(data.pin).emit('toggle-audio', { userId: socket.id, enabled: !!data.enabled });
  });

  socket.on('toggle-video', (data) => {
    if (!data || !validatePin(data.pin)) return;
    socket.to(data.pin).emit('toggle-video', { userId: socket.id, enabled: !!data.enabled });
  });

  socket.on('screen-share', (data) => {
    if (!data || !validatePin(data.pin)) return;
    socket.to(data.pin).emit('screen-share', { userId: socket.id, enabled: !!data.enabled });
  });

  socket.on('end-call', (pin) => {
    if (!validatePin(pin)) return;
    // Notify the other user that the call ended
    socket.to(pin).emit('call-ended');
    // Clean up this user's room state
    leaveCurrentRoom();
  });

  socket.on('disconnect', (reason) => {
    console.log('User disconnected:', socket.id, 'Reason:', reason);
    leaveCurrentRoom();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
