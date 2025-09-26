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

async function generateSubtitles(videoBuffer) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'fallback-key') {
        return {
            subtitles: [
                { speaker: 'Speaker 1', startTime: 0, endTime: 3, line: 'Bu bir test altyazısıdır.' },
                { speaker: 'Speaker 2', startTime: 3, endTime: 6, line: 'Vercel\'de çalışıyor.' }
            ]
        };
    }

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
        const prompt = `Bu video dosyasından altyazı oluştur. Video içeriğini analiz et ve konuşmacıları ayırt ederek altyazılar oluştur. JSON formatında döndür:
        {
            "subtitles": [
                {"speaker": "Speaker 1", "startTime": 0.0, "endTime": 3.0, "line": "Altyazı metni"},
                {"speaker": "Speaker 2", "startTime": 3.0, "endTime": 6.0, "line": "Başka altyazı metni"}
            ]
        }`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        } else {
            throw new Error('Geçerli JSON formatı bulunamadı');
        }
    } catch (error) {
        console.error('AI altyazı oluşturma hatası:', error);
        throw error;
    }
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
                logs.push('Altyazı oluşturma başlıyor...');
                const subtitlesData = await generateSubtitles(req.file.buffer);
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
