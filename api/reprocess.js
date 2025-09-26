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

// Multer konfigürasyonu
const storage = multer.memoryStorage();
const upload = multer({ 
    storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});

// Yardımcı fonksiyonlar
function formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const centiseconds = Math.round((totalSeconds - Math.floor(totalSeconds)) * 100);
    const pad = (num) => String(num).padStart(2, '0');
    return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

function convertToAss(subtitlesData, options = {}) {
    const { fontName = 'Arial', fontSize = 16, marginV = 70, italic = false, speakerColors = {} } = options;
    let assHeader = `[Script Info]
Title: Generated Subtitles
ScriptType: v4.00+
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
`;

    let stylesSection = '';
    let dialogueSection = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

    const defaultColors = ['&H0000FFFF&', '&H00FFFFFF&', '&H00FFFF00&', '&H00FF00FF&', '&H0000FF00&'];
    const usedStyles = new Set();

    subtitlesData.subtitles.forEach((sub, index) => {
        let styleName = 'Default';
        if (sub.speaker) {
            styleName = `Speaker_${sub.speaker.replace(/[^a-zA-Z0-9]/g, '_')}`;
        }

        if (!usedStyles.has(styleName)) {
            usedStyles.add(styleName);
            
            let color = defaultColors[0];
            if (sub.speaker && speakerColors[sub.speaker]) {
                color = speakerColors[sub.speaker];
            } else if (sub.overrideColor) {
                color = sub.overrideColor;
            } else if (sub.speaker) {
                const speakerIndex = [...new Set(subtitlesData.subtitles.map(s => s.speaker))].indexOf(sub.speaker);
                color = defaultColors[speakerIndex % defaultColors.length];
            }
            
            const italicValue = italic ? '1' : '0';
            stylesSection += `Style: ${styleName},${fontName},${fontSize},${color},&H000000FF,&H80000000,&H64000000,-1,${italicValue},0,0,100,100,0,0,1,1.5,1,2,10,10,${marginV},1\n`;
        }

        const startTime = formatTime(sub.startTime);
        const endTime = formatTime(sub.endTime);
        const text = sub.line.replace(/\n/g, '\\N');
        dialogueSection += `Dialogue: 0,${startTime},${endTime},${styleName},,0,0,0,,${text}\n`;
    });
    
    if (stylesSection === '') {
        const italicValue = italic ? '1' : '0';
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
        if (fontFile) {
            logs.push('🔵 MODE: drawtext (özel font var)');
            try {
                const filters = subtitlesData.subtitles.map((sub, index) => {
                    let color = '#FFFF00';
                    if (sub.overrideColor) {
                        color = sub.overrideColor;
                    } else if (sub.speaker && speakerColors[sub.speaker]) {
                        color = speakerColors[sub.speaker];
                    }

                    return {
                        filter: `drawtext=fontfile='${fontFile.path}':text='${sub.line.replace(/'/g, "\\'")}':fontsize=${fontSize}:fontcolor=${color}:x=(w-text_w)/2:y=h-${marginV}:enable='between(t,${sub.startTime},${sub.endTime})'`
                    };
                });

                const complexFilters = [
                    { filter: videoResizingFilter, inputs: '0:v', outputs: 'padded' },
                    ...filters.map(f => ({ ...f, inputs: 'padded', outputs: 'padded' }))
                ];

                command = ffmpeg(inputPath).complexFilter(complexFilters, 'padded');
            } catch (e) {
                const errorMsg = '❌ drawtext hazırlığında hata: ' + (e?.message || e);
                logs.push(errorMsg);
                reject({ error: new Error(errorMsg), logs });
                return;
            }
        } else {
            logs.push('🔵 MODE: subtitles/ASS (özel font yok)');
            const assContent = convertToAss(subtitlesData, { fontName: 'Arial', fontSize: fontSize, marginV: marginV, italic: italic, speakerColors: speakerColors });
            const assFilename = `subtitle_${uuidv4()}.ass`;
            const assPath = path.join(tempDir, assFilename);
            fs.writeFileSync(assPath, assContent);
            logs.push('✅ Geçici .ass altyazı dosyası oluşturuldu.');

            const videoFilter = `${videoResizingFilter},subtitles=filename='${assPath}'`;
            command = ffmpeg(inputPath).videoFilter(videoFilter);
        }

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
                } catch (e) {
                    console.log('Temp dosya temizleme hatası:', e.message);
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
                } catch (e) {
                    console.log('Temp dosya temizleme hatası:', e.message);
                }
                
                reject({ error: err, logs });
            });
        
        command.run();
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
