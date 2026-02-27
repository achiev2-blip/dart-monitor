/**
 * Gemini 채팅 위젯 — 독립 모듈
 * 
 * 사용법: <link rel="stylesheet" href="gemini-chat.css">
 *         <script src="gemini-chat.js"></script>
 *         한 줄로 어떤 페이지에든 추가 가능
 * 
 * 기능: 플로팅 버튼 → 드래그 가능 채팅창 → Gemini 대화
 * 독립: 다른 페이지 JS에 의존 없음
 */

(function () {
    'use strict';

    // ── 설정 ──
    const API_KEY = 'dartmonitor-2024';
    const CHAT_API = `/api/gemini/chat?api_key=${API_KEY}`;

    // 대화 히스토리 (localStorage에 저장하여 페이지 이동 후에도 유지)
    const STORAGE_KEY = 'gemini-chat-' + location.pathname;
    let chatHistory = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    let isWaiting = false;

    // 히스토리 저장 헬퍼
    function saveHistory() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(chatHistory));
    }

    // 현재 보고 있는 종목 컨텍스트 (페이지에서 설정 가능)
    window.geminiChatContext = window.geminiChatContext || {};

    // ── DOM 생성 ──
    function createWidget() {
        // CSS 로드 확인 — 없으면 자동 로드
        if (!document.querySelector('link[href*="gemini-chat.css"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'gemini-chat.css';
            document.head.appendChild(link);
        }

        // 플로팅 버튼 생성
        const btn = document.createElement('button');
        btn.className = 'gemini-chat-btn';
        btn.innerHTML = '✦';
        btn.title = 'Gemini 채팅';
        btn.onclick = toggleChat;
        document.body.appendChild(btn);

        // 채팅 컨테이너 생성
        const container = document.createElement('div');
        container.className = 'gemini-chat-container';
        container.id = 'geminiChat';
        container.innerHTML = `
            <div class="gemini-chat-header" id="geminiChatHeader">
                <div class="gemini-chat-header-title">
                    <span class="dot"></span>
                    <span>Gemini 어시스턴트</span>
                </div>
                <button class="gemini-chat-close" onclick="window.toggleGeminiChat()">✕</button>
            </div>
            <div class="gemini-chat-messages" id="geminiMessages">
                <div class="gemini-welcome">
                    <div class="icon">✦</div>
                    <div>Gemini 주식 어시스턴트입니다</div>
                    <div>종목, 시장, 분석에 대해 질문하세요</div>
                </div>
            </div>
            <div class="gemini-chat-input-area">
                <textarea class="gemini-chat-input" id="geminiInput" 
                    placeholder="메시지를 입력하세요..." 
                    rows="1"></textarea>
                <button class="gemini-chat-send" id="geminiSend" onclick="window.sendGeminiChat()">전송</button>
            </div>
        `;
        document.body.appendChild(container);

        // 입력창 이벤트
        const input = document.getElementById('geminiInput');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                window.sendGeminiChat();
            }
        });

        // 입력창 자동 높이 조절
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 80) + 'px';
        });

        // 드래그 기능 초기화
        initDrag(container, document.getElementById('geminiChatHeader'));

        // 이전 대화 이력 DOM 복원
        if (chatHistory.length > 0) {
            const messages = document.getElementById('geminiMessages');
            const welcome = messages.querySelector('.gemini-welcome');
            if (welcome) welcome.remove();
            chatHistory.forEach(h => {
                const uMsg = document.createElement('div');
                uMsg.className = 'gemini-msg user';
                uMsg.textContent = h.user;
                messages.appendChild(uMsg);
                const aMsg = document.createElement('div');
                aMsg.className = 'gemini-msg ai';
                aMsg.textContent = h.ai;
                messages.appendChild(aMsg);
            });
        }
    }

    // ── 채팅창 토글 ──
    function toggleChat() {
        const chat = document.getElementById('geminiChat');
        const btn = document.querySelector('.gemini-chat-btn');
        if (chat.classList.contains('open')) {
            chat.classList.remove('open');
            btn.classList.remove('active');
        } else {
            chat.classList.add('open');
            btn.classList.add('active');
            // 포커스
            setTimeout(() => {
                document.getElementById('geminiInput')?.focus();
            }, 100);
        }
    }
    window.toggleGeminiChat = toggleChat;

    // ── 메시지 전송 ──
    async function sendChat() {
        if (isWaiting) return;

        const input = document.getElementById('geminiInput');
        const message = input.value.trim();
        if (!message) return;

        // 사용자 메시지 추가
        addMessage(message, 'user');
        input.value = '';
        input.style.height = 'auto';

        // 전송 버튼 비활성화
        isWaiting = true;
        const sendBtn = document.getElementById('geminiSend');
        sendBtn.disabled = true;
        sendBtn.textContent = '...';

        // 타이핑 인디케이터 표시
        showTyping();

        try {
            const resp = await fetch(CHAT_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    context: window.geminiChatContext || {},
                    history: chatHistory
                })
            });

            removeTyping();

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status }));
                addMessage(`오류: ${err.error || '응답 실패'}`, 'error');
                return;
            }

            const data = await resp.json();
            if (data.ok && data.reply) {
                addMessage(data.reply, 'ai');
                // 히스토리에 추가 + localStorage 저장
                chatHistory.push({ user: message, ai: data.reply });
                if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
                saveHistory();
            } else {
                addMessage(`오류: ${data.error || '알 수 없는 오류'}`, 'error');
            }
        } catch (e) {
            removeTyping();
            addMessage(`네트워크 오류: ${e.message}`, 'error');
        } finally {
            isWaiting = false;
            sendBtn.disabled = false;
            sendBtn.textContent = '전송';
        }
    }
    window.sendGeminiChat = sendChat;

    // ── 메시지 DOM 추가 ──
    function addMessage(text, type) {
        const messages = document.getElementById('geminiMessages');
        // 환영 메시지 제거 (첫 메시지 시)
        const welcome = messages.querySelector('.gemini-welcome');
        if (welcome) welcome.remove();

        const msg = document.createElement('div');
        msg.className = `gemini-msg ${type}`;
        msg.textContent = text;
        messages.appendChild(msg);

        // 스크롤 하단으로
        messages.scrollTop = messages.scrollHeight;
    }

    // ── 타이핑 인디케이터 ──
    function showTyping() {
        const messages = document.getElementById('geminiMessages');
        const typing = document.createElement('div');
        typing.className = 'gemini-typing';
        typing.id = 'geminiTyping';
        typing.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
        messages.appendChild(typing);
        messages.scrollTop = messages.scrollHeight;
    }

    function removeTyping() {
        const typing = document.getElementById('geminiTyping');
        if (typing) typing.remove();
    }

    // ── 드래그 기능 ──
    function initDrag(element, handle) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        handle.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = element.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;

            // 위치를 fixed 기준으로 전환
            element.style.right = 'auto';
            element.style.bottom = 'auto';
            element.style.left = startLeft + 'px';
            element.style.top = startTop + 'px';

            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', stopDrag);
            e.preventDefault();
        });

        function onDrag(e) {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            let newLeft = startLeft + dx;
            let newTop = startTop + dy;

            // 화면 경계 제한
            const maxLeft = window.innerWidth - element.offsetWidth;
            const maxTop = window.innerHeight - element.offsetHeight;
            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            element.style.left = newLeft + 'px';
            element.style.top = newTop + 'px';
        }

        function stopDrag() {
            isDragging = false;
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', stopDrag);
        }

        // 터치 지원 (모바일)
        handle.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            isDragging = true;
            startX = touch.clientX;
            startY = touch.clientY;
            const rect = element.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            element.style.right = 'auto';
            element.style.bottom = 'auto';
            element.style.left = startLeft + 'px';
            element.style.top = startTop + 'px';

            document.addEventListener('touchmove', onTouchDrag, { passive: false });
            document.addEventListener('touchend', stopTouchDrag);
        });

        function onTouchDrag(e) {
            if (!isDragging) return;
            e.preventDefault();
            const touch = e.touches[0];
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            let newLeft = startLeft + dx;
            let newTop = startTop + dy;
            const maxLeft = window.innerWidth - element.offsetWidth;
            const maxTop = window.innerHeight - element.offsetHeight;
            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));
            element.style.left = newLeft + 'px';
            element.style.top = newTop + 'px';
        }

        function stopTouchDrag() {
            isDragging = false;
            document.removeEventListener('touchmove', onTouchDrag);
            document.removeEventListener('touchend', stopTouchDrag);
        }
    }

    // ── 초기화 ──
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createWidget);
    } else {
        createWidget();
    }

})();
