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
async function burnSubtitles(videoPath, subtitles, selectedStyle, speakerColors) {
    return new Promise(async (resolve, reject) => {
        const logs = [];
        try {
            const { 
                fontSize = 50, 
                marginV = 300, 
                italic = false, 
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
                backgroundOpacity = 0.5,
                animationStyle = 'none' // Animasyon stili eklendi
            } = selectedStyle;

            const fontFile = fontPaths[fontFamily] || fontPaths['Roboto'];
            logs.push(`📁 ${fontFamily} fontu kullanılıyor: ${fontFile}`);

            let complexFilter = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black`;
            
            subtitles.forEach((sub, index) => {
                const speaker = sub.speaker || 'Konuşmacı 1';
                const color = speakerColors[speaker] || 'yellow'; // Varsayılan sarı
                const fontColor = `0x${color.replace('#', '')}`;
                
                const escapedLine = escapeTextForFfmpeg(sub.line);
                let drawtextFilter = `drawtext=text='${escapedLine}':fontfile='${fontFile}':fontsize=${fontSize}:fontcolor=${fontColor}:x=(w-text_w)/2:y=h-th-${marginV}:line_spacing=${lineSpacing}:box=1:boxcolor=${backgroundColor}@${backgroundOpacity}:boxborderw=5`;

                if (shadow) {
                    drawtextFilter += `:shadowcolor=black@0.8:shadowx=${shadowOffset}:shadowy=${shadowOffset}`;
                }
                if (outline) {
                    drawtextFilter += `:borderw=${outlineWidth}:bordercolor=black`;
                }
                
                if (animationStyle === 'fadeIn') {
                    const fadeInDuration = 0.5; // saniye
                    drawtextFilter += `:alpha='if(lt(t,${sub.startTime}),0,if(lt(t,${sub.startTime}+${fadeInDuration}),(t-${sub.startTime})/${fadeInDuration},if(lt(t,${sub.endTime}),1,0)))'`;
                } else {
                    drawtextFilter += `:enable='between(t,${sub.startTime},${sub.endTime})'`;
                }

                complexFilter += `,${drawtextFilter}`;
            });

            const outputFilename = `subtitled_video_${Date.now()}.mp4`;
            const outputPath = path.join(os.tmpdir(), outputFilename);

            logs.push(`🔧 Oluşturulan FFmpeg Filtresi: ${complexFilter.substring(0, 200)}...`);

            const command = ffmpeg(videoPath)
                .videoFilter(complexFilter)
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
                            fs.unlinkSync(videoPath);
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
                        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
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
        
        // Gerçek AI Altyazı Oluşturma
        const subtitles = await generateSubtitles(inputPath);

        console.log('✅ AI yanıtı başarıyla JSON olarak ayrıştırıldı.');
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
        
        console.log('✅ Altyazı yakma işlemi tamamlandı');
        console.log(`📊 İşlem logları: ${result.logs.length} adet`);

        // Başarılı yanıt
                res.json({ 
                    success: true, 
            message: 'Video başarıyla işlendi',
            filename: result.filename,
            logs: result.logs,
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
