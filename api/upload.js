const { GoogleGenerativeAI } = require('@google/generative-ai');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// FFmpeg path'ini ayarla
ffmpeg.setFfmpegPath(ffmpegPath);

// Google AI konfigürasyonu
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'fallback-key');

// Multer konfigürasyonu - Vercel için memory storage
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});

// Google AI için yardımcı bir sınıf veya fonksiyon
class GeminiHelper {
    constructor(apiKey) {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
    }

    async generateSubtitlesFromVideo(videoBuffer, logs) {
        if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'fallback-key' || process.env.GEMINI_API_KEY === '') {
            logs.push('⚠️ GEMINI_API_KEY bulunamadı veya geçersiz. Fallback altyazılar oluşturuluyor.');
            return {
                subtitles: [
                    { speaker: 'Speaker 1', startTime: 0, endTime: 5, line: 'AI API key eksik. Fallback altyazı.' },
                    { speaker: 'Speaker 2', startTime: 5, endTime: 10, line: 'Lütfen .env dosyanızı kontrol edin.' }
                ]
            };
        }

        try {
            logs.push(`🤖 AI'a video analizi için istek gönderiliyor...`); // Sözdizimi hatası düzeltildi
            const prompt = `Bu video dosyasından altyazı oluştur. Video içeriğini analiz et ve konuşmacıları ayırt ederek altyazılar oluştur. ÖNEMLİ: Tüm altyazıları Türkçe olarak oluştur. Eğer video İngilizce ise, altyazıları Türkçe'ye çevir. Sadece JSON formatında döndür, başka hiçbir açıklama veya ön metin ekleme:

{
    "subtitles": [
        {"speaker": "Speaker 1", "startTime": 0.0, "endTime": 3.0, "line": "Türkçe altyazı metni"},
        {"speaker": "Speaker 2", "startTime": 3.0, "endTime": 6.0, "line": "Başka Türkçe altyazı metni"}
    ]
}`;

            const imagePart = {
                inline_data: {
                    data: videoBuffer.toString('base64'),
                    mime_type: 'video/mp4'
                }
            };

            const parts = [
                imagePart,
                { text: prompt }
            ];

            const result = await this.model.generateContent({ contents: [{ parts }] });
            const response = await result.response;
            const text = response.text();
            logs.push(`✅ AI Ham Yanıtı: ${text.substring(0, 500)}...`);
            
            let jsonStr = null;
            const jsonBlockMatch = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
            if (jsonBlockMatch) {
                jsonStr = jsonBlockMatch[1];
            } else {
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    jsonStr = jsonMatch[0];
                }
            }
            
            if (jsonStr) {
                try {
                    const parsed = JSON.parse(jsonStr);
                    if (parsed.subtitles && Array.isArray(parsed.subtitles)) {
                        logs.push('✅ AI yanıtı başarıyla JSON olarak ayrıştırıldı.');
                        return parsed;
                    }
                } catch (parseError) {
                    logs.push(`❌ JSON ayrıştırma hatası (iç): ${parseError.message}`);
                    console.error('JSON ayrıştırma hatası (iç):', parseError.message, 'Gelen Metin:', text);
                }
            }
            
            logs.push('❌ AI yanıtında geçerli JSON formatı bulunamadı veya altyazı formatı yanlış. Fallback altyazılar oluşturuluyor.');
            return {
                subtitles: [
                    { speaker: 'Speaker 1', startTime: 0, endTime: 5, line: 'AI yanıtı anlaşılamadı.' },
                    { speaker: 'Speaker 2', startTime: 5, endTime: 10, line: 'Lütfen prompt\'u veya AI yanıtını kontrol edin.' }
                ]
            };
        } catch (error) {
            logs.push(`❌ AI altyazı oluşturma hatası (dış): ${error.message}`);
            console.error('AI altyazı oluşturma hatası (dış):', error.message);
            logs.push('Hata durumunda fallback altyazılar döndürülüyor.');
            return {
                subtitles: [
                    { speaker: 'Speaker 1', startTime: 0, endTime: 5, line: 'AI API hatası: Fallback altyazı' },
                    { speaker: 'Speaker 2', startTime: 5, endTime: 10, line: 'Lütfen daha sonra tekrar deneyin.' }
                ]
            };
        }
    }
}

const geminiHelper = new GeminiHelper(process.env.GEMINI_API_KEY || 'fallback-key');

// Yardımcı fonksiyonlar
function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const centiseconds = Math.round((totalSeconds - Math.floor(totalSeconds)) * 100);
    const pad = (num) => String(num).padStart(2, '0');
    return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

function hexToDrawtext(hex) {
    if (!hex) return 'white';
    // ASS formatındaki &HBBGGRR& formatını veya #RRGGBB formatını destekler
    if (hex.startsWith('&H')) {
        const b = hex.substring(2, 4);
        const g = hex.substring(4, 6);
        const r = hex.substring(6, 8);
        return `0x${r}${g}${b}`;
    }
    return `0x${hex.substring(1)}`;
}

function convertToAss(subtitlesData, options = {}) {
    const { fontName = 'Arial', fontSize = 16, marginV = 70, italic = false, speakerColors = {} } = options;
    
    // ASS dosyası başlığı
    let assContent = `[Script Info]
Title: Generated Subtitles
ScriptType: v4.00+
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF&,&H000000FF&,&H00000000&,&H80000000&,0,0,0,0,100,100,0,0,1,2,2,2,10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    const defaultColors = ['&H0000FFFF&', '&H00FFFFFF&', '&H00FFFF00&', '&H00FF00FF&', '&H0000FF00&']; // Sarı, Beyaz, Mavi, Pembe, Yeşil
    const usedStyles = new Set();
    const italicValue = italic ? '1' : '0';
    
    // Vercel'de mevcut olan fontları kullan
    const safeFontName = 'Arial'; // Basit ve güvenilir font

    subtitlesData.subtitles.forEach((sub, index) => {
        const startTime = formatTime(sub.startTime);
        const endTime = formatTime(sub.endTime);
        const text = sub.line.replace(/\n/g, '\\N');
        
        // Basit format - sadece Default style kullan
        assContent += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${text}\n`;
    });
    
    return assContent;
}

async function burnSubtitles(videoBuffer, subtitlesData, options = {}) {
    const { fontFile = null, fontSize = 16, marginV = 70, italic = false, speakerColors = {} } = options;
    const logs = [];

    return new Promise((resolve, reject) => {
        const uniqueSuffix = Date.now();
        const outputFilename = `subtitled_video_${uniqueSuffix}.mp4`;
        const tempDir = '/tmp';
        const inputPath = path.join(tempDir, `input_${uuidv4()}.mp4`);
        const outputPath = path.join(tempDir, outputFilename);

        // Video buffer'ı dosyaya yaz
        fs.writeFileSync(inputPath, videoBuffer);

        const videoResizingFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black';

        let command;
        let currentFontPath = null;
        let assPath = null;

        try {
            logs.push('🔵 MODE: subtitles/ASS (libass kullanılıyor)');

            // Eğer özel font varsa, dosyayı /tmp'ye yaz
            if (fontFile && fontFile.buffer) {
                currentFontPath = path.join(tempDir, `custom_font_${uuidv4()}.ttf`);
                fs.writeFileSync(currentFontPath, fontFile.buffer);
                logs.push(`📁 Özel font dosyası /tmp dizinine yazıldı: ${currentFontPath}`);
            }
            
            // ASS içeriğini oluştur
            const assContent = convertToAss(subtitlesData, { 
                fontName: currentFontPath ? path.basename(currentFontPath, path.extname(currentFontPath)) : 'Arial', 
                fontSize: fontSize, 
                marginV: marginV, 
                italic: italic, 
                speakerColors: speakerColors 
            });
            const assFilename = `subtitle_${uuidv4()}.ass`;
            assPath = path.join(tempDir, assFilename);
            fs.writeFileSync(assPath, assContent);
            logs.push(`✅ Geçici .ass altyazı dosyası /tmp dizinine yazıldı: ${assPath}`);

            // FFmpeg komutunu oluştur - drawtext kullan (fontfile olmadan)
            let drawtextFilters = [];
            
            subtitlesData.subtitles.forEach((sub, index) => {
                const startTime = sub.startTime;
                const endTime = sub.endTime;
                const text = sub.line.replace(/'/g, "\\'").replace(/:/g, "\\:");
                
                drawtextFilters.push(
                    `drawtext=text='${text}':fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.8:boxborderw=5:x=(w-text_w)/2:y=h-th-${marginV}:enable='between(t,${startTime},${endTime})'`
                );
            });
            
            const fullFilter = `${videoResizingFilter},${drawtextFilters.join(',')}`;
            
            command = ffmpeg(inputPath)
                .videoFilter(fullFilter);

            command
                .output(outputPath)
                .on('start', (commandLine) => {
                    logs.push('🚀 FFmpeg komutu çalıştırılıyor:');
                    logs.push(commandLine);
                    logs.push('📋 Drawtext filtreleri:');
                    drawtextFilters.forEach((filter, index) => {
                        logs.push(`  ${index + 1}. ${filter}`);
                    });
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
                            if (assPath) fs.unlinkSync(assPath);
                            if (currentFontPath) fs.unlinkSync(currentFontPath);
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
                        if (assPath) fs.unlinkSync(assPath);
                        if (currentFontPath) fs.unlinkSync(currentFontPath);
                        logs.push('🗑️ Temp dosyalar temizlendi (hata durumunda)');
                    } catch (e) {
                        logs.push('⚠️ Temp dosya temizleme hatası: ' + e.message);
                    }
                    
                    reject({ error: err, logs });
                });
            
            command.run();

        } catch (e) {
            const errorMsg = '❌ Altyazı hazırlığında hata: ' + (e?.message || e);
            logs.push(errorMsg);
            reject({ error: new Error(errorMsg), logs });
        }
    });
}

module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method not allowed' });
    }

    try {
        const logs = ['\n--- Video Yükleme İsteği Aldı ---'];
        
        // Multer ile dosya işleme
        upload.single('video')(req, res, async (err) => {
            if (err) {
                logs.push('❌ Dosya yükleme hatası: ' + err.message);
                return res.status(400).json({ success: false, message: 'Dosya yükleme hatası', logs });
            }

            if (!req.file) {
                logs.push('❌ Video dosyası bulunamadı');
                return res.status(400).json({ success: false, message: 'Video dosyası gereklidir', logs });
            }

            logs.push(`📁 Dosya yüklendi: ${req.file.originalname} (${req.file.size} bytes)`);

            try {
                // AI'dan altyazı oluştur
                const subtitlesData = await geminiHelper.generateSubtitlesFromVideo(req.file.buffer, logs);
                logs.push('✅ Yapay zekadan altyazılar başarıyla oluşturuldu.');
                
                logs.push('Altyazı yakma işlemi başlıyor...');
                const burnResult = await burnSubtitles(req.file.buffer, subtitlesData, {
                    fontSize: 12,
                    marginV: 60,
                    italic: false,
                    speakerColors: {}
                });
                logs.push('✅ Video işleme tamamlandı.');

                // Base64 olarak döndür
                const base64Video = burnResult.outputBuffer.toString('base64');
                
                res.json({ 
                    success: true, 
                    message: 'Video başarıyla işlendi.',
                    subtitles: subtitlesData,
                    videoData: base64Video,
                    filename: burnResult.filename,
                    logs: logs.concat(burnResult.logs)
                });

            } catch (error) {
                console.error('İşleme hatası:', error);
                logs.push('❌ Genel Hata: ' + error.message);
                res.status(500).json({ success: false, message: 'Video işlenirken hata oluştu', error: error.message, logs });
            }
        });

    } catch (error) {
        console.error('Handler hatası:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Sunucu hatası', 
            error: error.message 
        });
    }
};
