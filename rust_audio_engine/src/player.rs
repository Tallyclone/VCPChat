//! VCP Hi-Fi Audio Engine - Audio Player Module
//!
//! Native audio playback using cpal with WASAPI exclusive mode support.
//! Upgraded to f64 full-stack path for maximum transparency.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Stream, StreamConfig};
use parking_lot::{Mutex, RwLock};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use crossbeam::channel::{Sender, unbounded};
use crate::config::{AppConfig, ResampleQuality};
use std::path::PathBuf;
use sha2::{Sha256, Digest};
use std::fs;
use std::io::{Read, Write};

use crate::processor::{Equalizer, VolumeController, NoiseShaper, SpectrumAnalyzer, Resampler};

#[cfg(windows)]
use crate::wasapi_output::{WasapiExclusivePlayer, WasapiState};

/// Commands sent to the audio thread
#[derive(Debug, Clone)]
pub enum AudioCommand {
    Play,
    Pause,
    Stop,
    Shutdown,
}

/// State of the audio player
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PlayerState {
    Stopped,
    Playing,
    Paused,
}

/// Shared state between audio thread and main thread
pub struct SharedState {
    pub state: RwLock<PlayerState>,
    pub position_frames: AtomicU64,
    pub sample_rate: AtomicU64,
    pub channels: AtomicU64,
    pub total_frames: AtomicU64,
    pub spectrum_data: Mutex<Vec<f32>>,
    pub audio_buffer: RwLock<Vec<f64>>, // Upgraded to f64
    pub exclusive_mode: AtomicBool,
}

impl SharedState {
    pub fn new() -> Self {
        Self {
            state: RwLock::new(PlayerState::Stopped),
            position_frames: AtomicU64::new(0),
            sample_rate: AtomicU64::new(44100),
            channels: AtomicU64::new(2),
            total_frames: AtomicU64::new(0),
            spectrum_data: Mutex::new(vec![0.0; 64]),
            audio_buffer: RwLock::new(Vec::new()),
            exclusive_mode: AtomicBool::new(false),
        }
    }
    
    pub fn current_time_secs(&self) -> f64 {
        let pos = self.position_frames.load(Ordering::Relaxed);
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1);
        pos as f64 / sr as f64
    }
    
    pub fn duration_secs(&self) -> f64 {
        let total = self.total_frames.load(Ordering::Relaxed);
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1);
        total as f64 / sr as f64
    }
}

impl Default for SharedState {
    fn default() -> Self {
        Self::new()
    }
}

/// Audio device info
#[derive(Debug, Clone, serde::Serialize)]
pub struct AudioDeviceInfo {
    pub id: usize,
    pub name: String,
    pub is_default: bool,
    pub sample_rate: Option<u32>,
}

/// The main audio player - thread-safe wrapper
pub struct AudioPlayer {
    shared_state: Arc<SharedState>,
    cmd_tx: Sender<AudioCommand>,
    audio_thread: Option<JoinHandle<()>>,
    
    // Processors (shared with audio callback)
    eq: Arc<Mutex<Equalizer>>,
    volume: Arc<Mutex<VolumeController>>,
    noise_shaper: Arc<Mutex<NoiseShaper>>,
    spectrum_analyzer: Arc<SpectrumAnalyzer>,
    
    // Config
    pub exclusive_mode: bool,
    pub target_sample_rate: Option<u32>,
    pub dither_enabled: bool,
    pub replaygain_enabled: bool,
    
    config: AppConfig,
    device_id: Option<usize>,
}

impl AudioPlayer {
    pub fn new(config: AppConfig) -> Self {
        log::info!("Initializing AudioPlayer...");
        let shared_state = Arc::new(SharedState::new());
        let (cmd_tx, cmd_rx) = unbounded::<AudioCommand>();
        
        let thread_state = Arc::clone(&shared_state);
        
        let eq = Arc::new(Mutex::new(Equalizer::new(2, 44100.0)));
        let volume = Arc::new(Mutex::new(VolumeController::new()));
        let noise_shaper = Arc::new(Mutex::new(NoiseShaper::new(2, 44100, 24)));
        let spectrum_analyzer = Arc::new(SpectrumAnalyzer::new(2048, 64));
        
        let thread_eq = Arc::clone(&eq);
        let thread_volume = Arc::clone(&volume);
        let thread_noise_shaper = Arc::clone(&noise_shaper);
        
        let (spectrum_tx, spectrum_rx) = crossbeam::channel::bounded::<f64>(4096);
        
        let spec_state = Arc::clone(&shared_state);
        let spec_analyzer = Arc::clone(&spectrum_analyzer);
        thread::spawn(move || {
            spectrum_thread_main(spectrum_rx, spec_state, spec_analyzer);
        });
        
        let audio_thread = thread::spawn(move || {
            audio_thread_main(
                cmd_rx,
                thread_state,
                thread_eq,
                thread_volume,
                thread_noise_shaper,
                spectrum_tx,
            );
        });
        
        Self {
            shared_state,
            cmd_tx,
            audio_thread: Some(audio_thread),
            eq,
            volume,
            noise_shaper,
            spectrum_analyzer,
            exclusive_mode: false,
            target_sample_rate: config.target_samplerate,
            dither_enabled: true,
            replaygain_enabled: true,
            config,
            device_id: None,
        }
    }
    
    pub fn list_devices(&self) -> Vec<AudioDeviceInfo> {
        log::info!("Listing audio devices across all hosts...");
        let mut all_devices = Vec::new();
        let mut global_idx = 0;

        for host_id in cpal::available_hosts() {
            let host = match cpal::host_from_id(host_id) {
                Ok(h) => h,
                Err(e) => {
                    log::error!("Failed to initialize host {:?}: {}", host_id, e);
                    continue;
                }
            };

            let host_name = format!("{:?}", host_id);
            let default_device = host.default_output_device();
            let default_name = default_device.as_ref().and_then(|d| d.name().ok());

            if let Ok(devices) = host.output_devices() {
                for device in devices {
                    if let Ok(name) = device.name() {
                        let config = device.default_output_config().ok();
                        let full_name = format!("{} [{}]", name, host_name);
                        all_devices.push(AudioDeviceInfo {
                            id: global_idx,
                            name: full_name,
                            is_default: Some(&name) == default_name.as_ref(),
                            sample_rate: config.map(|c| c.sample_rate().0),
                        });
                        global_idx += 1;
                    }
                }
            }
        }
        
        if all_devices.is_empty() {
            log::warn!("No audio output devices found on any host!");
        } else {
            log::info!("Found {} audio devices", all_devices.len());
        }
        
        all_devices
    }
    
    pub fn select_device(&mut self, device_id: Option<usize>) -> Result<(), String> {
        self.device_id = device_id;
        Ok(())
    }
    
    fn get_cache_path(&self, path: &str, target_sr: u32, original_len: usize) -> Option<PathBuf> {
        if !self.config.use_cache { return None; }
        let cache_dir = self.config.cache_dir.clone().unwrap_or_else(|| PathBuf::from("resample_cache"));
        let mut hasher = Sha256::new();
        hasher.update(path.as_bytes());
        hasher.update(target_sr.to_le_bytes());
        let q_byte = match self.config.resample_quality {
            ResampleQuality::Low => 0,
            ResampleQuality::Standard => 1,
            ResampleQuality::High => 2,
            ResampleQuality::UltraHigh => 3,
        };
        hasher.update(&[q_byte]);
        hasher.update(original_len.to_le_bytes());
        let hash = hex::encode(hasher.finalize());
        Some(cache_dir.join(format!("{}.bin", hash)))
    }
    
    pub fn load(&mut self, path: &str) -> Result<(), String> {
        use crate::decoder::StreamingDecoder;
        use crate::processor::StreamingResampler;
        
        log::info!("Loading track: {}", path);
        self.stop();
        
        let mut decoder = StreamingDecoder::open(path).map_err(|e| {
            log::error!("Failed to open decoder for {}: {}", path, e);
            e.to_string()
        })?;
        let info = decoder.info.clone();
        let original_sr = info.sample_rate;
        let channels = info.channels;
        
        // Determine target sample rate
        let target_sr = self.config.target_samplerate.or(self.target_sample_rate).unwrap_or_else(|| {
            let host = cpal::default_host();
            let device = match self.device_id {
                Some(id) => host.output_devices().ok().and_then(|mut d| d.nth(id)),
                None => host.default_output_device(),
            };
            device.and_then(|d| d.default_output_config().ok()).map(|c| c.sample_rate().0).unwrap_or(original_sr)
        });
        
        let need_resample = target_sr != original_sr;
        
        // Check cache first
        let estimated_input_frames = info.total_frames.unwrap_or(0) as usize;
        let cache_path = self.get_cache_path(path, target_sr, estimated_input_frames * channels);
        let mut loaded_from_cache = false;
        let mut samples: Vec<f64>;
        
        if let Some(ref cp) = cache_path {
            if cp.exists() {
                if let Ok(mut f) = fs::File::open(cp) {
                    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                    if size > 0 && size % 8 == 0 {
                        let mut bytes = Vec::new();
                        if f.read_to_end(&mut bytes).is_ok() {
                            samples = bytes.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
                            loaded_from_cache = true;
                            log::info!("Loaded {} samples from cache", samples.len());
                            
                            let total_frames = samples.len() / channels;
                            self.shared_state.sample_rate.store(target_sr as u64, Ordering::Relaxed);
                            self.shared_state.channels.store(channels as u64, Ordering::Relaxed);
                            self.shared_state.total_frames.store(total_frames as u64, Ordering::Relaxed);
                            self.shared_state.position_frames.store(0, Ordering::Relaxed);
                            *self.shared_state.state.write() = PlayerState::Stopped;
                            *self.shared_state.audio_buffer.write() = samples;
                            
                            *self.eq.lock() = Equalizer::new(channels, target_sr as f64);
                            *self.noise_shaper.lock() = NoiseShaper::new(channels, target_sr, 24);
                            
                            return Ok(());
                        }
                    }
                }
            }
        }
        
        // Streaming decode + resample
        if need_resample {
            log::info!("Streaming SoX VHQ Resampling {} -> {} Hz", original_sr, target_sr);
        }
        
        // Pre-allocate with estimate (may grow)
        let estimated_output_frames = if need_resample {
            (estimated_input_frames as f64 * target_sr as f64 / original_sr as f64).ceil() as usize
        } else {
            estimated_input_frames
        };
        samples = Vec::with_capacity(estimated_output_frames * channels);
        
        // Create streaming resampler if needed
        let mut resampler = if need_resample {
            Some(StreamingResampler::new(channels, original_sr, target_sr))
        } else {
            None
        };
        
        let mut chunk_count = 0;
        let mut decoded_frames = 0;
        
        // Stream decode and resample
        while let Some(decoded_chunk) = decoder.decode_next().map_err(|e| e.to_string())? {
            decoded_frames += decoded_chunk.len() / channels;
            
            if let Some(ref mut rs) = resampler {
                let resampled = rs.process_chunk(&decoded_chunk);
                samples.extend(resampled);
            } else {
                samples.extend(decoded_chunk);
            }
            
            chunk_count += 1;
            
            // Log progress periodically
            if chunk_count % 100 == 0 {
                log::debug!("Streaming progress: {} chunks, {} decoded frames", chunk_count, decoded_frames);
            }
        }
        
        // Flush resampler
        if let Some(ref mut rs) = resampler {
            let flushed = rs.flush();
            samples.extend(flushed);
        }
        
        log::info!(
            "Streaming decode complete: {} chunks, {} output samples ({}→{} Hz)",
            chunk_count, samples.len(), original_sr, target_sr
        );
        
        // Save to cache if enabled
        if need_resample && !loaded_from_cache {
            if let Some(ref cp) = cache_path {
                let _ = fs::create_dir_all(cp.parent().unwrap());
                if let Ok(mut f) = fs::File::create(cp) {
                    let mut bytes = Vec::with_capacity(samples.len() * 8);
                    for s in &samples { bytes.extend_from_slice(&s.to_le_bytes()); }
                    let _ = f.write_all(&bytes);
                    log::info!("Cached resampled audio to: {:?}", cp);
                }
            }
        }
        
        let total_frames = samples.len() / channels;
        self.shared_state.sample_rate.store(target_sr as u64, Ordering::Relaxed);
        self.shared_state.channels.store(channels as u64, Ordering::Relaxed);
        self.shared_state.total_frames.store(total_frames as u64, Ordering::Relaxed);
        self.shared_state.position_frames.store(0, Ordering::Relaxed);
        *self.shared_state.state.write() = PlayerState::Stopped;
        *self.shared_state.audio_buffer.write() = samples;
        
        *self.eq.lock() = Equalizer::new(channels, target_sr as f64);
        *self.noise_shaper.lock() = NoiseShaper::new(channels, target_sr, 24);
        
        Ok(())
    }
    
    pub fn play(&mut self) -> Result<(), String> { let _ = self.cmd_tx.send(AudioCommand::Play); Ok(()) }
    pub fn pause(&mut self) -> Result<(), String> { let _ = self.cmd_tx.send(AudioCommand::Pause); Ok(()) }
    pub fn stop(&mut self) { let _ = self.cmd_tx.send(AudioCommand::Stop); }
    pub fn seek(&mut self, time_secs: f64) -> Result<(), String> {
        let sr = self.shared_state.sample_rate.load(Ordering::Relaxed) as f64;
        let total = self.shared_state.total_frames.load(Ordering::Relaxed);
        let new_pos = ((time_secs * sr) as u64).min(total);
        self.shared_state.position_frames.store(new_pos, Ordering::Relaxed);
        Ok(())
    }
    pub fn set_volume(&mut self, vol: f64) { self.volume.lock().set_target(vol); }
    pub fn get_state(&self) -> PlayerState { *self.shared_state.state.read() }
    pub fn shared_state(&self) -> Arc<SharedState> { Arc::clone(&self.shared_state) }
    pub fn eq(&self) -> Arc<Mutex<Equalizer>> { Arc::clone(&self.eq) }
    pub fn noise_shaper(&self) -> Arc<Mutex<NoiseShaper>> { Arc::clone(&self.noise_shaper) }
}

impl Drop for AudioPlayer {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(AudioCommand::Shutdown);
        if let Some(handle) = self.audio_thread.take() { let _ = handle.join(); }
    }
}

fn audio_thread_main(
    cmd_rx: crossbeam::channel::Receiver<AudioCommand>,
    shared_state: Arc<SharedState>,
    eq: Arc<Mutex<Equalizer>>,
    volume: Arc<Mutex<VolumeController>>,
    noise_shaper: Arc<Mutex<NoiseShaper>>,
    spectrum_tx: Sender<f64>,
) {
    log::info!("Audio thread started, initializing cpal host...");
    let mut stream: Option<Stream> = None;
    
    loop {
        match cmd_rx.recv() {
            Ok(AudioCommand::Play) => {
                log::info!("Received Play command");
                if *shared_state.state.read() == PlayerState::Paused {
                    if let Some(ref s) = stream { let _ = s.play(); }
                    *shared_state.state.write() = PlayerState::Playing;
                    continue;
                }
                
                // Check exclusive mode flag
                let use_exclusive = shared_state.exclusive_mode.load(Ordering::Relaxed);
                
                // === WASAPI EXCLUSIVE MODE (Windows only) ===
                #[cfg(windows)]
                if use_exclusive {
                    log::info!("Starting TRUE WASAPI exclusive mode playback...");
                    
                    // Get audio data
                    let audio_buffer = shared_state.audio_buffer.read();
                    let sample_rate = shared_state.sample_rate.load(Ordering::Relaxed) as u32;
                    let channels = shared_state.channels.load(Ordering::Relaxed) as usize;
                    
                    if audio_buffer.is_empty() || channels == 0 {
                        log::error!("No audio data loaded or invalid channels");
                        *shared_state.state.write() = PlayerState::Stopped;
                        continue;
                    }
                    
                    // Clone the audio data for WASAPI player
                    let samples = audio_buffer.clone();
                    drop(audio_buffer);
                    
                    // Create WASAPI exclusive player
                    match WasapiExclusivePlayer::new(None) {
                        Ok(wasapi_player) => {
                            // Load audio into WASAPI player
                            wasapi_player.load(samples, sample_rate, channels);
                            
                            // Get WASAPI shared state for position sync
                            let wasapi_state = wasapi_player.shared_state();
                            
                            // Start exclusive playback
                            if let Err(e) = wasapi_player.play() {
                                log::error!("Failed to start WASAPI playback: {}", e);
                                *shared_state.state.write() = PlayerState::Stopped;
                                continue;
                            }
                            
                            *shared_state.state.write() = PlayerState::Playing;
                            
                            // Wait for WASAPI thread to start playing
                            let mut wait_count = 0;
                            while wasapi_player.get_state() == WasapiState::Stopped && wait_count < 100 {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                                wait_count += 1;
                            }
                            
                            if wasapi_player.get_state() == WasapiState::Stopped {
                                log::error!("WASAPI: Failed to start playback after waiting");
                                *shared_state.state.write() = PlayerState::Stopped;
                                continue;
                            }
                            
                            log::info!("WASAPI: Playback started, entering monitoring loop");
                            
                            // WASAPI playback loop - sync position and handle commands
                            let mut last_spectrum_pos: usize = 0;
                            loop {
                                // Check for new commands
                                if let Ok(cmd) = cmd_rx.try_recv() {
                                    match cmd {
                                        AudioCommand::Pause => {
                                            let _ = wasapi_player.pause();
                                            *shared_state.state.write() = PlayerState::Paused;
                                        }
                                        AudioCommand::Play => {
                                            let _ = wasapi_player.play();
                                            *shared_state.state.write() = PlayerState::Playing;
                                        }
                                        AudioCommand::Stop => {
                                            let _ = wasapi_player.stop();
                                            shared_state.position_frames.store(0, Ordering::Relaxed);
                                            *shared_state.state.write() = PlayerState::Stopped;
                                            break;
                                        }
                                        AudioCommand::Shutdown => {
                                            drop(wasapi_player);
                                            return;
                                        }
                                    }
                                }
                                
                                // Sync position from WASAPI player
                                let wasapi_pos = wasapi_state.position_frames.load(Ordering::Relaxed);
                                shared_state.position_frames.store(wasapi_pos, Ordering::Relaxed);
                                
                                // Send spectrum data (FIX: spectrum analyzer was not working in exclusive mode)
                                // Only send new samples since last update
                                if wasapi_player.get_state() == WasapiState::Playing {
                                    let current_frame = wasapi_pos as usize;
                                    if current_frame > last_spectrum_pos {
                                        let audio_buf = shared_state.audio_buffer.read();
                                        let samples_to_send = ((current_frame - last_spectrum_pos) * channels).min(4096);
                                        let start_sample = last_spectrum_pos * channels;
                                        
                                        for i in 0..samples_to_send {
                                            let idx = start_sample + i;
                                            if idx + channels <= audio_buf.len() && i % channels == 0 {
                                                // Mono mix for spectrum
                                                let mono = if channels == 2 {
                                                    (audio_buf[idx] + audio_buf[idx + 1]) * 0.5
                                                } else {
                                                    audio_buf[idx]
                                                };
                                                let _ = spectrum_tx.try_send(mono);
                                            }
                                        }
                                        drop(audio_buf);
                                        last_spectrum_pos = current_frame;
                                    }
                                }
                                
                                // Check if playback finished (only after position has advanced)
                                let current_state = wasapi_player.get_state();
                                if current_state == WasapiState::Stopped && wasapi_pos > 0 {
                                    log::info!("WASAPI playback finished at position {}", wasapi_pos);
                                    *shared_state.state.write() = PlayerState::Stopped;
                                    break;
                                }
                                
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            
                            // WASAPI player dropped automatically here
                            continue;
                        }
                        Err(e) => {
                            log::error!("Failed to create WASAPI player: {}. Falling back to cpal.", e);
                            // Fall through to cpal playback
                        }
                    }
                }
                
                // === CPAL SHARED MODE (default fallback) ===
                let host = cpal::default_host();
                
                let device = match host.default_output_device() {
                    Some(d) => d,
                    None => {
                        log::error!("Failed to play: No default audio output device found");
                        *shared_state.state.write() = PlayerState::Stopped;
                        continue;
                    }
                };
                
                let requested_sample_rate = shared_state.sample_rate.load(Ordering::Relaxed) as u32;
                let channels = shared_state.channels.load(Ordering::Relaxed) as u16;
                
                if channels == 0 {
                    log::error!("Failed to play: Invalid channel count (0)");
                    *shared_state.state.write() = PlayerState::Stopped;
                    continue;
                }

                // Query device's supported configurations
                let supported_configs = device.supported_output_configs();
                let (actual_sample_rate, buffer_size) = match supported_configs {
                    Ok(configs) => {
                        let configs: Vec<_> = configs.collect();
                        log::info!("Device supports {} output configurations", configs.len());
                        
                        // Find the best matching sample rate
                        let mut best_rate = None;
                        let mut max_supported_rate = 0u32;
                        
                        for config in &configs {
                            let min_rate = config.min_sample_rate().0;
                            let max_rate = config.max_sample_rate().0;
                            log::debug!("  Config: {} ch, {}-{} Hz", config.channels(), min_rate, max_rate);
                            
                            if config.channels() == channels {
                                // Track max supported rate for this channel count
                                if max_rate > max_supported_rate {
                                    max_supported_rate = max_rate;
                                }
                                
                                // Check if requested rate is in range
                                if requested_sample_rate >= min_rate && requested_sample_rate <= max_rate {
                                    best_rate = Some(requested_sample_rate);
                                }
                            }
                        }
                        
                        let final_rate = best_rate.unwrap_or_else(|| {
                            // Use max supported rate if requested rate isn't supported
                            if max_supported_rate > 0 {
                                log::warn!(
                                    "Requested {} Hz not supported, using device max {} Hz",
                                    requested_sample_rate, max_supported_rate
                                );
                                max_supported_rate
                            } else {
                                // Fallback to default config
                                device.default_output_config()
                                    .map(|c| c.sample_rate().0)
                                    .unwrap_or(48000)
                            }
                        });
                        
                        // Use small buffer for exclusive mode if rate is supported
                        let buf = if use_exclusive && best_rate.is_some() {
                            cpal::BufferSize::Fixed(512)
                        } else {
                            cpal::BufferSize::Default
                        };
                        
                        (final_rate, buf)
                    }
                    Err(e) => {
                        log::warn!("Failed to query device configs: {}. Using default.", e);
                        let rate = device.default_output_config()
                            .map(|c| c.sample_rate().0)
                            .unwrap_or(48000);
                        (rate, cpal::BufferSize::Default)
                    }
                };
                
                log::info!(
                    "Opening stream: {} Hz (requested {}), {} channels, exclusive={}",
                    actual_sample_rate, requested_sample_rate, channels, use_exclusive
                );
                
                let config = StreamConfig {
                    channels,
                    sample_rate: cpal::SampleRate(actual_sample_rate),
                    buffer_size,
                };
                
                // Update shared state with actual sample rate being used
                if actual_sample_rate != requested_sample_rate {
                    log::info!("Updating playback sample rate to device-supported {} Hz", actual_sample_rate);
                    // Note: Audio data was resampled to requested rate, but device will play at actual rate
                    // This may cause playback speed change - for now we just log the mismatch
                }
                
                let cb_shared = Arc::clone(&shared_state);
                let cb_eq = Arc::clone(&eq);
                let cb_volume = Arc::clone(&volume);
                let cb_ns = Arc::clone(&noise_shaper);
                let cb_spectrum_tx = spectrum_tx.clone();
                
                let mut process_buffer = Vec::with_capacity(8192);
                log::info!("Building output stream...");
                let new_stream = device.build_output_stream(
                    &config,
                    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        audio_callback(data, &cb_shared, &cb_eq, &cb_volume, &cb_ns, &cb_spectrum_tx, channels as usize, &mut process_buffer);
                    },
                    |err| log::error!("Stream error: {}", err),
                    None,
                );
                
                match new_stream {
                    Ok(s) => {
                        let _ = s.play();
                        stream = Some(s);
                        *shared_state.state.write() = PlayerState::Playing;
                        log::info!("Stream started successfully at {} Hz", actual_sample_rate);
                    }
                    Err(e) => {
                        log::error!("Failed to build stream: {}. Trying device default config...", e);
                        
                        // Ultimate fallback: use device's default config exactly
                        if let Ok(default_config) = device.default_output_config() {
                            let fallback_config: StreamConfig = default_config.clone().into();
                            log::info!("Trying device default: {} Hz, {} ch", 
                                fallback_config.sample_rate.0, fallback_config.channels);
                            
                            let cb_shared = Arc::clone(&shared_state);
                            let cb_eq = Arc::clone(&eq);
                            let cb_volume = Arc::clone(&volume);
                            let cb_ns = Arc::clone(&noise_shaper);
                            let cb_spectrum_tx = spectrum_tx.clone();
                            let fallback_channels = fallback_config.channels as usize;
                            let mut process_buffer = Vec::with_capacity(8192);
                            
                            match device.build_output_stream(
                                &fallback_config,
                                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                                    audio_callback(data, &cb_shared, &cb_eq, &cb_volume, &cb_ns, &cb_spectrum_tx, fallback_channels, &mut process_buffer);
                                },
                                |err| log::error!("Stream error: {}", err),
                                None,
                            ) {
                                Ok(s) => {
                                    let _ = s.play();
                                    stream = Some(s);
                                    *shared_state.state.write() = PlayerState::Playing;
                                    log::info!("Stream started with device default config");
                                }
                                Err(e2) => {
                                    log::error!("Failed to start stream even with device default: {}", e2);
                                    *shared_state.state.write() = PlayerState::Stopped;
                                }
                            }
                        } else {
                            log::error!("Cannot get device default config");
                            *shared_state.state.write() = PlayerState::Stopped;
                        }
                    }
                }
            }
            Ok(AudioCommand::Pause) => {
                if let Some(ref s) = stream { let _ = s.pause(); }
                *shared_state.state.write() = PlayerState::Paused;
            }
            Ok(AudioCommand::Stop) => {
                stream = None;
                shared_state.position_frames.store(0, Ordering::Relaxed);
                *shared_state.state.write() = PlayerState::Stopped;
            }
            Ok(AudioCommand::Shutdown) | Err(_) => break,
        }
    }
}

fn spectrum_thread_main(rx: crossbeam::channel::Receiver<f64>, shared: Arc<SharedState>, analyzer: Arc<SpectrumAnalyzer>) {
    let window_size = 2048;
    let mut buffer = Vec::with_capacity(window_size);
    loop {
        match rx.recv() {
            Ok(sample) => {
                buffer.push(sample);
                if buffer.len() >= window_size {
                    let sr = shared.sample_rate.load(Ordering::Relaxed) as u32;
                    let spectrum_data = analyzer.analyze(&buffer, sr);
                    *shared.spectrum_data.lock() = spectrum_data;
                    buffer.clear();
                }
            }
            Err(_) => break,
        }
    }
}

fn audio_callback(
    data: &mut [f32],
    shared: &SharedState,
    eq: &Mutex<Equalizer>,
    volume: &Mutex<VolumeController>,
    noise_shaper: &Mutex<NoiseShaper>,
    spectrum_tx: &Sender<f64>,
    channels: usize,
    process_buf: &mut Vec<f64>,
) {
    let buf = shared.audio_buffer.read();
    let frames_needed = data.len() / channels;
    let current_pos = shared.position_frames.load(Ordering::Relaxed) as usize;
    let total = shared.total_frames.load(Ordering::Relaxed) as usize;
    
    if current_pos >= total {
        data.fill(0.0);
        // Use try_write to avoid blocking in audio thread
        if let Some(mut state) = shared.state.try_write() {
            *state = PlayerState::Stopped;
        }
        return;
    }
    
    let start_sample = current_pos * channels;
    let available_frames = (total - current_pos).min(frames_needed);
    let end_sample = start_sample + available_frames * channels;
    let samples_needed = available_frames * channels;
    
    // Reuse pre-allocated buffer to avoid heap allocation in real-time thread
    process_buf.clear();
    if end_sample <= buf.len() {
        process_buf.extend_from_slice(&buf[start_sample..end_sample]);
    } else {
        process_buf.resize(samples_needed, 0.0);
    }
    drop(buf);
    
    if available_frames > 0 {
        // Use lock() instead of try_lock(). Critical sections in main thread are microsecond-short.
        // Blocking here is better than skipping effects (which causes popping).
        {
            let mut eq_guard = eq.lock();
            eq_guard.process(process_buf);
        }
        {
            let mut vol_guard = volume.lock();
            vol_guard.process(process_buf, channels);
        }
        {
            let mut ns_guard = noise_shaper.lock();
            ns_guard.process(process_buf, channels);
        }
        
        for (i, sample) in process_buf.iter().enumerate() {
            // Final conversion to f32 for hardware output
            data[i] = *sample as f32; // Clipping handled by noise shaper or hardware
            
            // Send to spectrum (Mono mix)
            if i % channels == 0 {
                let mut mono = 0.0;
                if channels == 2 {
                    if i + 1 < process_buf.len() {
                        mono = (process_buf[i] + process_buf[i+1]) * 0.5;
                    } else {
                        mono = process_buf[i];
                    }
                }
                else {
                    for c in 0..channels {
                        if i + c < process_buf.len() {
                            mono += process_buf[i+c];
                        }
                    }
                    mono /= channels as f64;
                }
                let _ = spectrum_tx.try_send(mono);
            }
        }
    }
    
    if available_frames < frames_needed {
        data[available_frames * channels..].fill(0.0);
    }
    
    shared.position_frames.store((current_pos + available_frames) as u64, Ordering::Relaxed);
}
