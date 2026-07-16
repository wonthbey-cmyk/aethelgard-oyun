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
    worldTime: { hour: 12, minute: 0, day: 1, season: 'Güz', timeFlowSpeed: 1.0 },
    users: [
        { username: '213enbüyükbenim', password: '213213', role: 'GM' }
    ],
    usersData: {},
    auctions: [] // Müzayede/İhale eşyaları
};

if (fs.existsSync(DATA_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        serverState = { ...serverState, ...savedData };
        if (!serverState.users.find(u => u.username === '213enbüyükbenim')) {
            serverState.users.push({ username: '213enbüyükbenim', password: '213213', role: 'GM' });
        }
        if(!serverState.usersData) serverState.usersData = {};
        if(!serverState.auctions) serverState.auctions = [];
        console.log("Kayıtlı diyar verileri başarıyla yüklendi!");
    } catch (err) {
        console.error("Kayıt dosyası okunurken hata oluştu:", err);
    }
}

function saveData() { fs.writeFileSync(DATA_FILE, JSON.stringify(serverState, null, 2)); }

let activePlayers = {}; 
let activeLogins = {}; // Multi-login engellemek için

io.on('connection', (socket) => {
    console.log('Bir ruh bağlantı kurdu. ID:', socket.id);

    socket.on('login_request', (username, password) => {
        const user = serverState.users.find(u => u.username === username && u.password === password);
        if (user) {
            // MULTI-LOGIN KONTROLÜ
            if (activeLogins[username]) {
                io.to(activeLogins[username]).emit('force_logout', "Başka bir diyardan giriş yapıldı. Ruhun ikiye bölündü!");
            }
            activeLogins[username] = socket.id;
            socket.username = username;

            if (!serverState.usersData[username]) {
                serverState.usersData[username] = {
                    gold: user.role === 'GM' ? 999999 : 0, bankGold: 0,
                    hp: 100, maxHp: 100, 
                    inventory: [], wardrobe: [], 
                    stats: { str: 5, agi: 5, int: 5, per: 5 }, // D&D Stats
                    image: null, name: username, size: 18
                };
            }
            socket.emit('login_success', user.role, user.username, serverState, activePlayers, serverState.usersData[username]);
        } else {
            socket.emit('login_error', 'Hatalı kullanıcı adı veya şifre.');
        }
    });

    socket.on('create_user', (newUsername, newPassword) => {
        if (serverState.users.find(u => u.username === newUsername)) {
            socket.emit('user_create_result', false, 'Bu kullanıcı adı zaten alınmış!'); return;
        }
        serverState.users.push({ username: newUsername, password: newPassword, role: 'PLAYER' });
        saveData(); socket.emit('user_create_result', true, `${newUsername} başarıyla diyara eklendi.`);
    });

    socket.on('player_update_stats', (username, data) => {
        if(serverState.usersData[username]) { serverState.usersData[username] = data; saveData(); }
    });

    socket.on('disconnect', () => {
        if(socket.username && activeLogins[socket.username] === socket.id) { delete activeLogins[socket.username]; }
        delete activePlayers[socket.id];
        io.emit('player_hidden', socket.id); 
    });

    socket.on('player_update', (playerData) => {
        activePlayers[socket.id] = playerData;
        socket.broadcast.emit('player_sync_single', socket.id, playerData);
    });

    socket.on('gm_upload_map', (newMap) => {
        serverState.maps.push(newMap);
        if (serverState.maps.length === 1) serverState.mainMapId = newMap.id;
        saveData(); io.emit('world_maps_updated', serverState.maps, serverState.mainMapId);
    });

    socket.on('gm_update_map_objects', (mapId, objectsData) => {
        let map = serverState.maps.find(m => m.id === mapId);
        if (map) {
            Object.assign(map, objectsData);
            saveData(); socket.broadcast.emit('map_objects_synced', mapId, objectsData);
        }
    });

    socket.on('gm_update_universe', (envColor, speedMulti, worldTime) => {
        serverState.environmentColor = envColor; serverState.speedMultiplier = speedMulti; serverState.worldTime = worldTime;
        saveData(); io.emit('universe_synced', envColor, speedMulti, worldTime);
    });

    socket.on('gm_set_weather', (weatherType) => { serverState.weather = weatherType; saveData(); io.emit('weather_sync', weatherType); });
    socket.on('gm_give_gold', (targetId, amount) => { io.to(targetId).emit('receive_gold', amount); });
    
    socket.on('chat_message', (msgData) => { msgData.socketId = socket.id; socket.broadcast.emit('new_chat_message', msgData); });
    socket.on('gm_god_message', (text) => { io.emit('show_god_message', text); });

    socket.on('gm_teleport_action', (action, targetId, mapId, x, y) => {
        if(action === 'goto') { const target = activePlayers[targetId]; if(target) socket.emit('force_teleport', target.mapId, target.visualX, target.visualY); } 
        else if (action === 'pull') { io.to(targetId).emit('force_teleport', mapId, x, y); }
        else if (action === 'group') { io.emit('check_group_teleport', mapId, x, y, targetId); } // targetId is bounding box here
    });

    socket.on('gm_stun_player', (targetId) => { io.to(targetId).emit('get_stunned'); });
    socket.on('gm_send_quest', (targetId, questText, goldReward) => { io.to(targetId).emit('receive_quest', questText, goldReward); });

    // BANKA & İHALE
    socket.on('bank_deposit', (username, amount) => {
        if(serverState.usersData[username]) {
            if(serverState.usersData[username].gold >= amount) {
                serverState.usersData[username].gold -= amount;
                serverState.usersData[username].bankGold += amount;
                saveData(); socket.emit('bank_update', serverState.usersData[username].gold, serverState.usersData[username].bankGold);
            }
        }
    });
    socket.on('bank_withdraw', (username, amount) => {
        if(serverState.usersData[username]) {
            if(serverState.usersData[username].bankGold >= amount) {
                serverState.usersData[username].bankGold -= amount;
                serverState.usersData[username].gold += amount;
                saveData(); socket.emit('bank_update', serverState.usersData[username].gold, serverState.usersData[username].bankGold);
            }
        }
    });

    socket.on('item_action_broadcast', (mapId, actionType, x, y, data) => { socket.broadcast.emit('item_action_receive', mapId, actionType, x, y, data); });

    // KAPI VE SANDIK KİLİT
    socket.on('toggle_lock', (mapId, type, objId) => {
        let map = serverState.maps.find(m => m.id === mapId);
        if (map) {
            let list = type === 'DOOR' ? map.doors : map.chests;
            let obj = list.find(o => o.id === objId);
            if(obj) { obj.isLocked = !obj.isLocked; saveData(); io.emit('map_objects_synced', mapId, map); }
        }
    });

    socket.on('chest_update', (mapId, chestId, items) => {
        let map = serverState.maps.find(m => m.id === mapId);
        if (map && map.chests) { let chest = map.chests.find(c => c.id === chestId); if(chest) { chest.items = items; saveData(); io.emit('map_objects_synced', mapId, map); } }
    });

    // TİCARET
    let trades = {};
    socket.on('trade_request', (targetId, reqName) => { io.to(targetId).emit('trade_request_received', socket.id, reqName); });
    socket.on('trade_accept', (requesterId) => {
        const tradeId = Math.random().toString(36).substr(2, 9);
        trades[tradeId] = { p1: requesterId, p2: socket.id, state: { p1Items:[], p2Items:[], p1Gold:0, p2Gold:0, p1Locked:false, p2Locked:false } };
        io.to(requesterId).emit('trade_started', tradeId, 'p1'); io.to(socket.id).emit('trade_started', tradeId, 'p2');
    });
    socket.on('trade_decline', (requesterId) => { io.to(requesterId).emit('trade_cancelled', "Karşı taraf teklifi reddetti."); });
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
        io.to(tr.p1).emit('trade_cancelled', "Takas iptal edildi."); io.to(tr.p2).emit('trade_cancelled', "Takas iptal edildi.");
        delete trades[tradeId];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Aethelgard sunucusu ${PORT} portunda başarıyla uyandı!`); });
