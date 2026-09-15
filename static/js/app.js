/**
 * Main Application Controller for Web Walkie-Talkie.
 * Handles:
 * - Room Join/Leave UI state
 * - WebSocket connection and message routing
 * - Tactical PTT pointer events (mouse/touch) & Spacebar shortcuts
 * - Floor control states (Standby, TX, RX, Busy)
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
    const networkAddress = document.getElementById('networkAddress');
    const audioCanvas = document.getElementById('audioCanvas');
    const chkAudioFX = document.getElementById('chkAudioFX');
    const chkSpacebar = document.getElementById('chkSpacebar');

    // State Variables
    let clientId = 'usr_' + Math.random().toString(36).substring(2, 9);
    let username = 'Operator';
    let currentRoom = '';
    let ws = null;
    let webrtcManager = null;
    let isTransmitting = false;
    let isFloorBusy = false;
    let activeSpeakerId = null;
    let spaceKeyDown = false;
    let knownPeers = new Map(); // client_id -> username

    // Frequencies mapping for retro feel
    const mockFrequencies = [
        "146.520 MHz", "462.562 MHz", "446.006 MHz", "151.625 MHz", "467.637 MHz"
    ];

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

    // Display the current app address.
    async function fetchNetworkInfo() {
        try {
            const res = await fetch(`${getAppBasePath()}/api/info`);
            const data = await res.json();
            if (data.app_url) {
                networkAddress.textContent = data.app_url;
            } else {
                networkAddress.textContent = window.location.origin;
            }
        } catch (e) {
            networkAddress.textContent = window.location.origin;
        }
    }
    fetchNetworkInfo();

    // Quick channel pill selection
    document.querySelectorAll('.channel-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.channel-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            roomInput.value = pill.dataset.channel;
        });
    });

    // Toggle Audio FX setting
    chkAudioFX.addEventListener('change', (e) => {
        window.tacticalAudioFX.enabled = e.target.checked;
    });

    // Join Channel
    async function joinRoom() {
        const userVal = usernameInput.value.trim();
        const roomVal = roomInput.value.trim().toUpperCase();

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

        // Initialize Web Audio & Synthesizer on user gesture
        window.tacticalAudioFX.init();

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

        connectWebSocket();
    }

    function connectWebSocket() {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}${getAppBasePath()}/ws/${encodeURIComponent(currentRoom)}/${encodeURIComponent(clientId)}?username=${encodeURIComponent(username)}`;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            showToast(`Connected to Channel [${currentRoom}]`);
            window.tacticalAudioFX.playJoinTone();

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
                if (msg.active_speaker_id) {
                    setFloorState(msg.active_speaker_id, msg.speaker_name);
                } else {
                    clearFloorState();
                }
                break;

            case 'peer_joined':
                knownPeers.set(msg.peer.client_id, msg.peer.username);
                updatePeersUI();
                showToast(`${msg.peer.username} tuned in`);
                window.tacticalAudioFX.playJoinTone();
                break;

            case 'peer_left':
                knownPeers.delete(msg.client_id);
                webrtcManager.closePeerConnection(msg.client_id);
                updatePeersUI();
                showToast(`${msg.username} left channel`);
                break;

            case 'floor_granted':
                setFloorState(msg.speaker_id, msg.speaker_name);
                break;

            case 'floor_denied':
                // Someone beat us to transmitting
                showToast(`Channel Busy: ${msg.speaker_name} transmitting`);
                window.tacticalAudioFX.playBusyAlert();
                resetPttState();
                break;

            case 'floor_released':
                clearFloorState();
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

    function setFloorState(speakerId, speakerName) {
        activeSpeakerId = speakerId;

        if (speakerId === clientId) {
            // Current client is transmitting.
            isTransmitting = true;
            isFloorBusy = false;
            webrtcManager.setMicrophoneEnabled(true);
            window.tacticalAudioFX.playPttKey();

            txLed.classList.add('tx-active');
            rxLed.classList.remove('rx-active');
            pttRing.className = 'ptt-outer-ring transmitting';
            pttButton.className = 'ptt-button pressed';
            pttLabel.textContent = 'TRANSMITTING';
            pttHint.textContent = 'Release to stop';

            channelStatusText.className = 'state-badge state-tx';
            channelStatusText.textContent = 'TX [LIVE MIC]';
            speakerNotice.textContent = 'TRANSMITTING LIVE';
        } else {
            // Another client is transmitting.
            isTransmitting = false;
            isFloorBusy = true;
            webrtcManager.setMicrophoneEnabled(false);

            txLed.classList.remove('tx-active');
            rxLed.classList.add('rx-active');
            pttRing.className = 'ptt-outer-ring receiving';
            pttButton.className = 'ptt-button disabled';
            pttLabel.textContent = 'BUSY';
            pttHint.textContent = `${speakerName} talking`;

            channelStatusText.className = 'state-badge state-rx';
            channelStatusText.textContent = 'RX [RECEIVING]';
            speakerNotice.textContent = `INCOMING: ${speakerName.toUpperCase()}`;
        }
        updatePeersUI();
    }

    function clearFloorState() {
        const wasSpeaking = isTransmitting;
        isTransmitting = false;
        isFloorBusy = false;
        activeSpeakerId = null;

        webrtcManager.setMicrophoneEnabled(false);

        if (wasSpeaking) {
            window.tacticalAudioFX.playRogerBeep();
        }

        txLed.classList.remove('tx-active');
        rxLed.classList.remove('rx-active');
        pttRing.className = 'ptt-outer-ring';
        pttButton.className = 'ptt-button';
        pttLabel.textContent = 'HOLD TALK';
        pttHint.textContent = 'Push To Transmit';

        channelStatusText.className = 'state-badge state-standby';
        channelStatusText.textContent = 'STANDBY [IDLE]';
        speakerNotice.textContent = 'ALL CLEAR';

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
            peersList.appendChild(createPeerChip(name, { talking: activeSpeakerId === id }));
        });
    }

    // Push-To-Talk Actions
    function startTransmit() {
        if (isTransmitting) return;
        if (isFloorBusy) {
            showToast("Channel Busy: Wait for operator to finish");
            window.tacticalAudioFX.playBusyAlert();
            return;
        }
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            showToast("Not connected to channel relay");
            return;
        }

        // Request floor lock from server
        ws.send(JSON.stringify({ type: 'talk_request' }));
    }

    function stopTransmit() {
        if (!isTransmitting) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'talk_release' }));
        }
    }

    function resetPttState() {
        isTransmitting = false;
        isFloorBusy = false;
        activeSpeakerId = null;
        if (webrtcManager) {
            webrtcManager.setMicrophoneEnabled(false);
        }
        if (webrtcManager) {
            clearFloorState();
        }
    }

    // Touch & Pointer Event Listeners for PTT button
    pttButton.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try {
            pttButton.setPointerCapture(e.pointerId);
        } catch (err) {}
        startTransmit();
    });

    const handlePointerRelease = (e) => {
        e.preventDefault();
        stopTransmit();
    };

    pttButton.addEventListener('pointerup', handlePointerRelease);
    pttButton.addEventListener('pointercancel', handlePointerRelease);
    pttButton.addEventListener('pointerleave', (e) => {
        // Only stop if pointer wasn't captured
        if (!pttButton.hasPointerCapture || !pttButton.hasPointerCapture(e.pointerId)) {
            stopTransmit();
        }
    });

    // Spacebar Keyboard Push-To-Talk
    window.addEventListener('keydown', (e) => {
        if (!chkSpacebar.checked) return;
        if (e.code === 'Space' && !spaceKeyDown && !deviceView.classList.contains('hidden')) {
            const activeTag = document.activeElement.tagName.toLowerCase();
            if (activeTag === 'input' || activeTag === 'textarea') return;
            e.preventDefault();
            spaceKeyDown = true;
            startTransmit();
        }
    });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && spaceKeyDown) {
            e.preventDefault();
            spaceKeyDown = false;
            stopTransmit();
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
    usernameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') roomInput.focus();
    });
    roomInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinRoom();
    });

    // Audio Oscilloscope Waveform Animation
    function startVisualizer() {
        const ctx = audioCanvas.getContext('2d');

        function resizeCanvas() {
            audioCanvas.width = audioCanvas.parentElement.clientWidth * window.devicePixelRatio || 300;
            audioCanvas.height = audioCanvas.parentElement.clientHeight * window.devicePixelRatio || 48;
        }
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        let phase = 0;

        function draw() {
            requestAnimationFrame(draw);
            const w = audioCanvas.width;
            const h = audioCanvas.height;

            ctx.clearRect(0, 0, w, h);

            let activityLevel = 0;
            if (webrtcManager && (isTransmitting || isFloorBusy)) {
                activityLevel = webrtcManager.getAudioVisualLevel() / 255;
            }

            // Draw oscilloscope line
            ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
            ctx.beginPath();

            let strokeColor = 'rgba(57, 255, 150, 0.4)';
            if (isTransmitting) {
                strokeColor = '#ef4444';
            } else if (isFloorBusy) {
                strokeColor = '#38bdf8';
            }

            ctx.strokeStyle = strokeColor;
            ctx.shadowBlur = 8;
            ctx.shadowColor = strokeColor;

            const sliceWidth = w / 60;
            let x = 0;
            phase += 0.12;

            for (let i = 0; i <= 60; i++) {
                const amp = (activityLevel > 0.05) ? (activityLevel * (h / 2.6)) : (h * 0.08);
                const sine = Math.sin(phase + i * 0.35) * Math.cos(phase * 0.5 + i * 0.2);
                const y = (h / 2) + sine * amp;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
                x += sliceWidth;
            }

            ctx.stroke();
            ctx.shadowBlur = 0; // reset
        }

        draw();
    }

    // Default username placeholder for convenience
    usernameInput.value = 'Operator-' + Math.floor(100 + Math.random() * 900);
    roomInput.value = 'ALPHA-1';
})();
