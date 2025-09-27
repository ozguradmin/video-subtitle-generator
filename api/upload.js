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
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

    const prompt = "Bu videodaki konuşmaları analiz et ve altyazıları Türkçe'ye çevirerek JSON formatında oluştur. Her bir altyazı için başlangıç ve bitiş zamanları (saniye cinsinden) ile birlikte olmalı. Sadece JSON çıktısı ver, başka hiçbir metin ekleme. Format şu şekilde olmalı: { \"subtitles\": [ { \"speaker\": \"Konuşmacı 1\", \"startTime\": 0.0, \"endTime\": 2.5, \"line\": \"Türkçe metin...\" } ] }";
    
    const videoBytes = fs.readFileSync(videoPath);
    const videoBuffer = Buffer.from(videoBytes).toString("base64");

    const file = {
        inlineData: {
            data: videoBuffer,
            mimeType: "video/mp4",
        },
    };

    const result = await model.generateContent([prompt, file]);
    const response = await result.response;
    const text = await response.text();
    
    // Temizleme ve JSON'a dönüştürme
    const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanedText).subtitles;
}

// Belirtilen sürede bir video parçası oluşturan fonksiyon
async function createVideoChunk(inputPath, outputPath, startTime, duration) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(duration)
            .outputOptions('-c', 'copy') // Re-encoding yapmadan kopyala
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .run();
    });
}


// Videonun süresini getiren fonksiyon
async function getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                return reject(err);
            }
            resolve(metadata.format.duration);
        });
    });
}


// Gemini API'ye istek atan ve tekrar deneyen fonksiyon
async function generateSubtitlesWithRetry(videoPath, logs, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await generateSubtitles(videoPath);
        } catch (error) {
            logs.push(`❌ Gemini API Hatası (Deneme ${attempt}/${maxRetries}): ${error.message}`);
            if (attempt < maxRetries) {
                logs.push(`⏳ 3 saniye sonra tekrar denenecek...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                logs.push(`🚨 Tüm denemeler başarısız oldu.`);
                throw error;
            }
        }
    }
}

// Ana altyazı oluşturma ve birleştirme fonksiyonu
async function processVideoAndGenerateSubtitles(inputPath, logs) {
    const CHUNK_DURATION_SECONDS = 58; // Gemini limiti ~1dk, güvenli tarafta kalalım
    const totalDuration = await getVideoDuration(inputPath);
    logs.push(`ℹ️ Video süresi: ${totalDuration.toFixed(2)} saniye`);

    if (totalDuration <= CHUNK_DURATION_SECONDS) {
        logs.push(`🤖 Video tek parça halinde işleniyor...`);
        return await generateSubtitlesWithRetry(inputPath, logs);
    }

    // Videoyu parçalara ayır ve işle
    const numChunks = Math.ceil(totalDuration / CHUNK_DURATION_SECONDS);
    logs.push(`🔪 Video ${numChunks} parçaya bölünüyor...`);
    
    let allSubtitles = [];
    for (let i = 0; i < numChunks; i++) {
        const startTime = i * CHUNK_DURATION_SECONDS;
        const duration = Math.min(CHUNK_DURATION_SECONDS, totalDuration - startTime);
        const chunkPath = path.join(os.tmpdir(), `chunk-${i}-${uuidv4()}.mp4`);
        
        logs.push(`[${i+1}/${numChunks}] 🎬 Parça oluşturuluyor: ${startTime}s - ${startTime+duration}s`);
        await createVideoChunk(inputPath, chunkPath, startTime, duration);

        try {
            logs.push(`[${i+1}/${numChunks}] 🤖 Parça için altyazı oluşturuluyor...`);
            const chunkSubtitles = await generateSubtitlesWithRetry(chunkPath, logs);

            // Zaman kodlarını ayarla
            const adjustedSubtitles = chunkSubtitles.map(sub => ({
                ...sub,
                startTime: sub.startTime + startTime,
                endTime: sub.endTime + startTime
            }));

            allSubtitles = allSubtitles.concat(adjustedSubtitles);
            logs.push(`[${i+1}/${numChunks}] ✅ Parça başarıyla işlendi.`);

        } finally {
            // Geçici chunk dosyasını sil
            if (fs.existsSync(chunkPath)) {
                fs.unlinkSync(chunkPath);
            }
        }
    }

    logs.push(`🧩 Tüm altyazılar birleştirildi.`);
    return allSubtitles;
}

// Font dosya yolları
const fontPaths = {
    'Roboto': path.join(__dirname, '..', 'public', 'fonts', 'Roboto-Regular.ttf'),
    'Avenir': path.join(__dirname, '..', 'public', 'fonts', 'Avenir.otf')
};

// FFmpeg path'ini ayarla
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

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

// Metni belirli bir karakter sayısına göre saran fonksiyon
function wrapText(text, maxCharsPerLine = 35) {
    if (typeof text !== 'string') {
        return '';
    }
    const words = text.split(' ');
    let lines = [];
    let currentLine = '';

    words.forEach(word => {
        // Kelimenin kendisi satırdan uzunsa, onu bile böl
        if (word.length > maxCharsPerLine) {
            if (currentLine.length > 0) {
                lines.push(currentLine);
            }
            let wordPart = word;
            while (wordPart.length > maxCharsPerLine) {
                lines.push(wordPart.substring(0, maxCharsPerLine));
                wordPart = wordPart.substring(maxCharsPerLine);
            }
            currentLine = wordPart;
        } else if ((currentLine + ' ' + word).trim().length > maxCharsPerLine && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = word;
        } else {
            if (currentLine.length === 0) {
                currentLine = word;
            } else {
                currentLine += ' ' + word;
            }
        }
    });
    lines.push(currentLine);
    return lines.join('\\n'); // FFmpeg için newline karakteri
}

// Altyazı yakma fonksiyonu
async function burnSubtitles(videoPath, subtitles, options = {}, speakerColors = {}) {
    const logs = [];
    const {
        fontName = 'Roboto',
        fontSize = 50,
        marginV = 300,
        italic = false
    } = options;

    const fontFile = fontPaths[fontName] || fontPaths['Roboto'];
    const fontPath = fontFile.replace(/\\/g, '/');
    logs.push(`📁 ${fontName} fontu kullanılıyor: ${fontPath}`);
    logs.push(`📏 Stil Parametreleri: Font Boyutu=${fontSize}, Dikey Konum=${marginV}, İtalik=${italic}`);

    const outputFilename = `subtitled_${uuidv4()}.mp4`;
    const outputPath = path.join(os.tmpdir(), outputFilename);

    const videoResizingFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black';
    
    const allDrawtextFilters = [];

    if (!subtitles || !Array.isArray(subtitles) || subtitles.length === 0) {
        logs.push('⚠️ Altyazı bulunamadı, sadece video resize yapılıyor');
    } else {
        logs.push(`📝 ${subtitles.length} adet altyazı işleniyor...`);
        subtitles.forEach((sub) => {
            const maxChars = Math.floor((50 / fontSize) * 25); // Daha hassas metin sarma
            const lines = wrapText(sub.line, maxChars).split('\\n');
            const numLines = lines.length;

            const start = Math.max(0, Number(sub.startTime) || 0);
            const end = Math.max(start + 0.01, Number(sub.endTime) || start + 0.01);
            
            let color = speakerColors[sub.speaker] || 'yellow';
            if (sub.overrideColor) {
                color = sub.overrideColor;
            }

            lines.forEach((line, lineIndex) => {
                const text = escapeTextForFfmpeg(line);
                if (!text) return;

                const yPos = `h - ${marginV} - (${numLines - 1 - lineIndex}) * ${fontSize} * 1.2`;
                
                allDrawtextFilters.push(
                    `drawtext=fontfile='${fontPath}':text='${text}':fontsize=${fontSize}:fontcolor=${color}:x=(w-text_w)/2:y=${yPos}:box=1:boxcolor=black@0.5:boxborderw=10:shadowcolor=black@0.8:shadowx=2:shadowy=2:borderw=2:bordercolor=black:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`
                );
            });
        });
    }

    const finalFilter = [videoResizingFilter, ...allDrawtextFilters].join(',');

    return new Promise((resolve, reject) => {
        const command = ffmpeg(videoPath)
            .videoFilter(finalFilter)
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
            .on('stderr', (stderrLine) => {
                // Sadece önemli logları tut, progress loglarını atla
                if (!stderrLine.includes('frame=') && !stderrLine.includes('size=')) {
                    logs.push(`🔍 FFmpeg stderr: ${stderrLine}`);
                }
            })
            .on('end', () => {
                logs.push('✅ Altyazı yakma işlemi başarıyla tamamlandı.');
                try {
                    const outputBuffer = fs.readFileSync(outputPath);
                    fs.unlinkSync(outputPath); // Geçici dosyayı sil
                    resolve({ outputBuffer, logs, filename: outputFilename });
                } catch (e) {
                    logs.push(`❌ Output dosya okuma/silme hatası: ${e.message}`);
                    reject({ error: e, logs });
                }
            })
            .on('error', (err, stdout, stderr) => {
                logs.push('❌ FFmpeg hatası: ' + err.message);
                if (stdout) logs.push('--- FFmpeg STDOUT ---', stdout);
                if (stderr) logs.push('--- FFmpeg STDERR ---', stderr);
                reject({ error: err, logs });
            })
            .save(outputPath);
    });
}


// Ana upload endpoint'i
app.post('/api/upload', upload.single('video'), async (req, res) => {
    console.log('--- Video Yükleme İsteği Aldı ---');
    
    if (!req.file) {
        return res.status(400).json({ error: 'Video dosyası bulunamadı' });
    }

    console.log(`📁 Dosya yüklendi: ${req.file.originalname} (${req.file.size} bytes)`);

    try {
        // Video dosyasını geçici olarak kaydet
        const tempDir = os.tmpdir();
        const uniqueId = uuidv4();
        const inputPath = path.join(tempDir, `input_${uniqueId}.mp4`);
        
        fs.writeFileSync(inputPath, req.file.buffer);
        console.log(`✅ Video geçici dosya olarak kaydedildi: ${inputPath}`);

        // AI'dan altyazı oluşturma simülasyonu
        console.log('🤖 AI\'a video analizi için istek gönderiliyor...');
        const logs = [];
        
        // Gerçek AI Altyazı Oluşturma (Parçalama ve Tekrar Deneme ile)
        const subtitles = await processVideoAndGenerateSubtitles(inputPath, logs);

        console.log('✅ Yapay zekadan altyazılar başarıyla oluşturuldu.');

        // Stil ayarları
        const selectedStyle = {
                    fontSize: 50,
                    marginV: 300,
                    italic: false,
                    fontFamily: 'Roboto',
                    maxWidth: 80,
                    marginH: 20,
                    lineSpacing: 5,
                    textAlign: 'center',
                    shadow: true,
                    outline: true,
                    outlineWidth: 2,
                    shadowOffset: 2,
                    backgroundColor: 'black',
                    backgroundOpacity: 0.5
        };

        const speakerColors = {};

        console.log('Altyazı yakma işlemi başlıyor...');

        // Altyazı yakma işlemini başlat
        const result = await burnSubtitles(inputPath, subtitles, selectedStyle, speakerColors);
        
        // Başlangıç loglarını result.logs'un başına ekle
        const finalLogs = logs.concat(result.logs);

        console.log('✅ Altyazı yakma işlemi tamamlandı');
        console.log(`📊 İşlem logları: ${finalLogs.length} adet`);

        // Başarılı yanıt
                res.json({ 
                    success: true, 
            message: 'Video başarıyla işlendi',
            filename: result.filename,
            logs: finalLogs,
            videoBuffer: result.outputBuffer.toString('base64'),
            subtitles: { subtitles: subtitles } // Oluşturulan altyazıları ekle
        });

    } catch (error) {
        console.error('❌ Genel Hata:', error.message);
        console.error('[17:38:56] ❌ Hata: Video işlenirken hata oluştu');
        console.error(`[${new Date().toISOString()}] [error] İşleme hatası:`, error);
        
        res.status(500).json({ 
            success: false, 
            error: error.message || 'Video işlenirken hata oluştu',
            logs: error.logs || []
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
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
