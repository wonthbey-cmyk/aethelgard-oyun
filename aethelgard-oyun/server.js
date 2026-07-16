const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// --- SUNUCU HAFIZASI VE VERİ KALICILIĞI (KAYIT) ---
const DATA_FILE = 'server_data.json';

let serverState = {
    maps: [],
    mainMapId: null,
    weather: 'NONE', // 'NONE', 'RAIN', 'SNOW'
    users: [
        { username: '213enbüyükbenim', password: '213213', role: 'GM' } // Varsayılan Baş Tanrı
    ]
};

// Sunucu açıldığında eski verileri yükle
if (fs.existsSync(DATA_FILE)) {
    try {
        const savedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        serverState = { ...serverState, ...savedData };
        
        // Eğer GM hesabı bir şekilde silinmişse tekrar ekle
        if (!serverState.users.find(u => u.username === '213enbüyükbenim')) {
            serverState.users.push({ username: '213enbüyükbenim', password: '213213', role: 'GM' });
        }
        console.log("Kayıtlı diyar verileri başarıyla yüklendi!");
    } catch (err) {
        console.error("Kayıt dosyası okunurken hata oluştu, sıfırdan başlanıyor:", err);
    }
}

// Verileri dosyaya kaydetme fonksiyonu
function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(serverState, null, 2));
}

let activePlayers = {}; 

io.on('connection', (socket) => {
    console.log('Bir ruh bağlantı kurdu. ID:', socket.id);

    // --- GİRİŞ VE KAYIT SİSTEMİ ---
    socket.on('login_request', (username, password) => {
        const user = serverState.users.find(u => u.username === username && u.password === password);
        if (user) {
            // Giriş Başarılı
            socket.emit('login_success', user.role, user.username, serverState, activePlayers);
        } else {
            // Hata
            socket.emit('login_error', 'Hatalı kullanıcı adı veya şifre.');
        }
    });

    socket.on('create_user', (newUsername, newPassword) => {
        // Sadece giriş yapmış yetkili GM'ler yeni hesap açabilmeli (güvenlik)
        if (serverState.users.find(u => u.username === newUsername)) {
            socket.emit('user_create_result', false, 'Bu kullanıcı adı zaten alınmış!');
            return;
        }
        serverState.users.push({ username: newUsername, password: newPassword, role: 'PLAYER' });
        saveData();
        socket.emit('user_create_result', true, `${newUsername} başarıyla diyara eklendi.`);
    });


    // --- OYUN İÇİ SENKRONİZASYON ---
    socket.on('disconnect', () => {
        console.log('Bir gezgin diyardan ayrıldı. ID:', socket.id);
        delete activePlayers[socket.id];
        io.emit('players_sync', activePlayers); 
    });

    socket.on('player_update', (playerData) => {
        activePlayers[socket.id] = playerData;
        socket.broadcast.emit('players_sync', activePlayers);
    });

    // HARİTA YÖNETİMİ
    socket.on('gm_upload_map', (newMap) => {
        serverState.maps.push(newMap);
        if (serverState.maps.length === 1) {
            serverState.mainMapId = newMap.id;
        }
        saveData(); // Kaydet
        io.emit('world_maps_updated', serverState.maps, serverState.mainMapId);
    });

    socket.on('gm_update_map_objects', (mapId, objectsData) => {
        let map = serverState.maps.find(m => m.id === mapId);
        if (map) {
            map.walls = objectsData.walls;
            map.poisons = objectsData.poisons;
            map.tps = objectsData.tps;
            map.bots = objectsData.bots;
            map.roofs = objectsData.roofs || []; // Çatı sistemini de kaydet
            saveData(); // Kaydet
            socket.broadcast.emit('map_objects_synced', mapId, objectsData);
        }
    });

    // HAVA DURUMU
    socket.on('gm_set_weather', (weatherType) => {
        serverState.weather = weatherType;
        saveData(); // Kaydet
        io.emit('weather_sync', weatherType);
    });

    // SOHBET VE DUYURU
    socket.on('chat_message', (msgData) => {
        socket.broadcast.emit('new_chat_message', msgData);
    });

    socket.on('gm_god_message', (text) => {
        io.emit('show_god_message', text);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Aethelgard sunucusu ${PORT} portunda başarıyla uyandı!`);
});
