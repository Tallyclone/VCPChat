// music-play.js
// VChat Distributed Plugin for controlling VCP Music Player
const WebSocket = require('ws');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');

const parseTracksString = (str) => {
    if (!str || typeof str !== 'string') return [];
    return str.split(';').map(item => {
        const parts = item.split('|');
        if (parts.length >= 2) {
            const source = parts[0].trim();
            const id = parts[1].trim();
            const title = parts[2] ? parts[2].trim() : '';
            const artist = parts[3] ? parts[3].trim() : '';
            if (source === 'local') {
                return { path: id, title, artist };
            }
            return { id, source, title, artist, isOnlinePlaceholder: true };
        }
        return null;
    }).filter(Boolean);
};

const getConfig = () => {
    const configPath = path.join(__dirname, 'config.json');
    const defaultPath = 'E:\\repo\\musicplayer\\start_silent.vbs';
    try {
        if (fs.existsSync(configPath)) {
            const config = fs.readJsonSync(configPath);
            if (config && config.playerPath) {
                return config;
            }
        }
    } catch (err) {
        console.warn('[Music CLI] Failed to read config.json, using default path.', err.message);
    }
    return { playerPath: defaultPath };
};

const config = getConfig();
const vbsPath = config.playerPath;

let inputBuffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
    inputBuffer += chunk;
});

process.stdin.on('end', async () => {
    try {
        if (!inputBuffer.trim()) {
            throw new Error('No input arguments received.');
        }

        const args = JSON.parse(inputBuffer);
        const command = args.command;

        if (!command) {
            throw new Error("Parameter 'command' is required.");
        }

        // 1. 本地读取曲库列表 (getLibrary) - 不需要启动播放器即可运行
        if (command === 'getLibrary') {
            const songlistPath = path.join(process.env.APPDATA, 'VCPMusicRefactor', 'songlist.json');
            try {
                if (await fs.pathExists(songlistPath)) {
                    const songlist = await fs.readJson(songlistPath);
                    console.log(JSON.stringify({ status: 'success', result: songlist }));
                } else {
                    console.log(JSON.stringify({ status: 'success', result: [] }));
                }
            } catch (readErr) {
                console.log(JSON.stringify({ status: 'error', error: '读取本地歌单失败: ' + readErr.message }));
            }
            process.exit(0);
        }

        // 2. 处理播放器控制指令中的 "open" (打开播放器)
        if (command === 'controlPlayer' && args.action === 'open') {
            try {
                await new Promise((resolve, reject) => {
                    exec(`wscript.exe "${vbsPath}"`, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                // 维持进程存活，给播放器拉起留出缓冲时间（2.5 秒）
                await new Promise(r => setTimeout(r, 2500));
                console.log(JSON.stringify({ status: 'success', result: { message: '播放器已启动。' } }));
            } catch (err) {
                console.log(JSON.stringify({ status: 'error', error: '无法启动播放器: ' + err.message }));
            }
            process.exit(0);
        }

        // 3. 将其他指令映射到 WebSocket 服务器协议上
        let action = '';
        let payload = {};

        switch (command) {
            case 'controlPlayer':
                action = args.action; // 'close', 'quit', 'play', 'pause', 'next', 'prev', 'volume', 'playMode', 'minimize', 'show', 'restore'
                if (action === 'close') {
                    action = 'close'; // WebSocket 对应的关闭界面指令
                } else if (action === 'quit') {
                    action = 'exit'; // WebSocket 对应的彻底退出指令
                } else if (action === 'minimize' || action === 'minimizeToTray') {
                    action = 'control';
                    payload = { command: 'minimize' };
                } else if (action === 'show' || action === 'restore') {
                    action = 'control';
                    payload = { command: 'show' };
                } else if (['play', 'pause', 'next', 'prev', 'volume', 'playMode'].includes(action)) {
                    // 统一打包成 control 动作
                    const val = args.value;
                    payload = { command: action === 'prev' ? 'previous' : action, value: val };
                    action = 'control';
                }
                break;
            case 'searchOnline':
                action = 'search';
                payload = { query: args.query, platforms: [args.platform || 'netease'] };
                break;
            case 'manageToplist': {
                const subAction = args.action; // 'query', 'detail', 'play', 'add'
                if (subAction === 'query') {
                    action = 'getToplists';
                    payload = { platform: args.platform || 'netease' };
                } else if (subAction === 'detail') {
                    action = 'getToplistDetail';
                    payload = { platform: args.platform || 'netease', id: args.id };
                } else if (subAction === 'play') {
                    action = 'playToplist';
                    payload = { platform: args.platform || 'netease', id: args.id, quality: args.quality || 'flac' };
                } else if (subAction === 'add') {
                    action = 'addToplistToQueue';
                    payload = { platform: args.platform || 'netease', id: args.id, quality: args.quality || 'flac' };
                } else {
                    throw new Error('Invalid manageToplist action: ' + subAction);
                }
                break;
            }
            case 'manageOnlinePlaylist': {
                const subAction = args.action; // 'query', 'detail', 'play', 'add'
                if (subAction === 'query') {
                    action = 'getHotPlaylists';
                    payload = {
                        platform: args.platform || 'netease',
                        page: args.page ? parseInt(args.page, 10) : 1,
                        limit: args.limit ? parseInt(args.limit, 10) : 20,
                        cat: args.cat || '全部'
                    };
                } else if (subAction === 'detail') {
                    action = 'getPlaylistDetail';
                    payload = { platform: args.platform || 'netease', id: args.id };
                } else if (subAction === 'play') {
                    action = 'playOnlinePlaylist';
                    payload = { platform: args.platform || 'netease', id: args.id, quality: args.quality || 'flac' };
                } else if (subAction === 'add') {
                    action = 'addOnlinePlaylistToQueue';
                    payload = { platform: args.platform || 'netease', id: args.id, quality: args.quality || 'flac' };
                } else {
                    throw new Error('Invalid manageOnlinePlaylist action: ' + subAction);
                }
                break;
            }
            case 'randomListen':
                action = 'randomListen';
                payload = { platform: args.platform, tag: args.tag };
                break;
            case 'playTrack':
                action = 'playTrack';
                payload = {
                    tracks: parseTracksString(args.tracks),
                    quality: args.quality || 'flac'
                };
                break;
            case 'playTracks':
                action = 'playTrack';
                payload = {
                    tracks: parseTracksString(args.tracks),
                    quality: args.quality || 'flac'
                };
                break;
            case 'addTracksToQueue':
                action = 'addTracksToQueue';
                payload = {
                    tracks: parseTracksString(args.tracks),
                    quality: args.quality || 'flac'
                };
                break;
            case 'getPlayerState':
                action = 'getState';
                payload = {};
                break;
            case 'downloadTrack': {
                action = 'downloadTrack';
                payload = {
                    tracks: parseTracksString(args.tracks),
                    quality: args.quality || 'flac'
                };
                break;
            }
            case 'manageCustomPlaylist': {
                const subAction = args.action; // 'query', 'create', 'play', 'playSong', 'addSong'
                const playlists = await sendCommandWithAutoStart('getCustomPlaylists', {});
                
                if (subAction === 'query') {
                    console.log(JSON.stringify({ status: 'success', result: playlists }));
                    process.exit(0);
                } else if (subAction === 'create') {
                    if (!args.name) throw new Error("新建歌单必须指定 'name' 参数。");
                    const newPl = {
                        id: 'fav-' + Date.now().toString(),
                        name: args.name,
                        tracks: []
                    };
                    playlists.push(newPl);
                    await sendCommandWithAutoStart('saveCustomPlaylists', { playlists });
                    console.log(JSON.stringify({ status: 'success', result: { message: `歌单 「${args.name}」 创建成功。`, playlist: newPl } }));
                    process.exit(0);
                } else if (subAction === 'delete') {
                    const matchIdx = playlists.findIndex(p => p.id === args.id);
                    if (matchIdx === -1) throw new Error(`找不到 ID 为 "${args.id}" 的自定义歌单。`);
                    const deletedPl = playlists.splice(matchIdx, 1)[0];
                    await sendCommandWithAutoStart('saveCustomPlaylists', { playlists });
                    console.log(JSON.stringify({ status: 'success', result: { message: `已成功删除自定义歌单 「${deletedPl.name}」。` } }));
                    process.exit(0);
                } else if (subAction === 'play') {
                    const match = playlists.find(p => p.id === args.id);
                    if (!match) throw new Error(`找不到 ID 为 "${args.id}" 的自定义歌单。`);
                    action = 'control';
                    payload = { command: 'loadPlaylistTracks', value: match.tracks };
                } else if (subAction === 'playSong') {
                    const match = playlists.find(p => p.id === args.id);
                    if (!match) throw new Error(`找不到 ID 为 "${args.id}" 的自定义歌单。`);
                    
                    let matchedTracks = [];
                    
                    if (args.tracks) {
                        const filterTracks = parseTracksString(args.tracks);
                        matchedTracks = match.tracks.filter(t => 
                            filterTracks.some(ft => 
                                (ft.path && t.path === ft.path) || 
                                (ft.id && t.id === ft.id) ||
                                (ft.title && (t.title || '').toLowerCase() === ft.title.toLowerCase())
                            )
                        );
                    } else if (args.songTitle) {
                        const titles = args.songTitle.split(';').map(t => t.trim().toLowerCase());
                        matchedTracks = match.tracks.filter(t => 
                            titles.some(title => (t.title || '').toLowerCase().includes(title))
                        );
                    } else if (args.songIndex !== undefined) {
                        const indices = String(args.songIndex).split(';').map(i => parseInt(i.trim(), 10)).filter(i => !isNaN(i));
                        matchedTracks = indices.map(idx => match.tracks[idx]).filter(Boolean);
                    }
                    
                    if (matchedTracks.length === 0) throw new Error("在歌单内找不到指定的歌曲。");
                    
                    action = 'playTrack';
                    payload = { tracks: matchedTracks, quality: args.quality || 'flac' };
                } else if (subAction === 'addSong') {
                    const match = playlists.find(p => p.id === args.id);
                    if (!match) throw new Error(`找不到 ID 为 "${args.id}" 的自定义歌单。`);
                    if (!args.tracks) throw new Error("添加歌曲必须指定 'tracks' 参数。");

                    const inputTracks = parseTracksString(args.tracks);
                    const addedList = [];
                    
                    for (let track of inputTracks) {
                        // 如果是网络歌曲，自动调用 downloadTrack 将其持久化下载
                        if (!track.path || track.path.toLowerCase().startsWith('http') || track.path.toLowerCase().includes('temp')) {
                            const dlRes = await sendCommandWithAutoStart('downloadTrack', { tracks: [track], quality: 'flac' });
                            if (dlRes && dlRes.path) {
                                track = {
                                    id: track.id,
                                    source: track.source,
                                    title: dlRes.title || track.title,
                                    artist: dlRes.artist || track.artist,
                                    path: dlRes.path,
                                    album: dlRes.album || track.album || '',
                                    albumArt: dlRes.albumArt || track.cover || ''
                                };
                            } else {
                                console.warn(`[Music CLI] Failed to download online track for custom playlist: ${track.title}`);
                                continue;
                            }
                        }
                        
                        if (!match.tracks.some(t => t.path === track.path)) {
                            match.tracks.push(track);
                            addedList.push(track);
                        }
                    }

                    if (addedList.length > 0) {
                        await sendCommandWithAutoStart('saveCustomPlaylists', { playlists });
                    }
                    
                    console.log(JSON.stringify({ 
                        status: 'success', 
                        result: { 
                            message: `已成功将 ${addedList.length} 首歌曲添加至歌单 「${match.name}」。`, 
                            added: addedList 
                        } 
                    }));
                    process.exit(0);
                } else if (subAction === 'removeSong') {
                    const match = playlists.find(p => p.id === args.id);
                    if (!match) throw new Error(`找不到 ID 为 "${args.id}" 的自定义歌单。`);
                    
                    let indicesToRemove = new Set();
                    
                    if (args.tracks) {
                        const filterTracks = parseTracksString(args.tracks);
                        match.tracks.forEach((t, idx) => {
                            if (filterTracks.some(ft => 
                                (ft.path && t.path === ft.path) || 
                                (ft.id && t.id === ft.id) ||
                                (ft.title && (t.title || '').toLowerCase() === ft.title.toLowerCase())
                            )) {
                                indicesToRemove.add(idx);
                            }
                        });
                    } else if (args.songTitle) {
                        const titles = args.songTitle.split(';').map(t => t.trim().toLowerCase());
                        match.tracks.forEach((t, idx) => {
                            if (titles.some(title => (t.title || '').toLowerCase().includes(title))) {
                                indicesToRemove.add(idx);
                            }
                        });
                    } else if (args.trackPath) {
                        const paths = args.trackPath.split(';').map(p => p.trim());
                        match.tracks.forEach((t, idx) => {
                            if (paths.includes(t.path)) {
                                indicesToRemove.add(idx);
                            }
                        });
                    } else if (args.songIndex !== undefined) {
                        String(args.songIndex).split(';').map(i => parseInt(i.trim(), 10)).forEach(idx => {
                            if (!isNaN(idx) && idx >= 0 && idx < match.tracks.length) {
                                indicesToRemove.add(idx);
                            }
                        });
                    }
                    
                    if (indicesToRemove.size === 0) {
                        throw new Error("在歌单内找不到指定的歌曲。");
                    }
                    
                    const sortedIndices = Array.from(indicesToRemove).sort((a, b) => b - a);
                    const removedList = [];
                    for (const idx of sortedIndices) {
                        removedList.push(match.tracks.splice(idx, 1)[0]);
                    }
                    
                    await sendCommandWithAutoStart('saveCustomPlaylists', { playlists });
                    console.log(JSON.stringify({ 
                        status: 'success', 
                        result: { 
                            message: `已成功从歌单 「${match.name}」 中移除 ${removedList.length} 首歌曲。`,
                            removed: removedList
                        } 
                    }));
                    process.exit(0);
                } else {
                    throw new Error(`未知的 manageCustomPlaylist action: ${subAction}`);
                }
                break;
            }
            default:
                throw new Error(`Unknown command: ${command}`);
        }

        // 发送指令给播放器 (支持自动拉起播放器逻辑)
        const result = await sendCommandWithAutoStart(action, payload);
        console.log(JSON.stringify({ status: 'success', result }));
        process.exit(0);

    } catch (error) {
        console.log(JSON.stringify({ status: 'error', error: error.message }));
        process.exit(0);
    }
});

// WebSocket 通信核心函数
function sendWsCommand(action, payload) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://127.0.0.1:63795');
        let resolved = false;

        ws.on('open', () => {
            ws.send(JSON.stringify({ action, payload }));
        });

        ws.on('message', (message) => {
            try {
                const response = JSON.parse(message.toString());
                if (response.status === 'success') {
                    resolve(response.data);
                } else {
                    reject(new Error(response.error || '播放器执行指令失败'));
                }
            } catch (err) {
                reject(err);
            }
            resolved = true;
            ws.close();
        });

        ws.on('error', (err) => {
            if (!resolved) {
                reject(new Error('无法连接到播放器，可能播放器未开启。'));
            }
        });

        // 动态超时保护（下载、搜索等耗时操作给予更长的时间）
        let timeoutDuration = 5000;
        if (action === 'downloadTrack' || (action === 'control' && payload.command === 'loadPlaylistTracks')) {
            timeoutDuration = 30000;
        } else if (action === 'search') {
            timeoutDuration = 20000;
        }
        setTimeout(() => {
            if (!resolved) {
                ws.close();
                reject(new Error('连接播放器超时，请检查播放器运行状态。'));
            }
        }, timeoutDuration);
    });
}

// 自动启动播放器重试的控制层
async function sendCommandWithAutoStart(action, payload) {
    try {
        const result = await sendWsCommand(action, payload);
        return result;
    } catch (err) {
        // 如果是连接失败，则尝试自动启动播放器并重试
        if (err.message.includes('无法连接到播放器')) {
            await new Promise((resolveSpawn, rejectSpawn) => {
                exec(`wscript.exe "${vbsPath}"`, (spawnErr) => {
                    if (spawnErr) rejectSpawn(spawnErr);
                    else resolveSpawn();
                });
            });

            // 等待 2.5 秒让播放器及其 WebSocket 服务器完全初始化
            await new Promise(r => setTimeout(r, 2500));

            // 重试指令发送
            const retryResult = await sendWsCommand(action, payload);
            return retryResult;
        } else {
            throw err;
        }
    }
}
