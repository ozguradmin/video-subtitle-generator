const dotenv = require('dotenv');
dotenv.config();

// API anahtarı yoksa kapatmak yerine fallback moduna geç
const USE_FAKE_AI = !process.env.GEMINI_API_KEY;
if (USE_FAKE_AI) {
    console.warn('UYARI: GEMINI_API_KEY bulunamadı. Fallback modunda sahte altyazı üretilecek.');
}

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

// Ensure required directories exist (uploads, processed)
const ensureDir = (dirPath) => {
    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    } catch (e) {
        console.error('Klasör oluşturma hatası:', dirPath, e?.message || e);
    }
};
ensureDir(path.join(__dirname, 'uploads'));
ensureDir(path.join(__dirname, 'processed'));
ensureDir(path.join(__dirname, 'fonts'));

async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error('HTTP ' + response.statusCode + ' while downloading ' + url));
                return;
            }
            response.pipe(file);
            file.on('finish', () => file.close(() => resolve(destPath)));
        }).on('error', (err) => {
            try { fs.unlinkSync(destPath); } catch (_) {}
            reject(err);
        });
    });
}

async function ensureDefaultFontFile() {
    const localPath = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
    try {
        if (fs.existsSync(localPath)) return localPath;
    } catch (_) {}
    const fontUrl = process.env.DEFAULT_FONT_URL || 'https://raw.githubusercontent.com/dejavu-fonts/dejavu-fonts/master/ttf/DejaVuSans.ttf';
    await downloadFile(fontUrl, localPath);
    return localPath;
}

const genAI = !USE_FAKE_AI ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const FORCE_DRAWTEXT = String(process.env.FORCE_DRAWTEXT || '').toLowerCase() === 'true';
// Drawtext font olmadan çalışmıyor Railway'da, varsayılan olarak ASS kullan
const PREFER_ASS = String(process.env.PREFER_ASS || 'true').toLowerCase() === 'true';

function fileToGenerativePart(path, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(path)).toString("base64"),
            mimeType
        },
    };
}

// Fallback için basit, sabit zamanlı örnek altyazılar
function generateSubtitlesFallback() {
    return {
        subtitles: [
            { speaker: 'Konuşmacı 1', line: 'Merhaba bu bir test altyazısı', startTime: 0.20, endTime: 2.80 },
            { speaker: 'Konuşmacı 1', line: 'İkinci satır burada görünecek', startTime: 3.00, endTime: 5.50 },
            { speaker: 'Konuşmacı 1', line: 'Font ve indirme testleri için yeterli', startTime: 6.00, endTime: 9.00 }
        ]
    };
}

async function generateSubtitles(videoData) {
    if (USE_FAKE_AI) {
        return generateSubtitlesFallback();
    }
    // For text-only input, use the gemini-2.5-flash model
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `Lütfen bu videonun altyazılarını oluştur.
ROLE: Sen uzman bir video altyazı oluşturucusun.
TASK: Sana verilen videoyu analiz et ve aşağıdaki ÇOK KESİN kurallara uyarak Türkçe altyazı oluştur.
KURALLAR:
1. ZAMANLAMA: Zaman aralıklarını konuşmanın başladığı ve bittiği anlara göre en yüksek hassasiyetle ayarla.
2. BİRLEŞTİRME: Anlamı bozmayacak şekilde, çok kısa ve art arda gelen cümleleri akıllıca TEK BİR altyazı satırında birleştir.
3. MİNİMUM SÜRE: Her bir altyazı, en az 0.5 saniye ekranda kalmalıdır.
4. NOKTALAMA: Cümle sonlarına ASLA nokta veya başka bir noktalama işareti KOYMA.
5. ÇIKTI FORMATI: Yanıt olarak SADECE ve SADECE aşağıda belirtilen JSON formatında bir çıktı ver. Öncesinde veya sonrasında KESİNLİKLE HİÇBİR yorum veya açıklama metni ekleme. Sadece ham JSON olsun.
JSON FORMATI:
{ "subtitles": [ { "speaker": "Konuşmacı 1", "line": "Türkçe çeviri metni", "startTime": saniye.saniyesinin_yuzde_biri, "endTime": saniye.saniyesinin_yuzde_biri } ] }`;

    // videoData buffer ise direkt kullan, path ise oku
    const videoBuffer = Buffer.isBuffer(videoData) ? videoData : Buffer.from(fs.readFileSync(videoData));
    const videoPart = {
        inlineData: {
            data: videoBuffer.toString("base64"),
            mimeType: "video/mp4"
        }
    }; 
    const result = await model.generateContent([prompt, videoPart]);
    const response = await result.response;
    const text = response.text();
    
    const startIndex = text.indexOf('{');
    const endIndex = text.lastIndexOf('}');
    if (startIndex === -1 || endIndex === -1) {
        throw new Error("Yapay zekadan gelen yanıtta geçerli JSON bulunamadı.");
    }
    const jsonText = text.substring(startIndex, endIndex + 1);
    try {
        return JSON.parse(jsonText);
    } catch (e) {
        console.error("JSON parse hatası:", e, "Orjinal metin:", jsonText);
        throw new Error("Yapay zekadan gelen yanıt JSON formatında değil.");
    }
}

function formatTime(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) return '0:00:00.00';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const centiseconds = Math.round((totalSeconds - Math.floor(totalSeconds)) * 100);
    const pad = (num) => String(num).padStart(2, '0');
    return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

function convertToSRT(subtitlesData) {
    let srtContent = '';
    subtitlesData.subtitles.forEach((sub, index) => {
        const safeStart = Math.max(0, Number(sub.startTime) || 0);
        const safeEnd = Math.max(safeStart + 0.50, Number(sub.endTime) || safeStart + 0.50);
        
        const formatSRTTime = (seconds) => {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            const millis = Math.floor((seconds - Math.floor(seconds)) * 1000);
            const pad = (num, len = 2) => String(num).padStart(len, '0');
            return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
        };
        
        srtContent += `${index + 1}\n`;
        srtContent += `${formatSRTTime(safeStart)} --> ${formatSRTTime(safeEnd)}\n`;
        srtContent += `${sub.line}\n\n`;
    });
    return srtContent;
}

function convertToAss(subtitlesData, options = {}) {
    const { fontName = 'Arial', fontSize = 16, marginV = 70, italic = false, speakerColors = {} } = options;
    let assHeader = `[Script Info]
Title: Generated Subtitles
ScriptType: v4.00+
ScaledBorderAndShadow: yes
PlayResX: 720
PlayResY: 1280
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
`;
    let stylesSection = '';
    let dialogueSection = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    const speakerStyles = new Map();
    let styleCounter = 1;
    // Gelen renkleri veya varsayılan paleti kullan (Sarı, Beyaz, Mavi, Pembe, Yeşil)
    const defaultColors = ['&H0000FFFF&', '&H00FFFFFF&', '&H00FFFF00&', '&H00FF00FF&', '&H0000FF00&'];
    const hexToAss = (hex) => {
        if (!hex || typeof hex !== 'string' || hex.length !== 7) return '&H00FFFFFF&'; // Varsayılan Beyaz
        const r = hex.substring(1, 3);
        const g = hex.substring(3, 5);
        const b = hex.substring(5, 7);
        return `&H00${b}${g}${r}&`.toUpperCase();
    };

    subtitlesData.subtitles.forEach((sub, index) => {
        let styleName = `Sub${index}`; // Her satır için eşsiz bir stil
        let color = hexToAss(sub.overrideColor); // Satıra özel rengi önceliklendir
        
        if (!sub.overrideColor) {
            // Konuşmacı için tanımlanmış bir renk var mı?
            if (sub.speaker && speakerColors[sub.speaker]) {
                color = hexToAss(speakerColors[sub.speaker]);
            } else if (sub.speaker) {
                 // Konuşmacı için renk tanımlanmamışsa, varsayılan paletten ata
                if (!speakerStyles.has(sub.speaker)) {
                    speakerStyles.set(sub.speaker, defaultColors[styleCounter % defaultColors.length]);
                    styleCounter++;
                }
                const assColor = speakerStyles.get(sub.speaker);
                color = assColor.startsWith('&H') ? assColor : hexToAss(assColor);
            } else {
                 // Konuşmacı yoksa genel varsayılan
                 color = defaultColors[0];
            }
        }
        
        const italicValue = italic ? '1' : '0';
        stylesSection += `Style: ${styleName},${fontName},${fontSize},${color},&H000000FF,&H80000000,&H64000000,-1,${italicValue},0,0,100,100,0,0,1,3,1,2,10,10,${marginV},1\n`;

        const safeStart = Math.max(0, Number(sub.startTime) || 0);
        const safeEnd = Math.max(safeStart + 0.50, Number(sub.endTime) || safeStart + 0.50); // min 0.5s
        const startTime = formatTime(safeStart);
        const endTime = formatTime(safeEnd);
        const text = sub.line.replace(/\n/g, '\\N');
        dialogueSection += `Dialogue: 0,${startTime},${endTime},${styleName},,0,0,0,,${text}\n`;
    });
    
    // Eğer hiç stil eklenmediyse (boş altyazı durumu), en az bir tane ekle
    if (stylesSection === '') {
        const italicValue = italic ? '1' : '0';
        stylesSection += `Style: Default,${fontName},${fontSize},&H00FFFFFF&,&H000000FF,&H80000000,&H64000000,-1,${italicValue},0,0,100,100,0,0,1,3,1,2,10,10,${marginV},1\n`;
    }
    return assHeader + stylesSection + dialogueSection;
}

async function burnSubtitles(videoPath, subtitlesData, options = {}) {
    const { fontFile = null, fontSize = 16, marginV = 70, italic = false, speakerColors = {} } = options;
    const logs = [];

    // Precompute default font if needed
    let precomputedDefaultFont = null;
    try {
        precomputedDefaultFont = await ensureDefaultFontFile();
    } catch (e) {
        logs.push('⚠️ Varsayılan font indirilemedi: ' + (e?.message || e));
    }

    return new Promise((resolve, reject) => {
        const uniqueSuffix = Date.now();
        const outputFilename = `subtitled_${path.basename(videoPath, path.extname(videoPath))}-${uniqueSuffix}${path.extname(videoPath)}`;
        const outputPath = path.join(__dirname, 'processed', outputFilename);
        
        // 9:16 formatına dönüştürme ve siyah bar ekleme (daha hafif: 720x1280)
        const videoResizingFilter = 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black';

        // Try to locate a common system font for drawtext fallback (Railway base images may not have fonts)
        let defaultFontPath = precomputedDefaultFont || null;
        const commonFonts = [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'
        ];
        for (const fp of commonFonts) {
            try { if (fs.existsSync(fp)) { defaultFontPath = fp; break; } } catch(_) {}
        }

        const fontFileProvided = Boolean(fontFile && fontFile.filename);
        // By default use drawtext (more deterministic on minimal systems). Set PREFER_ASS=true to force ASS.
        const useDrawtext = !PREFER_ASS || fontFileProvided || FORCE_DRAWTEXT || Boolean(defaultFontPath);

        if (useDrawtext) {
            try {
                let fontPath = null;
                if (fontFileProvided) {
                    fontPath = path.join(__dirname, 'uploads', fontFile.filename).replace(/\\/g, '/');
                    logs.push(`🟢 MODE: drawtext (custom font dosyası ile)`);
                } else if (defaultFontPath) {
                    fontPath = defaultFontPath;
                    logs.push(`🟢 MODE: drawtext (varsayılan sistem fontu)`);
                } else {
                    // As a last resort, try to ensure default font now (sync path only, no await inside executor)
                    fontPath = precomputedDefaultFont || null;
                    if (fontPath) {
                        logs.push(`🟢 MODE: drawtext (indirilen varsayılan font) -> ${fontPath}`);
                    } else {
                        logs.push('🟡 MODE: drawtext (fontfile olmadan denenecek)');
                    }
                }
                if (fontPath) {
                    logs.push(`ℹ️ drawtext kullanılacak. fontfile='${fontPath}'`);
                }

                const escapeDrawtext = (text) => {
                    if (typeof text !== 'string') return '';
                    return text.replace(/\\/g, '\\\\\\\\').replace(/:/g, '\\\\:').replace(/'/g, `\\\\'`).replace(/\n/g, '\\\n');
                };

                const hexToDrawtext = (hex) => {
                    if (!hex || typeof hex !== 'string' || hex.length !== 7) return 'white';
                    return `#${hex.substring(1)}`;
                };

                const filters = subtitlesData.subtitles.map((sub) => {
                    const start = Math.max(0, Number(sub.startTime) || 0);
                    const end = Math.max(start + 0.01, Number(sub.endTime) || start + 0.01);
                    const text = escapeDrawtext(sub.line || '');
                    
                    let color = 'white';
                    if (sub.overrideColor) {
                        color = hexToDrawtext(sub.overrideColor);
                    } else if (sub.speaker && speakerColors[sub.speaker]) {
                        color = hexToDrawtext(speakerColors[sub.speaker]);
                    }

                    const options = {
                        text: text, fontsize: fontSize, fontcolor: color,
                        x: "(w-text_w)/2", y: `h-${marginV}-text_h`, box: 1, boxcolor: 'black@0.35', boxborderw: 8,
                        shadowcolor: 'black', shadowx: 0, shadowy: 0,
                        enable: `between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})`
                    };
                    if (fontPath) options.fontfile = fontPath;
                    return { filter: 'drawtext', options };
                });

                // Önce videoyu yeniden boyutlandır, sonra drawtext filtrelerini sırayla uygula
                const complexFilters = [];
                complexFilters.push({ filter: videoResizingFilter, inputs: '0:v', outputs: 'p0' });
                let prev = 'p0';
                filters.forEach((f, i) => {
                    const out = `p${i + 1}`;
                    complexFilters.push({ ...f, inputs: prev, outputs: out });
                    prev = out;
                });

                command = ffmpeg(videoPath)
                    .complexFilter(complexFilters, prev)
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .outputOptions([
                        '-preset ultrafast', // CPU kullanımı düşük, daha hızlı
                        '-crf 28',            // Kalite/fayda dengesi
                        '-threads 1',         // Bellek kullanımını azalt
                        '-movflags +faststart'
                    ]);
            } catch (e) {
                const errorMsg = '❌ drawtext hazırlığında hata: ' + (e?.message || e);
                logs.push(errorMsg);
                reject({ error: new Error(errorMsg), logs });
                return;
            }
        } else {
            logs.push('🔵 MODE: subtitles/ASS (drawtext kullanılmıyor)');
            const assContent = convertToAss(subtitlesData, { fontName: 'Arial', fontSize: fontSize, marginV: marginV, italic: italic, speakerColors: speakerColors });
            const assFilename = `${path.basename(videoPath, path.extname(videoPath))}.ass`;
            const assPath = path.join(__dirname, 'uploads', assFilename);
            fs.writeFileSync(assPath, assContent);
            logs.push('✅ Geçici .ass altyazı dosyası oluşturuldu.');

            const relativeAssPath = path.join('uploads', assFilename).replace(/\\/g, '/');
            const absoluteAssPath = assPath.replace(/\\/g, '/');
            logs.push(`ℹ️ ASS path (relative): ${relativeAssPath}`);
            logs.push(`ℹ️ ASS path (absolute): ${absoluteAssPath}`);
            
            // Fontconfig'i bypass et - SRT kullan (daha basit, font gerektirmez)
            const srtFilename = `${path.basename(videoPath, path.extname(videoPath))}.srt`;
            const srtPath = path.join(__dirname, 'uploads', srtFilename);
            const srtContent = convertToSRT(subtitlesData);
            fs.writeFileSync(srtPath, srtContent);
            logs.push('✅ Geçici .srt altyazı dosyası oluşturuldu.');
            
            const absoluteSrtPath = srtPath.replace(/\\/g, '/');
            logs.push(`ℹ️ SRT path (absolute): ${absoluteSrtPath}`);
            
            // SRT filter - fontconfig bypass
            const videoFilter = `${videoResizingFilter},subtitles=filename='${absoluteSrtPath}'`;
            command = ffmpeg(videoPath)
                .videoFilter(videoFilter)
                .videoCodec('libx264')
                .audioCodec('aac')
                .outputOptions([
                    '-preset ultrafast',
                    '-crf 30',            // ASS + libass daha ağır olabilir
                    '-threads 1',
                    '-movflags +faststart'
                ]);
        }

        command
            .outputOptions('-y')
            .output(outputPath)
            .on('start', (commandLine) => {
                logs.push('🚀 FFmpeg komutu çalıştırılıyor:\n' + commandLine);
            })
            .on('progress', (progress) => {
                const prog = `⏱️ ilerleme: ${progress.frames || 0} frame, ${progress.currentFps || 0} fps, ${progress.timemark || '00:00:00'}`;
                logs.push(prog);
            })
            .on('end', () => {
                logs.push('✅ Altyazı yakma işlemi başarıyla tamamlandı.');
                resolve({ finalVideoPath: path.join('processed', outputFilename), logs });
            })
            .on('error', (err, stdout, stderr) => {
                const errorMsg = '❌ FFmpeg hatası: ' + err.message;
                logs.push(errorMsg, '--- FFmpeg Hata Detayı (stderr) ---', stderr || 'stderr boş', '------------------------------------');
                reject({ error: err, logs });
            });
        
        command.run();
    });
}

const app = express();
const port = process.env.PORT || 4000;

app.use(express.static('public'));
app.use('/processed', express.static(path.join(__dirname, 'processed')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/favicon.ico', (req, res) => res.status(204));

// Test endpoint
app.get('/test', (req, res) => {
    res.json({ message: 'Railway çalışıyor!', timestamp: new Date().toISOString() });
});

// Railway'da uploads klasörü olmayabilir, memory storage kullan
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
// Accept any single file field name for reprocess font uploads
const reprocessUpload = (req, res, next) => {
    const anySingle = multer({ storage: storage }).any();
    anySingle(req, res, (err) => {
        if (err) return next(err);
        // Normalize: pick first file as req.file if present
        if (Array.isArray(req.files) && req.files.length > 0) {
            req.file = req.files[0];
        }
        next();
    });
};

async function uploadHandler(req, res) {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Lütfen bir video dosyası yükleyin.', logs:['❌ Lütfen bir video dosyası yükleyin.'] });
    }
    let fullLogs = [];
    const receivedInfo = `Dosya alındı: name='${req.file.originalname}', size=${req.file.size}B, mimetype='${req.file.mimetype}'`;
    console.log(receivedInfo);
    fullLogs.push('📥 ' + receivedInfo);
    let tempVideoPath = null;
    try {
        // Buffer'ı geçici dosyaya yaz
        tempVideoPath = path.join(__dirname, 'uploads', `upload-${Date.now()}.mp4`);
        fs.writeFileSync(tempVideoPath, req.file.buffer);
        fullLogs.push('📝 Geçici video dosyası oluşturuldu: ' + tempVideoPath);

        fullLogs.push('🤖 Altyazı oluşturma başlıyor...');
        const subtitlesData = await generateSubtitles(req.file.buffer);
        fullLogs.push('✅ Yapay zekadan altyazılar başarıyla oluşturuldu.');
        
        fullLogs.push('🔥 Altyazı yakma işlemi başlıyor...');
        const burnResult = await burnSubtitles(tempVideoPath, subtitlesData, {
            fontSize: 12,
            marginV: 60,
            italic: false,
            speakerColors: {}
        });
        fullLogs = fullLogs.concat(burnResult.logs);
        
        res.json({ 
            success: true, 
            message: 'Video başarıyla işlendi.',
            originalPath: path.relative(__dirname, tempVideoPath),
            downloadUrl: `/${path.join('processed', path.basename(burnResult.finalVideoPath)).replace(/\\/g, '/')}`,
            subtitles: subtitlesData,
            logs: fullLogs
        });
    } catch (error) {
        const errorLogs = error.logs || [];
        fullLogs = fullLogs.concat(errorLogs);
        fullLogs.push('❌ Genel Hata: ' + (error.message || error));
        console.error('Upload hata:', error?.message || error);
        res.status(500).json({ success: false, message: 'Altyazı oluşturulurken bir hata oluştu.', error: (error.message || error), logs: fullLogs });
    }
}

// Add both routes for compatibility with frontend
app.post('/upload', upload.single('video'), uploadHandler);
app.post('/api/upload', upload.single('video'), uploadHandler);

app.post('/reprocess', reprocessUpload, async (req, res) => {
    const { videoPath, subtitles, fontSize, marginV, italic, speakerColors } = req.body;
    let fullLogs = ['\n--- Yeniden İşleme İsteği Aldı ---'];

    if (!videoPath || !subtitles) {
        return res.status(400).json({ success: false, message: 'Video yolu ve altyazı verisi gereklidir.', logs: fullLogs.concat('❌ Video yolu ve altyazı verisi gereklidir.') });
    }

    const originalVideoFullPath = path.join(__dirname, videoPath);
    fullLogs.push(`ℹ️ Orijinal video yolu: ${originalVideoFullPath}`);

    if (!fs.existsSync(originalVideoFullPath)) {
        return res.status(404).json({ success: false, message: 'Sunucuda dosya bulunamadı.', logs: fullLogs.concat(`❌ Sunucu tarafında dosya bulunamadı: ${originalVideoFullPath}`) });
    }

    if (req.file) {
        fullLogs.push(`ℹ️ Font dosyası yüklendi: ${req.file.originalname}`);
    }

    try {
        const subtitlesData = typeof subtitles === 'string' ? JSON.parse(subtitles) : subtitles;
        const speakerColorsData = typeof speakerColors === 'string' ? JSON.parse(speakerColors) : (speakerColors || {});
        fullLogs.push('✅ Altyazı ve stil verisi başarıyla parse edildi.');

        const burnResult = await burnSubtitles(originalVideoFullPath, subtitlesData, {
            fontFile: req.file,
            fontSize: Number(fontSize),
            marginV: Number(marginV),
            italic: italic === 'true' || italic === true,
            speakerColors: speakerColorsData
        });

        fullLogs = fullLogs.concat(burnResult.logs);
        
        res.json({ 
            success: true, 
            message: 'Video başarıyla yeniden işlendi.',
            downloadUrl: `/${path.join('processed', path.basename(burnResult.finalVideoPath)).replace(/\\/g, '/')}`,
            logs: fullLogs
        });

    } catch (error) {
        const errorLogs = error.logs || [];
        fullLogs = fullLogs.concat(errorLogs);
        fullLogs.push('❌ Yeniden İşleme Hatası: ' + (error.message || (error.error && error.error.message)));
        res.status(500).json({ 
            success: false, 
            message: 'Yeniden işleme sırasında bir hata oluştu.', 
            error: (error.message || (error.error && error.error.message)),
            logs: fullLogs 
        });
    } finally {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
    }
});

// Frontend uyumluluğu için API alias
// /api/reprocess için aynı handler'ı kullan  
app.post('/api/reprocess', reprocessUpload, async (req, res) => {
    const { videoPath, subtitles, fontSize, marginV, italic, speakerColors } = req.body;
    let fullLogs = ['\n--- Yeniden İşleme İsteği Aldı (API) ---'];
    
    // Frontend'den gelen 'video' dosyasını 'files' arrayinden al
    let videoFile = null;
    if (req.files && req.files.length > 0) {
        videoFile = req.files.find(f => f.fieldname === 'video');
    }
    
    let originalVideoFullPath;
    
    // Eğer video dosyası gönderildiyse, geçici olarak kaydet
    if (videoFile && videoFile.buffer) {
        originalVideoFullPath = path.join(__dirname, 'uploads', `reprocess-${Date.now()}.mp4`);
        fs.writeFileSync(originalVideoFullPath, videoFile.buffer);
        fullLogs.push(`📥 Video dosyası yüklendi ve kaydedildi: ${originalVideoFullPath}`);
    } else if (videoPath) {
        originalVideoFullPath = path.join(__dirname, videoPath);
        fullLogs.push(`ℹ️ Orijinal video yolu: ${originalVideoFullPath}`);
    } else {
        return res.status(400).json({ success: false, message: 'Video dosyası veya yolu gereklidir.', logs: fullLogs.concat('❌ Video dosyası veya yolu gereklidir.') });
    }

    if (!subtitles) {
        return res.status(400).json({ success: false, message: 'Altyazı verisi gereklidir.', logs: fullLogs.concat('❌ Altyazı verisi gereklidir.') });
    }

    if (!fs.existsSync(originalVideoFullPath)) {
        return res.status(404).json({ success: false, message: 'Sunucuda dosya bulunamadı.', logs: fullLogs.concat(`❌ Sunucu tarafında dosya bulunamadı: ${originalVideoFullPath}`) });
    }

    if (req.file) {
        fullLogs.push(`ℹ️ Font dosyası yüklendi: ${req.file.originalname}`);
    }

    try {
        const subtitlesData = typeof subtitles === 'string' ? JSON.parse(subtitles) : subtitles;
        const speakerColorsData = typeof speakerColors === 'string' ? JSON.parse(speakerColors) : (speakerColors || {});
        fullLogs.push('✅ Altyazı ve stil verisi başarıyla parse edildi.');

        const burnResult = await burnSubtitles(originalVideoFullPath, subtitlesData, {
            fontFile: req.file,
            fontSize: Number(fontSize),
            marginV: Number(marginV),
            italic: italic === 'true' || italic === true,
            speakerColors: speakerColorsData
        });

        fullLogs = fullLogs.concat(burnResult.logs);
        
        res.json({ 
            success: true, 
            message: 'Video başarıyla yeniden işlendi.',
            downloadUrl: `/${path.join('processed', path.basename(burnResult.finalVideoPath)).replace(/\\/g, '/')}`,
            logs: fullLogs
        });

    } catch (error) {
        const errorLogs = error.logs || [];
        fullLogs = fullLogs.concat(errorLogs);
        fullLogs.push('❌ Yeniden İşleme Hatası: ' + (error.message || (error.error && error.error.message)));
        res.status(500).json({ 
            success: false, 
            message: 'Yeniden işleme sırasında bir hata oluştu.', 
            error: (error.message || (error.error && error.error.message)),
            logs: fullLogs 
        });
    } finally {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
    }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Sunucu http://localhost:${port} adresinde çalışıyor.`);
});
