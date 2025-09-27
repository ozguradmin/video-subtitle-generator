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
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Multer konfigürasyonu - Geçici dosyaya kaydet
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, os.tmpdir());
    },
    filename: (req, file, cb) => {
        cb(null, `upload_${uuidv4()}${path.extname(file.originalname)}`);
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
async function burnSubtitles(videoPath, subtitlesData, options = {}) {
    const logs = [];
    const {
        fontName = 'Roboto',
        fontSize = 50,
        marginV = 300,
        italic = false,
        speakerColors = {}
    } = options;

    const fontFile = fontPaths[fontName] || fontPaths['Roboto'];
    const fontPath = fontFile.replace(/\\/g, '/');
    logs.push(`📁 ${fontName} fontu kullanılıyor: ${fontPath}`);
    logs.push(`📏 Stil Parametreleri: Font Boyutu=${fontSize}, Dikey Konum=${marginV}, İtalik=${italic}`);
    
    const outputFilename = `subtitled_${uuidv4()}.mp4`;
    const outputPath = path.join(os.tmpdir(), outputFilename);

    const videoResizingFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black';
    
    const allDrawtextFilters = [];

    if (!subtitlesData.subtitles || !Array.isArray(subtitlesData.subtitles) || subtitlesData.subtitles.length === 0) {
        logs.push('⚠️ Altyazı bulunamadı, sadece video resize yapılıyor');
    } else {
        logs.push(`📝 ${subtitlesData.subtitles.length} adet altyazı işleniyor...`);
        subtitlesData.subtitles.forEach((sub) => {
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
                logs.push('🚀 FFmpeg komutu çalıştırılıyor (Yeniden İşleme):');
                logs.push(commandLine);
            })
            .on('stderr', (stderrLine) => {
                if (!stderrLine.includes('frame=') && !stderrLine.includes('size=')) {
                    logs.push(`🔍 FFmpeg stderr: ${stderrLine}`);
                }
            })
            .on('end', () => {
                logs.push('✅ Video yeniden işleme tamamlandı.');
                try {
                    const outputBuffer = fs.readFileSync(outputPath);
                    fs.unlinkSync(outputPath);
                    resolve({
                        outputBuffer,
                        logs,
                        filename: outputFilename,
                        subtitles: subtitlesData // Altyazıları da döndür
                    });
                } catch (e) {
                    logs.push(`❌ Output dosya okuma/silme hatası: ${e.message}`);
                    reject({ error: e, logs });
                }
            })
            .on('error', (err, stdout, stderr) => {
                logs.push('❌ FFmpeg hatası (Yeniden İşleme): ' + err.message);
                if (stdout) logs.push('--- FFmpeg STDOUT ---', stdout);
                if (stderr) logs.push('--- FFmpeg STDERR ---', stderr);
                reject({ error: err, logs });
            })
            .save(outputPath);
    });
}

// Reprocess endpoint
app.post('/api/reprocess', upload.single('video'), async (req, res) => {
    let inputPath = null;
    try {
        console.log('🔄 Video yeniden işleniyor...');
        
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Video dosyası bulunamadı' });
        }
        inputPath = req.file.path; // multer tarafından kaydedilen dosyanın yolu

        let { subtitles, selectedStyle, speakerColors } = req.body;

        // Gelen verileri doğru formatlara çevir
                const subtitlesData = JSON.parse(subtitles);
        const style = JSON.parse(selectedStyle);
        const colors = JSON.parse(speakerColors);

        if (!subtitlesData || !subtitlesData.subtitles) {
            return res.status(400).json({ success: false, message: 'Altyazı verisi bulunamadı' });
        }

        console.log('🎨 Gönderilen stil ayarları:');
        console.log(`   Font Ailesi: ${style.fontFamily}, Boyut: ${style.fontSize}, Dikey Konum: ${style.marginV}`);
        console.log('📝 Altyazı verisi:', JSON.stringify(subtitlesData, null, 2));
        
        // burnSubtitles fonksiyonuna doğru parametreleri gönder
        const result = await burnSubtitles(inputPath, subtitlesData, {
            ...style,
            speakerColors: colors
        });
        
        console.log('✅ Video yeniden işleme tamamlandı');
        console.log(`📊 İşlem logları: ${result.logs.length} adet`);
                
                res.json({ 
                    success: true, 
                    message: 'Video başarıyla yeniden işlendi',
                    filename: result.filename,
                    logs: result.logs,
                    videoBuffer: result.outputBuffer.toString('base64'),
                    subtitles: result.subtitles // Altyazıları da döndür
                });

    } catch (err) {
        const error = err.error || err; // Hata objesini normalleştir
        console.error(`[${new Date().toISOString()}] [error] Reprocess hatası:`, error.message);
        
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Video yeniden işlenirken hata oluştu',
            logs: err.logs || [`İç sunucu hatası: ${error.message}`]
        });
    } finally {
        // Geçici yüklenen video dosyasını temizle
        if (inputPath && fs.existsSync(inputPath)) {
            try {
                fs.unlinkSync(inputPath);
                console.log('🗑️ Geçici input dosyası temizlendi:', inputPath);
            } catch (e) {
                console.error('⚠️ Geçici input dosyasını temizleme hatası:', e.message);
            }
        }
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
