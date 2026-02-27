const express = require('express');
const axios = require('axios');
const { saveJSON } = require('../utils/file-io');
const router = express.Router();

// 텔레그램 전송
router.post('/telegram', async (req, res) => {
    const { token, chatId, text } = req.body;
    if (!token || !chatId || !text) return res.status(400).json({ error: '필수값 누락' });

    try {
        const resp = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        }, { timeout: 15000 });

        res.json(resp.data);
    } catch (e) {
        const errMsg = e.response?.data?.description || e.message;
        console.error(`[TG] ${errMsg}`);
        res.status(500).json({ error: errMsg });
    }
});

// 컨텍스트 분석 결과를 텔레그램으로 전송
router.post('/context/send-telegram', async (req, res) => {
    const { code, token, chatId } = req.body;
    if (!token || !chatId) return res.status(400).json({ error: 'token, chatId 필요' });

    const { loadContext, loadStockContext } = req.app.locals.contextHelpers;

    try {
        let text = '';
        if (code === 'market') {
            const m = loadContext('market.json') || {};
            text = `📊 *MARKET 분석 업데이트*\n`;
            text += `KOSPI: ${m.kospi || '-'} (${m.kospiUp ? '+' : ''}${m.kospiChange || 0}%)\n`;
            text += `날짜: ${m.lastDate || '-'}\n\n`;
            if (m.note) text += `📝 ${m.note}\n\n`;
            if (m.keyInsights && m.keyInsights.length) {
                text += `🔑 *KEY INSIGHTS*\n`;
                m.keyInsights.forEach((ins, i) => { text += `${i + 1}. ${ins}\n`; });
                text += '\n';
            }
            if (m.nextAction) text += `⏭ *NEXT:* ${m.nextAction}\n`;
        } else {
            const s = loadStockContext(code);
            if (!s) return res.status(404).json({ error: '종목 없음' });
            text = `🏢 *${s.name}* (${s.code})\n`;
            if (s.price) text += `가격: ${s.price.toLocaleString()}원 (${(s.change || 0) >= 0 ? '+' : ''}${s.change || 0}%)\n`;
            text += `날짜: ${s.lastDate || '-'}\n\n`;
            if (s.context) text += `📝 ${s.context}\n\n`;
            if (s.keyInsights && s.keyInsights.length) {
                text += `🔑 *KEY INSIGHTS*\n`;
                s.keyInsights.forEach((ins, i) => { text += `${i + 1}. ${ins}\n`; });
                text += '\n';
            }
            if (s.events && s.events.length) {
                text += `📅 *EVENTS*\n`;
                s.events.forEach(ev => { text += `• ${ev.title} [${ev.status}] ${ev.timing || ''}\n`; });
                text += '\n';
            }
            if (s.nextAction) text += `⏭ *NEXT:* ${s.nextAction}\n`;
        }

        const resp = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        }, { timeout: 15000 });

        console.log(`[CTX-TG] ${code} 전송 완료`);
        res.json(resp.data);
    } catch (e) {
        const errMsg = e.response?.data?.description || e.message;
        console.error(`[CTX-TG] ${errMsg}`);
        res.status(500).json({ error: errMsg });
    }
});

// 전송 이력
router.get('/sent', (req, res) => {
    res.json(req.app.locals.sentItems);
});

router.post('/sent', (req, res) => {
    const sentItems = req.app.locals.sentItems;
    const { items } = req.body;
    if (items && typeof items === 'object') {
        const now = Date.now();
        for (const key of Object.keys(items)) {
            sentItems[key] = now;
        }
        saveJSON('sent_items.json', sentItems);
    }
    res.json({ ok: true, count: Object.keys(sentItems).length });
});

module.exports = router;
