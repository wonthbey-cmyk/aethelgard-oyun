const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let serverState = {
    maps: [],
    mainMapId: null
};

let activePlayers = {}; 

io.on('connection', (socket) => {
    console.log('Bir gezgin diyara ayak bastı. ID:', socket.id);

    socket.emit('init_world_state', serverState, activePlayers);

    socket.on('disconnect', () => {
        console.log('Bir gezgin diyardan ayrıldı. ID:', socket.id);
        delete activePlayers[socket.id];
        io.emit('players_sync', activePlayers); 
    });

    socket.on('player_update', (playerData) => {
        activePlayers[socket.id] = playerData;
        socket.broadcast.emit('players_sync', activePlayers);
    });

    socket.on('gm_upload_map', (newMap) => {
        serverState.maps.push(newMap);
        if (serverState.maps.length === 1) {
            serverState.mainMapId = newMap.id;
        }
        io.emit('world_maps_updated', serverState.maps, serverState.mainMapId);
    });

    socket.on('gm_update_map_objects', (mapId, objectsData) => {
        let map = serverState.maps.find(m => m.id === mapId);
        if (map) {
            map.walls = objectsData.walls;
            map.poisons = objectsData.poisons;
            map.tps = objectsData.tps;
            map.bots = objectsData.bots;
            socket.broadcast.emit('map_objects_synced', mapId, objectsData);
        }
    });

    // Sohbet kutusundan mesaj atıldığında
    socket.on('chat_message', (msgData) => {
        // Kendisi hariç diğer BÜTÜN herkese mesajı yolla
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
