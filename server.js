const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = 3000;
const ROOMS_FILE = path.join(__dirname, 'rooms.json');

// Load or initialize rooms JSON
let rooms = {};
if (fs.existsSync(ROOMS_FILE)) {
    try {
        rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    } catch (e) {
        console.error("Error reading rooms.json, starting fresh.");
    }
}

const saveRooms = () => {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));
};

// HTTP Server to serve index.html
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    } else {
        res.writeHead(404);
        res.end();
    }
});

// Raw WebSocket Server attached to HTTP
const wss = new WebSocketServer({ server });
const clients = new Map(); // Map ws connection to { id, room }

wss.on('connection', (ws) => {
    const clientId = crypto.randomUUID();
    clients.set(ws, { id: clientId, room: null });

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) { return; }

        const client = clients.get(ws);

        switch (data.type) {
            case 'CREATE_ROOM': {
                if (rooms[data.roomName]) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Room already exists.' }));
                    return;
                }
                // Encrypt password securely using salt
                const salt = crypto.randomBytes(16).toString('hex');
                const hash = crypto.pbkdf2Sync(data.password, salt, 1000, 64, 'sha512').toString('hex');
                
                rooms[data.roomName] = { salt, hash };
                saveRooms();
                
                client.room = data.roomName;
                ws.send(JSON.stringify({ type: 'ROOM_JOINED', roomName: data.roomName }));
                break;
            }
            case 'JOIN_ROOM': {
                const room = rooms[data.roomName];
                if (!room) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found.' }));
                    return;
                }
                const hash = crypto.pbkdf2Sync(data.password, room.salt, 1000, 64, 'sha512').toString('hex');
                if (hash !== room.hash) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Incorrect password.' }));
                    return;
                }
                
                client.room = data.roomName;
                ws.send(JSON.stringify({ type: 'ROOM_JOINED', roomName: data.roomName }));
                // Notify others so WebRTC sequence can begin
                broadcastToRoom(client.room, { type: 'CLIENT_JOINED', clientId }, ws);
                break;
            }
            case 'SIGNAL': {
                // Route WebRTC signaling messages directly to the target peer
                for (const[targetWs, targetClient] of clients.entries()) {
                    if (targetClient.id === data.targetId && targetWs.readyState === targetWs.OPEN) {
                        targetWs.send(JSON.stringify({
                            type: 'SIGNAL',
                            fromId: client.id,
                            signal: data.signal
                        }));
                        break;
                    }
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        const client = clients.get(ws);
        if (client.room) {
            broadcastToRoom(client.room, { type: 'CLIENT_LEFT', clientId: client.id });
        }
        clients.delete(ws);
    });
});

function broadcastToRoom(roomName, msgObj, excludeWs = null) {
    for (const [ws, client] of clients.entries()) {
        if (client.room === roomName && ws !== excludeWs && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(msgObj));
        }
    }
}

server.listen(PORT, () => {
    console.log(`Security Camera Server is running on port ${PORT}`);
    console.log(`Access locally at: http://localhost:${PORT}`);
});