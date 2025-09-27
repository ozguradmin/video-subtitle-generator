const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// Gemini AI Yapılandırması
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function generateSubtitles(videoPath) {
    // Test için mock altyazılar döndür
    console.log('🤖 Mock altyazılar oluşturuluyor...');
    return [
        { speaker: "Test Konuşmacı", startTime: 0.0, endTime: 2.5, line: "Merhaba, bu bir test videosudur." },
        { speaker: "Test Konuşmacı", startTime: 3.0, endTime: 6.0, line: "Altyazı yakma işlemi test ediliyor." }
    ];
}

// Font dosya yolları
const fontPaths = {
    'Roboto': path.join(__dirname, '..', 'public', 'fonts', 'Roboto-Regular.ttf'),
    'Avenir': path.join(__dirname, '..', 'public', 'fonts', 'Avenir.otf')
};

// FFmpeg path'ini ayarla
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

// Multer konfigürasyonu
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, os.tmpdir())
    },
    filename: function (req, file, cb) {
        const uniqueId = uuidv4();
        cb(null, `input_${uniqueId}.mp4`)
    }
});
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
async function burnSubtitles(videoPath, subtitles, selectedStyle, speakerColors) {
    let logs = [];
    const tempDir = os.tmpdir();
    const uniqueId = uuidv4();
    const inputPath = videoPath;
    const outputFilename = `subtitled_video_${Date.now()}.mp4`;
    const outputPath = path.join(tempDir, outputFilename);

    return new Promise((resolve, reject) => {
        let command;
        try {
            const {
                fontFamily = 'Roboto',
                fontSize = 44,
                verticalPosition = 255,
                italic = false,
                reelsWidth = 80,
                reelsMargin = 20,
                lineSpacing = 5,
                textAlign = 'center',
                effects = { shadow: true, outline: true, background: 'black@0.5' }
            } = selectedStyle;

            const fontPath = fontPaths[fontFamily];
            if (!fontPath || !fs.existsSync(fontPath)) {
                throw new Error(`Font dosyası bulunamadı: ${fontFamily} (${fontPath})`);
            }
            
            logs.push(`✅ ${fontFamily} fontu kullanılıyor: ${fontPath}`);
            logs.push('🔵 MODE: drawtext (doğrudan font dosyası ile)');
            logs.push(`📏 Stil Parametreleri: Font Boyutu=${fontSize}, Dikey Konum=${verticalPosition}, İtalik=${italic}`);
            logs.push(`📐 Reels Ayarları: Genişlik=${reelsWidth}%, Kenar=${reelsMargin}px, Satır Arası=${lineSpacing}px, Hizalama=${textAlign}`);
            
            const shadow = effects.shadow !== false;
            const outline = effects.outline !== false;
            const background = effects.background || 'black@0.5';
            logs.push(`🎨 Efektler: Gölge=${shadow}, Kontur=${outline}, Arka Plan=${background}`);
            logs.push(`🎭 Konuşmacı Renkleri: ${JSON.stringify(speakerColors)}`);

            const videoResizingFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black';
                
            let drawtextFilters = [];
            subtitles.forEach((sub, index) => {
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
                    xPosition = reelsMargin;
                } else if (textAlign === 'right') {
                    xPosition = `w-${reelsMargin}-text_w`;
                } else { // center
                    xPosition = `(w-text_w)/2`;
                }

                // Arka plan rengi ve şeffaflığı
                const [bgColorName, bgOpacityValue] = (background || 'black@0.5').split('@');
                const bgColor = hexToDrawtext(bgColorName);
                const bgOpacity = Math.round((parseFloat(bgOpacityValue) || 0.5) * 255).toString(16).padStart(2, '0');
                const bgColorWithOpacity = `${bgColor}${bgOpacity}`;
                
                // Gölge ve kontur efektleri
                let effectsStr = '';
                if (shadow) {
                    const shadowOffset = effects.shadowOffset || 2;
                    effectsStr += `:shadowcolor=black@0.8:shadowx=${shadowOffset}:shadowy=${shadowOffset}`;
                }
                if (outline) {
                    const outlineWidth = effects.outlineWidth || 2;
                    effectsStr += `:borderw=${outlineWidth}:bordercolor=black`;
                }

                logs.push(`🎨 Altyazı ${index + 1}: "${sub.speaker}" - Renk: ${color} (${ffmpegColor}) - Boyut: ${fontSize} - Konum: ${verticalPosition} - Hizalama: ${textAlign}`);

                drawtextFilters.push(
                    `drawtext=text='${text}':fontfile='${fontPath}':fontsize=${fontSize}:fontcolor=${ffmpegColor}:x=${xPosition}:y=h-th-${verticalPosition}:line_spacing=${lineSpacing}:box=1:boxcolor=${bgColorWithOpacity}:boxborderw=5${effectsStr}:enable='between(t,${sub.startTime},${sub.endTime})'`
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


// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Ana upload endpoint'i
app.post('/api/upload', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Video dosyası bulunamadı.' });
    }

    const videoPath = req.file.path;

    try {
        const subtitles = await generateSubtitles(videoPath);
        const speakerColors = {}; // Placeholder, actual colors will be determined by generateSubtitles
        const selectedStyle = {
            fontFamily: 'Roboto',
            fontSize: 44,
            verticalPosition: 255,
            italic: false,
            reelsWidth: 80,
            reelsMargin: 20,
            lineSpacing: 5,
            textAlign: 'center',
            effects: { shadow: true, outline: true, background: 'black@0.5' }
        };

        const { outputBuffer, logs, filename } = await burnSubtitles(videoPath, subtitles, selectedStyle, speakerColors);

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.send(outputBuffer);

    } catch (error) {
        console.error('Upload process error:', error);
        res.status(500).json({ error: error.message, logs: error.logs || [] });
    } finally {
        try {
            if (fs.existsSync(videoPath)) {
                fs.unlinkSync(videoPath);
            }
        } catch (e) {
            console.error('Error deleting temp video file:', e);
        }
    }
});

// Ana sayfa
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Video Subtitle Generator</title>
            <meta charset="utf-8">
        </head>
        <body>
            <h1>Video Subtitle Generator API</h1>
            <p>API çalışıyor! Video yüklemek için POST /api/upload endpoint'ini kullanın.</p>
            <p>Font dosyaları:</p>
            <ul>
                <li>Roboto: ${fontPaths.Roboto} - ${fs.existsSync(fontPaths.Roboto) ? '✅ Mevcut' : '❌ Bulunamadı'}</li>
                <li>Avenir: ${fontPaths.Avenir} - ${fs.existsSync(fontPaths.Avenir) ? '✅ Mevcut' : '❌ Bulunamadı'}</li>
            </ul>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda çalışıyor`);
    console.log(`📁 Font dosyaları kontrol ediliyor...`);
    console.log(`Roboto: ${fontPaths.Roboto} - ${fs.existsSync(fontPaths.Roboto) ? '✅' : '❌'}`);
    console.log(`Avenir: ${fontPaths.Avenir} - ${fs.existsSync(fontPaths.Avenir) ? '✅' : '❌'}`);
});

module.exports = app;
