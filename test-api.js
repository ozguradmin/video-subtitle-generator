const fs = require('fs');
const FormData = require('form-data');

async function testAPI() {
    try {
        console.log('🧪 API testi başlatılıyor...');
        
        const form = new FormData();
        form.append('video', fs.createReadStream('test_video.mp4'), {
            filename: 'test_video.mp4',
            contentType: 'video/mp4'
        });
        form.append('selectedStyle', JSON.stringify({
            fontFamily: 'Roboto',
            fontSize: 44,
            verticalPosition: 255,
            italic: false,
            reelsWidth: 80,
            reelsMargin: 20,
            lineSpacing: 5,
            textAlign: 'center',
            effects: {
                shadow: true,
                outline: true,
                background: 'black@0.5'
            }
        }));
        form.append('speakerColors', JSON.stringify({}));

        console.log('📤 Video yükleniyor...');
        
        const response = await fetch('http://localhost:3000/api/upload', {
            method: 'POST',
            body: form,
            headers: {
                ...form.getHeaders(),
                'Connection': 'close'
            }
        });

        console.log(`📊 Response Status: ${response.status}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.log('❌ Hata:', errorText);
            return;
        }

        const result = await response.json();
        console.log('✅ Başarılı!');
        console.log('📝 Log sayısı:', result.logs ? result.logs.length : 0);
        
        if (result.logs) {
            console.log('🔍 Son 5 log:');
            result.logs.slice(-5).forEach(log => console.log('  ', log));
        }
        
    } catch (error) {
        console.error('❌ Test hatası:', error.message);
    }
}

testAPI();