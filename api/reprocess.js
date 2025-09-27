const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Font dosya yolları
const fontPaths = {
    'Roboto': path.join(__dirname, '..', 'public', 'fonts', 'Roboto-Regular.ttf'),
    'Avenir': path.join(__dirname, '..', 'public', 'fonts', 'Avenir.otf')
};

// FFmpeg path'ini ayarla
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

// Multer konfigürasyonu
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

app.use(express.json());

// Hex renk formatını FFmpeg drawtext formatına çeviren fonksiyon
function hexToDrawtext(hexColor) {
    if (!hexColor) return 'white';
    
    // Özel renk isimlerini hex'e çevir
    const colorMap = {
        'white': 'FFFFFF',
        'black': '000000',
        'yellow': 'FFFF00',
        'red': 'FF0000',
        'green': '00FF00',
        'blue': '0000FF',
        'cyan': '00FFFF',
        'magenta': 'FF00FF'
    };
    
    let hex = hexColor.replace('#', '').toUpperCase();
    
    // Renk ismi varsa hex'e çevir
    if (colorMap[hexColor.toLowerCase()]) {
        hex = colorMap[hexColor.toLowerCase()];
    }
    
    // Kısa formatı uzun formata çevir (#FFF -> #FFFFFF)
    if (hex.length === 3) {
        hex = hex.split('').map(char => char + char).join('');
    }
    
    // FFmpeg drawtext formatına çevir (0xRRGGBB)
    return `0x${hex}`;
}

// FFmpeg için metin escape etme fonksiyonu
function escapeTextForFfmpeg(text) {
    if (typeof text !== 'string') {
        return '';
    }
    // Önce ters eğik çizgileri temizle, sonra özel karakterleri escape et
    return text
        .replace(/\\/g, '') // Mevcut ters eğik çizgileri kaldır
        .replace(/'/g, "'\\\\\\''") // Tek tırnakları escape et
        .replace(/:/g, '\\\\:') // İki nokta üst üste işaretini escape et
        .replace(/%/g, '\\\\%'); // Yüzde işaretini escape et
}

// Altyazı yakma fonksiyonu
async function burnSubtitles(videoBuffer, subtitlesData, options = {}) {
    const { 
        fontFile = null, 
        fontSize = 28, 
        marginV = 120, 
        italic = false, 
        speakerColors = {},
        fontFamily = 'Roboto',
        maxWidth = 80,
        marginH = 20,
        lineSpacing = 5,
        textAlign = 'center',
        shadow = true,
        outline = true,
        outlineWidth = 2,
        shadowOffset = 2,
        backgroundColor = 'black',
        backgroundOpacity = 0.5
    } = options;
    
    const logs = [];
    const tempDir = os.tmpdir();
    const uniqueId = uuidv4();
    const inputPath = path.join(tempDir, `input_${uniqueId}.mp4`);
    const outputFilename = `subtitled_video_${Date.now()}.mp4`;
    const outputPath = path.join(tempDir, outputFilename);

    fs.writeFileSync(inputPath, videoBuffer);

    return new Promise((resolve, reject) => {
        let command;
        let assPath = null; // drawtext kullandığımız için artık assPath'e gerek yok

        try {
            // Font dosyasını kontrol et
            const fontPath = fontPaths[fontFamily];
            if (!fontPath || !fs.existsSync(fontPath)) {
                throw new Error(`Font dosyası bulunamadı: ${fontFamily} (${fontPath})`);
            }
            
            logs.push(`📁 ${fontFamily} fontu kullanılıyor: ${fontPath}`);
            logs.push('🔵 MODE: drawtext (doğrudan font dosyası ile)');
            logs.push(`📏 Stil Parametreleri: Font Boyutu=${fontSize}, Dikey Konum=${marginV}, İtalik=${italic}`);
            logs.push(`📐 Reels Ayarları: Genişlik=${maxWidth}%, Kenar=${marginH}px, Satır Arası=${lineSpacing}px, Hizalama=${textAlign}`);
            logs.push(`🎨 Efektler: Gölge=${shadow}, Kontur=${outline}, Arka Plan=${backgroundColor}@${backgroundOpacity}`);
            logs.push(`🎭 Konuşmacı Renkleri: ${JSON.stringify(speakerColors)}`);

            const videoResizingFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black';
            
            let drawtextFilters = [];
            subtitlesData.subtitles.forEach((sub, index) => {
                const text = escapeTextForFfmpeg(sub.line);
                
                // Renk belirleme: overrideColor > speakerColors > varsayılan
                let color = 'white';
                if (sub.overrideColor) {
                    color = sub.overrideColor;
                } else if (speakerColors[sub.speaker]) {
                    color = speakerColors[sub.speaker];
                } else {
                    // Varsayılan renk paleti
                    const defaultColors = ['yellow', 'white', 'cyan', 'magenta', 'green'];
                    const speakerIndex = parseInt(sub.speaker.replace(/\D/g, '')) - 1;
                    color = defaultColors[speakerIndex] || 'yellow';
                }
                
                // Hex renk formatını FFmpeg formatına çevir
                const ffmpegColor = hexToDrawtext(color);
                
                // Hizalama pozisyonu hesapla
                let xPosition;
                if (textAlign === 'left') {
                    xPosition = marginH;
                } else if (textAlign === 'right') {
                    xPosition = `w-${marginH}-text_w`;
                } else { // center
                    xPosition = `(w-text_w)/2`;
                }
                
                // Arka plan rengi ve şeffaflığı
                const bgColor = hexToDrawtext(backgroundColor);
                const bgOpacity = Math.round(backgroundOpacity * 255).toString(16).padStart(2, '0');
                const bgColorWithOpacity = `${bgColor}${bgOpacity}`;
                
                // Gölge ve kontur efektleri
                let effects = '';
                if (shadow) {
                    effects += `:shadowcolor=black@0.8:shadowx=${shadowOffset}:shadowy=${shadowOffset}`;
                }
                if (outline) {
                    effects += `:borderw=${outlineWidth}:bordercolor=black`;
                }
                
                // Metin sarmalama için genişlik hesapla
                const textWidth = `w*${maxWidth}/100-${marginH*2}`;
                
                logs.push(`🎨 Altyazı ${index + 1}: "${sub.speaker}" - Renk: ${color} (${ffmpegColor}) - Boyut: ${fontSize} - Konum: ${marginV} - Hizalama: ${textAlign}`);
                
                drawtextFilters.push(
                    `drawtext=text='${text}':fontfile='${fontPath}':fontsize=${fontSize}:fontcolor=${ffmpegColor}:x=${xPosition}:y=h-th-${marginV}:line_spacing=${lineSpacing}:box=1:boxcolor=${bgColorWithOpacity}:boxborderw=5${effects}:enable='between(t,${sub.startTime},${sub.endTime})'`
                );
            });

            const fullFilter = `${videoResizingFilter},${drawtextFilters.join(',')}`;
            logs.push(`🔧 Oluşturulan FFmpeg Filtresi: ${fullFilter.substring(0, 200)}...`);

            command = ffmpeg(inputPath)
                .videoFilter(fullFilter);

            command
                .output(outputPath)
                .outputOptions([
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-crf', '28',
                    '-c:a', 'aac',
                    '-b:a', '96k',
                    '-movflags', '+faststart'
                ])
                .on('start', (commandLine) => {
                    logs.push('🚀 FFmpeg komutu çalıştırılıyor:');
                    logs.push(commandLine);
                    logs.push('⏱️ İşlem başladı, lütfen bekleyin...');
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        logs.push(`⏳ İlerleme: %${Math.round(progress.percent)}`);
                    }
                    if (progress.frames) {
                        logs.push(`🎬 İşlenen frame sayısı: ${progress.frames}`);
                    }
                    if (progress.currentFps) {
                        logs.push(`📊 Mevcut FPS: ${progress.currentFps}`);
                    }
                })
                .on('stderr', (stderrLine) => {
                    logs.push(`🔍 FFmpeg stderr: ${stderrLine}`);
                })
                .on('stdout', (stdoutLine) => {
                    logs.push(`📤 FFmpeg stdout: ${stdoutLine}`);
                })
                .on('end', () => {
                    logs.push('✅ Altyazı yakma işlemi başarıyla tamamlandı.');
                    
                    // Output dosyasını kontrol et
                    try {
                        const outputStats = fs.statSync(outputPath);
                        logs.push(`📁 Output dosya boyutu: ${outputStats.size} bytes`);
                        
                        const outputBuffer = fs.readFileSync(outputPath);
                        logs.push(`✅ Output buffer okundu: ${outputBuffer.length} bytes`);
                        
                        // Temp dosyaları temizle
                        try {
                            fs.unlinkSync(inputPath);
                            fs.unlinkSync(outputPath);
                            logs.push('🗑️ Temp dosyalar temizlendi');
                        } catch (e) {
                            logs.push('⚠️ Temp dosya temizleme hatası: ' + e.message);
                        }
                        
                        resolve({ 
                            outputBuffer, 
                            logs,
                            filename: outputFilename
                        });
                    } catch (e) {
                        logs.push(`❌ Output dosya okuma hatası: ${e.message}`);
                        reject({ error: e, logs });
                    }
                })
                .on('error', (err, stdout, stderr) => {
                    const errorMsg = '❌ FFmpeg hatası: ' + err.message;
                    logs.push(errorMsg);
                    logs.push('--- FFmpeg Hata Detayı (stdout) ---');
                    logs.push(stdout || 'stdout boş');
                    logs.push('--- FFmpeg Hata Detayı (stderr) ---');
                    logs.push(stderr || 'stderr boş');
                    logs.push('--- FFmpeg Error Object ---');
                    logs.push(`Name: ${err.name}`);
                    logs.push(`Message: ${err.message}`);
                    logs.push(`Code: ${err.code}`);
                    logs.push(`Signal: ${err.signal}`);
                    logs.push('------------------------------------');
                    
                    // Temp dosyaları temizle
                    try {
                        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                        logs.push('🗑️ Temp dosyalar temizlendi (hata durumunda)');
                    } catch (e) {
                        logs.push('⚠️ Temp dosya temizleme hatası: ' + e.message);
                    }
                    
                    reject({ error: err, logs });
                });
            
            command.run();

        } catch (error) {
            logs.push(`❌ Altyazı hazırlığında hata: ${error.message}`);
            reject({ error, logs });
        }
    });
}

// Reprocess endpoint
app.post('/api/reprocess', upload.single('video'), async (req, res) => {
    console.log('🔄 Video yeniden işleniyor...');
    
    if (!req.file) {
        return res.status(400).json({ error: 'Video dosyası bulunamadı' });
    }

    try {
        const { subtitlesData, options } = req.body;
        
        if (!subtitlesData || !subtitlesData.subtitles) {
            return res.status(400).json({ error: 'Altyazı verisi bulunamadı' });
        }

        console.log('🎨 Gönderilen stil ayarları:');
        console.log(`   Font Boyutu: ${options?.fontSize || 28}, Dikey Konum: ${options?.marginV || 120}, İtalik: ${options?.italic || false}`);
        console.log(`   Metin Genişliği: ${options?.maxWidth || 80}%, Kenar Boşluğu: ${options?.marginH || 20}px, Satır Arası: ${options?.lineSpacing || 5}px`);
        console.log(`   Hizalama: ${options?.textAlign || 'center'}, Gölge: ${options?.shadow !== false}, Kontur: ${options?.outline !== false}`);
        console.log(`   Arka Plan: ${options?.backgroundColor || 'black'}@${options?.backgroundOpacity || 0.5}`);
        console.log(`   Konuşmacı Renkleri: ${JSON.stringify(options?.speakerColors || {})}`);

        const result = await burnSubtitles(req.file.buffer, subtitlesData, options);
        
        console.log('✅ Video yeniden işleme tamamlandı');
        console.log(`📊 İşlem logları: ${result.logs.length} adet`);
                
                res.json({ 
                    success: true, 
            message: 'Video başarıyla yeniden işlendi',
            filename: result.filename,
            logs: result.logs,
            videoBuffer: result.outputBuffer.toString('base64')
        });

    } catch (error) {
        console.error('❌ Reprocess hatası:', error.message);
        console.error(`[${new Date().toISOString()}] [error] Reprocess hatası:`, error);
        
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Video yeniden işlenirken hata oluştu',
            logs: error.logs || []
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`🚀 Reprocess Server ${PORT} portunda çalışıyor`);
    console.log(`📁 Font dosyaları kontrol ediliyor...`);
    console.log(`Roboto: ${fontPaths.Roboto} - ${fs.existsSync(fontPaths.Roboto) ? '✅' : '❌'}`);
    console.log(`Avenir: ${fontPaths.Avenir} - ${fs.existsSync(fontPaths.Avenir) ? '✅' : '❌'}`);
});

module.exports = app;
