(() => {
    const $ = id => document.getElementById(id);
    const lobbyView = $('lobbyView');
    const deviceView = $('deviceView');
    const usernameInput = $('usernameInput');
    const roomInput = $('roomInput');
    const btnJoin = $('btnJoin');
    const btnLeave = $('btnLeave');
    const btnPttLock = $('btnPttLock');
    const btnCamera = $('btnCamera');
    const btnCameraToggle = $('btnCameraToggle');
    const btnSpeaker = $('btnSpeaker');
    const btnMembers = $('btnMembers');
    const videoPanel = $('videoPanel');
    const localVideo = $('localVideo');
    const pttButton = $('pttButton');
    const pttRing = $('pttRing');
    const pttLabel = $('pttLabel');
    const pttHint = $('pttHint');
    const callRoom = $('callRoom');
    const callTitle = $('callTitle');
    const connectionStatus = $('connectionStatus');
    const peersCount = $('peersCount');
    const speakerNotice = $('speakerNotice');
    const peersList = $('peersList');
    const toast = $('toast');
    const audioCanvas = $('audioCanvas');
    const chkSpacebar = $('chkSpacebar');

    let clientId = 'usr_' + Math.random().toString(36).slice(2, 9);
    let username = localStorage.getItem('walkyTalkyUsername') || `Operator-${Math.floor(100 + Math.random() * 900)}`;
    let currentRoom = 'ALPHA-1';
    let ws = null;
    let webrtcManager = null;
    let isTransmitting = false;
    let isPttLocked = false;
    let isSpeakerOn = true;
    let spaceKeyDown = false;
    const activeSpeakerIds = new Set();
    const knownPeers = new Map();

    usernameInput.value = username;
    roomInput.value = currentRoom;

    function basePath() {
        const path = window.location.pathname;
        if (path.endsWith('/')) return path.slice(0, -1);
        const slash = path.lastIndexOf('/');
        return slash > 0 ? path.slice(0, slash) : '';
    }

    function showToast(message) {
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => toast.classList.remove('show'), 2600);
    }

    function avatarUrl(name) {
        return `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(name)}&backgroundColor=b6e3f4,c0aede,d1d4f9`;
    }

    function cameraState(enabled) {
        const available = webrtcManager && webrtcManager.hasCamera();
        const on = Boolean(enabled && available);
        videoPanel.classList.toggle('hidden', !on);
        btnCamera.setAttribute('aria-pressed', String(on));
        btnCamera.textContent = on ? 'Camera on' : 'Camera off';
        btnCameraToggle.classList.toggle('active', on);
        if (available) webrtcManager.setCameraEnabled(on);
    }

    async function joinRoom() {
        const enteredName = usernameInput.value.trim();
        if (!enteredName) {
            usernameInput.focus();
            showToast('Enter your name to join');
            return;
        }
        username = enteredName;
        localStorage.setItem('walkyTalkyUsername', username);
        webrtcManager = new WebRTCManager(signal => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(signal));
        });

        if (!await webrtcManager.initMicrophone()) {
            showToast(webrtcManager.lastMicrophoneError?.message || 'Microphone access is required');
            return;
        }
        localVideo.srcObject = webrtcManager.localStream;
        localVideo.muted = true;
        cameraState(false);
        connectWebSocket();
    }

    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${window.location.host}${basePath()}/ws/${encodeURIComponent(currentRoom)}/${encodeURIComponent(clientId)}?username=${encodeURIComponent(username)}`;
        ws = new WebSocket(url);
        ws.onopen = () => {
            lobbyView.classList.add('hidden');
            deviceView.classList.remove('hidden');
            callRoom.textContent = currentRoom;
            updateHeader();
            connectionStatus.textContent = 'Link active';
            startVisualizer();
            showToast('Joined the call');
        };
        ws.onmessage = event => handleServerMessage(JSON.parse(event.data));
        ws.onclose = () => {
            connectionStatus.textContent = 'Reconnecting';
            resetPttState();
        };
        ws.onerror = () => showToast('Connection problem');
    }

    async function handleServerMessage(message) {
        switch (message.type) {
            case 'room_state':
                knownPeers.clear();
                message.peers.forEach(peer => {
                    if (peer.client_id !== clientId) {
                        knownPeers.set(peer.client_id, peer.username);
                        webrtcManager.initiateCall(peer.client_id);
                    }
                });
                activeSpeakerIds.clear();
                (message.active_speaker_ids || []).forEach(id => activeSpeakerIds.add(id));
                updateAudioState();
                break;
            case 'peer_joined':
                knownPeers.set(message.peer.client_id, message.peer.username);
                updateHeader();
                updatePeersUI();
                break;
            case 'peer_left':
                knownPeers.delete(message.client_id);
                activeSpeakerIds.delete(message.client_id);
                webrtcManager.closePeerConnection(message.client_id);
                updateHeader();
                updateAudioState();
                break;
            case 'speaker_started':
                activeSpeakerIds.add(message.speaker_id);
                updateAudioState();
                break;
            case 'speaker_stopped':
                activeSpeakerIds.delete(message.speaker_id || message.client_id);
                updateAudioState();
                break;
            case 'signal_offer': await webrtcManager.handleSignalOffer(message.from_id, message.payload); break;
            case 'signal_answer': await webrtcManager.handleSignalAnswer(message.from_id, message.payload); break;
            case 'signal_candidate': await webrtcManager.handleSignalCandidate(message.from_id, message.payload); break;
        }
    }

    function updateHeader() {
        const count = knownPeers.size + 1;
        peersCount.textContent = `${count} online`;
        callTitle.textContent = count === 2 ? 'Private voice call' : 'Group voice call';
    }

    function updateAudioState() {
        const remoteNames = [...activeSpeakerIds].filter(id => id !== clientId).map(id => knownPeers.get(id)).filter(Boolean);
        const receiving = remoteNames.length > 0;
        if (webrtcManager) webrtcManager.setMicrophoneEnabled(isTransmitting);
        pttRing.className = `ptt-ring${isTransmitting ? ' transmitting' : ''}`;
        pttButton.className = `ptt-button${isTransmitting ? ' pressed' : ''}`;
        pttLabel.textContent = isTransmitting ? 'SPEAKING' : 'HOLD TO TALK';
        pttHint.textContent = isTransmitting ? 'RELEASE TO STOP' : 'PUSH TO TRANSMIT';
        speakerNotice.textContent = isTransmitting ? 'You are speaking...' : receiving ? `${remoteNames[0]} is speaking...` : 'Ready to talk';
        updatePeersUI();
    }

    function updatePeersUI() {
        const count = knownPeers.size + 1;
        peersList.className = `peers-list ${count <= 2 ? 'single-call' : 'group-call'}`;
        peersList.innerHTML = '';
        const addPeer = (name, id, self = false) => {
            const talking = self ? isTransmitting : activeSpeakerIds.has(id);
            const chip = document.createElement('article');
            chip.className = `peer-chip${talking ? ' talking' : ''}${self ? ' you' : ''}`;
            const avatar = document.createElement('img');
            avatar.className = 'peer-avatar';
            avatar.src = avatarUrl(name);
            avatar.alt = `${name} avatar`;
            avatar.loading = 'lazy';
            avatar.referrerPolicy = 'no-referrer';
            const details = document.createElement('div');
            details.className = 'peer-details';
            const label = document.createElement('strong');
            label.textContent = self ? `${name} (YOU)` : name;
            const status = document.createElement('span');
            status.className = 'peer-status';
            status.textContent = talking ? 'Speaking...' : self ? 'Ready' : 'Listening';
            details.append(label, status);
            chip.append(avatar, details);
            peersList.appendChild(chip);
        };
        knownPeers.forEach((name, id) => { if (activeSpeakerIds.has(id)) addPeer(name, id); });
        addPeer(username, clientId, true);
        knownPeers.forEach((name, id) => { if (!activeSpeakerIds.has(id)) addPeer(name, id); });
    }

    function startTransmit() {
        if (isTransmitting || !ws || ws.readyState !== WebSocket.OPEN) return;
        isTransmitting = true;
        activeSpeakerIds.add(clientId);
        updateAudioState();
        ws.send(JSON.stringify({ type: 'talk_request' }));
    }

    function stopTransmit() {
        if (!isTransmitting) return;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'talk_release' }));
        isTransmitting = false;
        activeSpeakerIds.delete(clientId);
        updateAudioState();
    }

    function resetPttState() {
        isTransmitting = false;
        activeSpeakerIds.clear();
        updateAudioState();
    }

    function toggleLock() {
        isPttLocked = !isPttLocked;
        btnPttLock.classList.toggle('active', isPttLocked);
        btnPttLock.setAttribute('aria-pressed', String(isPttLocked));
        if (!isPttLocked && isTransmitting) stopTransmit();
    }

    pttButton.addEventListener('pointerdown', event => {
        event.preventDefault();
        if (isPttLocked) isTransmitting ? stopTransmit() : startTransmit();
        else startTransmit();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => pttButton.addEventListener(type, event => {
        event.preventDefault();
        if (!isPttLocked) stopTransmit();
    }));
    btnPttLock.addEventListener('click', toggleLock);
    btnJoin.addEventListener('click', joinRoom);
    usernameInput.addEventListener('input', () => localStorage.setItem('walkyTalkyUsername', usernameInput.value.trim()));
    usernameInput.addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(); });

    btnCameraToggle.addEventListener('click', () => cameraState(videoPanel.classList.contains('hidden')));
    btnCamera.addEventListener('click', () => cameraState(videoPanel.classList.contains('hidden')));
    btnSpeaker.addEventListener('click', () => {
        isSpeakerOn = !isSpeakerOn;
        btnSpeaker.classList.toggle('active', isSpeakerOn);
        btnSpeaker.setAttribute('aria-pressed', String(isSpeakerOn));
        webrtcManager?.setRemoteAudioEnabled(isSpeakerOn);
    });
    btnMembers.addEventListener('click', () => peersList.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    $('btnMoreCall').addEventListener('click', () => showToast('Audio call controls are ready'));
    $('btnMore').addEventListener('click', () => showToast('Audio-first call · video is optional'));
    $('btnMinimize').addEventListener('click', () => showToast('Keep this tab open to stay connected'));
    btnLeave.addEventListener('click', () => {
        if (ws) ws.close();
        webrtcManager?.cleanupAll();
        deviceView.classList.add('hidden');
        lobbyView.classList.remove('hidden');
        cameraState(false);
    });
    window.addEventListener('keydown', event => {
        if (!chkSpacebar.checked || event.code !== 'Space' || spaceKeyDown || deviceView.classList.contains('hidden')) return;
        if (['input', 'textarea'].includes(document.activeElement.tagName.toLowerCase())) return;
        event.preventDefault(); spaceKeyDown = true;
        if (isPttLocked) isTransmitting ? stopTransmit() : startTransmit(); else startTransmit();
    });
    window.addEventListener('keyup', event => {
        if (event.code === 'Space') { spaceKeyDown = false; if (!isPttLocked) stopTransmit(); }
    });
    videoPanel.addEventListener('click', async event => {
        const button = event.target.closest('.fullscreen-button');
        if (!button) return;
        const tile = button.closest('.video-tile');
        if (!tile) return;
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (tile.requestFullscreen) await tile.requestFullscreen();
    });

    function startVisualizer() {
        const context = audioCanvas.getContext('2d');
        let phase = 0;
        function resize() {
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            audioCanvas.width = audioCanvas.clientWidth * ratio;
            audioCanvas.height = audioCanvas.clientHeight * ratio;
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
        }
        resize(); window.addEventListener('resize', resize);
        function draw() {
            requestAnimationFrame(draw);
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            const width = audioCanvas.width / ratio;
            const height = audioCanvas.height / ratio;
            const active = isTransmitting || activeSpeakerIds.size > 0;
            const level = webrtcManager ? webrtcManager.getAudioVisualLevel() / 255 : 0;
            context.clearRect(0, 0, width, height);
            context.strokeStyle = active ? '#55a9ff' : '#314866';
            context.lineWidth = 3;
            context.beginPath();
            phase += active ? .14 : .035;
            for (let i = 0; i <= 48; i++) {
                const x = (i / 48) * width;
                const y = height / 2 + Math.sin(phase + i * .45) * Math.max(3, level * height * .8) * Math.sin(i * .16);
                if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
            }
            context.stroke();
        }
        draw();
    }
})();
