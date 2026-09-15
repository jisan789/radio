/**
 * Main Application Controller for Web Walkie-Talkie.
 * Handles:
 * - Room Join/Leave UI state
 * - WebSocket connection and message routing
 * - Tactical PTT pointer events (mouse/touch) & Spacebar shortcuts
 * - Independent push-to-talk state for every connected operator
 * - Canvas audio visualizer animation loop
 */

(() => {
    // DOM Elements
    const lobbyView = document.getElementById('lobbyView');
    const deviceView = document.getElementById('deviceView');
    const usernameInput = document.getElementById('usernameInput');
    const roomInput = document.getElementById('roomInput');
    const btnJoin = document.getElementById('btnJoin');
    const btnLeave = document.getElementById('btnLeave');
    const btnPttLock = document.getElementById('btnPttLock');
    const btnCamera = document.getElementById('btnCamera');
    const btnLight = document.getElementById('btnLight');
    const btnCloseLight = document.getElementById('btnCloseLight');
    const screenLight = document.getElementById('screenLight');
    const lightBrightness = document.getElementById('lightBrightness');
    const videoPanel = document.getElementById('videoPanel');
    const localVideo = document.getElementById('localVideo');
    const pttButton = document.getElementById('pttButton');
    const pttRing = document.getElementById('pttRing');
    const pttLabel = document.getElementById('pttLabel');
    const pttHint = document.getElementById('pttHint');
    const txLed = document.getElementById('txLed');
    const rxLed = document.getElementById('rxLed');
    const connectionStatus = document.getElementById('connectionStatus');
    const lcdCallsign = document.getElementById('lcdCallsign');
    const lcdPeersCount = document.getElementById('lcdPeersCount');
    const lcdRoom = document.getElementById('lcdRoom');
    const lcdFreq = document.getElementById('lcdFreq');
    const channelStatusText = document.getElementById('channelStatusText');
    const speakerNotice = document.getElementById('speakerNotice');
    const peersList = document.getElementById('peersList');
    const toast = document.getElementById('toast');
    const audioCanvas = document.getElementById('audioCanvas');
    const chkSpacebar = document.getElementById('chkSpacebar');

    // State Variables
    let clientId = 'usr_' + Math.random().toString(36).substring(2, 9);
    let username = 'Operator';
    let currentRoom = '';
    let ws = null;
    let webrtcManager = null;
    let isTransmitting = false;
    let isPttLocked = false;
    const activeSpeakerIds = new Set();
    let spaceKeyDown = false;
    let knownPeers = new Map(); // client_id -> username

    // Frequencies mapping for retro feel
    const mockFrequencies = [
        "146.520 MHz", "462.562 MHz", "446.006 MHz", "151.625 MHz", "467.637 MHz"
    ];
    const defaultRoom = 'ALPHA-1';
    const savedUsername = localStorage.getItem('walkyTalkyUsername');

    function getAppBasePath() {
        const path = window.location.pathname;
        if (path.endsWith('/')) {
            return path.slice(0, -1);
        }
        const lastSlash = path.lastIndexOf('/');
        return lastSlash > 0 ? path.slice(0, lastSlash) : '';
    }

    // Helper: Show toast notification
    function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(() => {
            toast.classList.remove('show');
        }, 2600);
    }

    function getMicrophoneErrorMessage(error) {
        if (!error) {
            return "Microphone access failed. Check browser site settings and try again.";
        }

        switch (error.name) {
            case "InsecureContext":
                return "Microphone permission will not appear unless the app is opened over HTTPS. Enable SSL on the hosted site, then reload.";
            case "NotAllowedError":
            case "PermissionDeniedError":
                return "Microphone access is blocked for this site. Open browser site settings, allow Microphone, then reload.";
            case "NotFoundError":
            case "DevicesNotFoundError":
                return "No microphone was found on this device.";
            case "NotReadableError":
            case "TrackStartError":
                return "The microphone is already in use by another app or browser tab.";
            case "OverconstrainedError":
                return "The selected microphone does not support the requested audio settings.";
            case "UnsupportedBrowser":
                return "This browser does not support microphone access. Use a modern Chrome, Edge, Firefox, or Safari browser.";
            default:
                return `Microphone access failed: ${error.message}`;
        }
    }

    usernameInput.value = savedUsername || 'Operator-' + Math.floor(100 + Math.random() * 900);
    roomInput.value = defaultRoom;
    usernameInput.addEventListener('input', () => {
        localStorage.setItem('walkyTalkyUsername', usernameInput.value.trim());
    });

    // Join Channel
    async function joinRoom() {
        const userVal = usernameInput.value.trim();
        const roomVal = defaultRoom;

        if (!userVal) {
            usernameInput.focus();
            showToast("Please enter an Operator Callsign");
            return;
        }
        if (!roomVal) {
            roomInput.focus();
            showToast("Please enter or select a Channel");
            return;
        }

        username = userVal;
        currentRoom = roomVal;
        localStorage.setItem('walkyTalkyUsername', username);

        // Initialize WebRTC
        webrtcManager = new WebRTCManager((signalData) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(signalData));
            }
        });

        const micGranted = await webrtcManager.initMicrophone();
        if (!micGranted) {
            alert(getMicrophoneErrorMessage(webrtcManager.lastMicrophoneError));
            return;
        }

        localVideo.srcObject = webrtcManager.localStream;
        localVideo.muted = true;
        videoPanel.classList.toggle('hidden', !webrtcManager.hasCamera());
        btnCamera.setAttribute('aria-pressed', 'true');
        btnCamera.textContent = 'CAMERA ON';

        connectWebSocket();
    }

    function connectWebSocket() {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}${getAppBasePath()}/ws/${encodeURIComponent(currentRoom)}/${encodeURIComponent(clientId)}?username=${encodeURIComponent(username)}`;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            showToast(`Connected to Channel [${currentRoom}]`);
            // Transition UI
            lobbyView.classList.add('hidden');
            deviceView.classList.remove('hidden');

            lcdCallsign.textContent = `CALLSIGN: ${username.toUpperCase()}`;
            lcdRoom.textContent = currentRoom;
            lcdFreq.textContent = mockFrequencies[Math.floor(Math.random() * mockFrequencies.length)];
            connectionStatus.textContent = 'LINK ACTIVE';
            connectionStatus.style.color = '#38bdf8';

            startVisualizer();
        };

        ws.onmessage = async (event) => {
            const msg = JSON.parse(event.data);
            handleServerMessage(msg);
        };

        ws.onclose = () => {
            connectionStatus.textContent = 'DISCONNECTED';
            connectionStatus.style.color = '#ef4444';
            resetPttState();
        };

        ws.onerror = (err) => {
            console.error("WebSocket Error:", err);
            showToast("Connection Error with Signaling Relay");
        };
    }

    async function handleServerMessage(msg) {
        switch (msg.type) {
            case 'room_state':
                knownPeers.clear();
                msg.peers.forEach(p => {
                    if (p.client_id !== clientId) {
                        knownPeers.set(p.client_id, p.username);
                        // Initiate WebRTC offer with established peers
                        webrtcManager.initiateCall(p.client_id);
                    }
                });
                updatePeersUI();
                activeSpeakerIds.clear();
                (msg.active_speaker_ids || []).forEach(id => activeSpeakerIds.add(id));
                updateAudioState();
                break;

            case 'peer_joined':
                knownPeers.set(msg.peer.client_id, msg.peer.username);
                updatePeersUI();
                showToast(`${msg.peer.username} tuned in`);
                break;

            case 'peer_left':
                knownPeers.delete(msg.client_id);
                webrtcManager.closePeerConnection(msg.client_id);
                updatePeersUI();
                showToast(`${msg.username} left channel`);
                break;

            case 'speaker_started':
                activeSpeakerIds.add(msg.speaker_id);
                updateAudioState();
                break;

            case 'speaker_stopped':
                activeSpeakerIds.delete(msg.speaker_id || msg.client_id);
                updateAudioState();
                break;

            // WebRTC Signaling
            case 'signal_offer':
                await webrtcManager.handleSignalOffer(msg.from_id, msg.payload);
                break;

            case 'signal_answer':
                await webrtcManager.handleSignalAnswer(msg.from_id, msg.payload);
                break;

            case 'signal_candidate':
                await webrtcManager.handleSignalCandidate(msg.from_id, msg.payload);
                break;
        }
    }

    function updateAudioState() {
        const remoteSpeakers = [...activeSpeakerIds].filter(id => id !== clientId);
        const remoteNames = remoteSpeakers.map(id => knownPeers.get(id)).filter(Boolean);
        const receiving = remoteSpeakers.length > 0;

        if (webrtcManager) webrtcManager.setMicrophoneEnabled(isTransmitting);
        txLed.classList.toggle('tx-active', isTransmitting);
        rxLed.classList.toggle('rx-active', receiving);

        if (isTransmitting) {
            pttRing.className = 'ptt-outer-ring transmitting';
            pttButton.className = 'ptt-button pressed';
            pttLabel.textContent = 'TRANSMITTING';
            pttHint.textContent = receiving ? 'Live with incoming audio' : 'Release to stop';
        } else {
            pttRing.className = receiving ? 'ptt-outer-ring receiving' : 'ptt-outer-ring';
            pttButton.className = 'ptt-button';
            pttLabel.textContent = 'HOLD TALK';
            pttHint.textContent = receiving ? `${remoteNames.join(', ')} talking` : 'Push To Transmit';
        }

        channelStatusText.className = `state-badge ${isTransmitting ? 'state-tx' : receiving ? 'state-rx' : 'state-standby'}`;
        channelStatusText.textContent = isTransmitting ? 'TX [LIVE MIC]' : receiving ? 'RX [RECEIVING]' : 'STANDBY [IDLE]';
        speakerNotice.textContent = isTransmitting && receiving ? 'TRANSMITTING + RECEIVING' : isTransmitting ? 'TRANSMITTING LIVE' : receiving ? `INCOMING: ${remoteNames.join(', ').toUpperCase()}` : 'ALL CLEAR';
        updatePeersUI();
    }

    function updatePeersUI() {
        lcdPeersCount.textContent = `${knownPeers.size + 1} ONLINE`;
        peersList.innerHTML = '';

        function createPeerChip(name, options = {}) {
            const chip = document.createElement('div');
            chip.className = `peer-chip ${options.self ? 'you ' : ''}${options.talking ? 'talking' : ''}`.trim();

            const pulse = document.createElement('span');
            pulse.className = 'peer-pulse';

            const label = document.createElement('span');
            label.textContent = options.self ? `${name} (Current)` : name;

            chip.appendChild(pulse);
            chip.appendChild(label);
            return chip;
        }

        // Add self
        peersList.appendChild(createPeerChip(username, { self: true, talking: isTransmitting }));

        // Add others
        knownPeers.forEach((name, id) => {
            peersList.appendChild(createPeerChip(name, { talking: activeSpeakerIds.has(id) }));
        });
    }

    // Push-To-Talk Actions
    function startTransmit() {
        if (isTransmitting) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            showToast("Not connected to channel relay");
            return;
        }

        isTransmitting = true;
        activeSpeakerIds.add(clientId);
        updateAudioState();
        ws.send(JSON.stringify({ type: 'talk_request' }));
    }

    function stopTransmit() {
        if (!isTransmitting) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'talk_release' }));
        }
        activeSpeakerIds.delete(clientId);
        isTransmitting = false;
        updateAudioState();
    }

    function togglePttLock() {
        isPttLocked = !isPttLocked;
        btnPttLock.classList.toggle('active', isPttLocked);
        btnPttLock.setAttribute('aria-pressed', String(isPttLocked));
        btnPttLock.querySelector('.lock-icon').textContent = isPttLocked ? '\uD83D\uDD13' : '\uD83D\uDD12';
        btnPttLock.title = isPttLocked
            ? 'PTT lock active: click PTT to start and click again to stop'
            : 'Click PTT once to transmit and again to stop';

        if (!isPttLocked && isTransmitting) {
            stopTransmit();
        }
    }

    function resetPttState() {
        isTransmitting = false;
        activeSpeakerIds.clear();
        if (webrtcManager) {
            webrtcManager.setMicrophoneEnabled(false);
        }
        if (webrtcManager) {
            updateAudioState();
        }
    }

    // Touch & Pointer Event Listeners for PTT button
    pttButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try {
            pttButton.setPointerCapture(e.pointerId);
        } catch (err) {}
        if (isPttLocked) {
            if (isTransmitting) {
                stopTransmit();
            } else {
                startTransmit();
            }
            return;
        }
        startTransmit();
    });

    const handlePointerRelease = (e) => {
        e.preventDefault();
        if (isPttLocked) return;
        stopTransmit();
    };

    pttButton.addEventListener('pointerup', handlePointerRelease);
    pttButton.addEventListener('pointercancel', handlePointerRelease);
    pttButton.addEventListener('pointerleave', (e) => {
        // Only stop if pointer wasn't captured
        if (!isPttLocked && (!pttButton.hasPointerCapture || !pttButton.hasPointerCapture(e.pointerId))) {
            stopTransmit();
        }
    });

    btnPttLock.addEventListener('click', togglePttLock);

    // Spacebar Keyboard Push-To-Talk
    window.addEventListener('keydown', (e) => {
        if (!chkSpacebar.checked) return;
        if (e.code === 'Space' && !spaceKeyDown && !deviceView.classList.contains('hidden')) {
            const activeTag = document.activeElement.tagName.toLowerCase();
            if (activeTag === 'input' || activeTag === 'textarea') return;
            e.preventDefault();
            spaceKeyDown = true;
            if (isPttLocked) {
                if (isTransmitting) stopTransmit();
                else startTransmit();
            } else {
                startTransmit();
            }
        }
    });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && spaceKeyDown) {
            e.preventDefault();
            spaceKeyDown = false;
            if (!isPttLocked) stopTransmit();
        }
    });

    // Disengage / Leave Channel
    btnLeave.addEventListener('click', () => {
        if (ws) {
            ws.close();
        }
        if (webrtcManager) {
            webrtcManager.cleanupAll();
        }
        deviceView.classList.add('hidden');
        lobbyView.classList.remove('hidden');
        showToast("Disengaged from channel");
    });

    // Join Button Event
    btnJoin.addEventListener('click', joinRoom);
    btnCamera.addEventListener('click', () => {
        if (!webrtcManager || !webrtcManager.hasCamera()) {
            showToast('Camera is not available');
            return;
        }
        const cameraOn = btnCamera.getAttribute('aria-pressed') === 'true';
        webrtcManager.setCameraEnabled(!cameraOn);
        btnCamera.setAttribute('aria-pressed', String(!cameraOn));
        btnCamera.textContent = cameraOn ? 'CAMERA OFF' : 'CAMERA ON';
        localVideo.classList.toggle('camera-off', cameraOn);
    });

    function setScreenLight(open) {
        screenLight.classList.toggle('hidden', !open);
        btnLight.setAttribute('aria-pressed', String(open));
    }

    btnLight.addEventListener('click', () => setScreenLight(true));
    btnCloseLight.addEventListener('click', () => setScreenLight(false));
    lightBrightness.addEventListener('input', () => {
        screenLight.style.setProperty('--light-level', lightBrightness.value);
    });
    screenLight.style.setProperty('--light-level', lightBrightness.value);

    videoPanel.addEventListener('click', async (event) => {
        const fullscreenButton = event.target.closest('.fullscreen-button');
        if (!fullscreenButton) return;

        const tile = fullscreenButton.closest('.video-tile');
        if (!tile) return;

        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else if (tile.requestFullscreen) {
                await tile.requestFullscreen();
            } else if (tile.webkitRequestFullscreen) {
                tile.webkitRequestFullscreen();
            } else {
                showToast('Fullscreen is not supported on this browser');
            }
        } catch (error) {
            showToast('Fullscreen was blocked by the browser');
        }
    });
    usernameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') roomInput.focus();
    });
    roomInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinRoom();
    });

    // Responsive radio signal monitor with carrier, sweep, pulse, and activity layers.
    function startVisualizer() {
        const ctx = audioCanvas.getContext('2d');

        function resizeCanvas() {
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            const width = Math.max(audioCanvas.parentElement.clientWidth, 1);
            const height = Math.max(audioCanvas.parentElement.clientHeight, 1);
            audioCanvas.width = Math.floor(width * pixelRatio);
            audioCanvas.height = Math.floor(height * pixelRatio);
            ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        }
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        let phase = 0;
        let sweep = 0;

        function draw() {
            requestAnimationFrame(draw);
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            const w = audioCanvas.width / pixelRatio;
            const h = audioCanvas.height / pixelRatio;

            ctx.clearRect(0, 0, w, h);

            let activityLevel = 0;
            if (webrtcManager && (isTransmitting || activeSpeakerIds.size > 0)) {
                activityLevel = webrtcManager.getAudioVisualLevel() / 255;
            }

            const active = isTransmitting || activeSpeakerIds.size > 0;
            const signalColor = isTransmitting ? '#ef3e32' : active ? '#168c5b' : '#1d5cff';
            const centerY = h / 2;
            const amplitude = active ? Math.max(h * 0.12, activityLevel * h * 0.42) : h * 0.06;
            phase += active ? 0.16 : 0.05;
            sweep = (sweep + (active ? 1.8 : 0.55)) % Math.max(w, 1);

            ctx.fillStyle = 'rgba(17, 17, 17, 0.06)';
            for (let x = 0; x < w; x += 24) ctx.fillRect(x, 0, 1, h);
            for (let y = 8; y < h; y += 16) ctx.fillRect(0, y, w, 1);

            ctx.strokeStyle = signalColor;
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i <= 100; i++) {
                const x = (i / 100) * w;
                const wave = Math.sin(phase + i * 0.42) * amplitude;
                const y = centerY + wave * Math.cos(phase * 0.45 + i * 0.08);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();

            ctx.globalAlpha = active ? 0.9 : 0.45;
            ctx.fillStyle = signalColor;
            ctx.fillRect(sweep, 0, 2, h);
            ctx.globalAlpha = 1;

            const pulseCount = active ? 3 : 1;
            for (let i = 0; i < pulseCount; i++) {
                const radius = ((phase * 12 + i * 22) % Math.max(w, h)) / 2;
                ctx.globalAlpha = Math.max(0, 0.35 - radius / Math.max(w, h));
                ctx.beginPath();
                ctx.arc(w / 2, centerY, radius, 0, Math.PI * 2);
                ctx.strokeStyle = signalColor;
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
        }

        draw();
    }

})();
