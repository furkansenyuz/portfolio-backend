const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const sharp = require('sharp');
const rateLimit = require('express-rate-limit');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const sanitizeHtml = require('sanitize-html');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// API Key kontrolü
if (!process.env.GEMINI_API_KEY) {
    console.error("KRİTİK HATA: GEMINI_API_KEY bulunamadı!");
    process.exit(1);
}

// Ters proxy (Render, Railway, Cloudflare vb.) arkasında gerçek istemci IP'si için.
// Hız sınırı IP başına çalışır; IP hiçbir yere YAZILMAZ (log yok).
app.set('trust proxy', 1);

// --- İzinli kaynaklar (CORS + Origin zorunluluğu) ---
// Varsayılan: yalnızca kendi sitem. Ek kaynak gerekirse ALLOWED_ORIGINS env'i (virgülle).
const DEFAULT_ORIGINS = [
    'https://furkansenyuz.com',
    'https://www.furkansenyuz.com',
    'https://furkansenyuz.github.io',
];
const ALLOWED_ORIGINS = new Set(
    (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : DEFAULT_ORIGINS)
        .map(s => s.trim()).filter(Boolean)
);

app.use(cors({
    origin: (origin, cb) => {
        // Origin başlığı olmayan istekler (curl, sunucudan sunucuya) CORS'tan geçer,
        // ama aşağıdaki requireOrigin onları /chat'te reddeder.
        if (!origin) return cb(null, false);
        cb(null, ALLOWED_ORIGINS.has(origin));
    },
    methods: ['GET', 'POST'],
    maxAge: 600,
}));
app.use(express.json({ limit: '20kb' }));

// /chat yalnızca izinli bir Origin ile çağrılabilir (tarayıcı dışı kötüye kullanımı zorlaştırır).
function requireOrigin(req, res, next) {
    const origin = req.get('origin');
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
        return res.status(403).json({ reply: 'Bu uç nokta yalnızca furkansenyuz.com üzerinden kullanılabilir.' });
    }
    next();
}

// --- Hız sınırları ---
// IP başına: 15 dakikada 20 istek.
const perIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_PER_IP || 20),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { reply: 'Çok fazla istek. Lütfen biraz sonra tekrar dene.' },
});

// Günlük toplam tavan (anahtarın maliyetini sınırlar). Bellekte tutulur; süreç yeniden
// başlayınca sıfırlanır — bu kabul edilebilir, amaç kötüye kullanımı pahalı hale getirmemek.
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 300);
let dailyCount = 0;
let dailyDate = new Date().toISOString().slice(0, 10);
function dailyBudget(req, res, next) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== dailyDate) { dailyDate = today; dailyCount = 0; }
    if (dailyCount >= DAILY_LIMIT) {
        return res.status(429).json({ reply: 'Günlük kullanım sınırına ulaşıldı. Yarın tekrar dene.' });
    }
    dailyCount += 1;
    next();
}

// Kullanım sayacı: tarih, model, durum. IP veya içerik YOK.
function logUsage(model, status) {
    try {
        if (!fs.existsSync('logs')) fs.mkdirSync('logs');
        const date = new Date().toISOString().split('T')[0];
        const entry = `${new Date().toISOString()} | Model: ${model} | Status: ${status}\n`;
        fs.appendFile(path.join('logs', `usage-${date}.log`), entry, () => {});
    } catch (e) { console.error("Log Error:", e); }
}

// Dosya yükleme: yalnızca resim, en fazla 2 MB.
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});

// data.json okuma ve system instruction
let systemInstruction = "";
try {
    let rawData = null;
    const possiblePaths = [
        path.join(__dirname, 'data.json'),
        path.join(__dirname, 'data', 'data.json')
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) { rawData = fs.readFileSync(p, 'utf8'); console.log(`Veri seti bulundu: ${p}`); break; }
    }
    if (!rawData) throw new Error("data.json bulunamadı!");
    const portfolioData = JSON.parse(rawData);
    const contextData = {
        Profile: portfolioData.profile,
        Experience: portfolioData.experience,
        Education: portfolioData.education,
        Projects: portfolioData.projects,
        Locations: portfolioData.locations,
        Skills_Translations: portfolioData.translations
    };
    systemInstruction = `
    ROLE: You are the AI assistant on furkansenyuz.com, the portfolio website of Furkan Şenyüz (also written "Furkan Senyuz").

    MISSION: Answer questions about Furkan Şenyüz's identity, career, projects, and skills, using only the DATA below.

    OFFICIAL DATA SOURCE (Use this to answer):
    ${JSON.stringify(contextData, null, 2)}

    RULES:
    1. Only use the provided JSON data. Do not hallucinate or invent facts.
    2. "Furkan Şenyüz", "Furkan Senyuz" and "Furkan" all refer to the SAME person — the owner of this portfolio. Use Profile.summary and Profile.currentRole as the basis of "who is he" answers.
    3. Be professional, slightly technical, and concise.
    4. Speak the language of the user (Turkish, English, Serbian or German) based on their input.
    5. Refuse requests unrelated to Furkan's portfolio (code generation, essays, general chat) in one polite sentence.
    `;
    console.log("System instruction yüklendi.");
} catch (err) {
    console.error("VERİ YÜKLEME HATASI:", err.message);
    systemInstruction = "You are the AI assistant for Furkan Şenyüz (also written 'Furkan Senyuz') on furkansenyuz.com. Furkan Şenyüz is a civil engineer who builds AI tools for contract management and has worked on mega infrastructure projects. Answer only questions about his portfolio.";
}

// Gemini kurulumu
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODELS = [
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite"
];
const MAX_MESSAGE_CHARS = 1000;
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 600);

// Health check (model listesi dışarı verilmez)
app.get('/', (req, res) => res.json({ status: "Online" }));

// Chat rotası
app.post('/chat', requireOrigin, perIpLimiter, dailyBudget, upload.single('image'), async (req, res) => {
    let imagePath = null;
    let usedModel = null;
    try {
        const userMsg = sanitizeHtml(req.body.message || "", { allowedTags: [] }).trim().slice(0, MAX_MESSAGE_CHARS);
        if (!userMsg && !req.file) return res.status(400).json({ reply: "Mesaj veya resim yok." });

        const contents = [{ role: 'user', parts: [{ text: userMsg }] }];

        if (req.file) {
            imagePath = req.file.path;
            const imageBuffer = await sharp(imagePath).resize(800).jpeg({ quality: 80 }).toBuffer();
            contents[0].parts.push({ inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } });
        }

        let finalReply = null;
        for (const modelName of MODELS) {
            try {
                usedModel = modelName;
                const response = await genAI.models.generateContent({
                    model: modelName,
                    contents,
                    config: { systemInstruction, maxOutputTokens: MAX_OUTPUT_TOKENS }
                });
                finalReply = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || null;
                if (finalReply) { logUsage(usedModel, 'SUCCESS'); break; }
            } catch (err) {
                console.error(`${modelName} hatası: ${err.message}`);
                continue;
            }
        }
        if (!finalReply) throw new Error("Hiçbir model yanıt veremedi.");
        res.json({ reply: finalReply });
    } catch (error) {
        console.error("SERVER HATASI:", error.message);
        logUsage(usedModel || 'none', 'ERROR');
        res.status(500).json({ reply: "Sunucu hatası oluştu. Lütfen tekrar dene." });
    } finally {
        if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    }
});

// Multer ve diğer middleware hataları için düzgün yanıt
app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ reply: 'Resim en fazla 2 MB olabilir.' });
    console.error("MIDDLEWARE HATASI:", err && err.message);
    res.status(400).json({ reply: 'Geçersiz istek.' });
});

app.listen(PORT, () => console.log(`Server ${PORT} portunda. İzinli kaynaklar: ${[...ALLOWED_ORIGINS].join(', ')}`));
