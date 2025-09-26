const { GoogleGenerativeAI } = require('@google/generative-ai');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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
            logs.push(`🤖 AI'a video analizi için istek gönderiliyor...`);
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
                    { speaker: 'Speaker 2', startTime: 5, endTime: 10, line: 'Lütfen prompt'u veya AI yanıtını kontrol edin.' }
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

// Multer konfigürasyonu
const storage = multer.memoryStorage();
const upload = multer({ 
    storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});

// FFmpeg path'ini ayarla
ffmpeg.setFfmpegPath(ffmpegPath);

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
    let assHeader = `[Script Info]\nTitle: Generated Subtitles\nScriptType: v4.00+\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`;

    let stylesSection = '';
    let dialogueSection = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

    const defaultColors = ['&H0000FFFF&', '&H00FFFFFF&', '&H00FFFF00&', '&H00FF00FF&', '&H0000FF00&']; // Sarı, Beyaz, Mavi, Pembe, Yeşil
    const usedStyles = new Set();
    const italicValue = italic ? '1' : '0'; // Italic değeri sabit tutulacak
    
    // Vercel'de mevcut olan fontları kullan
    const safeFontName = 'Arial'; // Vercel'de garantili olan font

    subtitlesData.subtitles.forEach((sub, index) => {
        let styleName = 'Default';
        if (sub.speaker) {
            styleName = `Speaker_${sub.speaker.replace(/[^a-zA-Z0-9]/g, '_')}`;
        }

        if (!usedStyles.has(styleName)) {
            usedStyles.add(styleName);
            
            let color = defaultColors[0];
            if (sub.overrideColor) {
                color = sub.overrideColor;
            } else if (sub.speaker && speakerColors[sub.speaker]) {
                const hexColor = speakerColors[sub.speaker].startsWith('#') ? speakerColors[sub.speaker].substring(1) : speakerColors[sub.speaker];
                color = `&H00${hexColor.substring(4, 6)}${hexColor.substring(2, 4)}${hexColor.substring(0, 2)}&`;
            } else if (sub.speaker) {
                const speakerIndex = [...new Set(subtitlesData.subtitles.map(s => s.speaker))].indexOf(sub.speaker);
                color = defaultColors[speakerIndex % defaultColors.length];
            }
            
            stylesSection += `Style: ${styleName},${safeFontName},${fontSize},${color},&H000000FF,&H80000000,&H64000000,-1,${italicValue},0,0,100,100,0,0,1,1.5,1,2,10,10,${marginV},1\n`;
        }

        const startTime = formatTime(sub.startTime);
        const endTime = formatTime(sub.endTime);
        const text = sub.line.replace(/\n/g, '\\N');
        dialogueSection += `Dialogue: 0,${startTime},${endTime},${styleName},,0,0,0,,${text}\n`;
    });
    
    if (stylesSection === '') {
        stylesSection += `Style: Default,${fontName},${fontSize},&H00FFFF&,&H000000FF,&H80000000,&H64000000,-1,${italicValue},0,0,100,100,0,0,1,1.5,1,2,10,10,${marginV},1\n`;
    }
    return assHeader + stylesSection + dialogueSection;
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

            // FFmpeg komutunu oluştur - complexFilter kullan
            const complexFilter = `[0:v]${videoResizingFilter}[resized];[resized]subtitles=filename='${assPath.replace(/\\/g, '/')}'[out]`;
            
            command = ffmpeg(inputPath)
                .complexFilter(complexFilter)
                .outputOptions(['-map', '[out]']);

            command
                .output(outputPath)
                .on('start', (commandLine) => {
                    logs.push('🚀 FFmpeg komutu çalıştırılıyor:');
                    logs.push(commandLine);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        logs.push(`⏳ İlerleme: %${Math.round(progress.percent)}`);
                    }
                })
                .on('end', () => {
                    logs.push('✅ Altyazı yakma işlemi başarıyla tamamlandı.');
                    
                    // Output dosyasını oku
                    const outputBuffer = fs.readFileSync(outputPath);
                    
                    // Temp dosyaları temizle
                    try {
                        fs.unlinkSync(inputPath);
                        fs.unlinkSync(outputPath);
                        if (assPath) fs.unlinkSync(assPath);
                        if (currentFontPath) fs.unlinkSync(currentFontPath);
                    } catch (e) {
                        logs.push('⚠️ Temp dosya temizleme hatası: ' + e.message);
                    }
                    
                    resolve({ 
                        outputBuffer, 
                        logs,
                        filename: outputFilename
                    });
                })
                .on('error', (err, stdout, stderr) => {
                    const errorMsg = '❌ FFmpeg hatası: ' + err.message;
                    logs.push(errorMsg, '--- FFmpeg Hata Detayı (stderr) ---', stderr || 'stderr boş', '------------------------------------');
                    
                    // Temp dosyaları temizle
                    try {
                        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                        if (assPath) fs.unlinkSync(assPath);
                        if (currentFontPath) fs.unlinkSync(currentFontPath);
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
        const logs = ['\n--- Yeniden İşleme İsteği Aldı ---'];
        
        // Multer ile dosya işleme
        upload.fields([
            { name: 'video', maxCount: 1 },
            { name: 'font', maxCount: 1 }
        ])(req, res, async (err) => {
            if (err) {
                logs.push('❌ Dosya yükleme hatası: ' + err.message);
                return res.status(400).json({ success: false, message: 'Dosya yükleme hatası', logs });
            }

            const { videoPath, subtitles, fontSize, marginV, italic, speakerColors } = req.body;

            if (!videoPath || !subtitles) {
                logs.push('❌ Video yolu ve altyazı verisi gereklidir');
                return res.status(400).json({ success: false, message: 'Video yolu ve altyazı verisi gereklidir', logs });
            }

            try {
                const subtitlesData = JSON.parse(subtitles);
                const speakerColorsData = speakerColors ? JSON.parse(speakerColors) : {};
                logs.push('✅ Altyazı ve stil verisi başarıyla parse edildi.');

                // Video dosyasını yükle (bu örnekte base64 olarak geliyor olabilir)
                let videoBuffer;
                if (req.files && req.files.video && req.files.video[0]) {
                    videoBuffer = req.files.video[0].buffer;
                } else {
                    logs.push('❌ Video dosyası bulunamadı');
                    return res.status(400).json({ success: false, message: 'Video dosyası gereklidir', logs });
                }

                const burnResult = await burnSubtitles(videoBuffer, subtitlesData, {
                    fontFile: req.files.font ? req.files.font[0] : null,
                    fontSize: parseInt(fontSize) || 12,
                    marginV: parseInt(marginV) || 60,
                    italic: italic === 'true' || italic === true,
                    speakerColors: speakerColorsData
                });

                logs.push('✅ Video yeniden işleme tamamlandı.');

                // Base64 olarak döndür
                const base64Video = burnResult.outputBuffer.toString('base64');
                
                res.json({ 
                    success: true, 
                    message: 'Video başarıyla yeniden işlendi.',
                    videoData: base64Video,
                    filename: burnResult.filename,
                    logs: logs.concat(burnResult.logs)
                });

            } catch (error) {
                console.error('Yeniden işleme hatası:', error);
                logs.push('❌ Genel Hata: ' + error.message);
                res.status(500).json({ success: false, message: 'Video yeniden işlenirken hata oluştu', error: error.message, logs });
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
