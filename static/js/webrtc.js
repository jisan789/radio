/**
 * WebRTC Mesh Manager for Push-to-Talk Audio.
 * Manages local microphone stream, peer connections per remote client,
 * ICE candidates, SDP offer/answer exchange, and Web Audio Analyzer for visuals.
 */

class WebRTCManager {
    constructor(signalingCallback) {
        this.sendSignal = signalingCallback; // Function to send message to websocket
        this.localStream = null;
        this.peers = new Map(); // target_id -> RTCPeerConnection
        this.remoteAudioElements = new Map(); // target_id -> HTMLAudioElement
        this.remoteVideoElements = new Map(); // target_id -> HTMLVideoElement
        this.audioContext = null;
        this.analyser = null;
        this.micSourceNode = null;
        this.isMicActive = false;
        this.lastMicrophoneError = null;

        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ]
        };
    }

    async initMicrophone() {
        if (this.localStream) return true;
        this.lastMicrophoneError = null;

        if (!window.isSecureContext) {
            this.lastMicrophoneError = {
                name: "InsecureContext",
                message: "Microphone access requires HTTPS."
            };
            return false;
        }

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this.lastMicrophoneError = {
                name: "UnsupportedBrowser",
                message: "This browser does not support microphone access."
            };
            return false;
        }

        try {
            const audioConstraints = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    audio: audioConstraints,
                    video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } }
                });
            } catch (videoError) {
                console.warn('Camera unavailable, continuing with audio only:', videoError);
                this.localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
            }

            // Start with microphone track disabled (PTT is silent by default)
            this.setMicrophoneEnabled(false);

            // Connect mic to Web Audio Analyzer for live visualizer
            this.setupAudioAnalyser();
            return true;
        } catch (err) {
            this.lastMicrophoneError = {
                name: err.name || "MicrophoneError",
                message: err.message || "Microphone access failed."
            };
            console.error("Failed to access microphone:", err);
            return false;
        }
    }

    setMicrophoneEnabled(enabled) {
        this.isMicActive = enabled;
        if (this.localStream) {
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = enabled;
            });
        }
    }

    setCameraEnabled(enabled) {
        if (!this.localStream) return false;
        const videoTracks = this.localStream.getVideoTracks();
        videoTracks.forEach(track => { track.enabled = enabled; });
        return videoTracks.length > 0;
    }

    setRemoteAudioEnabled(enabled) {
        this.remoteAudioElements.forEach(audioElement => {
            audioElement.volume = enabled ? 1 : 0;
        });
    }

    hasCamera() {
        return Boolean(this.localStream && this.localStream.getVideoTracks().length);
    }

    setupAudioAnalyser() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioCtx();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 64;
            this.analyser.smoothingTimeConstant = 0.8;

            if (this.localStream) {
                this.micSourceNode = this.audioContext.createMediaStreamSource(this.localStream);
                this.micSourceNode.connect(this.analyser);
            }
        } catch (e) {
            console.warn("Audio analyzer setup failed:", e);
        }
    }

    getAudioVisualLevel() {
        if (!this.analyser) return 0;
        const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        return sum / dataArray.length; // 0 to 255
    }

    createPeerConnection(targetId) {
        if (this.peers.has(targetId)) {
            return this.peers.get(targetId);
        }

        const pc = new RTCPeerConnection(this.iceServers);

        // Add local mic tracks to the connection
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                pc.addTrack(track, this.localStream);
            });
        }

        // Handle remote stream
        pc.ontrack = (event) => {
            console.log(`Received remote track from peer: ${targetId}`);
            let audioEl = this.remoteAudioElements.get(targetId);
            if (!audioEl) {
                audioEl = new Audio();
                audioEl.autoplay = true;
                audioEl.playsInline = true;
                audioEl.volume = 1;
                this.remoteAudioElements.set(targetId, audioEl);
            }
            if (event.streams && event.streams[0]) {
                audioEl.srcObject = event.streams[0];
            } else {
                const inboundStream = new MediaStream([event.track]);
                audioEl.srcObject = inboundStream;
            }

            if (event.track.kind === 'video') {
                let videoEl = this.remoteVideoElements.get(targetId);
                if (!videoEl) {
                    videoEl = document.createElement('video');
                    videoEl.autoplay = true;
                    videoEl.playsInline = true;
                    videoEl.className = 'remote-video';
                    this.remoteVideoElements.set(targetId, videoEl);
                    const tile = document.createElement('div');
                    tile.className = 'video-tile remote-video-tile';
                    tile.dataset.peerId = targetId;
                    tile.appendChild(videoEl);
                    const label = document.createElement('span');
                    label.className = 'video-name';
                    label.textContent = (event.track.label || 'OPERATOR').toUpperCase();
                    tile.appendChild(label);
                    const fullscreenButton = document.createElement('button');
                    fullscreenButton.className = 'fullscreen-button';
                    fullscreenButton.type = 'button';
                    fullscreenButton.title = 'Watch operator fullscreen';
                    fullscreenButton.setAttribute('aria-label', 'Watch operator fullscreen');
                    fullscreenButton.innerHTML = '<i class="bx bx-expand-alt"></i>';
                    tile.appendChild(fullscreenButton);
                    document.getElementById('remoteVideos').appendChild(tile);
                }
                videoEl.srcObject = event.streams && event.streams[0]
                    ? event.streams[0]
                    : new MediaStream([event.track]);
                videoEl.play().catch(() => {});
            }
        };

        // ICE candidate generation
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendSignal({
                    type: "signal_candidate",
                    target_id: targetId,
                    payload: event.candidate
                });
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`Peer ${targetId} ICE state: ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
                this.closePeerConnection(targetId);
            }
        };

        this.peers.set(targetId, pc);
        return pc;
    }

    async initiateCall(targetId) {
        const pc = this.createPeerConnection(targetId);
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.sendSignal({
                type: "signal_offer",
                target_id: targetId,
                payload: offer
            });
        } catch (err) {
            console.error(`Error creating offer to ${targetId}:`, err);
        }
    }

    async handleSignalOffer(fromId, offerPayload) {
        const pc = this.createPeerConnection(fromId);
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offerPayload));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendSignal({
                type: "signal_answer",
                target_id: fromId,
                payload: answer
            });
        } catch (err) {
            console.error(`Error handling offer from ${fromId}:`, err);
        }
    }

    async handleSignalAnswer(fromId, answerPayload) {
        const pc = this.peers.get(fromId);
        if (pc) {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(answerPayload));
            } catch (err) {
                console.error(`Error handling answer from ${fromId}:`, err);
            }
        }
    }

    async handleSignalCandidate(fromId, candidatePayload) {
        const pc = this.peers.get(fromId);
        if (pc) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidatePayload));
            } catch (err) {
                console.error(`Error adding ICE candidate from ${fromId}:`, err);
            }
        }
    }

    closePeerConnection(targetId) {
        const pc = this.peers.get(targetId);
        if (pc) {
            pc.close();
            this.peers.delete(targetId);
        }
        const audioEl = this.remoteAudioElements.get(targetId);
        if (audioEl) {
            audioEl.srcObject = null;
            audioEl.remove();
            this.remoteAudioElements.delete(targetId);
        }
        const videoEl = this.remoteVideoElements.get(targetId);
        if (videoEl) {
            videoEl.srcObject = null;
            const tile = videoEl.closest('.video-tile');
            if (tile) tile.remove();
            this.remoteVideoElements.delete(targetId);
        }
    }

    cleanupAll() {
        for (const [targetId] of this.peers) {
            this.closePeerConnection(targetId);
        }
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
    }
}

window.WebRTCManager = WebRTCManager;
