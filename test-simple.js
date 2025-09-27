const fs = require('fs');

async function testSimple() {
    try {
        console.log('🧪 Basit test başlatılıyor...');
        
        // Sadece text gönder
        const response = await fetch('http://localhost:3000/api/health');
        const result = await response.json();
        console.log('✅ Health check:', result);
        
    } catch (error) {
        console.error('❌ Test hatası:', error.message);
    }
}

testSimple();
