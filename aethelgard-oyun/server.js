const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// --- SUNUCU HAFIZASI VE VERİ KALICILIĞI (KAYIT) ---
const DATA_FILE = 'server_data.json';

let serverState = {
    maps: [],
    mainMapId: null,
    weather: 'NONE', // 'NONE', 'RAIN', 'SNOW'
    users: [
        { username: '213enbüyükbenim', password: '213213', role: 'GM' }
    ]
};

if (fs.existsSync(DATA_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        serverState = { ...serverState, ...savedData };
        if (!serverState.users.find(u => u.username === '213enbüyükbenim')) {
            serverState.users.push({ username: '213enbüyükbenim', password: '213213', role: 'GM' });
        }
        console.log("Kayıtlı diyar verileri başarıyla yüklendi!");
    } catch (err) {
        console.error("Kayıt dosyası okunurken hata oluştu, sıfırdan başlanıyor:", err);
    }
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(serverState, null, 2));
}

let activePlayers = {}; 
let activeTrades = {}; // Takas oturumları

io.on('connection', (socket) => {
    console.log('Bir ruh bağlantı kurdu. ID:', socket.id);

    socket.on('login_request', (username, password) => {
        const user = serverState.users.find(u => u.username === username && u.password === password);
        if (user) {
            socket.emit('login_success', user.role, user.username, serverState, activePlayers);
        } else {
            socket.emit('login_error', 'Hatalı kullanıcı adı veya şifre.');
        }
    });

    socket.on('create_user', (newUsername, newPassword) => {
        if (serverState.users.find(u => u.username === newUsername)) {
            socket.emit('user_create_result', false, 'Bu kullanıcı adı zaten alınmış!'); return;
        }
        serverState.users.push({ username: newUsername, password: newPassword, role: 'PLAYER' });
        saveData();
        socket.emit('user_create_result', true, `${newUsername} başarıyla diyara eklendi.`);
    });

    socket.on('disconnect', () => {
        console.log('Bir gezgin diyardan ayrıldı. ID:', socket.id);
        delete activePlayers[socket.id];
        
        // Eğer iptal olan takası varsa sil
        for(let tId in activeTrades) {
            if(activeTrades[tId].p1 === socket.id || activeTrades[tId].p2 === socket.id) {
                const other = activeTrades[tId].p1 === socket.id ? activeTrades[tId].p2 : activeTrades[tId].p1;
                io.to(other).emit('trade_cancelled', "Karşı taraf diyardan ayrıldı.");
                delete activeTrades[tId];
            }
        }
        io.emit('players_sync', activePlayers); 
    });

    socket.on('player_update', (playerData) => {
        activePlayers[socket.id] = playerData;
        // Eğer Ghost modundaysa sadece GM'lere veya kimseye gönderme, ama sistem basit kalsın, kimseye iletmiyoruz
        if (playerData.isGhost) {
            // Sadece kendisi haritada ama kimseye gönderilmiyor
            socket.broadcast.emit('player_hidden', socket.id); 
        } else {
            socket.broadcast.emit('player_sync_single', socket.id, playerData);
        }
    });

    socket.on('gm_upload_map', (newMap) => {
        serverState.maps.push(newMap);
        if (serverState.maps.length === 1) serverState.mainMapId = newMap.id;
        saveData();
        io.emit('world_maps_updated', serverState.maps, serverState.mainMapId);
    });

    socket.on('gm_update_map_objects', (mapId, objectsData) => {
        let map = serverState.maps.find(m => m.id === mapId);
        if (map) {
            map.walls = objectsData.walls;
            map.poisons = objectsData.poisons;
            map.tps = objectsData.tps;
            map.bots = objectsData.bots;
            map.roofs = objectsData.roofs || [];
            map.notes = objectsData.notes || []; // Notlar
            map.musicZones = objectsData.musicZones || []; // Müzik Alanları
            saveData();
            socket.broadcast.emit('map_objects_synced', mapId, objectsData);
        }
    });

    socket.on('gm_set_weather', (weatherType) => {
        serverState.weather = weatherType;
        saveData();
        io.emit('weather_sync', weatherType);
    });

    socket.on('gm_teleport_action', (action, targetId, myMapId, myX, myY) => {
        if (!activePlayers[targetId]) return;
        if (action === 'goto') {
            socket.emit('force_teleport', activePlayers[targetId].mapId, activePlayers[targetId].visualX, activePlayers[targetId].visualY);
        } else if (action === 'pull') {
            io.to(targetId).emit('force_teleport', myMapId, myX, myY);
        }
    });

    socket.on('chat_message', (msgData) => {
        msgData.socketId = socket.id;
        socket.broadcast.emit('new_chat_message', msgData);
    });

    socket.on('gm_god_message', (text) => {
        io.emit('show_god_message', text);
    });

    socket.on('trade_request', (targetId, myName) => {
        if(activePlayers[targetId]) {
            io.to(targetId).emit('trade_request_received', socket.id, myName);
        }
    });

    socket.on('trade_accept', (requesterId) => {
        if(activePlayers[requesterId]) {
            const tradeId = socket.id + "_" + requesterId;
            activeTrades[tradeId] = {
                p1: requesterId, p2: socket.id,
                p1Items: [], p2Items: [],
                p1Gold: 0, p2Gold: 0,
                p1Locked: false, p2Locked: false
            };
            io.to(requesterId).emit('trade_started', tradeId, 'p1');
            io.to(socket.id).emit('trade_started', tradeId, 'p2');
        }
    });

    socket.on('trade_decline', (requesterId) => {
        io.to(requesterId).emit('trade_cancelled', "Karşı taraf takası reddetti.");
    });

    socket.on('trade_update_offer', (tradeId, role, items, gold) => {
        if(activeTrades[tradeId]) {
            if(role === 'p1') { activeTrades[tradeId].p1Items = items; activeTrades[tradeId].p1Gold = gold; activeTrades[tradeId].p1Locked = false; activeTrades[tradeId].p2Locked = false; }
            if(role === 'p2') { activeTrades[tradeId].p2Items = items; activeTrades[tradeId].p2Gold = gold; activeTrades[tradeId].p1Locked = false; activeTrades[tradeId].p2Locked = false; }
            io.to(activeTrades[tradeId].p1).emit('trade_sync', activeTrades[tradeId]);
            io.to(activeTrades[tradeId].p2).emit('trade_sync', activeTrades[tradeId]);
        }
    });

    socket.on('trade_lock', (tradeId, role) => {
        if(activeTrades[tradeId]) {
            if(role === 'p1') activeTrades[tradeId].p1Locked = true;
            if(role === 'p2') activeTrades[tradeId].p2Locked = true;
            io.to(activeTrades[tradeId].p1).emit('trade_sync', activeTrades[tradeId]);
            io.to(activeTrades[tradeId].p2).emit('trade_sync', activeTrades[tradeId]);
        }
    });

    socket.on('trade_confirm', (tradeId, role, finalInventory, finalGold) => {
        // Güvenlik için oyuncular işlem bitince bana son çantalarını yolluyorlar
        // Gerçek mmo'larda bu sunucu tarafında yapılır, biz şimdilik state'i oyuncudan güvenerek alıyoruz
        if(activeTrades[tradeId]) {
            if(role === 'p1') activeTrades[tradeId].p1Confirmed = { inv: finalInventory, gold: finalGold };
            if(role === 'p2') activeTrades[tradeId].p2Confirmed = { inv: finalInventory, gold: finalGold };
            
            if(activeTrades[tradeId].p1Confirmed && activeTrades[tradeId].p2Confirmed) {
                // İkisi de onayladı, verileri çapraz gönderip işlemi bitir
                io.to(activeTrades[tradeId].p1).emit('trade_success', activeTrades[tradeId].p1Confirmed.inv, activeTrades[tradeId].p1Confirmed.gold);
                io.to(activeTrades[tradeId].p2).emit('trade_success', activeTrades[tradeId].p2Confirmed.inv, activeTrades[tradeId].p2Confirmed.gold);
                delete activeTrades[tradeId];
            }
        }
    });

    socket.on('trade_cancel', (tradeId) => {
        if(activeTrades[tradeId]) {
            io.to(activeTrades[tradeId].p1).emit('trade_cancelled', "Takas iptal edildi.");
            io.to(activeTrades[tradeId].p2).emit('trade_cancelled', "Takas iptal edildi.");
            delete activeTrades[tradeId];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Aethelgard sunucusu ${PORT} portunda başarıyla uyandı!`);
});
