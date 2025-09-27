const fs = require('fs');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Test video oluştur (basit)
const testVideoPath = 'test-api-video.mp4';
const outputPath = 'test-api-output.mp4';

console.log('🎥 Test video oluşturuluyor...');

// Basit test video oluştur
const { spawn } = require('child_process');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');

const command = spawn(ffmpeg.path, [
    '-f', 'lavfi',
    '-i', 'color=c=blue:size=640x480:duration=3',
    '-y',
    testVideoPath
]);

command.on('close', (code) => {
    if (code === 0) {
        console.log('✅ Test video oluşturuldu');
        testAPI();
    } else {
        console.error('❌ Video oluşturma hatası');
    }
});

function testAPI() {
    console.log('🚀 API testi başlıyor...');
    
    // FormData oluştur
    const form = new FormData();
    form.append('video', fs.createReadStream(testVideoPath));
    
    // API'ye istek gönder
    fetch('http://localhost:3000/api/upload', {
        method: 'POST',
        body: form
    })
    .then(response => response.json())
    .then(data => {
        console.log('📊 API Yanıtı:');
        console.log('Success:', data.success);
        console.log('Message:', data.message);
        console.log('Logs sayısı:', data.logs ? data.logs.length : 0);
        
        if (data.logs) {
            console.log('\n📝 İşlem Logları:');
            data.logs.forEach((log, index) => {
                console.log(`${index + 1}. ${log}`);
            });
        }
        
        if (data.success) {
            console.log('\n🎉 API testi başarılı!');
        } else {
            console.log('\n❌ API testi başarısız!');
        }
        
        // Temizlik
        try {
            if (fs.existsSync(testVideoPath)) fs.unlinkSync(testVideoPath);
            console.log('🗑️ Test dosyası temizlendi');
        } catch (e) {
            console.log('⚠️ Temizlik hatası:', e.message);
        }
    })
    .catch(error => {
        console.error('❌ API test hatası:', error.message);
        
        // Temizlik
        try {
            if (fs.existsSync(testVideoPath)) fs.unlinkSync(testVideoPath);
        } catch (e) {
            console.log('⚠️ Temizlik hatası:', e.message);
        }
    });
}
