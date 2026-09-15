/**
 * Tactical Radio Audio FX Synthesizer using Web Audio API.
 * Synthesizes:
 * - Mic PTT key-down squelch / burst
 * - Roger beep on release (NASA / military dual-tone standard)
 * - Channel joined / disconnected alert beeps
 * - Channel busy warning tone
 */

class TacticalAudioFX {
    constructor() {
        this.ctx = null;
        this.enabled = true;
    }

    init() {
        if (!this.ctx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContextClass();
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    playPttKey() {
        if (!this.enabled) return;
        this.init();
        const now = this.ctx.currentTime;

        // Quick burst of high-passed noise (mic click/squelch)
        const bufferSize = this.ctx.sampleRate * 0.04; // 40ms noise burst
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = (Math.random() * 2 - 1) * 0.4;
        }

        const whiteNoise = this.ctx.createBufferSource();
        whiteNoise.buffer = noiseBuffer;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(2500, now);
        filter.Q.setValueAtTime(3, now);

        const gainNode = this.ctx.createGain();
        gainNode.gain.setValueAtTime(0.3, now);
        gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.04);

        // Subtle beep before opening mic
        const osc = this.ctx.createOscillator();
        const oscGain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1050, now);
        oscGain.gain.setValueAtTime(0.15, now);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);

        whiteNoise.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(this.ctx.destination);

        osc.connect(oscGain);
        oscGain.connect(this.ctx.destination);

        whiteNoise.start(now);
        osc.start(now);
        osc.stop(now + 0.04);
        whiteNoise.stop(now + 0.04);
    }

    playRogerBeep() {
        if (!this.enabled) return;
        this.init();
        const now = this.ctx.currentTime;

        // Classic Apollo/Motorola style 2-tone Roger beep: 2475Hz -> 2000Hz
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(2475, now);
        osc.frequency.setValueAtTime(2000, now + 0.06);

        gain.gain.setValueAtTime(0.18, now);
        gain.gain.setValueAtTime(0.18, now + 0.11);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

        // Trailing short squelch tail
        const bufferSize = this.ctx.sampleRate * 0.03;
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = (Math.random() * 2 - 1) * 0.25;
        }
        const whiteNoise = this.ctx.createBufferSource();
        whiteNoise.buffer = noiseBuffer;
        const noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.12, now + 0.14);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.17);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        whiteNoise.connect(noiseGain);
        noiseGain.connect(this.ctx.destination);

        osc.start(now);
        osc.stop(now + 0.17);
        whiteNoise.start(now + 0.14);
        whiteNoise.stop(now + 0.17);
    }

    playBusyAlert() {
        if (!this.enabled) return;
        this.init();
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(330, now + 0.08);

        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now);
        osc.stop(now + 0.18);
    }

    playJoinTone() {
        if (!this.enabled) return;
        this.init();
        const now = this.ctx.currentTime;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(1400, now + 0.12);

        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now);
        osc.stop(now + 0.15);
    }
}

window.tacticalAudioFX = new TacticalAudioFX();
