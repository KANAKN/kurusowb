import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';
import process from 'process';

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());

// --- サービスアカウント認証 ---
const KEYFILEPATH = process.env.RENDER ? '/etc/secrets/service-account.json' : path.join(process.cwd(), 'service-account.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: SCOPES,
});
const calendar = google.calendar({ version: 'v3', auth });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Expressサーバーのルーティング ---
const upload = multer({ storage: multer.memoryStorage() });

app.get('/healthz', (req, res) => {
    // ヘルスチェック用のエンドポイント
    res.status(200).json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'index.html'));
});

app.post('/analyze', upload.single('scheduleImage'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '画像ファイルがアップロードされていません。' });
    }
    
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", generationConfig: { responseMimeType: "application/json" } });
        const imagePart = { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } };
        
        const promptTemplate = await fs.readFile('prompt.txt', 'utf-8');
        
        const result = await model.generateContent([promptTemplate, imagePart]);
        const jsonResponse = result.response.text().trim();
        
        console.log('[Analyze] Raw AI Response:\n', jsonResponse); // ★★★ 生レスポンスのログ ★★★
        
        const analysisResult = JSON.parse(jsonResponse);
        
        console.log('[Analyze] 解析完了。');
        res.json(analysisResult);

    } catch (error) {
        console.error('[Analyze] エラー:', error);
        res.status(500).json({ error: 'AI_PROCESSING_ERROR', message: 'AIの処理中にエラーが発生しました。', details: error.message });
    }
});

app.post('/register', async (req, res) => {
    const { events } = req.body;
    if (!events || !Array.isArray(events)) {
        return res.status(400).send('登録データが不正です。');
    }

    const eventsToRegister = events.filter(event => event.title && event.title.toLowerCase().includes('vs'));
    console.log(`[Register] ${eventsToRegister.length}件の対象予定の登録を開始...`);

    try {
        // --- 1. 既存の予定をすべての日付・すべてのカレンダーから削除 ---
        const uniqueDates = [...new Set(eventsToRegister.map(e => e.full_date))];
        const mappingData = await fs.readFile('calendar_mapping.json', 'utf-8');
        const calendarMapping = JSON.parse(mappingData);
        const allCalendarIds = Object.values(calendarMapping);

        for (const date of uniqueDates) {
            console.log(`[Register] ${date} の既存予定を全カレンダーから削除します...`);
            const startDate = new Date(`${date}T00:00:00+09:00`);
            const endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + 1);

            const timeMin = startDate.toISOString();
            const timeMax = endDate.toISOString();

            for (const calendarId of allCalendarIds) {
                console.log(`[Debug] Deleting from calendar: ${calendarId}`);
                console.log(`[Debug] Search range: timeMin=${timeMin}, timeMax=${timeMax}`);

                const existingEvents = await calendar.events.list({
                    calendarId,
                    timeMin,
                    timeMax,
                    singleEvents: true,
                });

                console.log(`[Debug] Found ${existingEvents.data.items.length} events to delete.`);

                if (existingEvents.data.items.length > 0) {
                    const deletePromises = existingEvents.data.items.map(item =>
                        calendar.events.delete({ calendarId, eventId: item.id })
                    );
                    await Promise.all(deletePromises);
                }
            }
        }

        // --- 2. 新しい予定を登録 ---
        console.log('[Register] 新しい予定の登録を開始します...');
        const results = [];
        for (const event of eventsToRegister) {
            try {
                const calendarId = await get_calendar_id({ category: event.category });
                if (!calendarId) throw new Error(`'${event.category}' に対応するカレンダーIDが見つかりません。`);

                const { startTime, endTime } = parseClientTime(event.full_date, event.time_str);
                let location = event.location_str;
                if (location && location.toUpperCase() === 'HG') {
                    location = '東久留米総合高校';
                } else {
                    location = await search_location({ place_name: event.location_str });
                }

                const result = await create_calendar_event({
                    calendarId,
                    summary: `[${event.category}] ${event.title}`,
                    start_time: startTime,
                    end_time: endTime,
                    location,
                    description: event.description,
                    category: event.category
                });
                results.push({ ...result, title: `[${event.category}] ${event.title}` });

            } catch (error) {
                results.push({ status: 'error', title: `[${event.category}] ${event.title}`, message: error.message });
            }
        }
        res.json(results);

    } catch (error) {
        console.error('[Register] 全体処理エラー:', error);
        res.status(500).json({ error: 'REGISTRATION_ERROR', message: '予定の登録処理中にエラーが発生しました。', details: error.message });
    }
});

// --- ヘルパー関数 ---

async function get_calendar_id({ category }) {
  try {
    const mappingData = await fs.readFile('calendar_mapping.json', 'utf-8');
    const mapping = JSON.parse(mappingData);
    return mapping[category] || null;
  } catch (error) {
    console.error('Error reading calendar mapping:', error);
    return null;
  }
};

async function search_location({ place_name }) {
    if (!place_name || place_name.trim() === '') return '';
    const apiKey = process.env.MAPS_API_KEY;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place_name)}&key=${apiKey}&language=ja`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.status === 'OK' && data.results.length > 0) {
            return data.results[0].formatted_address;
        }
        return '';
    } catch (error) {
        console.error('Google Maps API request failed:', error);
        return '';
    }
};

async function create_calendar_event({ calendarId, summary, start_time, end_time, location, description, category }) {
    try {
        console.log(`[Debug] Received in create_calendar_event:`, { summary, category });
        const event = { 
            summary, 
            location, 
            description, 
            start: {}, 
            end: {} 
        };
        
        if (start_time instanceof Date) {
            event.start.dateTime = toYyyyMmDdTHhMmSs(start_time);
            event.start.timeZone = 'Asia/Tokyo';
            
            if (end_time) {
                event.end.dateTime = toYyyyMmDdTHhMmSs(end_time);
            } else {
                const startDate = new Date(start_time);
                startDate.setHours(startDate.getHours() + 4);
                event.end.dateTime = toYyyyMmDdTHhMmSs(startDate);
            }
            event.end.timeZone = 'Asia/Tokyo';

        } else {
            event.start.date = start_time;
            event.end.date = end_time || start_time;
        }
        
        const res = await calendar.events.insert({ calendarId, resource: event });
        return { status: "success", event_url: res.data.htmlLink };
    } catch (error) {
        console.error(`Failed to create event for ${summary}:`, error);
        return { status: "error", message: error.message };
    }
};

function parseClientTime(fullDate, timeStr) {
    if (!timeStr || timeStr === '終日') {
        return { startTime: fullDate, endTime: fullDate };
    }
    
    // 数字、コロン、ハイフン以外のすべての文字を削除
    const cleanedTimeStr = String(timeStr).replace(/[^0-9:-]/g, '');

    const rangeMatch = cleanedTimeStr.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
    if (rangeMatch) {
        const start = new Date(`${fullDate}T00:00:00`);
        start.setHours(parseInt(rangeMatch[1]), parseInt(rangeMatch[2]));
        const end = new Date(`${fullDate}T00:00:00`);
        end.setHours(parseInt(rangeMatch[3]), parseInt(rangeMatch[4]));
        return { startTime: start, endTime: end };
    }
    
    const startMatch = cleanedTimeStr.match(/(\d{1,2}):(\d{2})/);
    if (startMatch) {
        const start = new Date(`${fullDate}T00:00:00`);
        start.setHours(parseInt(startMatch[1]), parseInt(startMatch[2]));
        return { startTime: start, endTime: null };
    }

    return { startTime: fullDate, endTime: fullDate };
}

function toYyyyMmDdTHhMmSs(d) {
    if (!d) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${day}T${h}:${min}:${s}`;
}

app.listen(port, () => {
  console.log(`サーバーが http://localhost:${port} で起動しました`);
});
