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

const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    
    // Auth Helper
    const authRoom = (roomName, password) => {
        const room = rooms[roomName];
        if (!room) return false;
        const hash = crypto.pbkdf2Sync(password, room.salt, 1000, 64, 'sha512').toString('hex');
        return hash === room.hash;
    };

    if (urlObj.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    
    // Save Camera Feed Chunks (Independent segments)
    if (urlObj.pathname === '/upload') {
        const room = urlObj.searchParams.get('room');
        const pwd = urlObj.searchParams.get('pwd');
        const filename = urlObj.searchParams.get('filename');
        
        if (!authRoom(room, pwd)) { res.writeHead(403); return res.end(); }
        
        const recDir = path.join(__dirname, 'recordings');
        if (!fs.existsSync(recDir)) fs.mkdirSync(recDir);
        
        const safeFilename = path.basename(filename || '');
        if (!safeFilename) { res.writeHead(400); return res.end(); }
        const writeStream = fs.createWriteStream(path.join(recDir, safeFilename));
        req.pipe(writeStream);
        req.on('end', () => { res.writeHead(200); res.end(); });
        return;
    }
    
    // Get list of room's recordings grouped by Sessions
    if (urlObj.pathname === '/recordings-list') {
        const room = urlObj.searchParams.get('room');
        const pwd = urlObj.searchParams.get('pwd');
        if (!authRoom(room, pwd)) { res.writeHead(403); return res.end('[]'); }
        
        const recDir = path.join(__dirname, 'recordings');
        if (!fs.existsSync(recDir)) { res.writeHead(200); return res.end('[]'); }
        
        const safeRoom = encodeURIComponent(room).replace(/---/g, '');
        const files = fs.readdirSync(recDir).filter(f => f.startsWith(safeRoom + '---'));
        const sessions = {};
        
        files.forEach(f => {
            const parts = f.split('---');
            if (parts.length < 4) return;
            const camId = decodeURIComponent(parts[1]);
            const sessionStart = parseInt(parts[2], 10);
            const chunkStart = parseInt(parts[3].split('.')[0], 10);
            
            if (!sessions[sessionStart]) {
                sessions[sessionStart] = { sessionStart, camId, chunks:[] };
            }
            sessions[sessionStart].chunks.push({ chunkStart, filename: f });
        });
        
        // Sort chunks inside each session chronologically
        Object.values(sessions).forEach(s => s.chunks.sort((a, b) => a.chunkStart - b.chunkStart));
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Return sessions sorted newest to oldest
        return res.end(JSON.stringify(Object.values(sessions).sort((a,b) => b.sessionStart - a.sessionStart)));
    }

    // Serve Video File with Range Support (Allows Timeline Seeking)
    if (urlObj.pathname.startsWith('/recordings/')) {
        const filePath = path.join(__dirname, decodeURIComponent(urlObj.pathname));
        if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end(); }
        
        const stat = fs.statSync(filePath);
        const range = req.headers.range;
        const ext = path.extname(filePath).toLowerCase();
        const contentType = ext === '.mp4' ? 'video/mp4' : 'video/webm';
        
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType
            });
            file.pipe(res);
        } else {
            res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType });
            fs.createReadStream(filePath).pipe(res);
        }
        return;
    }

    res.writeHead(404);
    res.end();
});

// Raw WebSocket Server attached to HTTP
const wss = new WebSocketServer({ server });
const clients = new Map(); // Map ws connection to { id, room }

wss.on('connection', (ws) => {
    const clientId = crypto.randomUUID();
    clients.set(ws, { id: clientId, room: null });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

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

const interval = setInterval(() => {
    for (const [ws] of clients.entries()) {
        if (ws.isAlive === false) {
            clients.delete(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    }
}, 30000);
wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
    console.log(`Security Camera Server is running on port ${PORT}`);
    console.log(`Access locally at: http://localhost:${PORT}`);
});