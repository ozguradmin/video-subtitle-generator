const { exec } = require('child_process');
const fs = require('fs');

function testWithCurl() {
    console.log('🧪 Curl ile test başlatılıyor...');
    
    // Curl komutu oluştur
    const curlCommand = `curl -X POST -F "video=@test_video.mp4" -F "selectedStyle={\\"fontFamily\\":\\"Roboto\\",\\"fontSize\\":44,\\"verticalPosition\\":255}" -F "speakerColors={}" http://localhost:3000/api/upload`;
    
    console.log('📤 Curl komutu çalıştırılıyor...');
    console.log('Komut:', curlCommand);
    
    exec(curlCommand, (error, stdout, stderr) => {
        if (error) {
            console.error('❌ Curl hatası:', error.message);
            return;
        }
        
        if (stderr) {
            console.log('⚠️ Stderr:', stderr);
        }
        
        console.log('📊 Response:');
        console.log(stdout);
    });
}

testWithCurl();
