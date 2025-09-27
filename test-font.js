const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

// Font dosya yolları
const fontPaths = {
    'Roboto': path.join(__dirname, 'public', 'fonts', 'Roboto-Regular.ttf'),
    'Avenir': path.join(__dirname, 'public', 'fonts', 'Avenir LT Std Medium TR Bold Italic TR.otf')
};

console.log('🔍 Font dosyaları kontrol ediliyor...');
console.log(`Roboto: ${fontPaths.Roboto} - ${fs.existsSync(fontPaths.Roboto) ? '✅ Mevcut' : '❌ Bulunamadı'}`);
console.log(`Avenir: ${fontPaths.Avenir} - ${fs.existsSync(fontPaths.Avenir) ? '✅ Mevcut' : '❌ Bulunamadı'}`);

// FFmpeg path'ini ayarla
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);
console.log(`🎬 FFmpeg path: ${ffmpegPath}`);

// Test video oluştur (basit renkli video)
const testVideoPath = path.join(__dirname, 'test-video.mp4');
const outputPath = path.join(__dirname, 'test-output.mp4');

console.log('\n🎥 Test video oluşturuluyor...');

// Basit test video oluştur
const command = ffmpeg()
    .input('color=c=red:size=640x480:duration=5')
    .inputFormat('lavfi')
    .output(testVideoPath)
    .on('start', (commandLine) => {
        console.log('🚀 Video oluşturma komutu:', commandLine);
    })
    .on('end', () => {
        console.log('✅ Test video oluşturuldu');
        testFontProcessing();
    })
    .on('error', (err) => {
        console.error('❌ Video oluşturma hatası:', err.message);
    });

command.run();

function testFontProcessing() {
    console.log('\n🎨 Font işleme testi başlıyor...');
    
    // Test altyazıları
    const testSubtitles = [
        {
            speaker: "Test Speaker",
            startTime: 0.0,
            endTime: 2.0,
            line: "Bu bir test altyazısıdır."
        },
        {
            speaker: "Test Speaker", 
            startTime: 2.5,
            endTime: 5.0,
            line: "Avenir fontu test ediliyor."
        }
    ];

    // Avenir fontu ile test
    const fontPath = fontPaths.Avenir;
    console.log(`📁 Kullanılan font: ${fontPath}`);
    
    // Drawtext filtresi oluştur
    const drawtextFilters = testSubtitles.map((sub, index) => {
        const text = sub.line.replace(/'/g, `\\\\\\\\\\\\''`).replace(/:/g, `\\\\\\\\:`).replace(/%/g, `\\\\\\\\%`).replace(/\\/g, `\\\\\\\\\\\\`);
        return `drawtext=text='${text}':fontfile=${fontPath}:fontsize=24:fontcolor=white:x=(w-text_w)/2:y=h-th-50:enable='between(t,${sub.startTime},${sub.endTime})'`;
    });
    
    const fullFilter = drawtextFilters.join(',');
    console.log(`🔧 FFmpeg Filtresi: ${fullFilter}`);
    
    // FFmpeg komutu çalıştır
    const processCommand = ffmpeg(testVideoPath)
        .videoFilter(fullFilter)
        .output(outputPath)
        .outputOptions(['-c:v', 'libx264', '-preset', 'ultrafast'])
        .on('start', (commandLine) => {
            console.log('🚀 FFmpeg komutu:', commandLine);
        })
        .on('progress', (progress) => {
            if (progress.percent) {
                console.log(`⏳ İlerleme: %${Math.round(progress.percent)}`);
            }
        })
        .on('end', () => {
            console.log('✅ Font işleme testi başarılı!');
            console.log(`📁 Output dosyası: ${outputPath}`);
            
            // Dosya boyutunu kontrol et
            const stats = fs.statSync(outputPath);
            console.log(`📊 Output dosya boyutu: ${stats.size} bytes`);
            
            // Temizlik
            try {
                fs.unlinkSync(testVideoPath);
                fs.unlinkSync(outputPath);
                console.log('🗑️ Test dosyaları temizlendi');
            } catch (e) {
                console.log('⚠️ Temizlik hatası:', e.message);
            }
            
            console.log('\n🎉 Test tamamlandı! Avenir fontu çalışıyor.');
        })
        .on('error', (err, stdout, stderr) => {
            console.error('❌ Font işleme hatası:', err.message);
            console.error('stdout:', stdout);
            console.error('stderr:', stderr);
            
            // Temizlik
            try {
                if (fs.existsSync(testVideoPath)) fs.unlinkSync(testVideoPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            } catch (e) {
                console.log('⚠️ Temizlik hatası:', e.message);
            }
        });
    
    processCommand.run();
}
