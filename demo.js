/*
 * LEAVE-TEN-O 포트폴리오 데모 전용 데이터 계층
 * - 원본 앱의 Supabase 클라이언트와 같은 모양(from().select().eq()...)으로 동작하는 가짜 DB
 * - 모든 데이터는 방문자 브라우저의 localStorage에만 저장되고 외부로 전송되지 않음
 * - 처음 열면 오늘 날짜 기준으로 샘플 계정 3개와 기본 캘린더(공지)를 채움
 */
(function () {
    // 같은 도메인(github.io)의 DAY-TEN-O 데모와 저장소가 섞이지 않도록 앱 키와 다른 접두어를 씀
    const DB_KEY = 'leaveteno_demo_db';
    const AUTH_KEY = 'leave_ten_o_auth';
    const STORAGE_PREFIXES = ['leaveteno_', 'leave_ten_o'];
    const START_ROOM = 'user_dongun';
    const DEMO_PIN = '0000';

    // 데모 첫 화면은 샘플 계정 '동건' (앱 스크립트가 주소를 읽기 전에 바꿔 둠)
    const params = new URLSearchParams(location.search);
    if (!params.get('room')) {
        params.set('room', START_ROOM);
        history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
    }

    /* ================= [DEMO: DATE HELPERS] ================= */
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
    const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const addMonths = (d, n) => {
        const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
        x.setDate(Math.min(d.getDate(), new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()));
        return x;
    };
    const today = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
    const datesBetween = (start, end) => {
        const out = [];
        for (let d = parse(start); d <= parse(end); d = addDays(d, 1)) out.push(fmt(d));
        return out;
    };

    // '동건' 계정의 입대일 (오늘로부터 10개월 전)
    const defaultEnlistDate = () => fmt(addMonths(today(), -10));

    /* ================= [DEMO: STORAGE] ================= */
    let memory = null; // localStorage를 쓸 수 없는 환경(사생활 보호 모드 등)용 대체 저장소

    function writeDB(db) {
        memory = db;
        try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) {}
    }

    function readDB() {
        try {
            const raw = localStorage.getItem(DB_KEY);
            if (raw) return (memory = JSON.parse(raw));
        } catch (e) {}
        if (!memory) writeDB(buildSeed());
        return memory;
    }

    function reset() {
        try {
            Object.keys(localStorage)
                .filter(k => STORAGE_PREFIXES.some(p => k.startsWith(p)))
                .forEach(k => localStorage.removeItem(k));
        } catch (e) {}
        memory = null;
        location.replace(location.pathname); // 첫 화면('동건' 계정)으로
    }

    /* ================= [DEMO: QUERY BUILDER] ================= */
    const clone = v => JSON.parse(JSON.stringify(v));
    const same = (a, b) => a === b || (a != null && b != null && String(a) === String(b));

    // SQL LIKE 패턴(%, _)을 정규식으로 변환
    function likeToRegex(pattern) {
        const src = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
        return new RegExp(`^${src}$`, 's');
    }

    // 'room_id.eq.default' / 'room_id.is.null' 형태의 or() 조건 해석
    function parseCondition(expr) {
        const [col, op, ...rest] = expr.split('.');
        const value = rest.join('.');
        if (op === 'is' && value === 'null') return r => r[col] == null;
        if (op === 'eq') return r => same(r[col], value);
        return () => false;
    }

    class Query {
        constructor(table) {
            this.table = table;
            this.action = 'select';
            this.filters = [];
            this.payload = null;
            this.returning = false;
            this.sortKey = null;
            this.ascending = true;
            this.max = null;
        }

        select() { if (this.action !== 'select') this.returning = true; return this; }
        insert(rows) { this.action = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
        update(values) { this.action = 'update'; this.payload = values; return this; }
        delete() { this.action = 'delete'; return this; }

        eq(col, val) { this.filters.push(r => same(r[col], val)); return this; }
        gte(col, val) { this.filters.push(r => r[col] >= val); return this; }
        lte(col, val) { this.filters.push(r => r[col] <= val); return this; }
        not(col, op, val) { if (op === 'eq') this.filters.push(r => !same(r[col], val)); return this; }
        in(col, vals) { const set = new Set(vals.map(String)); this.filters.push(r => set.has(String(r[col]))); return this; }
        like(col, pattern) { const re = likeToRegex(pattern); this.filters.push(r => typeof r[col] === 'string' && re.test(r[col])); return this; }
        or(expr) { const conds = expr.split(',').map(parseCondition); this.filters.push(r => conds.some(c => c(r))); return this; }
        order(col, opts = {}) { this.sortKey = col; this.ascending = opts.ascending !== false; return this; }
        limit(n) { this.max = n; return this; }

        // await 시점에 실행 (Supabase 빌더처럼 thenable)
        then(onFulfilled, onRejected) {
            return new Promise(resolve => resolve(this.run())).then(onFulfilled, onRejected);
        }

        run() {
            const db = readDB();
            const rows = db.tables[this.table] || (db.tables[this.table] = []);
            const match = r => this.filters.every(f => f(r));
            let data;

            if (this.action === 'insert') {
                data = this.payload.map(p => ({ is_completed: false, room_id: null, ...p, id: ++db.lastId }));
                rows.push(...data);
                writeDB(db);
            } else if (this.action === 'update') {
                data = rows.filter(match);
                data.forEach(r => Object.assign(r, this.payload));
                writeDB(db);
            } else if (this.action === 'delete') {
                data = rows.filter(match);
                db.tables[this.table] = rows.filter(r => !match(r));
                writeDB(db);
            } else {
                data = rows.filter(match);
                if (this.sortKey) {
                    const k = this.sortKey, dir = this.ascending ? 1 : -1;
                    data.sort((a, b) => (typeof a[k] === 'number' ? a[k] - b[k] : String(a[k]).localeCompare(String(b[k]))) * dir);
                }
                if (this.max != null) data = data.slice(0, this.max);
                return { data: clone(data), error: null };
            }
            return { data: this.returning ? clone(data) : null, error: null };
        }
    }

    function createClient() {
        readDB(); // 앱 초기화 전에 샘플 데이터를 준비
        return {
            from: table => new Query(table),
            // 데모는 서버가 없으므로 실시간 동기화 채널은 아무 일도 하지 않음
            channel: () => { const ch = { on: () => ch, subscribe: () => ch }; return ch; }
        };
    }

    /* ================= [DEMO: SAMPLE DATA] ================= */
    function buildSeed() {
        const t = today();
        const y = t.getFullYear(), m = t.getMonth();
        const lastDay = new Date(y, m + 1, 0).getDate();
        const thisMonth = n => fmt(new Date(y, m, Math.min(n, lastDay)));
        const monthsAgo = (k, n) => fmt(new Date(y, m - k, n));
        const fromToday = n => fmt(addDays(t, n));

        const rows = [];
        let lastId = 0;
        let eventSeq = Date.now();
        let grantSeq = eventSeq - 1000000;
        const add = (room, date, task, isCompleted = false) => rows.push({ id: ++lastId, date, task: JSON.stringify(task), is_completed: isCompleted, room_id: room });
        const leaveKey = { '연가': 'annual', '포상': 'reward', '위로': 'comfort' };

        // 원본 앱과 같은 구조: 계정 목록은 기본 캘린더의 'profile_v1' 줄에, 계정 데이터는 room_id = roomKey 로 저장
        const profiles = [
            { name: '동건', roomKey: START_ROOM, enlist: addMonths(t, -10) },   // 상병
            { name: '민준', roomKey: 'user_minjun', enlist: addMonths(t, -5) }, // 일병
            { name: '지훈', roomKey: 'user_jihun', enlist: addMonths(t, -16) }  // 병장, 전역 두 달 전
        ];
        profiles.forEach(p => add('default', 'profile_v1', { name: p.name, enlistmentDate: fmt(p.enlist), pinCode: DEMO_PIN, roomKey: p.roomKey }));

        // 계정 하나의 휴가·일정·할 일·메모를 채우는 도우미
        function seedRoom(room, build) {
            const history = [];
            const usage = { annual: 0, reward: 0, comfort: 0 };
            const granted = { annual: 0, reward: 0, comfort: 0 };
            const api = {
                grant(type, reason, days, date) {
                    const g = { id: ++grantSeq, type, reason, days, date };
                    history.push(g);
                    granted[leaveKey[type]] += days;
                    return g;
                },
                // 여러 날 일정은 날짜마다 같은 내용을 한 줄씩 저장 (원본과 같은 방식)
                event(start, end, o) {
                    const days = datesBetween(start, end);
                    const isLeave = !!leaveKey[o.leaveType];
                    if (isLeave) usage[leaveKey[o.leaveType]] += days.length;
                    const payload = {
                        is_json_event: true, type: o.type, color: o.color, title: o.title,
                        startDate: start, endDate: end, startTime: o.startTime || '', endTime: o.endTime || '', memo: o.memo || '',
                        eventId: ++eventSeq, useDays: isLeave ? days.length : 0, leaveType: o.leaveType,
                        usedHolidayId: o.grant ? o.grant.id : null, calendar_type: 'basic'
                    };
                    days.forEach(d => add(room, d, payload));
                },
                leave(start, end, g, memo) {
                    const colors = { '연가': 'var(--event-vacation)', '포상': 'var(--event-reward)', '위로': 'var(--event-comfort)' };
                    api.event(start, end, { type: g.type, leaveType: g.type, color: colors[g.type], title: g.reason, grant: g, memo });
                },
                todo(date, content, done = false) { add(room, date, { content, calendar_type: 'basic' }, done); },
                memo(date, content) { add(room, 'memo_' + date, { content }); },
                chips(list) { add(room, 'custom_categories', list); }
            };
            build(api);
            if (history.length) {
                add(room, 'holiday_data_v2', {
                    annual: { granted: granted.annual, used: usage.annual },
                    reward: { granted: granted.reward, used: usage.reward },
                    comfort: { granted: granted.comfort, used: usage.comfort },
                    history
                });
            }
        }

        const [dongun, minjun, jihun] = profiles;
        const out = (title, memo) => ({ type: '외출 (정기외출)', leaveType: '외출', color: 'var(--event-out)', title, memo });

        // 동건 (상병) — DAY-TEN-O 데모와 같은 이야기
        seedRoom(dongun.roomKey, r => {
            const annual = r.grant('연가', '정기 연가', 24, fmt(dongun.enlist));
            const shooting = r.grant('포상', '사격 우수자', 2, fmt(addMonths(dongun.enlist, 2)));
            r.grant('포상', '체력검정 특급', 1, fmt(addMonths(dongun.enlist, 4)));
            r.grant('위로', '전술훈련 위로', 2, fmt(addMonths(dongun.enlist, 6)));
            const model = r.grant('포상', '모범 병사 표창', 2, fromToday(-20));
            r.chips([{ name: '면회', color: 'var(--accent-pink)' }]);

            r.leave(monthsAgo(4, 10), monthsAgo(4, 13), annual, '첫 정기휴가. 집밥 실컷 먹기');
            r.leave(monthsAgo(3, 18), monthsAgo(3, 19), shooting);
            r.event(thisMonth(6), thisMonth(6), out('부모님과 점심', '부대 앞 식당 12시'));
            r.leave(thisMonth(10), thisMonth(12), annual, '친구 결혼식 참석');
            r.event(thisMonth(15), thisMonth(15), { type: '외출 (평일외출)', leaveType: '외출', color: 'var(--event-out)', title: '치과 진료' });
            r.event(thisMonth(20), thisMonth(21), { type: '외박', leaveType: '외박', color: 'var(--event-sleep)', title: '동기들과 외박' });
            r.leave(thisMonth(24), thisMonth(25), model);
            r.event(thisMonth(28), thisMonth(28), { type: '면회', leaveType: '면회', color: 'var(--accent-pink)', title: '친구 면회' });

            r.todo(fromToday(0), '세탁물 걷기', true);
            r.todo(fromToday(0), '부모님께 전화드리기');
            r.todo(fromToday(1), '체력단련 3km 달리기');
            r.memo(fromToday(-12), '전역하면 하고 싶은 것\n1. 운전면허 따기\n2. 혼자 여행 가기\n3. 포트폴리오 정리');
            r.memo(fromToday(-3), '휴가 때 할 것\n- 첫날은 집에서 푹 쉬기\n- 친구들이랑 저녁\n- 미용실 예약');
        });

        // 민준 (일병) — 첫 정기휴가를 앞둔 신병
        seedRoom(minjun.roomKey, r => {
            const annual = r.grant('연가', '정기 연가', 24, fmt(minjun.enlist));
            r.grant('포상', '신병 우수 표창', 1, fmt(addMonths(minjun.enlist, 2)));

            r.leave(monthsAgo(2, 8), monthsAgo(2, 9), annual, '신병 위로 휴가');
            r.event(thisMonth(8), thisMonth(8), out('가족 면회 겸 외출'));
            r.leave(thisMonth(17), thisMonth(20), annual, '첫 정기휴가!');
            r.event(thisMonth(27), thisMonth(28), { type: '외박', leaveType: '외박', color: 'var(--event-sleep)', title: '부모님과 외박' });

            r.todo(fromToday(0), '부모님 선물 고르기');
            r.todo(fromToday(2), '사격 예습');
            r.memo(fromToday(-5), '첫 정기휴가 계획\n- 집 도착하면 바로 잠\n- 동네 친구들 만나기\n- 휴대폰 요금제 바꾸기');
        });

        // 지훈 (병장) — 전역을 두 달 앞두고 남은 휴가를 쓰는 중
        seedRoom(jihun.roomKey, r => {
            const annual = r.grant('연가', '정기 연가', 24, fmt(jihun.enlist));
            const sniper = r.grant('포상', '사격 만발', 2, fmt(addMonths(jihun.enlist, 3)));
            const leader = r.grant('포상', '분대장 근무', 3, fmt(addMonths(jihun.enlist, 9)));
            const drill = r.grant('위로', '대대 전술훈련 위로', 2, fmt(addMonths(jihun.enlist, 12)));

            r.leave(monthsAgo(10, 3), monthsAgo(10, 7), annual);
            r.leave(monthsAgo(6, 12), monthsAgo(6, 17), annual, '여름 휴가');
            r.leave(monthsAgo(4, 20), monthsAgo(4, 21), sniper);
            r.leave(monthsAgo(2, 5), monthsAgo(2, 6), drill);
            r.event(thisMonth(4), thisMonth(4), out('취업 박람회 다녀오기'));
            r.leave(thisMonth(16), thisMonth(18), leader, '자격증 시험 응시');

            r.todo(fromToday(0), '후임 인수인계 노트 정리');
            r.todo(fromToday(1), '전역 후 이력서 준비', true);
            r.memo(fromToday(-7), '말년 휴가 계획\n남은 연가 13일은 전역 직전에 몰아서 쓰기');
            r.memo(fromToday(-1), '후임에게 넘길 것\n- 근무표 짜는 방법\n- 분대 물품 목록\n- 휴가 신청 순서');
        });

        // 기본 캘린더: 모두가 함께 보는 부대 일정과 관리자 공지
        const unit = (title, memo) => ({ type: '부대 일정', leaveType: '부대 일정', color: 'var(--accent-teal)', title, memo });
        seedRoom('default', r => {
            r.event(thisMonth(5), thisMonth(5), unit('정신전력교육', '10:00 대대 강당'));
            r.event(thisMonth(12), thisMonth(12), unit('체력검정', '3km 달리기 · 팔굽혀펴기 · 윗몸일으키기'));
            r.event(thisMonth(14), thisMonth(14), unit('부대 체육대회'));
            r.event(thisMonth(22), thisMonth(24), unit('대대 전술훈련', '훈련 기간에는 휴가·외출이 제한됩니다'));
            // 공지 (오래된 것부터 넣어야 '최신 공지'와 '최신순' 정렬이 자연스러움)
            r.memo(fromToday(-9), '12월 휴가 신청 안내\n12월에 휴가를 갈 인원은 이번 달 25일까지 행정반에 신청해 주세요.');
            r.memo(fromToday(-4), '동절기 복장 안내\n다음 주부터 일과 중 방한 내피 착용이 허용됩니다.');
            r.memo(fromToday(0), 'LEAVE-TEN-O 사용 안내\n오른쪽 위 프로필에서 내 계정을 만들거나 바꿀 수 있어요. 휴가와 일정은 계정마다 따로 관리됩니다.');
        });

        // 첫 방문은 '동건' 계정이 잠금 해제된 상태로 시작
        try { localStorage.setItem(AUTH_KEY, 'true'); } catch (e) {}

        return { version: 1, lastId, tables: { todos: rows } };
    }

    window.DemoDB = { createClient, reset, defaultEnlistDate, DEMO_PIN };
})();
