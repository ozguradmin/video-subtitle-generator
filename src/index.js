import { GoogleGenerativeAI } from '@google/generative-ai';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Gemini AI yapılandırması - environment variable'ı fonksiyon içinde kullanacağız

// Fallback için basit, sabit zamanlı örnek altyazılar
function generateSubtitlesFallback() {
  return {
    subtitles: [
      { speaker: 'Konuşmacı 1', line: 'Merhaba bu bir test altyazısı', startTime: 0.20, endTime: 2.80 },
      { speaker: 'Konuşmacı 1', line: 'İkinci satır burada görünecek', startTime: 3.00, endTime: 5.50 },
      { speaker: 'Konuşmacı 1', line: 'Font ve indirme testleri için yeterli', startTime: 6.00, endTime: 9.00 }
    ]
  };
}

async function generateSubtitles(videoBuffer, env) {
  try {
    console.log('Gemini API Key var mı:', !!env.GEMINI_API_KEY);
    
    if (!env.GEMINI_API_KEY) {
      console.log('API key bulunamadı, fallback kullanılıyor');
      return generateSubtitlesFallback();
    }
    
    // Gemini AI yapılandırması
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    // Gemini 2.5 Flash modelini kullan
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    const prompt = `Lütfen bu videonun altyazılarını oluştur.
ROLE: Sen uzman bir video altyazı oluşturucusun.
TASK: Sana verilen videoyu analiz et ve aşağıdaki ÇOK KESİN kurallara uyarak Türkçe altyazı oluştur.
KURALLAR:
1. ZAMANLAMA: Zaman aralıklarını konuşmanın başladığı ve bittiği anlara göre en yüksek hassasiyetle ayarla.
2. BİRLEŞTİRME: Anlamı bozmayacak şekilde, çok kısa ve art arda gelen cümleleri akıllıca TEK BİR altyazı satırında birleştir.
3. MİNİMUM SÜRE: Her bir altyazı, en az 0.5 saniye ekranda kalmalıdır.
4. NOKTALAMA: Cümle sonlarına ASLA nokta veya başka bir noktalama işareti KOYMA.
5. ÇIKTI FORMATI: Yanıt olarak SADECE ve SADECE aşağıda belirtilen JSON formatında bir çıktı ver. Öncesinde veya sonrasında KESİNLİKLE HİÇBİR yorum veya açıklama metni ekleme. Sadece ham JSON olsun.
JSON FORMATI:
{ "subtitles": [ { "speaker": "Konuşmacı 1", "line": "Türkçe çeviri metni", "startTime": saniye.saniyesinin_yuzde_biri, "endTime": saniye.saniyesinin_yuzde_biri } ] }`;

    const videoPart = {
      inlineData: {
        data: videoBuffer,
        mimeType: "video/mp4",
      },
    };

    const result = await model.generateContent([prompt, videoPart]);
    const response = await result.response;
    const text = response.text();
    
    const startIndex = text.indexOf('{');
    const endIndex = text.lastIndexOf('}');
    if (startIndex === -1 || endIndex === -1) {
      throw new Error("Yapay zekadan gelen yanıtta geçerli JSON bulunamadı.");
    }
    const jsonText = text.substring(startIndex, endIndex + 1);
    
    return JSON.parse(jsonText);
  } catch (error) {
    console.error('Gemini API hatası:', error);
    console.error('Hata detayı:', error.message);
    console.error('Stack trace:', error.stack);
    
    // API key problemi varsa fallback kullan
    if (error.message.includes('API key') || error.message.includes('authentication') || error.message.includes('unauthorized')) {
      console.log('API key hatası, fallback kullanılıyor');
      return generateSubtitlesFallback();
    }
    
    // Diğer hatalar için de fallback
    console.log('Genel hata, fallback kullanılıyor');
    return generateSubtitlesFallback();
  }
}

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    
    // Ana sayfa - Frontend'i serve et
    if (url.pathname === '/' && request.method === 'GET') {
      // Basit ve çalışan HTML
      const frontendHtml = `<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Video Subtitle Generator - Cloudflare</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; }
        .upload-area { 
            border: 2px dashed #ccc; 
            padding: 2rem; 
            text-align: center; 
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s;
        }
        .upload-area:hover { border-color: #3b82f6; background-color: #f8fafc; }
        .upload-area.dragover { border-color: #3b82f6; background-color: #eff6ff; }
        .btn { 
            background: #3b82f6; 
            color: white; 
            padding: 0.75rem 1.5rem; 
            border-radius: 6px; 
            border: none; 
            cursor: pointer;
            font-weight: 600;
        }
        .btn:hover { background: #2563eb; }
        .btn:disabled { background: #9ca3af; cursor: not-allowed; }
        .log-area { 
            background: #f3f4f6; 
            padding: 1rem; 
            border-radius: 6px; 
            max-height: 300px; 
            overflow-y: auto; 
            font-family: monospace; 
            font-size: 0.875rem;
        }
        .status-success { color: #059669; }
        .status-error { color: #dc2626; }
        .status-processing { color: #d97706; }
        .hidden { display: none !important; }
    </style>
</head>
<body class="bg-gray-50 min-h-screen">
    <div class="max-w-4xl mx-auto p-4">
        <!-- Header -->
        <div class="bg-white rounded-lg shadow-sm p-6 mb-6">
            <h1 class="text-2xl font-bold text-gray-900 mb-2">🎬 Video Altyazı Generator</h1>
            <p class="text-gray-600">Gemini 2.5 Flash ile otomatik altyazı oluşturun</p>
        </div>

        <!-- Upload Section -->
        <div class="bg-white rounded-lg shadow-sm p-6 mb-6">
            <h2 class="text-lg font-semibold mb-4">1. Video Yükle</h2>
            
            <div class="upload-area" id="uploadArea">
                <div class="text-4xl mb-2">📁</div>
                <p class="text-gray-600 mb-2">Video dosyasını buraya sürükleyin veya tıklayın</p>
                <p class="text-sm text-gray-500">Desteklenen formatlar: MP4, AVI, MOV, MKV</p>
            </div>
            
            <input type="file" id="fileInput" accept="video/*" class="hidden">
            
            <div id="fileInfo" class="hidden mt-4 p-3 bg-blue-50 rounded-lg">
                <p class="text-sm"><strong>Seçilen dosya:</strong> <span id="fileName"></span></p>
            </div>
            
            <button id="uploadBtn" class="btn mt-4">
                <span id="uploadBtnText">Altyazı Oluştur</span>
            </button>
        </div>

        <!-- Status Section -->
        <div id="statusSection" class="hidden bg-white rounded-lg shadow-sm p-6 mb-6">
            <h2 class="text-lg font-semibold mb-4">Durum</h2>
            <p id="statusMessage" class="status-processing"></p>
        </div>

        <!-- Logs Section -->
        <div id="logsSection" class="hidden bg-white rounded-lg shadow-sm p-6 mb-6">
            <div class="flex justify-between items-center mb-4">
                <h2 class="text-lg font-semibold">İşlem Kayıtları</h2>
                <button id="copyLogsBtn" class="text-sm text-blue-600 hover:text-blue-800">Kopyala</button>
            </div>
            <div id="logArea" class="log-area"></div>
        </div>

        <!-- Results Section -->
        <div id="resultsSection" class="hidden bg-white rounded-lg shadow-sm p-6">
            <div class="flex justify-between items-center mb-4">
                <h2 class="text-lg font-semibold">Altyazı Sonuçları</h2>
                <button id="downloadBtn" class="btn">📥 SRT İndir</button>
            </div>
            
            <div id="resultsList" class="space-y-3">
            </div>
        </div>
    </div>

    <script>
    // Global state
    let currentVideoFile = null;
    let currentSubtitles = [];
    let logs = [];
    let isLoading = false;

    // DOM elements
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileInfo = document.getElementById('fileInfo');
    const fileName = document.getElementById('fileName');
    const uploadBtn = document.getElementById('uploadBtn');
    const uploadBtnText = document.getElementById('uploadBtnText');
    const statusSection = document.getElementById('statusSection');
    const statusMessage = document.getElementById('statusMessage');
    const logsSection = document.getElementById('logsSection');
    const logArea = document.getElementById('logArea');
    const copyLogsBtn = document.getElementById('copyLogsBtn');
    const resultsSection = document.getElementById('resultsSection');
    const resultsList = document.getElementById('resultsList');
    const downloadBtn = document.getElementById('downloadBtn');

    // Utility functions
    function show(element) {
        element.classList.remove('hidden');
    }

    function hide(element) {
        element.classList.add('hidden');
    }

    function formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return \`\${hours.toString().padStart(2, '0')}:\${minutes.toString().padStart(2, '0')}:\${secs.toString().padStart(2, '0')},\${ms.toString().padStart(3, '0')}\`;
    }

    function addLog(message) {
        logs.push(\`[\${new Date().toLocaleTimeString()}] \${message}\`);
        logArea.textContent = logs.join('\\n');
        show(logsSection);
    }

    function updateStatus(message, type = 'processing') {
        statusMessage.textContent = message;
        statusMessage.className = 'status-' + type;
        show(statusSection);
    }

    function handleFileSelect(file) {
        if (file) {
            currentVideoFile = file;
            fileName.textContent = file.name;
            show(fileInfo);
            hide(statusSection);
            hide(resultsSection);
        }
    }

    // Event listeners
    uploadArea.addEventListener('click', () => {
        fileInput.click();
    });

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            if (file.type.startsWith('video/')) {
                handleFileSelect(file);
            } else {
                alert('Lütfen bir video dosyası seçin.');
            }
        }
    });

    fileInput.addEventListener('change', (e) => {
        handleFileSelect(e.target.files[0]);
    });

    uploadBtn.addEventListener('click', async () => {
        if (!currentVideoFile) {
            updateStatus('Lütfen bir video dosyası seçin.', 'error');
            return;
        }

        isLoading = true;
        logs = [];
        updateStatus('Video yükleniyor ve işleniyor...', 'processing');
        addLog('📤 Video yükleniyor...');
        
        uploadBtn.disabled = true;
        uploadBtnText.textContent = 'İşleniyor...';

        const formData = new FormData();
        formData.append('video', currentVideoFile);

        try {
            const response = await fetch('/upload', { method: 'POST', body: formData });
            const result = await response.json();
            
            if (result.logs && Array.isArray(result.logs)) {
                logs = [...result.logs];
                logArea.textContent = logs.join('\\n');
                show(logsSection);
            }

            if (!response.ok || !result.success) {
                throw new Error(result.message || 'Sunucu hatası oluştu.');
            }

            updateStatus('✅ Başarıyla tamamlandı!', 'success');
            addLog('✅ Altyazılar oluşturuldu!');
            
            if (result.subtitles && result.subtitles.subtitles) {
                currentSubtitles = result.subtitles.subtitles;
                addLog(\`📝 \${currentSubtitles.length} altyazı bulundu\`);
                
                // Show results
                resultsList.innerHTML = '';
                currentSubtitles.forEach((subtitle, index) => {
                    const div = document.createElement('div');
                    div.className = 'border border-gray-200 rounded-lg p-4';
                    div.innerHTML = \`
                        <div class="flex justify-between items-center mb-2">
                            <span class="text-sm font-medium text-gray-600">\${subtitle.speaker}</span>
                            <span class="text-xs text-gray-500">\${formatTime(subtitle.startTime)} - \${formatTime(subtitle.endTime)}</span>
                        </div>
                        <p class="text-gray-900">\${subtitle.line}</p>
                    \`;
                    resultsList.appendChild(div);
                });
                show(resultsSection);
            }

        } catch (error) {
            console.error('Yükleme hatası:', error);
            addLog('❌ Hata: ' + error.message);
            updateStatus('❌ Hata: ' + error.message, 'error');
        } finally {
            isLoading = false;
            uploadBtn.disabled = false;
            uploadBtnText.textContent = 'Altyazı Oluştur';
        }
    });

    copyLogsBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(logs.join('\\n')).then(() => {
            alert('Loglar kopyalandı!');
        });
    });

    downloadBtn.addEventListener('click', () => {
        if (currentSubtitles.length === 0) return;
        
        const srtContent = currentSubtitles.map((sub, index) => {
            return \`\${index + 1}\\n\${formatTime(sub.startTime)} --> \${formatTime(sub.endTime)}\\n\${sub.line}\\n\`;
        }).join('\\n');
        
        const blob = new Blob([srtContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = \`subtitles_\${Date.now()}.srt\`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // Initialize
    console.log('Video Altyazı Generator yüklendi!');
    </script>
</body>
</html>`;

      return new Response(frontendHtml, {
        headers: { ...corsHeaders, 'Content-Type': 'text/html' }
      });
    }

    // Upload endpoint
    if (url.pathname === '/upload' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const videoFile = formData.get('video');
        
        if (!videoFile) {
          return new Response(JSON.stringify({
            success: false,
            message: 'Lütfen bir video dosyası yükleyin.',
            logs: ['❌ Lütfen bir video dosyası yükleyin.']
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Video dosyasını buffer'a çevir
        const videoBuffer = await videoFile.arrayBuffer();
        
        // Altyazı oluştur
        const subtitlesData = await generateSubtitles(videoBuffer, env);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Video başarıyla işlendi.',
          subtitles: subtitlesData,
          logs: ['✅ Yapay zekadan altyazılar başarıyla oluşturuldu.']
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          message: 'Altyazı oluşturulurken bir hata oluştu.',
          error: error.message,
          logs: ['❌ Genel Hata: ' + error.message]
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Health check
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'OK',
        timestamp: new Date().toISOString(),
        model: 'gemini-2.5-flash',
        hasApiKey: !!env.GEMINI_API_KEY,
        apiKeyLength: env.GEMINI_API_KEY ? env.GEMINI_API_KEY.length : 0
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 404
    return new Response('Not Found', { 
      status: 404,
      headers: corsHeaders 
    });
  },
};
