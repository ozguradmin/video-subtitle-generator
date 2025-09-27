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

// Altyazı yakma fonksiyonu
async function burnSubtitles(videoPath, subtitlesData, options = {}) {
    return new Promise(async (resolve, reject) => {
        const logs = [];
        try {
            const { 
                fontFile = null, 
                fontSize = 50, 
                marginV = 300, 
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
                backgroundOpacity = 0.5,
                animationStyle = 'none' // Animasyon stili eklendi
            } = options;

            const tempDir = os.tmpdir();
            const uniqueId = uuidv4();
            const outputFilename = `subtitled_video_${Date.now()}.mp4`;
            const outputPath = path.join(tempDir, outputFilename);

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
            
            // Altyazı kontrolü
            if (!subtitlesData.subtitles || !Array.isArray(subtitlesData.subtitles) || subtitlesData.subtitles.length === 0) {
                logs.push('⚠️ Altyazı bulunamadı, sadece video resize yapılıyor');
            } else {
                logs.push(`📝 ${subtitlesData.subtitles.length} adet altyazı işleniyor...`);
                
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
                    
                    let drawtextFilter = `drawtext=text='${text}':fontfile='${fontPath}':fontsize=${fontSize}:fontcolor=${ffmpegColor}:x=${xPosition}:y=h-th-${marginV}:line_spacing=${lineSpacing}:box=1:boxcolor=${bgColorWithOpacity}:boxborderw=5${effects}`;

                    if (animationStyle === 'fadeIn') {
                        const fadeInDuration = 0.5; // saniye
                        drawtextFilter += `:alpha='if(lt(t,${sub.startTime}),0,if(lt(t,${sub.startTime}+${fadeInDuration}),(t-${sub.startTime})/${fadeInDuration},if(lt(t,${sub.endTime}),1,0)))'`;
                    } else {
                        drawtextFilter += `:enable='between(t,${sub.startTime},${sub.endTime})'`;
                    }

                    drawtextFilters.push(drawtextFilter);
                });
            }

            // Eğer altyazı yoksa sadece video resize yap
            let fullFilter;
            if (drawtextFilters.length === 0) {
                fullFilter = videoResizingFilter;
                logs.push('⚠️ Altyazı bulunamadı, sadece video resize yapılıyor');
            } else {
                fullFilter = `${videoResizingFilter},${drawtextFilters.join(',')}`;
            }
            
            logs.push(`🔧 Oluşturulan FFmpeg Filtresi: ${fullFilter.substring(0, 200)}...`);

            const command = ffmpeg(videoPath)
                .videoFilter(fullFilter)
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
                            // inputPath artık req.file.path olduğu için burada silinmemeli, endpoint'te silinecek
                            fs.unlinkSync(outputPath);
                            logs.push('🗑️ Temp output dosyası temizlendi');
                        } catch (e) {
                            logs.push('⚠️ Temp output dosya temizleme hatası: ' + e.message);
                        }
                        
                        resolve({ 
                            outputBuffer, 
                            logs,
                            filename: outputFilename,
                            subtitles: subtitlesData // Altyazıları da döndür
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
                        // if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
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
            logs: err.logs || ['İç sunucu hatası.']
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
