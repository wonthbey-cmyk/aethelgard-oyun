const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const DATA_FILE = 'server_data.json';

let serverState = {
    maps: [],
    mainMapId: null,
    weather: 'NONE',
    environmentColor: 'rgba(0,0,0,0)',
    speedMultiplier: 1.0,
    users: [
        { username: '213enbüyükbenim', password: '213213', role: 'GM' }
    ],
    usersData: {} // OYUNCU ENVANTERLERİ, ALTINLARI, PORTRELERİ BURADA SAKLANACAK
};

// Sunucu açıldığında eski verileri yükle
if (fs.existsSync(DATA_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        serverState = { ...serverState, ...savedData };
        if (!serverState.users.find(u => u.username === '213enbüyükbenim')) {
            serverState.users.push({ username: '213enbüyükbenim', password: '213213', role: 'GM' });
        }
        if(!serverState.usersData) serverState.usersData = {};
        console.log("Kayıtlı diyar verileri başarıyla yüklendi!");
    } catch (err) {
        console.error("Kayıt dosyası okunurken hata oluştu:", err);
    }
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(serverState, null, 2));
}

let activePlayers = {}; 

io.on('connection', (socket) => {
    console.log('Bir ruh bağlantı kurdu. ID:', socket.id);

    // GİRİŞ
    socket.on('login_request', (username, password) => {
        const user = serverState.users.find(u => u.username === username && u.password === password);
        if (user) {
            // Eğer kullanıcının kayıtlı bir oyun verisi yoksa, sıfırdan oluştur
            if (!serverState.usersData[username]) {
                serverState.usersData[username] = {
                    gold: user.role === 'GM' ? 999999 : 0, 
                    hp: 100, maxHp: 100, 
                    inventory: [], wardrobe: [], 
                    image: null, name: username, size: 18
                };
            }
            socket.emit('login_success', user.role, user.username, serverState, activePlayers, serverState.usersData[username]);
        } else {
            socket.emit('login_error', 'Hatalı kullanıcı adı veya şifre.');
        }
    });

    // OYUNCU KAYIT
    socket.on('create_user', (newUsername, newPassword) => {
        if (serverState.users.find(u => u.username === newUsername)) {
            socket.emit('user_create_result', false, 'Bu kullanıcı adı zaten alınmış!');
            return;
        }
        serverState.users.push({ username: newUsername, password: newPassword, role: 'PLAYER' });
        saveData();
        socket.emit('user_create_result', true, `${newUsername} başarıyla diyara eklendi.`);
    });

    // OYUNCU VERİLERİNİ GÜNCELLEME (Envanter, altın vb. değiştiğinde client bunu çağırır)
    socket.on('player_update_stats', (username, data) => {
        if(serverState.usersData[username]) {
            serverState.usersData[username] = data;
            saveData();
        }
    });

    socket.on('disconnect', () => {
        delete activePlayers[socket.id];
        io.emit('player_hidden', socket.id); 
    });

    socket.on('player_update', (playerData) => {
        activePlayers[socket.id] = playerData;
        socket.broadcast.emit('player_sync_single', socket.id, playerData);
    });

    // HARİTA
    socket.on('gm_upload_map', (newMap) => {
        serverState.maps.push(newMap);
        if (serverState.maps.length === 1) serverState.mainMapId = newMap.id;
        saveData();
        io.emit('world_maps_updated', serverState.maps, serverState.mainMapId);
    });

    socket.on('gm_update_map_objects', (mapId, objectsData) => {
        let map = serverState.maps.find(m => m.id === mapId);
        if (map) {
            map.walls = objectsData.walls || [];
            map.tps = objectsData.tps || [];
            map.bots = objectsData.bots || [];
            map.roofs = objectsData.roofs || [];
            map.notes = objectsData.notes || [];
            map.musicZones = objectsData.musicZones || [];
            saveData();
            socket.broadcast.emit('map_objects_synced', mapId, objectsData);
        }
    });

    socket.on('gm_update_universe', (envColor, speedMulti) => {
        serverState.environmentColor = envColor;
        serverState.speedMultiplier = speedMulti;
        saveData();
        io.emit('universe_synced', envColor, speedMulti);
    });

    socket.on('gm_set_weather', (weatherType) => {
        serverState.weather = weatherType;
        saveData();
        io.emit('weather_sync', weatherType);
    });

    socket.on('gm_give_gold', (targetId, amount) => {
        io.to(targetId).emit('receive_gold', amount);
    });

    // MESAJLAR
    socket.on('chat_message', (msgData) => {
        msgData.socketId = socket.id;
        socket.broadcast.emit('new_chat_message', msgData);
    });

    socket.on('gm_god_message', (text) => {
        io.emit('show_god_message', text);
    });

    // IŞINLANMA YARDIMCISI (DÜZELTİLDİ)
    socket.on('gm_teleport_action', (action, targetId, mapId, x, y) => {
        if(action === 'goto') {
            const target = activePlayers[targetId];
            if(target) socket.emit('force_teleport', target.mapId, target.visualX, target.visualY);
        } else if (action === 'pull') {
            io.to(targetId).emit('force_teleport', mapId, x, y);
        }
    });

    // NOT SİLME YARDIMCISI (Oyuncu notu çantaya alınca)
    socket.on('remove_note_from_map', (mapId, noteId) => {
        let map = serverState.maps.find(m => m.id === mapId);
        if (map && map.notes) {
            map.notes = map.notes.filter(n => n.id !== noteId);
            saveData();
            io.emit('map_objects_synced', mapId, { walls: map.walls, tps: map.tps, bots: map.bots, roofs: map.roofs, notes: map.notes, musicZones: map.musicZones });
        }
    });

    // TİCARET
    let trades = {};
    socket.on('trade_request', (targetId, reqName) => { io.to(targetId).emit('trade_request_received', socket.id, reqName); });
    socket.on('trade_accept', (requesterId) => {
        const tradeId = Math.random().toString(36).substr(2, 9);
        trades[tradeId] = { p1: requesterId, p2: socket.id, state: { p1Items:[], p2Items:[], p1Gold:0, p2Gold:0, p1Locked:false, p2Locked:false } };
        io.to(requesterId).emit('trade_started', tradeId, 'p1'); io.to(socket.id).emit('trade_started', tradeId, 'p2');
    });
    socket.on('trade_decline', (requesterId, targetName) => { io.to(requesterId).emit('trade_cancelled', `${targetName} ticaret teklifini reddetti.`); });
    socket.on('trade_update_offer', (tradeId, role, items, gold) => {
        if(!trades[tradeId]) return; const tr = trades[tradeId];
        if(role === 'p1') { tr.state.p1Items = items; tr.state.p1Gold = gold; } else { tr.state.p2Items = items; tr.state.p2Gold = gold; }
        io.to(tr.p1).emit('trade_sync', tr.state); io.to(tr.p2).emit('trade_sync', tr.state);
    });
    socket.on('trade_lock', (tradeId, role) => {
        if(!trades[tradeId]) return; const tr = trades[tradeId];
        if(role === 'p1') tr.state.p1Locked = true; else tr.state.p2Locked = true;
        io.to(tr.p1).emit('trade_sync', tr.state); io.to(tr.p2).emit('trade_sync', tr.state);
    });
    socket.on('trade_confirm', (tradeId, role, newInv, newGold) => {
        if(!trades[tradeId]) return; const tr = trades[tradeId];
        io.to(socket.id).emit('trade_success', newInv, newGold);
        if(role === 'p1') tr.p1Confirmed = true; else tr.p2Confirmed = true;
        if(tr.p1Confirmed && tr.p2Confirmed) delete trades[tradeId];
    });
    socket.on('trade_cancel', (tradeId) => {
        if(!trades[tradeId]) return; const tr = trades[tradeId];
        io.to(tr.p1).emit('trade_cancelled', "Takas masadan kalkıldı."); io.to(tr.p2).emit('trade_cancelled', "Takas masadan kalkıldı.");
        delete trades[tradeId];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Aethelgard sunucusu ${PORT} portunda başarıyla uyandı!`);
});
