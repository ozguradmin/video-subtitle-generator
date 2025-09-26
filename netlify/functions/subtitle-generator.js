const { GoogleGenerativeAI } = require('@google/generative-ai');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// FFmpeg path'ini ayarla
ffmpeg.setFfmpegPath(ffmpegPath);

// Multer konfigürasyonu
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = '/tmp/uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `video-${Date.now()}${path.extname(file.originalname)}`);
    }
});

const upload = multer({ storage });

// Google AI konfigürasyonu
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'fallback-key');

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

    const defaultColors = ['&H0000FFFF&', '&H00FFFFFF&', '&H00FFFF00&', '&H00FF00FF&', '&H0000FF00&']; // Sarı, Beyaz, Mavi, Pembe, Yeşil
    const usedStyles = new Set();

    subtitlesData.subtitles.forEach((sub, index) => {
        let styleName = 'Default';
        if (sub.speaker) {
            styleName = `Speaker_${sub.speaker.replace(/[^a-zA-Z0-9]/g, '_')}`;
        }

        if (!usedStyles.has(styleName)) {
            usedStyles.add(styleName);
            
            let color = defaultColors[0]; // Varsayılan sarı
            if (sub.speaker && speakerColors[sub.speaker]) {
                color = speakerColors[sub.speaker];
            } else if (sub.overrideColor) {
                color = sub.overrideColor;
            } else if (sub.speaker) {
                // Konuşmacı sırasına göre renk ata
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

async function generateSubtitles(videoPath) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'fallback-key') {
        // Fallback: Sahte altyazılar oluştur
        return {
            subtitles: [
                { speaker: 'Speaker 1', startTime: 0, endTime: 3, line: 'Bu bir test altyazısıdır.' },
                { speaker: 'Speaker 2', startTime: 3, endTime: 6, line: 'Netlify Functions ile çalışıyor.' }
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
        
        // JSON'u parse et
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

async function burnSubtitles(videoPath, subtitlesData, options = {}) {
    const { fontFile = null, fontSize = 16, marginV = 70, italic = false, speakerColors = {} } = options;
    const logs = [];

    return new Promise((resolve, reject) => {
        const uniqueSuffix = Date.now();
        const outputFilename = `subtitled_${path.basename(videoPath, path.extname(videoPath))}-${uniqueSuffix}${path.extname(videoPath)}`;
        const outputPath = `/tmp/processed/${outputFilename}`;
        
        // Output klasörünü oluştur
        if (!fs.existsSync('/tmp/processed')) {
            fs.mkdirSync('/tmp/processed', { recursive: true });
        }

        const videoResizingFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black';

        let command;
        if (fontFile) {
            logs.push('🔵 MODE: drawtext (özel font var)');
            try {
                const filters = subtitlesData.subtitles.map((sub, index) => {
                    let color = '#FFFF00'; // Varsayılan sarı
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

                command = ffmpeg(videoPath).complexFilter(complexFilters, 'padded');
            } catch (e) {
                const errorMsg = '❌ drawtext hazırlığında hata: ' + (e?.message || e);
                logs.push(errorMsg);
                reject({ error: new Error(errorMsg), logs });
                return;
            }
        } else {
            logs.push('🔵 MODE: subtitles/ASS (özel font yok)');
            const assContent = convertToAss(subtitlesData, { fontName: 'Arial', fontSize: fontSize, marginV: marginV, italic: italic, speakerColors: speakerColors });
            const assFilename = `${path.basename(videoPath, path.extname(videoPath))}.ass`;
            const assPath = `/tmp/uploads/${assFilename}`;
            fs.writeFileSync(assPath, assContent);
            logs.push('✅ Geçici .ass altyazı dosyası oluşturuldu.');

            const relativeAssPath = assPath.replace(/\\/g, '/');
            const videoFilter = `${videoResizingFilter},subtitles=filename='${relativeAssPath}'`;
            command = ffmpeg(videoPath).videoFilter(videoFilter);
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
                resolve({ 
                    outputPath, 
                    logs,
                    downloadUrl: `/api/download/${outputFilename}`
                });
            })
            .on('error', (err, stdout, stderr) => {
                const errorMsg = '❌ FFmpeg hatası: ' + err.message;
                logs.push(errorMsg, '--- FFmpeg Hata Detayı (stderr) ---', stderr || 'stderr boş', '------------------------------------');
                reject({ error: err, logs });
            });
        
        command.run();
    });
}

exports.handler = async (event, context) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        if (event.httpMethod === 'POST' && event.path === '/api/upload') {
            // Video upload ve işleme
            const logs = ['\n--- Video Yükleme İsteği Aldı ---'];
            
            // Multer ile dosya işleme (Netlify'de farklı yaklaşım gerekebilir)
            logs.push('⚠️ Netlify Functions\'da dosya yükleme için farklı yaklaşım gerekli');
            
            return {
                statusCode: 200,
                headers: {
                    ...headers,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    success: false,
                    message: 'Netlify Functions\'da dosya yükleme için özel konfigürasyon gerekli. Lütfen Vercel veya Railway gibi bir platform kullanın.',
                    logs
                })
            };
        }

        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ message: 'Endpoint bulunamadı' })
        };

    } catch (error) {
        console.error('Handler hatası:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                success: false, 
                message: 'Sunucu hatası', 
                error: error.message 
            })
        };
    }
};
