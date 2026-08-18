// === 설정 ===
var CLAUDE_API_KEY = 'YOUR_CLAUDE_API_KEY_HERE'; // Apps Script 편집기 좌측 "프로젝트 설정 > 스크립트 속성"에 넣어도 됨
var SHEET_SELLER = '판매자정보';
var SHEET_PROPOSAL = '제안서요청';
var SHEET_LOG = '방문로그';
var SHEET_USERS = '사용자목록';
var SHEET_DELETED = '삭제된 판매자';
var SHEET_TASKS = '업무리스트';
var SHEET_TASKS_DONE = '완료된업무';
var SHEET_GEO = '지점위치';   // 지점별 좌표(위도/경도). 지도 기능용. 지점당 1행.
var SHEET_GEO_SRC = '지점주소'; // 사용자가 엑셀에서 붙여넣는 원본 주소 시트(은행명/지점명/주소)
var DATA_SPREADSHEET_ID = '1z1XB9HUxc8AtvDPXPRnzljLnXR05FJtz1Y3ChfW2iq4'; // 시스템 데이터 전용 스프레드시트("방카 활동의 기록 (시스템 데이터)")

// 실제 데이터가 저장된 스프레드시트. 이 스크립트 파일 자체는 기존 "은행분석 및 방문정리" 파일에 묶여있지만,
// 데이터는 별도 파일로 분리되어 있으므로 getActiveSpreadsheet() 대신 이 함수를 사용한다.
var _cachedSS = null;
function getSS() {
  if (!_cachedSS) _cachedSS = SpreadsheetApp.openById(DATA_SPREADSHEET_ID);
  return _cachedSS;
}

// === 시트 읽기 캐시 ==========================================================
// 기존에는 요청 하나마다 시트를 통째로 다시 읽어서(getDataRange) 조회/입력이 모두 느렸다.
// - readRows      : 같은 실행(요청) 안에서만 재사용. 행 번호로 쓰기를 하는 핸들러가 사용(항상 최신).
// - readRowsCached: CacheService에 저장해 요청 사이에도 재사용. 읽기 전용 핸들러가 사용.
// 쓰기가 일어난 요청은 doGet 끝에서 캐시를 통째로 무효화하므로 오래된 데이터가 남지 않는다.
var _memRows = {};
var _memFromCache = {}; // 이 데이터가 캐시에서 온 것인지 표시
var CACHE_SECONDS = 21600; // Apps Script 캐시 최대치(6시간)
var CACHE_CHUNK = 90 * 1024; // 캐시 값 1건 한도(100KB)보다 작게 잘라 저장
var CACHE_MAX_CHUNKS = 60;

// 시트에서 직접 읽는다. 같은 실행 안에서는 한 번만 읽는다.
// 행 번호를 계산해서 그 자리에 쓰는 핸들러는 반드시 이 함수를 써야 한다.
// (캐시에서 온 데이터로 행 번호를 계산하면 엉뚱한 행에 쓸 수 있으므로,
//  메모리에 있는 값이 캐시 출처면 버리고 시트에서 다시 읽는다)
function readRows(sheetName) {
  if (_memRows[sheetName] && !_memFromCache[sheetName]) return _memRows[sheetName];
  var sheet = getSS().getSheetByName(sheetName);
  var rows = sheet ? sheet.getDataRange().getValues() : [];
  _memRows[sheetName] = rows;
  _memFromCache[sheetName] = false;
  return rows;
}

// getValues()가 돌려주는 Date 객체를 JSON으로 손실 없이 넣고 빼기 위한 표시.
function _rowsReplacer(key, value) {
  var raw = this[key];
  if (raw instanceof Date) return '\u0000D' + raw.getTime();
  return value;
}
function _rowsReviver(key, value) {
  if (typeof value === 'string' && value.charCodeAt(0) === 0 && value.charAt(1) === 'D') {
    return new Date(Number(value.substring(2)));
  }
  return value;
}

// 캐시 세대(version). 무효화는 이 키를 지우는 것으로 끝난다(지워지면 자동으로 새로 읽음).
function _cacheVersion(sheetName) {
  var cache = CacheService.getScriptCache();
  var key = 'VER:' + sheetName;
  var v = cache.get(key);
  if (!v) {
    v = String(new Date().getTime()) + '_' + Math.floor(Math.random() * 100000);
    cache.put(key, v, CACHE_SECONDS);
  }
  return v;
}

function readRowsCached(sheetName) {
  if (_memRows[sheetName]) return _memRows[sheetName];
  var cache = CacheService.getScriptCache();
  var prefix = 'ROWS:' + sheetName + ':' + _cacheVersion(sheetName) + ':';
  try {
    var count = cache.get(prefix + 'n');
    if (count) {
      var n = Number(count);
      var keys = [];
      for (var i = 0; i < n; i++) keys.push(prefix + i);
      var got = cache.getAll(keys);
      var buf = '';
      var complete = true;
      for (i = 0; i < n; i++) {
        var part = got[prefix + i];
        if (part === undefined || part === null) { complete = false; break; }
        buf += part;
      }
      if (complete) {
        var cachedRows = JSON.parse(buf, _rowsReviver);
        _memRows[sheetName] = cachedRows;
        _memFromCache[sheetName] = true;
        return cachedRows;
      }
    }
  } catch (e) {
    // 캐시가 깨졌으면 그냥 시트에서 읽는다.
  }

  var rows = readRows(sheetName);
  if (rows.length === 0) return rows; // 시트가 아직 없는 상태는 캐시하지 않는다
  try {
    var text = JSON.stringify(rows, _rowsReplacer);
    var chunks = Math.ceil(text.length / CACHE_CHUNK);
    if (chunks <= CACHE_MAX_CHUNKS) {
      var entries = {};
      for (var c = 0; c < chunks; c++) {
        entries[prefix + c] = text.substring(c * CACHE_CHUNK, (c + 1) * CACHE_CHUNK);
      }
      entries[prefix + 'n'] = String(chunks);
      cache.putAll(entries, CACHE_SECONDS);
    }
  } catch (e2) {
    // 캐시 저장 실패는 무시(다음 요청에서 다시 읽으면 됨)
  }
  return rows;
}

var CACHED_SHEETS = [SHEET_SELLER, SHEET_PROPOSAL, SHEET_LOG, SHEET_USERS,
                     SHEET_DELETED, SHEET_TASKS, SHEET_TASKS_DONE, SHEET_GEO];

function invalidateAllCaches() {
  var keys = CACHED_SHEETS.map(function (n) { return 'VER:' + n; });
  try { CacheService.getScriptCache().removeAll(keys); } catch (e) {}
  _memRows = {};
  _memFromCache = {};
}

// 시트를 변경하는 action 목록. 이 요청이 끝나면 캐시를 버린다.
var MUTATING_ACTIONS = {
  commit: true, recordForSeller: true, logVisit: true, saveSellerFields: true,
  deleteVisitDay: true, updateProposal: true, updateSellerTitle: true,
  updateSellerName: true, addNewSeller: true, deleteSeller: true,
  login: true, addTask: true, editTask: true, completeTask: true,
  moveTask: true, setTaskAlarm: true, deleteCompletedTask: true,
  updateVisit: true, deleteVisit: true
};

// 일회성 유틸: 판매자정보 시트 K열(영업대상 체크박스) 308행부터 마지막행까지 체크박스로 채움.
// 셀 크기(행높이/열너비)는 건드리지 않고 데이터 유효성(체크박스)만 적용.
function fillCheckboxesK308() {
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var lastRow = sheet.getLastRow();
  if (lastRow < 308) return '308행 이후 데이터가 없습니다. lastRow=' + lastRow;
  var range = sheet.getRange(308, 11, lastRow - 308 + 1, 1); // K열 = 11번째 열
  range.insertCheckboxes();
  return 'K308:K' + lastRow + ' 체크박스 적용 완료';
}

// 일회성 유틸: 판매자정보 시트 K열(영업대상 체크박스) 308행부터 마지막행까지 TRUE로 채움.
// 셀 크기/체크박스 서식은 건드리지 않고 값만 TRUE로 설정.
function checkAllK308() {
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var lastRow = sheet.getLastRow();
  if (lastRow < 308) return '308행 이후 데이터가 없습니다. lastRow=' + lastRow;
  var numRows = lastRow - 308 + 1;
  var range = sheet.getRange(308, 11, numRows, 1); // K열 = 11번째 열
  var values = [];
  for (var i = 0; i < numRows; i++) values.push([true]);
  range.setValues(values);
  return 'K308:K' + lastRow + ' 전부 TRUE로 체크 완료';
}

function doGet(e) {
  var action = e.parameter.action;
  var text = e.parameter.text || '';
  var callback = e.parameter.callback;
  // 웹앱이 배포자(USER_DEPLOYING) 권한으로 실행되므로 Session.getActiveUser()로는
  // 접속자 본인을 식별할 수 없다. 로그인 시 발급한 서명 토큰을 검증해 신원을 확정한다.
  // (이메일 파라미터를 직접 신뢰하지 않으므로 위조로 남의 계정 접근 불가)
  _requestUserEmail = verifyToken(e.parameter.token || '');

  var result;
  try {
    if (action === 'record') {
      result = handleParse(text); // 음성을 항목별로 구조화만 함. 시트에는 아직 안 씀.
    } else if (action === 'reparse') {
      result = handleReparse(e.parameter.original || '', e.parameter.correction || '');
    } else if (action === 'commit') {
      result = handleCommit(JSON.parse(e.parameter.data)); // 사용자가 검토/수정한 내용을 최종 저장
    } else if (action === 'query') {
      result = handleQuery(text);
    } else if (action === 'queryByBranch') {
      result = handleQueryByBranch(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '');
    } else if (action === 'listBranches') {
      result = handleListBranches();
    } else if (action === 'listSellers') {
      result = handleListSellers(e.parameter.bank || '', e.parameter.branch || '');
    } else if (action === 'recordForSeller') {
      result = handleRecordForSeller(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '', e.parameter.text || '', e.parameter.date || '');
    } else if (action === 'logVisit') {
      result = handleLogVisit(e.parameter.bank || '', e.parameter.branch || '', e.parameter.date || '', e.parameter.visitType || '', e.parameter.note || '');
    } else if (action === 'branchVisits') {
      result = handleBranchVisits(e.parameter.bank || '', e.parameter.branch || '');
    } else if (action === 'updateVisit') {
      result = handleUpdateVisit(Number(e.parameter.row), e.parameter.bank || '', e.parameter.branch || '', e.parameter.note || '', e.parameter.visitType || '');
    } else if (action === 'deleteVisit') {
      result = handleDeleteVisit(Number(e.parameter.row), e.parameter.bank || '', e.parameter.branch || '');
    } else if (action === 'getSellerInfo') {
      result = handleGetSellerInfo(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '');
    } else if (action === 'saveSellerFields') {
      result = handleSaveSellerFields(JSON.parse(e.parameter.data));
    } else if (action === 'calendarDay') {
      result = handleCalendarDay(e.parameter.date || '');
    } else if (action === 'deleteVisitDay') {
      result = handleDeleteVisitDay(e.parameter.date || '', e.parameter.bank || '', e.parameter.branch || '');
    } else if (action === 'listProposals') {
      result = handleListProposals();
    } else if (action === 'updateProposal') {
      result = handleUpdateProposal(Number(e.parameter.rowIndex), JSON.parse(e.parameter.data));
    } else if (action === 'updateSellerTitle') {
      result = handleUpdateSellerTitle(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '', e.parameter.newTitle || '');
    } else if (action === 'updateSellerName') {
      result = handleUpdateSellerName(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '', e.parameter.newName || '');
    } else if (action === 'findArchivedSellers') {
      result = handleFindArchivedSellers(e.parameter.bank || '', e.parameter.seller || '', e.parameter.title || '');
    } else if (action === 'listUsers') {
      result = handleListUsers();
    } else if (action === 'login') {
      result = handleLogin(e.parameter.email || '', e.parameter.pin || '');
    } else if (action === 'getMe') {
      result = handleGetMe();
    } else if (action === 'listTasks') {
      result = handleListTasks();
    } else if (action === 'addTask') {
      result = handleAddTask(JSON.parse(e.parameter.data));
    } else if (action === 'editTask') {
      result = handleEditTask(e.parameter.id || '', JSON.parse(e.parameter.data));
    } else if (action === 'completeTask') {
      result = handleCompleteTask(e.parameter.id || '');
    } else if (action === 'moveTask') {
      result = handleMoveTask(e.parameter.id || '', e.parameter.direction || '');
    } else if (action === 'setTaskAlarm') {
      result = handleSetTaskAlarm(e.parameter.id || '', e.parameter.alarm || '');
    } else if (action === 'listCompletedTasks') {
      result = handleListCompletedTasks();
    } else if (action === 'deleteCompletedTask') {
      result = handleDeleteCompletedTask(e.parameter.id || '');
    } else if (action === 'addNewSeller') {
      result = handleAddNewSeller(e.parameter.bank || '', e.parameter.branch || '', e.parameter.sellerName || '', e.parameter.title || '');
    } else if (action === 'deleteSeller') {
      result = handleDeleteSeller(e.parameter.bank || '', e.parameter.branch || '', e.parameter.seller || '');
    } else if (action === 'dashboard') {
      result = handleDashboard();
    } else if (action === 'dashboardBank') {
      result = handleDashboardBank(e.parameter.bank || '');
    } else if (action === 'bootstrap') {
      result = handleBootstrap();
    } else if (action === 'mapData') {
      result = handleMapData();
    } else if (action === 'geoStatus') {
      result = handleGeoStatus();
    } else if (action === 'branchDetail') {
      result = handleBranchDetail(e.parameter.bank || '', e.parameter.branch || '', e.parameter.key || '');
    } else if (action === 'ownerAudit') {
      result = handleOwnerAudit();
    } else if (action === 'diagAs') {
      result = handleDiagAs(e.parameter.as || '', e.parameter.bank || '', e.parameter.branch || '');
    } else {
      result = { error: 'unknown action' };
    }
  } catch (err) {
    result = { error: err.message };
  }

  // 시트를 바꾼 요청이면, 변경 내용을 확실히 반영시킨 뒤 캐시를 버린다.
  if (MUTATING_ACTIONS[action]) {
    try { SpreadsheetApp.flush(); } catch (e2) {}
    invalidateAllCaches();
  }

  var body = callback ? callback + '(' + JSON.stringify(result) + ')' : JSON.stringify(result);
  return ContentService.createTextOutput(body)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

var KOREAN_DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
var KOREAN_DIGIT_MAP = { '영': '0', '일': '1', '이': '2', '삼': '3', '사': '4', '오': '5', '육': '6', '칠': '7', '팔': '8', '구': '9' };

function formatDateWithDay(date) {
  var base = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return base + '(' + KOREAN_DAY_NAMES[date.getDay()] + ')';
}

// UI에서 "yyyy-MM-dd" 형식으로 넘어온 날짜를 라벨로 변환한다. 비어있거나 형식이 잘못되면 오늘 날짜를 쓴다.
// 지난 날짜로 방문 기록을 남길 때 쓰인다 (정보 기록 카드의 날짜 선택).
function resolveDateLabel(dateStr) {
  var s = String(dateStr || '').trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(d.getTime())) return formatDateWithDay(d);
  }
  return formatDateWithDay(new Date());
}

// 은행명/지점명 음성인식 오류 보정: 띄어쓰기 제거 + 한글 숫자(구,육 등)와 아라비아 숫자를 동일하게 취급
function normalizeText(name) {
  var s = String(name || '').replace(/\s+/g, '');
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    out += KOREAN_DIGIT_MAP[ch] || ch;
  }
  return out;
}

function levenshtein(a, b) {
  a = a || ''; b = b || '';
  var dp = [];
  for (var i = 0; i <= a.length; i++) dp.push([i]);
  for (var j = 0; j <= b.length; j++) dp[0][j] = j;
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function similarity(a, b) {
  a = a || ''; b = b || '';
  if (!a.length && !b.length) return 1;
  var dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length, 1);
}

// 은행명/지점명 셀을 병합해두면, 병합된 아래쪽 행은 빈 칸으로 읽힌다.
// 바로 위 행의 값을 그대로 이어받은 것으로 간주해서 채워준다.
function fillMergedColumn(rows, colIndex) {
  var filled = [];
  var last = '';
  for (var i = 0; i < rows.length; i++) {
    var v = String(rows[i][colIndex] || '');
    // 머리글(0행)의 값은 아래로 이어지면 안 된다. 데이터 2행의 은행/지점 칸이 비어 있으면
    // "은행명 | 지점명"이라는 유령 지점이 만들어져 목록과 지도에 나타난다.
    if (i === 0) { filled.push(v); continue; }
    if (v) last = v;
    filled.push(last);
  }
  return filled;
}

// 일부만 말해도(부분 일치) 같은 곳으로 인식한다 ("구월동" -> "구월동종합금융센터")
function textMatches(storedNorm, spokenNorm) {
  if (!storedNorm || !spokenNorm) return false;
  return storedNorm === spokenNorm ||
    storedNorm.indexOf(spokenNorm) !== -1 ||
    spokenNorm.indexOf(storedNorm) !== -1;
}

// 같은 은행 내에 이미 등록된 지점명 중, 말한 지점명(부분 발화/오인식 포함)과 가장 비슷한 풀네임을 찾는다.
// 일치하는 후보가 없으면(완전히 새 지점) 말한 그대로를 돌려준다. 은행명은 사용자가 말한 대로 고정(임의 보정 안 함).
function resolveBranchName(rows, bankName, spokenBranch) {
  var normBank = normalizeText(bankName);
  var normSpoken = normalizeText(spokenBranch);
  var fallback = String(spokenBranch || '').trim();
  if (!normBank || !normSpoken) return fallback;

  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);
  var candidates = {}; // normBranch -> 풀네임
  for (var i = 1; i < rows.length; i++) {
    if (!textMatches(normalizeText(bankCol[i]), normBank)) continue;
    var full = String(branchCol[i] || '').trim();
    if (full) candidates[normalizeText(full)] = full;
  }

  var bestFull = null;
  var bestScore = -1;
  Object.keys(candidates).forEach(function (normFull) {
    var score;
    if (normFull === normSpoken) score = 1;
    else if (normFull.indexOf(normSpoken) !== -1 || normSpoken.indexOf(normFull) !== -1) score = 0.9;
    else score = similarity(normFull, normSpoken);
    if (score > bestScore) {
      bestScore = score;
      bestFull = candidates[normFull];
    }
  });

  return bestScore >= 0.55 ? bestFull : fallback;
}

// 은행명+지점명이 모두 일치하는 행만 같은 그룹으로 취급한다 (은행이 다르면 절대 같은 지점으로 보지 않음).
// 지점명은 resolveBranchName으로 먼저 풀네임을 확정한 뒤, 그 풀네임과 정확히 일치하는 행만 묶는다.
function findMatchingGroup(rows, bankName, branchName) {
  var normBank = normalizeText(bankName);
  if (!normBank || !String(branchName || '').trim()) return []; // 은행/지점 중 하나라도 비어있으면 매칭하지 않음 (임의 추측 금지)

  var canonicalBranch = resolveBranchName(rows, bankName, branchName);
  var normBranch = normalizeText(canonicalBranch);

  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);
  var group = [];
  for (var i = 1; i < rows.length; i++) {
    if (textMatches(normalizeText(bankCol[i]), normBank) && normalizeText(branchCol[i]) === normBranch) {
      group.push(i);
    }
  }
  return group;
}

// 정확히 같거나, 한쪽이 다른 쪽을 포함하면("세진" ⊂ "박세진") 높은 점수를 주고, 그 외엔 유사도로 채점한다.
function fuzzyNameScore(stored, spoken) {
  var s = normalizeText(stored);
  var p = normalizeText(spoken);
  if (!s || !p) return 0;
  if (s === p) return 1;
  if (s.indexOf(p) !== -1 || p.indexOf(s) !== -1) return 0.9;
  return similarity(s, p);
}

// 같은 은행+지점 그룹 내에서, 음성 인식이 부정확해도(성을 빼고 부르는 등) 가장 그럴듯한 기존 판매자 행을 찾는다.
// 판매자명을 말하지 않았으면(은행+지점만 언급) 그 그룹의 대표 행을 돌려준다 (날짜만 기록하는 용도).
// 은행/지점이 비어있거나 그룹 자체가 없으면 -1 (새 행 추가 대상).
function findBestSellerRow(rows, bankName, branchName, sellerName, position) {
  var group = findMatchingGroup(rows, bankName, branchName);
  if (group.length === 0) return -1;
  if (!String(sellerName || '').trim()) return group[0];

  var bestIndex = group[0];
  var bestScore = -1;
  group.forEach(function (idx) {
    var row = rows[idx];
    var nameScore = fuzzyNameScore(row[3], sellerName);
    var posScore = position && row[4] ? fuzzyNameScore(row[4], position) : 0;
    var score = nameScore * 0.85 + posScore * 0.15;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = idx;
    }
  });
  return bestIndex;
}

// 기존 내용 뒤에 새 내용을 줄바꿈으로 이어붙인다 (새로 말한 내용이 기존 내용을 지우지 않도록).
// 이미 같은 내용이 포함되어 있으면 중복으로 추가하지 않는다.
function appendField(existingVal, newVal) {
  var ev = String(existingVal || '').trim();
  var nv = String(newVal || '').trim();
  if (!nv) return ev;
  if (!ev) return nv;
  if (ev.indexOf(nv) !== -1) return ev;
  return ev + '\n' + nv;
}

// 가족관계/자택/판매성향/방문이력/기타대화내용을 합쳐서 "특이사항 없음" 수준인지 판단한다.
// 트리비얼하면 날짜만 기록하고 기존 내용을 덮어쓰지 않는다.
// entry.__manual이 true면(드롭다운+텍스트로 직접 입력한 경우) 짧아도 트리비얼로 취급하지 않는다 - "10글자 미만" 기준은
// 음성으로 "특이사항 없음"류를 말했을 때만 걸리도록 만든 것인데, 직접 타이핑한 짧은 메모까지 날려버리면 안 된다.
function isTrivialContent(entry) {
  var combined = ['가족관계', '자택', '판매성향', '방문이력', '기타대화내용'].map(function (k) {
    return String(entry[k] || '').trim();
  }).join('');
  var normalized = combined.replace(/\s+/g, '');
  if (!normalized) return true;
  var trivialPhrases = ['특이사항없음', '특이사항없다', '특이사항없었음', '단순방문', '특별한내용없음', '없음', '별다른내용없음', '별일없음'];
  if (trivialPhrases.indexOf(normalized) !== -1) return true;
  if (entry.__manual) return false;
  return normalized.length < 10;
}

var ENTRIES_SCHEMA_TEXT = '{\n' +
  '  "entries": [\n' +
  '    {\n' +
  '      "은행명": "", "지점명": "", "판매자명": "", "직책": "", "가족관계": "", "자택": "", ' +
  '"판매성향": "", "방문이력": "", "기타대화내용": "",\n' +
  '      "proposal_request": { "있음": false, "상품명": "", "가입금액": "", "고객성명": "", "고객나이": "", "고객성별": "" }\n' +
  '    }\n' +
  '  ]\n' +
  '}';

// Claude 응답을 항상 entries 배열로 정규화 (구버전 단일 객체 응답에도 대응)
function normalizeEntries(data) {
  if (data && Array.isArray(data.entries)) return data.entries;
  if (data && data['은행명'] !== undefined) return [data];
  return [];
}

// 1단계: 음성 텍스트를 항목별로 구조화만 함 (시트에는 쓰지 않음, 사용자 검토용)
function handleParse(transcript) {
  var prompt = '다음은 보험사 방카슈랑스 영업담당자가 은행 지점 방문 후 음성으로 남긴 메모입니다. ' +
    '음성인식(STT)을 거친 텍스트이므로 띄어쓰기 오류, 발음이 비슷한 단어로의 오인식, 조사 누락/오류가 섞여 있을 수 있습니다. ' +
    '문맥상 가장 자연스러운 의미로 보정해서 해석하세요(예: "구체적"이 "구취적"처럼 들렸거나 은행/지점명이 일부 깨졌어도 가장 그럴듯한 의미로 받아들이세요). ' +
    '아래 JSON 스키마로만 추출해서 답하세요. "entries" 배열에는 언급된 은행/지점/판매자별로 항목을 하나씩 만드세요.\n' +
    '- 한 지점에 여러 명의 판매자가 언급되면, 각 판매자에게 해당하는 내용만 그 사람의 entry에 넣으세요. 한 사람 얘기를 다른 사람 entry에 절대 섞지 마세요.\n' +
    '- 판매자 이름이 성 없이 이름(또는 일부)만 불려도 들린 그대로 "판매자명"에 넣으세요 (예: "세진 팀장" -> 판매자명 "세진", 직책 "팀장"). 시스템이 나중에 기존 판매자와 매칭합니다.\n' +
    '- 여러 은행/지점이 동시에 언급되었지만 구체적인 대화 내용 없이 단순 방문/특이사항 없음 정도만 언급된 경우, 각 은행/지점마다 별도 entry를 만들고 판매자명과 나머지 항목은 모두 빈 문자열로 두세요.\n' +
    '- 해당 항목 정보가 없으면 빈 문자열로 두세요. 항목에 맞지 않는 추가 정보는 모두 "기타대화내용"에 합쳐서 넣으세요.\n' +
    '- 제안서 요청이 언급되면 해당 판매자 entry의 proposal_request를 채우세요(상품명, 가입금액, 고객성명/나이/성별 포함).\n' +
    '- 각 값에는 마크다운이나 기호(*, #, -, /, {, } 등) 없이 평문 텍스트만 넣으세요.\n\n' +
    '스키마:\n' + ENTRIES_SCHEMA_TEXT + '\n\n' +
    '메모: ' + transcript;

  var data = callClaude(prompt);
  return { ok: true, parsed: { entries: normalizeEntries(data) } };
}

// 녹음 종료 후 재확인 단계에서, 사용자가 음성으로 정정한 내용을 원래 메모에 반영해 다시 구조화
function handleReparse(original, correction) {
  var prompt = '다음은 보험사 방카슈랑스 영업담당자가 은행 지점 방문 후 음성으로 남긴 메모와, ' +
    '그 내용을 다시 들려준 뒤 사용자가 말한 정정/추가 사항입니다. 정정 사항을 반영해서 최종 내용을 같은 JSON 스키마(entries 배열)로 추출해 답하세요. ' +
    '정정 사항에서 언급되지 않은 entry나 항목은 원래 메모의 내용을 그대로 유지하세요. ' +
    '마크다운이나 기호(*, #, -, /, {, } 등) 없이 평문 텍스트만 넣으세요.\n\n' +
    '스키마:\n' + ENTRIES_SCHEMA_TEXT + '\n\n' +
    '원래 메모: ' + original + '\n\n' +
    '정정/추가 사항: ' + correction;

  var data = callClaude(prompt);
  return { ok: true, parsed: { entries: normalizeEntries(data) } };
}

// 2단계: 사용자가 음성으로 확인한 최종 내용(entries 배열, 판매자별/지점별로 분리됨)을 시트에 저장
function handleCommit(data) {
  var entries = normalizeEntries(data);
  if (entries.length === 0) {
    return { ok: false, message: '저장할 내용이 없습니다.' };
  }

  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var logSheet = getSS().getSheetByName(SHEET_LOG);
  var pSheet = getSS().getSheetByName(SHEET_PROPOSAL);
  // 정보 기록 카드에서 날짜를 직접 선택했으면(지난 날짜 기록 등) 그 날짜를 쓰고, 없으면 오늘 날짜를 쓴다.
  var todayLabel = resolveDateLabel(data && data.date);
  var results = [];

  entries.forEach(function (entry) {
    var bank = String(entry['은행명'] || '').trim();
    var branchInput = String(entry['지점명'] || '').trim();
    if (!bank || !branchInput) {
      results.push({ 은행명: bank, 지점명: branchInput, error: '은행명/지점명이 명확하지 않아 건너뜀' });
      return;
    }

    // entry마다 다시 읽어서, 같은 commit 안에서 앞서 새로 생긴 행도 바로 매칭 대상에 포함시킨다.
    var rows = sheet.getDataRange().getValues();
    // 지점명은 부분 발화/오인식이어도 그 은행에 이미 등록된 지점 풀네임으로 먼저 확정한다 (예: "가좌공단" -> "가좌공단금융센터", "인천" vs "인천법조타운"을 서로 다른 지점으로 정확히 구분).
    var resolvedBranch = resolveBranchName(rows, bank, branchInput);
    var trivial = isTrivialContent(entry);
    var sellerWasSpecified = !!String(entry['판매자명'] || '').trim();
    // 판매자명은 성 없이 일부만 불러도("세진" -> "박세진") fuzzyNameScore로 매칭된다. 판매자명이 비었으면 그룹 대표 행(날짜만 기록용).
    var matchRowIndex = findBestSellerRow(rows, bank, resolvedBranch, entry['판매자명'], entry['직책']);

    var canonicalBank = bank;
    var canonicalBranch = resolvedBranch;
    // 사용자가 판매자명을 말하지 않았으면(은행+지점만 언급) 방문로그/달력에는 특정인 이름을 붙이지 않고 지점명만 남긴다.
    var canonicalSeller = sellerWasSpecified ? entry['판매자명'] : '';

    var userEmail = getCurrentUserEmail();
    if (matchRowIndex === -1) {
      insertSellerIntoGroup(sheet, rows, bank, resolvedBranch, [
        todayLabel, bank, resolvedBranch, entry['판매자명'], entry['직책'],
        trivial ? '' : entry['가족관계'], trivial ? '' : entry['자택'], trivial ? '' : entry['판매성향'],
        trivial ? '' : entry['방문이력'], trivial ? '' : entry['기타대화내용'], '', userEmail
      ]);
    } else {
      var rowNum = matchRowIndex + 1; // 시트는 1-based
      var existing = rows[matchRowIndex];
      // 은행명/지점명은 음성 인식 오차로 잘못 덮어쓰면 안 되므로, 기존 시트의 정확한 값을 그대로 사용
      canonicalBank = existing[1];
      canonicalBranch = existing[2];
      // 판매자명을 말한 경우에만 기존 시트의 정확한 판매자명으로 교체 (말 안 했으면 위에서 정한 빈 값 유지)
      if (sellerWasSpecified) canonicalSeller = existing[3];

      // 날짜 칸이 지점 단위로 병합되어 있으면, 병합의 맨 위(앵커) 셀에 적어야 실제로 보인다.
      var dateCell = sheet.getRange(rowNum, 1);
      var mergedRanges = dateCell.getMergedRanges();
      var dateAnchorRange = mergedRanges.length > 0 ? mergedRanges[0] : dateCell;
      var existingDates = String(dateAnchorRange.getValue() || '').trim();
      var newDateField = existingDates.indexOf(todayLabel) !== -1
        ? existingDates
        : (existingDates ? existingDates + '\n' + todayLabel : todayLabel);
      dateAnchorRange.setValue(newDateField);

      // 특이사항 없음/단순방문/10글자 미만처럼 내용이 트리비얼하면 날짜만 찍고 기존 내용은 건드리지 않는다.
      // 트리비얼하지 않으면, 새로 말한 내용을 기존 내용을 지우지 않고 줄바꿈으로 이어붙인다.
      if (!trivial) {
        sheet.getRange(rowNum, 2, 1, 9).setValues([[
          existing[1],
          existing[2],
          existing[3],
          entry['직책'] || existing[4],
          appendField(existing[5], entry['가족관계']),
          appendField(existing[6], entry['자택']),
          appendField(existing[7], entry['판매성향']),
          appendField(existing[8], entry['방문이력']),
          appendField(existing[9], entry['기타대화내용'])
        ]]);
        sheet.getRange(rowNum, 1, 1, 10).setWrap(true);
      }
    }

    logSheet.appendRow([
      todayLabel, canonicalBank, canonicalBranch, canonicalSeller,
      trivial ? '' : (entry['방문이력'] || entry['기타대화내용']), userEmail
    ]);

    if (entry.proposal_request && entry.proposal_request['있음']) {
      pSheet.appendRow([
        todayLabel, canonicalBank, canonicalBranch, canonicalSeller,
        entry.proposal_request['상품명'], entry.proposal_request['가입금액'],
        entry.proposal_request['고객성명'], entry.proposal_request['고객나이'],
        entry.proposal_request['고객성별'], '대기'
      ]);
    }

    results.push({
      은행명: canonicalBank, 지점명: canonicalBranch, 판매자명: canonicalSeller,
      trivial: trivial,
      가족관계: trivial ? '' : entry['가족관계'], 자택: trivial ? '' : entry['자택'],
      판매성향: trivial ? '' : entry['판매성향'], 방문이력: trivial ? '' : entry['방문이력'],
      기타대화내용: trivial ? '' : entry['기타대화내용'],
      proposal_request: entry.proposal_request || null
    });
  });

  return { ok: true, results: results };
}

// 조회 음성에서 은행명/지점명/판매자명(선택)을 구조화
function parseQueryFields(transcript) {
  var prompt = '다음은 보험사 방카슈랑스 영업담당자가 방문 전 정보를 조회하려고 한 음성 질문입니다. ' +
    '음성인식(STT) 결과라 띄어쓰기나 발음이 비슷한 단어로의 오인식이 섞여 있을 수 있으니, 문맥상 가장 자연스러운 은행명/지점명/판매자명으로 보정해서 추출하세요. ' +
    '은행명, 지점명, 판매자명(언급 안 했으면 빈 문자열)을 아래 JSON으로만 추출하세요. ' +
    '기호 없이 평문으로만 넣으세요.\n\n' +
    '{ "은행명": "", "지점명": "", "판매자명": "" }\n\n' +
    '질문: ' + transcript;
  return callClaude(prompt);
}

function handleQuery(transcript) {
  var q = parseQueryFields(transcript);
  return buildBranchSummary(q['은행명'], q['지점명'], q['판매자명']);
}

// UI의 은행/지점(+판매자) 드롭다운으로 직접 선택했을 때 - 자연어 파싱 없이 바로 조회. 판매자를 선택 안 하면 지점 전체.
function handleQueryByBranch(bank, branch, seller) {
  return buildBranchSummary(bank, branch, seller || '');
}

function buildBranchSummary(qBank, qBranch, qSeller) {
  if (!String(qBank || '').trim() || !String(qBranch || '').trim()) {
    return {
      ok: true,
      summary: '은행명과 지점명을 정확히 말씀해주셔야 조회할 수 있습니다. 예를 들어 국민은행 구월동지점처럼 말씀해주세요.',
      needsClarification: true
    };
  }

  var sellerRows = readRowsCached(SHEET_SELLER);
  var bankCol = fillMergedColumn(sellerRows, 1);
  var branchCol = fillMergedColumn(sellerRows, 2);

  // 지점명은 부분 발화/오인식이어도 그 은행에 이미 등록된 지점 풀네임으로 먼저 확정해서 찾는다.
  // (예: "인천"이라고 하면 "인천"만, "인천 법조타운"이라고 하면 "인천법조타운"만 - 풀네임 확정 후엔 정확히 일치하는 것만 묶는다.)
  var resolvedBranch = resolveBranchName(sellerRows, qBank, qBranch);
  var normBank = normalizeText(qBank);
  var normBranchSpoken = normalizeText(qBranch);
  var normBranch = normalizeText(resolvedBranch);

  var branchOnlyMatches = []; // 지점명만 헐겁게 일치 (은행 무관) - 같은/비슷한 지점명이 다른 은행에 있는지 확인용 힌트
  var fullMatches = []; // 은행 일치 + 지점명 풀네임 정확히 일치
  for (var i = 1; i < sellerRows.length; i++) {
    if (textMatches(normalizeText(branchCol[i]), normBranchSpoken)) branchOnlyMatches.push(i);
    if (textMatches(normalizeText(bankCol[i]), normBank) && normalizeText(branchCol[i]) === normBranch) {
      fullMatches.push(i);
    }
  }

  if (fullMatches.length === 0) {
    if (branchOnlyMatches.length > 0) {
      var otherBanks = [...new Set(branchOnlyMatches.map(function (idx) { return String(bankCol[idx]); }))];
      return {
        ok: true,
        needsClarification: true,
        summary: qBranch + '은 ' + otherBanks.join(', ') + '에 있습니다. 어느 은행인지 다시 한번 정확히 말씀해주세요.'
      };
    }
    return { ok: true, summary: qBank + ' ' + qBranch + '에 대한 기록이 아직 없습니다.' };
  }

  // 판매자명까지 말한 경우, 그 그룹 안에서 해당 판매자만 추려낸다. 불명확하면 추측하지 않고 다시 물어본다.
  var targetRows = fullMatches;
  if (String(qSeller || '').trim()) {
    var sellerHits = fullMatches.filter(function (idx) {
      var name = String(sellerRows[idx][3] || '');
      return name.indexOf(qSeller) !== -1 || qSeller.indexOf(name) !== -1 || similarity(name, qSeller) >= 0.6;
    });
    if (sellerHits.length === 0) {
      return {
        ok: true,
        needsClarification: true,
        summary: qBank + ' ' + qBranch + '에서 ' + qSeller + ' 판매자를 찾을 수 없습니다. 이름을 다시 한번 말씀해주세요.'
      };
    }
    targetRows = sellerHits;
  }

  var matchedSellers = targetRows.map(function (idx) { return sellerRows[idx]; });

  // 화면에 이름/직책/저장된 정보는 굵게, 정보 없는 항목은 옅게 표시하기 위한 구조화 데이터 (시트 원본 값 그대로)
  var sellersStructured = matchedSellers.map(function (r) {
    return {
      판매자명: r[3], 직책: r[4], 가족관계: r[5], 자택: r[6],
      판매성향: r[7], 방문이력: r[8], 기타대화내용: r[9]
    };
  });

  // 음성으로 읽어주는 내용과 화면에 보이는 텍스트가 항상 똑같도록, 같은 구조화 데이터를 그대로 문장으로 풀어서 사용한다 (Claude 가공 없음).
  var summary = sanitizeText(buildSpokenSellerSummary(sellersStructured));

  return { ok: true, summary: summary, sellers: sellersStructured };
}

// renderSellerInfo(프론트엔드)가 화면에 표시하는 항목과 정확히 같은 순서/내용으로 음성용 문장을 만든다.
function buildSpokenSellerSummary(sellersStructured) {
  var fieldDefs = [
    ['가족관계', '가족관계'], ['자택', '자택'], ['판매성향', '판매성향'],
    ['방문이력', '방문이력'], ['기타대화내용', '기타']
  ];
  return sellersStructured.map(function (s) {
    var lead = [String(s.판매자명 || '').trim(), String(s.직책 || '').trim()].filter(Boolean).join(' ');
    var lines = fieldDefs.map(function (fd) {
      var key = fd[0], label = fd[1];
      var v = String(s[key] || '').trim();
      return label + '은 ' + (v ? v : '정보 없음');
    });
    return (lead ? lead + '. ' : '') + lines.join('. ') + '.';
  }).join(' ');
}

// 지점 조회 카드의 은행/지점 드롭다운을 채우기 위한, 시트에 등록된 모든 은행+지점 목록(중복 제거)
// 담당자 이메일이 설정된 행은 본인 것만, 미설정 행은 모두에게 표시(마이그레이션 호환)
// 각 지점마다 판매자 목록(sellers)까지 함께 담아 보낸다. 프런트가 이 목록만으로 판매자 드롭다운을
// 채울 수 있어서, 은행/지점을 고를 때마다 listSellers를 따로 호출하지 않아도 된다.
function handleListBranches() {
  var email = getCurrentUserEmail().toLowerCase();
  var rows = readRowsCached(SHEET_SELLER);
  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);

  var byKey = {};
  var branches = [];
  for (var i = 1; i < rows.length; i++) {
    if (isHeaderEchoRow(rows, i)) continue;
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    var bank = String(bankCol[i] || '').trim();
    var branch = String(branchCol[i] || '').trim();
    if (!bank || !branch) continue;
    var key = branchKey(bank, branch);
    if (!byKey[key]) {
      // k(지점키)는 지도에서 좌표와 지점을 잇는 조인 키. 서버가 만든 키를 그대로 쓰게 해서
      // normalizeText를 프런트로 이식하지 않는다(두 구현이 어긋나는 버그를 원천 차단).
      byKey[key] = { k: key, 은행명: bank, 지점명: branch, sellers: [] };
      branches.push(byKey[key]);
    }
    var name = String(rows[i][3] || '').trim();
    if (name) byKey[key].sellers.push({ 판매자명: name, 직책: String(rows[i][4] || '').trim() });
  }

  branches.sort(function (a, b) {
    if (a.은행명 !== b.은행명) return a.은행명.localeCompare(b.은행명, 'ko');
    return a.지점명.localeCompare(b.지점명, 'ko');
  });

  return { ok: true, branches: branches };
}

// 은행+지점을 선택했을 때, 그 지점에 등록된 판매자 목록(드롭다운용)
// (프런트는 보통 listBranches의 sellers를 그대로 쓰므로, 이 액션은 예비용으로만 남겨둔다)
function handleListSellers(bank, branch) {
  var email = getCurrentUserEmail().toLowerCase();
  var rows = readRowsCached(SHEET_SELLER);
  var group = findMatchingGroup(rows, bank, branch);
  if (email) {
    group = group.filter(function (idx) {
      var rowEmail = String(rows[idx][11] || '').trim().toLowerCase();
      return !rowEmail || rowEmail === email;
    });
  }
  var sellers = group.map(function (idx) {
    return { 판매자명: String(rows[idx][3] || '').trim(), 직책: String(rows[idx][4] || '').trim() };
  }).filter(function (s) { return s.판매자명; });
  return { ok: true, sellers: sellers };
}

// 은행/지점/판매자를 드롭다운으로 선택하고 자유롭게 나열한 메모를, 정해진 5개 항목(+제안서 요청)으로 분류한다.
function classifyNoteText(text) {
  var prompt = '다음은 보험사 방카슈랑스 영업담당자가 특정 판매자에 대해 나열식으로 자유롭게 적은 메모입니다. ' +
    '아래 JSON 스키마의 항목에 맞게 내용을 분류해서 답하세요. 해당 항목 정보가 없으면 빈 문자열로 두세요. ' +
    '항목에 맞지 않는 내용은 모두 "기타대화내용"에 합쳐서 넣으세요. ' +
    '제안서 요청이 언급되면 proposal_request를 채우세요(상품명, 가입금액, 고객성명/나이/성별 포함). ' +
    '각 값에는 마크다운이나 기호(*, #, -, /, {, } 등) 없이 평문 텍스트만 넣으세요.\n\n' +
    '스키마:\n' +
    '{\n  "가족관계": "", "자택": "", "판매성향": "", "방문이력": "", "기타대화내용": "",\n' +
    '  "proposal_request": { "있음": false, "상품명": "", "가입금액": "", "고객성명": "", "고객나이": "", "고객성별": "" }\n}\n\n' +
    '메모: ' + text;
  return callClaude(prompt);
}

// 방문기록 카드에서 은행/지점/판매자를 드롭다운으로 선택하고 메모를 적어 저장하는 경우.
// 분류만 새로 하고, 실제 저장(누적/병합, 날짜 처리 등)은 handleCommit과 완전히 동일한 로직을 그대로 재사용한다.
function handleRecordForSeller(bank, branch, seller, text, date) {
  if (!String(bank || '').trim() || !String(branch || '').trim()) {
    return { ok: false, message: '은행과 지점을 선택해주세요.' };
  }
  if (!String(text || '').trim()) {
    return { ok: false, message: '입력할 내용이 없습니다.' };
  }
  var classified = classifyNoteText(text);
  var entry = {
    은행명: bank, 지점명: branch, 판매자명: seller || '', 직책: '',
    가족관계: classified['가족관계'] || '', 자택: classified['자택'] || '',
    판매성향: classified['판매성향'] || '', 방문이력: classified['방문이력'] || '',
    기타대화내용: classified['기타대화내용'] || '', proposal_request: classified.proposal_request || null,
    __manual: true
  };
  return handleCommit({ entries: [entry], date: date });
}

// 방문 지점 입력: 방문로그에만 기록 (판매자 정보 시트는 건드리지 않음)
function handleLogVisit(bank, branch, date, visitType, note) {
  if (!String(bank || '').trim() || !String(branch || '').trim()) {
    return { ok: false, message: '은행과 지점을 선택해주세요.' };
  }
  var email = getCurrentUserEmail();
  var rows = readRowsCached(SHEET_SELLER);
  var resolvedBranch = resolveBranchName(rows, bank, branch);
  var dateLabel = resolveDateLabel(date);
  var logSheet = getSS().getSheetByName(SHEET_LOG);
  logSheet.appendRow([dateLabel, bank, resolvedBranch, '', String(note || '').trim(), email, String(visitType || '지점방문').trim()]);
  logSheet.getRange(logSheet.getLastRow(), 1, 1, 7).setWrap(true);
  return { ok: true, dateLabel: dateLabel, bank: bank, branch: resolvedBranch, row: logSheet.getLastRow() };
}

// 한 지점의 방문 기록 목록(최근 순). 수정·삭제 대상을 고르기 위한 것이라 시트 행번호를 함께 준다.
function handleBranchVisits(bank, branch) {
  if (!String(bank || '').trim() || !String(branch || '').trim()) {
    return { ok: false, message: '은행과 지점이 필요합니다.' };
  }
  var email = getCurrentUserEmail().toLowerCase();
  var normBank = normalizeText(bank), normBranch = normalizeText(branch);
  var logRows = readRowsCached(SHEET_LOG);
  var visits = [];
  for (var i = 1; i < logRows.length; i++) {
    var r = logRows[i];
    if (normalizeText(r[1]) !== normBank || normalizeText(r[2]) !== normBranch) continue;
    var rowEmail = String(r[5] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    visits.push({
      row: i + 1,
      날짜: String(r[0] || ''),
      판매자명: String(r[3] || '').trim(),
      내용: String(r[4] || ''),
      방문유형: String(r[6] || '').trim() || '지점방문'
    });
  }
  visits.reverse(); // 최근 기록이 위로
  return { ok: true, visits: visits.slice(0, 30) };
}

// 방문로그의 한 행을 찾아, 정말 그 지점의 내 기록이 맞는지 확인한 뒤에만 손댄다.
// 다른 사람이 그 사이에 행을 지웠다면 행번호가 밀려 엉뚱한 기록을 건드리게 되므로 반드시 대조한다.
function _findVerifiedVisitRow(row, bank, branch) {
  if (!row || row < 2) return { error: '잘못된 기록입니다.' };
  var logRows = readRows(SHEET_LOG);
  if (row > logRows.length) return { error: '기록을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.' };
  var r = logRows[row - 1];
  if (normalizeText(r[1]) !== normalizeText(bank) || normalizeText(r[2]) !== normalizeText(branch)) {
    return { error: '기록이 변경되었습니다. 새로고침 후 다시 시도해주세요.' };
  }
  var email = getCurrentUserEmail().toLowerCase();
  var rowEmail = String(r[5] || '').trim().toLowerCase();
  if (email && rowEmail && rowEmail !== email) return { error: '다른 담당자의 기록입니다.' };
  return { row: row };
}

function handleUpdateVisit(row, bank, branch, note, visitType) {
  var v = _findVerifiedVisitRow(row, bank, branch);
  if (v.error) return { ok: false, message: v.error };
  var logSheet = getSS().getSheetByName(SHEET_LOG);
  logSheet.getRange(v.row, 5).setValue(String(note || '').trim());
  if (String(visitType || '').trim()) logSheet.getRange(v.row, 7).setValue(String(visitType).trim());
  logSheet.getRange(v.row, 1, 1, 7).setWrap(true);
  return { ok: true };
}

function handleDeleteVisit(row, bank, branch) {
  var v = _findVerifiedVisitRow(row, bank, branch);
  if (v.error) return { ok: false, message: v.error };
  getSS().getSheetByName(SHEET_LOG).deleteRow(v.row);
  return { ok: true };
}

// 판매자 드롭다운 선택 시 현재 저장된 정보를 로드해 필드를 채워주기 위한 조회
function handleGetSellerInfo(bank, branch, seller) {
  if (!String(seller || '').trim()) return { ok: true, seller: null };
  var email = getCurrentUserEmail().toLowerCase();
  var rows = readRowsCached(SHEET_SELLER);
  var rowIdx = findBestSellerRow(rows, bank, branch, seller, '');
  if (rowIdx === -1) return { ok: true, seller: null };
  var rowEmail = String(rows[rowIdx][11] || '').trim().toLowerCase();
  if (email && rowEmail && rowEmail !== email) return { ok: true, seller: null };
  var r = rows[rowIdx];
  return {
    ok: true,
    seller: {
      판매자명: String(r[3] || '').trim(),
      직책:     String(r[4] || '').trim(),
      가족관계:  String(r[5] || '').trim(),
      자택:     String(r[6] || '').trim(),
      판매성향:  String(r[7] || '').trim(),
      방문이력:  String(r[8] || '').trim(),
      기타대화내용: String(r[9] || '').trim()
    }
  };
}

// 직책만 수정
function handleUpdateSellerTitle(bank, branch, seller, newTitle) {
  if (!bank || !branch || !seller) return { ok: false, message: '은행, 지점, 판매자를 모두 선택해주세요.' };
  var email = getCurrentUserEmail().toLowerCase();
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = readRows(SHEET_SELLER);
  var rowIdx = findBestSellerRow(rows, bank, branch, seller, '');
  if (rowIdx === -1) return { ok: false, message: '판매자를 찾을 수 없습니다.' };
  var rowEmail = String(rows[rowIdx][11] || '').trim().toLowerCase();
  if (email && rowEmail && rowEmail !== email) return { ok: false, message: '다른 담당자의 판매자입니다.' };
  sheet.getRange(rowIdx + 1, 5, 1, 1).setValue(newTitle.trim());
  return { ok: true, newTitle: newTitle.trim() };
}

// 판매자 이름 교체: 기존 정보를 삭제된 판매자 시트로 보관 후, 현재 행은 새 이름으로 초기화
function handleUpdateSellerName(bank, branch, seller, newName) {
  if (!bank || !branch || !seller || !newName) return { ok: false, message: '필수 항목이 빠졌습니다.' };
  var newNameTrimmed = String(newName).trim();
  if (normalizeText(newNameTrimmed) === normalizeText(seller)) return { ok: false, message: '이름이 동일합니다.' };

  var email = getCurrentUserEmail().toLowerCase();
  var ss = getSS();
  var sheet = ss.getSheetByName(SHEET_SELLER);
  var rows = readRows(SHEET_SELLER);
  var rowIdx = findBestSellerRow(rows, bank, branch, seller, '');
  if (rowIdx === -1) return { ok: false, message: '판매자를 찾을 수 없습니다.' };
  var rowEmail = String(rows[rowIdx][11] || '').trim().toLowerCase();
  if (email && rowEmail && rowEmail !== email) return { ok: false, message: '다른 담당자의 판매자입니다.' };

  // 삭제된 판매자 시트에 기존 행 보관 (삭제일 추가)
  var delSheet = ss.getSheetByName(SHEET_DELETED);
  if (!delSheet) {
    delSheet = ss.insertSheet(SHEET_DELETED);
    delSheet.appendRow(['날짜', '은행명', '지점명', '판매자명', '직책', '가족관계', '자택', '판매성향', '방문이력', '기타대화내용', '영업대상', '담당자이메일', '삭제일']);
  }
  var oldRow = rows[rowIdx];
  delSheet.appendRow(oldRow.slice(0, 12).concat([Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')]));
  delSheet.getRange(delSheet.getLastRow(), 1, 1, 13).setWrap(true);

  // 현재 행: 새 이름으로 교체하고 개인정보 필드 초기화 (새 사람이므로)
  var rowNum = rowIdx + 1;
  sheet.getRange(rowNum, 4, 1, 7).setValues([[newNameTrimmed, '', '', '', '', '', '']]);

  return { ok: true, oldName: String(seller).trim(), newName: newNameTrimmed };
}

// 새 판매자 1명을 해당 지점(지점) 그룹 "안"에 삽입한다.
// A(날짜)/B(은행)/C(지점) 세로 병합이 있으면 그룹 앵커 바로 아래에 행을 끼워 넣어
// 구글시트가 병합을 자동 확장하도록 한다(맨 아래 append로 그룹과 분리되는 문제 방지).
// 그룹이 없으면(새 지점) 기존처럼 맨 아래에 append 한다.
// rowValues: 12칸 [날짜,은행,지점,이름,직책,가족관계,자택,판매성향,방문이력,기타대화내용,영업대상,담당자이메일]
// 반환: 삽입된 시트 행번호(1-based)
function insertSellerIntoGroup(sheet, rows, bank, branch, rowValues) {
  var resolvedBranch = resolveBranchName(rows, bank, branch);
  var group = findMatchingGroup(rows, bank, resolvedBranch);
  if (group.length === 0) {
    sheet.appendRow(rowValues);
    var r = sheet.getLastRow();
    sheet.getRange(r, 1, 1, 12).setWrap(true);
    return r;
  }
  // 지점 블록 앵커(top1) = 그룹 첫 행의 C(지점) 병합 최상단
  var top1 = group[0] + 1;
  var cMerges = sheet.getRange(top1, 3).getMergedRanges();
  if (cMerges.length > 0) top1 = cMerges[0].getRow();

  sheet.insertRowAfter(top1);       // 앵커 바로 아래(병합 범위 내부)에 삽입 → 병합 자동 확장
  var newRow1 = top1 + 1;

  // A/B/C: 병합에 자동 포함되면 비워두고(위 값이 이어짐), 병합이 없으면 앵커 값 복사
  for (var c = 1; c <= 3; c++) {
    if (sheet.getRange(newRow1, c).getMergedRanges().length === 0) {
      sheet.getRange(newRow1, c).setValue(sheet.getRange(top1, c).getValue());
    }
  }
  // D~J(이름/직책/각 필드) + L(이메일) 기록. K(영업대상 체크박스)는 위 행 서식이 복사되므로 건드리지 않음.
  sheet.getRange(newRow1, 4, 1, 7).setValues([rowValues.slice(3, 10)]); // D..J
  sheet.getRange(newRow1, 12).setValue(rowValues[11]);                  // L 이메일
  sheet.getRange(newRow1, 1, 1, 12).setWrap(true);
  return newRow1;
}

// 지점 내 판매자 수 증가: 다른 필드/판매자를 건드리지 않고 새 행 1개만 추가
function handleAddNewSeller(bank, branch, sellerName, title) {
  bank = String(bank || '').trim();
  branch = String(branch || '').trim();
  sellerName = String(sellerName || '').trim();
  title = String(title || '').trim();
  if (!bank || !branch || !sellerName) return { ok: false, message: '은행, 지점, 판매자 이름을 입력해주세요.' };

  var email = getCurrentUserEmail();
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = readRows(SHEET_SELLER);
  var resolvedBranch = resolveBranchName(rows, bank, branch);

  // 이미 같은 은행+지점+이름의 판매자가 있으면 중복 추가 방지
  var existingIdx = findBestSellerRow(rows, bank, resolvedBranch, sellerName, title);
  if (existingIdx !== -1) {
    var existingName = String(rows[existingIdx][3] || '').trim();
    if (normalizeText(existingName) === normalizeText(sellerName)) {
      return { ok: false, message: '이미 등록된 판매자입니다.' };
    }
  }

  var todayLabel = resolveDateLabel('');
  insertSellerIntoGroup(sheet, rows, bank, resolvedBranch,
    [todayLabel, bank, resolvedBranch, sellerName, title, '', '', '', '', '', '', email]);
  return { ok: true };
}

// 지점 내 판매자 수 감소: 해당 판매자 행만 삭제된 판매자 시트로 이동 후 원본에서 제거 (다른 행은 그대로 유지)
function handleDeleteSeller(bank, branch, seller) {
  if (!bank || !branch || !seller) return { ok: false, message: '은행, 지점, 판매자를 모두 선택해주세요.' };
  var email = getCurrentUserEmail().toLowerCase();
  var ss = getSS();
  var sheet = ss.getSheetByName(SHEET_SELLER);
  var rows = readRows(SHEET_SELLER);
  var rowIdx = findBestSellerRow(rows, bank, branch, seller, '');
  if (rowIdx === -1) return { ok: false, message: '판매자를 찾을 수 없습니다.' };
  var rowEmail = String(rows[rowIdx][11] || '').trim().toLowerCase();
  if (email && rowEmail && rowEmail !== email) return { ok: false, message: '다른 담당자의 판매자입니다.' };

  var delSheet = ss.getSheetByName(SHEET_DELETED);
  if (!delSheet) {
    delSheet = ss.insertSheet(SHEET_DELETED);
    delSheet.appendRow(['날짜', '은행명', '지점명', '판매자명', '직책', '가족관계', '자택', '판매성향', '방문이력', '기타대화내용', '영업대상', '담당자이메일', '삭제일']);
  }
  var oldRow = rows[rowIdx];
  delSheet.appendRow(oldRow.slice(0, 12).concat([Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')]));
  delSheet.getRange(delSheet.getLastRow(), 1, 1, 13).setWrap(true);

  deleteRowPreservingMerges(sheet, rowIdx + 1);
  return { ok: true };
}

// 병합-인지형 행 삭제: 지우려는 행이 A(날짜)/B(은행)/C(지점) 병합의 "맨 위(앵커)"이면
// 병합 값이 그 행에만 있어 삭제 시 사라진다. 값을 아래 행으로 옮기고 병합을 한 칸 줄여 재병합한다.
// (앵커가 아니면 구글시트가 자동으로 병합을 축소하고 값을 보존하므로 손대지 않는다.)
function deleteRowPreservingMerges(sheet, rowNum) {
  var relocations = [];
  for (var c = 1; c <= 3; c++) {
    var merged = sheet.getRange(rowNum, c).getMergedRanges();
    if (merged.length > 0) {
      var mr = merged[0];
      var n = mr.getNumRows();
      if (mr.getRow() === rowNum && n > 1) {
        var val = mr.getValue();
        mr.breakApart();
        sheet.getRange(rowNum + 1, c).setValue(val); // 삭제 후 새 앵커가 될 아래 행으로 값 이전
        relocations.push({ col: c, count: n - 1 });
      }
    }
  }
  sheet.deleteRow(rowNum);
  for (var k = 0; k < relocations.length; k++) {
    if (relocations[k].count >= 2) {
      sheet.getRange(rowNum, relocations[k].col, relocations[k].count, 1).merge();
    }
  }
}

// 이전 담당자 정보 찾기: 은행+이름 기준으로 삭제된 판매자 시트 및 다른 사용자의 판매자정보를 탐색
// (직책은 매칭 조건이 아니라 후보 구분 표시용) 1건이면 자동 복원용, 2건 이상이면 후보 목록 반환
function handleFindArchivedSellers(bank, sellerName, title) {
  if (!bank || !sellerName) return { ok: true, candidates: [] };
  var normBank = normalizeText(bank);
  var normName = normalizeText(sellerName);
  var myEmail = getCurrentUserEmail().toLowerCase();
  var ss = getSS();
  var candidates = [];

  function rowToCandidate(r, source) {
    return {
      source: source,
      지점명: String(r[2] || '').trim(),
      판매자명: String(r[3] || '').trim(),
      직책: String(r[4] || '').trim(),
      가족관계: String(r[5] || '').trim(),
      자택: String(r[6] || '').trim(),
      판매성향: String(r[7] || '').trim(),
      방문이력: String(r[8] || '').trim(),
      기타대화내용: String(r[9] || '').trim(),
      날짜: String(r[0] || '').trim()
    };
  }

  // 1) 삭제된 판매자 시트 탐색
  var delSheet = ss.getSheetByName(SHEET_DELETED);
  if (delSheet) {
    var delRows = readRowsCached(SHEET_DELETED);
    for (var i = 1; i < delRows.length; i++) {
      var r = delRows[i];
      if (normalizeText(String(r[1] || '')) !== normBank) continue;
      if (normalizeText(String(r[3] || '')) !== normName) continue;
      candidates.push(rowToCandidate(r, '보관'));
    }
  }

  // 2) 판매자정보 시트에서 다른 사용자 행 탐색
  var selRows = readRowsCached(SHEET_SELLER);
  for (var j = 1; j < selRows.length; j++) {
    var sr = selRows[j];
    var srEmail = String(sr[11] || '').trim().toLowerCase();
    if (srEmail && srEmail === myEmail) continue; // 내 데이터 제외
    if (normalizeText(String(sr[1] || '')) !== normBank) continue;
    if (normalizeText(String(sr[3] || '')) !== normName) continue;
    candidates.push(rowToCandidate(sr, '현재'));
  }

  return { ok: true, candidates: candidates };
}

// 판매자 정보 폼에서 각 항목별로 입력한 내용을 저장 (프런트에서 전체 편집된 텍스트를 그대로 받아 덮어씀)
// 폼에 기존 내용이 이미 표시된 상태에서 사용자가 직접 수정하므로, appendField 대신 덮어쓰기
function handleSaveSellerFields(data) {
  var bank   = String(data.bank   || '').trim();
  var branch = String(data.branch || '').trim();
  var seller = String(data.seller || '').trim();
  if (!bank || !branch || !seller) {
    return { ok: false, message: '은행, 지점, 판매자를 모두 선택해주세요.' };
  }

  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = readRows(SHEET_SELLER);
  var todayLabel = resolveDateLabel(data.date);
  var resolvedBranch = resolveBranchName(rows, bank, branch);
  var rowIdx = findBestSellerRow(rows, bank, resolvedBranch, seller, '');

  var fam  = String(data['가족관계']    || '').trim();
  var home = String(data['자택']       || '').trim();
  var tend = String(data['판매성향']    || '').trim();
  var hist = String(data['방문이력']    || '').trim();
  var etc  = String(data['기타대화내용'] || '').trim();

  var email = getCurrentUserEmail();
  if (rowIdx === -1) {
    insertSellerIntoGroup(sheet, rows, bank, resolvedBranch,
      [todayLabel, bank, resolvedBranch, seller, '', fam, home, tend, hist, etc, '', email]);
  } else {
    var existingEmail = String(rows[rowIdx][11] || '').trim().toLowerCase();
    if (existingEmail && email && existingEmail !== email.toLowerCase()) {
      return { ok: false, message: '다른 담당자의 판매자입니다.' };
    }
    var rowNum = rowIdx + 1;
    var existing = rows[rowIdx];
    var dateCell = sheet.getRange(rowNum, 1);
    var mergedRanges = dateCell.getMergedRanges();
    var dateAnchorRange = mergedRanges.length > 0 ? mergedRanges[0] : dateCell;
    var existingDates = String(dateAnchorRange.getValue() || '').trim();
    var newDateField = existingDates.indexOf(todayLabel) !== -1
      ? existingDates
      : (existingDates ? existingDates + '\n' + todayLabel : todayLabel);
    dateAnchorRange.setValue(newDateField);
    sheet.getRange(rowNum, 6, 1, 5).setValues([[fam, home, tend, hist, etc]]);
    if (!existingEmail && email) sheet.getRange(rowNum, 12, 1, 1).setValue(email);
    sheet.getRange(rowNum, 1, 1, 12).setWrap(true);
  }

  return { ok: true };
}

// 달력에서 특정 날짜(YYYY-MM-DD)를 누르면 그날 방문한 점포 목록을 보여줌
function handleCalendarDay(dateStr) {
  var email = getCurrentUserEmail().toLowerCase();
  var logRows = readRowsCached(SHEET_LOG);
  var matches = logRows.slice(1).filter(function (r) {
    if (String(r[0] || '').indexOf(dateStr) !== 0) return false;
    var rowEmail = String(r[5] || '').trim().toLowerCase();
    return !email || !rowEmail || rowEmail === email;
  });

  // 판매자명 없이(은행+지점만) 기록된 줄은 같은 은행+지점이면 한 번만 보여준다 (중복 제거).
  var seenBranchOnly = {};
  var visits = [];
  matches.forEach(function (r) {
    var seller = String(r[3] || '').trim();
    var key = normalizeText(r[1]) + '|' + normalizeText(r[2]);
    if (!seller) {
      if (seenBranchOnly[key]) return;
      seenBranchOnly[key] = true;
    }
    visits.push({ 은행명: r[1], 지점명: r[2], 판매자명: seller, 방문이력: r[4], 방문유형: String(r[6] || '').trim() || '지점방문' });
  });

  var branchSet = {};
  var sellerSet = {};
  visits.forEach(function (v) {
    var bKey = normalizeText(v.은행명) + '|' + normalizeText(v.지점명);
    branchSet[bKey] = true;
    if (v.판매자명) sellerSet[bKey + '|' + normalizeText(v.판매자명)] = true;
  });

  return {
    ok: true,
    date: dateStr,
    branchCount: Object.keys(branchSet).length,
    sellerCount: Object.keys(sellerSet).length,
    visits: visits
  };
}

// 활동달력에서 특정 날짜의 특정 지점 방문 기록을 전부 삭제 (해당 날짜+은행+지점에 해당하는 방문로그 행 전부 제거)
function handleDeleteVisitDay(dateStr, bank, branch) {
  if (!dateStr || !bank || !branch) return { ok: false, message: '필수 정보가 없습니다.' };
  var email = getCurrentUserEmail().toLowerCase();
  var normBank = normalizeText(bank);
  var normBranch = normalizeText(branch);
  var logSheet = getSS().getSheetByName(SHEET_LOG);
  var rows = readRows(SHEET_LOG);

  var rowNumsToDelete = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[0] || '').indexOf(dateStr) !== 0) continue;
    if (normalizeText(String(r[1] || '')) !== normBank) continue;
    if (normalizeText(String(r[2] || '')) !== normBranch) continue;
    var rowEmail = String(r[5] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    rowNumsToDelete.push(i + 1);
  }
  if (rowNumsToDelete.length === 0) return { ok: false, message: '삭제할 방문 기록을 찾을 수 없습니다.' };

  // 뒤에서부터 삭제해야 행 번호가 밀리지 않음
  rowNumsToDelete.sort(function (a, b) { return b - a; });
  rowNumsToDelete.forEach(function (rowNum) { logSheet.deleteRow(rowNum); });

  return { ok: true, deleted: rowNumsToDelete.length };
}

// 은행별: 모수(영업대상 지점수) / 당월 방문 지점수 / 미방문 지점수
// 판매자정보 시트 K열(영업대상, 체크박스)에 TRUE로 표시된 지점만 모수로 집계함
function handleDashboard() {
  var email = getCurrentUserEmail().toLowerCase();
  var rows = readRowsCached(SHEET_SELLER);
  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);

  var targetBranchesByBank = {}; // bank -> Set(branchKey) 모수
  var allBranchLabelByKey = {};
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    var bank = String(bankCol[i] || '').trim();
    var branch = String(branchCol[i] || '').trim();
    if (!bank || !branch) continue;
    var isTarget = rows[i][10] === true || String(rows[i][10] || '').toUpperCase() === 'TRUE';
    if (!isTarget) continue;
    var key = normalizeText(bank) + '|' + normalizeText(branch);
    if (!targetBranchesByBank[bank]) targetBranchesByBank[bank] = {};
    targetBranchesByBank[bank][key] = true;
    allBranchLabelByKey[key] = branch;
  }

  var thisMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var logRows = readRowsCached(SHEET_LOG);
  var visitedByBank = {}; // bank -> Set(branchKey) 이번달 방문
  for (var j = 1; j < logRows.length; j++) {
    var logDate = String(logRows[j][0] || '');
    if (logDate.indexOf(thisMonth) !== 0) continue;
    var logEmail = String(logRows[j][5] || '').trim().toLowerCase();
    if (email && logEmail && logEmail !== email) continue;
    var lBank = String(logRows[j][1] || '').trim();
    var lBranch = String(logRows[j][2] || '').trim();
    if (!lBank || !lBranch) continue;
    var lKey = normalizeText(lBank) + '|' + normalizeText(lBranch);
    if (!visitedByBank[lBank]) visitedByBank[lBank] = {};
    visitedByBank[lBank][lKey] = true;
  }

  // 은행별 지점 상세(방문/미방문)까지 한 번에 담아 보낸다. 대시보드에서 은행을 눌렀을 때
  // dashboardBank를 은행마다 다시 호출하지 않아도 되도록(요청 N번 -> 0번).
  var banks = Object.keys(targetBranchesByBank);
  var result = banks.map(function (bank) {
    var targetKeys = Object.keys(targetBranchesByBank[bank]);
    var visitedTargetCount = 0;
    var branchList = targetKeys.map(function (k) {
      var visited = !!(visitedByBank[bank] && visitedByBank[bank][k]);
      if (visited) visitedTargetCount++;
      return { 지점명: allBranchLabelByKey[k], visited: visited };
    }).sort(function (a, b) { return a.지점명.localeCompare(b.지점명, 'ko'); });
    return {
      은행명: bank,
      모수: targetKeys.length,
      당월방문: visitedTargetCount,
      미방문: targetKeys.length - visitedTargetCount,
      branches: branchList
    };
  });

  return { ok: true, month: thisMonth, banks: result };
}

// 대시보드에서 특정 은행을 눌렀을 때, 그 은행의 영업대상 지점 전체를 방문/미방문으로 나눠서 보여줌
function handleDashboardBank(bankName) {
  var email = getCurrentUserEmail().toLowerCase();
  var normBank = normalizeText(bankName);
  var rows = readRowsCached(SHEET_SELLER);
  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);

  var targetBranches = {}; // normBranch -> 풀네임 (영업대상으로 체크된 지점만)
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    if (!textMatches(normalizeText(bankCol[i]), normBank)) continue;
    var isTarget = rows[i][10] === true || String(rows[i][10] || '').toUpperCase() === 'TRUE';
    if (!isTarget) continue;
    var branch = String(branchCol[i] || '').trim();
    if (!branch) continue;
    targetBranches[normalizeText(branch)] = branch;
  }

  var thisMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var logRows = readRowsCached(SHEET_LOG);
  var visited = {}; // normBranch -> true (이번 달 방문)
  for (var j = 1; j < logRows.length; j++) {
    var logDate = String(logRows[j][0] || '');
    if (logDate.indexOf(thisMonth) !== 0) continue;
    var logEmail = String(logRows[j][5] || '').trim().toLowerCase();
    if (email && logEmail && logEmail !== email) continue;
    if (!textMatches(normalizeText(logRows[j][1] || ''), normBank)) continue;
    var lBranch = String(logRows[j][2] || '').trim();
    if (!lBranch) continue;
    visited[normalizeText(lBranch)] = true;
  }

  var branches = Object.keys(targetBranches).map(function (key) {
    return { 지점명: targetBranches[key], visited: !!visited[key] };
  }).sort(function (a, b) { return a.지점명.localeCompare(b.지점명, 'ko'); });

  return { ok: true, 은행명: bankName, branches: branches };
}

// 제안서 요청 시트 전체를 화면에서 실시간으로 보기 위한 목록
function handleListProposals() {
  var rows = readRowsCached(SHEET_PROPOSAL);
  var header = rows[0];
  var items = [];
  for (var i = 1; i < rows.length; i++) {
    var obj = { rowIndex: i + 1 };
    header.forEach(function (h, c) { obj[h] = rows[i][c]; });
    items.push(obj);
  }
  return { ok: true, header: header, items: items };
}

// 제안서 요청 한 행을 화면에서 수정(처리상태 토글 포함)한 내용을 저장
function handleUpdateProposal(rowIndex, data) {
  var sheet = getSS().getSheetByName(SHEET_PROPOSAL);
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values = header.map(function (h) { return data[h] !== undefined ? data[h] : ''; });
  sheet.getRange(rowIndex, 1, 1, header.length).setValues([values]);
  return { ok: true };
}

// 앱을 처음 열 때 필요한 것(내 정보 / 은행·지점·판매자 / 업무 / 대시보드)을 한 요청으로 모아서 준다.
// 예전에는 요청 4번이 각각 시트를 통째로 다시 읽어서 첫 화면이 특히 느렸다.
function handleBootstrap() {
  function safe(fn) {
    try { return fn(); } catch (e) { return { ok: false, error: e.message }; }
  }
  return {
    ok: true,
    me: safe(handleGetMe),
    branches: safe(handleListBranches),
    tasks: safe(handleListTasks),
    dashboard: safe(handleDashboard)
  };
}

// === 지도 (지점 좌표 + 방문/미방문) ==========================================
// 시트에는 지점 "이름"만 있고 좌표가 없다. 지점위치 시트에 좌표를 모아두고,
// 이번 달 방문 여부를 얹어서 지도에 그린다.
// 좌표 수집(importBranchAddresses/geocodeAll)은 Apps Script 편집기에서 직접 실행한다.

var GEO_HEADERS = ['지점키', '은행명', '지점명', '위도', '경도', '상태', '주소', '좌표출처', '매칭결과', '갱신일시'];
var GEO_COL_COUNT = 10;

// 지점을 식별하는 표준 키. 코드 전체가 이 형식을 쓴다.
function branchKey(bank, branch) {
  return normalizeText(bank) + '|' + normalizeText(branch);
}

// 판매자정보 시트는 1행이 비어 있고 2행이 실제 머리글이다. 반복문이 i=1부터 도는 탓에
// 그 머리글이 지점 하나로 잡혀 "은행명 | 지점명" 유령 지점이 목록과 지도에 나타났다.
// 머리글 위치를 가정하지 말고 값 자체로 판정한다 (실제로 "은행명"이라는 은행은 없다).
function isHeaderEchoRow(rows, i) {
  if (i === 0) return true;
  return String(rows[i][1] || '').trim() === '은행명' &&
         String(rows[i][2] || '').trim() === '지점명';
}

// "구월북지점" / "구월북" / "만수6동(점)" 처럼 접미어만 다른 표기를 같은 곳으로 보기 위해
// 접미어를 떼어낸 알맹이를 만든다.
var BRANCH_SUFFIX_RE = /(\(점\)|\(출\)|종합금융센터|금융센터|출장소|영업부|PB센터|센터|지점|점)$/;
function branchCore(name) {
  var v = normalizeText(name);
  while (true) {
    var n = v.replace(BRANCH_SUFFIX_RE, '');
    if (n === v || !n) return v;
    v = n;
  }
}

// 지점명 두 개가 같은 곳인지 점수로 판단한다.
// 단순 부분일치(indexOf)를 쓰면 "인천"이 "인천논현역지점"에 붙어버려서
// 엉뚱한 지점의 주소를 가져오게 된다. 접미어를 뗀 알맹이끼리 비교해야 안전하다.
function branchNameScore(nameA, nameB) {
  var a = normalizeText(nameA), b = normalizeText(nameB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  var ca = branchCore(a), cb = branchCore(b);
  if (ca && ca === cb) return 0.95;
  return similarity(ca, cb);
}

// 도로명 뒤에 건물명/층/지점명이 붙어 있으면 주소 검색이 실패한다. 도로명까지만 남긴다.
// "인천 남동구 백범로 124번길 7 만수주공아파트상가 1층 국민은행 만수동(점)" -> "인천 남동구 백범로 124번길 7"
// 번길을 먼저 찾아야 한다. 그냥 찾으면 "백범로 124"에서 끊겨 실제 위치와 수백 m 어긋난다.
function cleanRoadAddress(raw) {
  var s = String(raw || '').replace(/,/g, ' ');
  var m = s.match(/[가-힣A-Za-z0-9]*[로길]\s*\d+번길\s*\d+(?:-\d+)?/);
  if (!m) m = s.match(/[가-힣A-Za-z0-9]*[로길]\s*\d+(?:-\d+)?/);
  if (!m) return s.replace(/\s+/g, ' ').trim();
  return s.substring(0, m.index + m[0].length).replace(/\s+/g, ' ').trim();
}

// 카카오는 x=경도, y=위도로 돌려주는데 지도 SDK 생성자는 (위도, 경도) 순서다.
// 뒤바꿔 넣으면 전 지점이 서해 한복판에 찍히므로 대한민국 범위로 걸러낸다.
function isValidKoreaCoord(lat, lng) {
  return isFinite(lat) && isFinite(lng) &&
         lat >= 33.0 && lat <= 38.7 && lng >= 124.5 && lng <= 132.0;
}

function getGeoSheet() {
  var ss = getSS();
  var sheet = ss.getSheetByName(SHEET_GEO);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_GEO);
    sheet.appendRow(GEO_HEADERS);
    sheet.setFrozenRows(1);
  }
  // 열 수가 모자라면 아래 일괄 쓰기(setValues)가 범위 불일치로 실패한다.
  var missing = GEO_COL_COUNT - sheet.getMaxColumns();
  if (missing > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), missing);
  return sheet;
}

// 판매자정보에 등록된 모든 지점(중복 제거). 좌표는 담당자와 무관하게 공용이므로
// 이메일/영업대상 필터 없이 전부 모은다.
function listAllBranchesForGeo() {
  var rows = readRowsCached(SHEET_SELLER);
  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);
  var seen = {};
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (isHeaderEchoRow(rows, i)) continue;
    var bank = String(bankCol[i] || '').trim();
    var branch = String(branchCol[i] || '').trim();
    if (!bank || !branch) continue;
    var key = branchKey(bank, branch);
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ key: key, 은행명: bank, 지점명: branch });
  }
  return out;
}

// 지도에 표시할 대상 = 모수(K열 영업대상 TRUE) + 내 담당분. 대시보드와 같은 기준.
function listTargetBranches(email) {
  var rows = readRowsCached(SHEET_SELLER);
  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);
  var seen = {};
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (isHeaderEchoRow(rows, i)) continue;
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    var isTarget = rows[i][10] === true || String(rows[i][10] || '').toUpperCase() === 'TRUE';
    if (!isTarget) continue;
    var bank = String(bankCol[i] || '').trim();
    var branch = String(branchCol[i] || '').trim();
    if (!bank || !branch) continue;
    var key = branchKey(bank, branch);
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ key: key, 은행명: bank, 지점명: branch });
  }
  return out;
}

// 이번 달 방문 상태를 지점키별로 계산한다. 0=미접촉, 1=통화/제안서만, 2=방문완료.
// 대시보드와 달리 은행명 원문으로 버킷팅하지 않고 정규화 키 하나만 쓴다
// (은행명 표기가 시트마다 미세하게 달라도 어긋나지 않도록).
function buildVisitStateThisMonth(email) {
  var thisMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var logRows = readRowsCached(SHEET_LOG);
  var state = {};
  for (var j = 1; j < logRows.length; j++) {
    var r = logRows[j];
    if (String(r[0] || '').indexOf(thisMonth) !== 0) continue;
    var logEmail = String(r[5] || '').trim().toLowerCase();
    if (email && logEmail && logEmail !== email) continue;
    var bank = String(r[1] || '').trim();
    var branch = String(r[2] || '').trim();
    if (!bank || !branch) continue;
    // 방문유형(G열)이 비어 있으면 음성 기록 경로(handleCommit)로 남은 과거 행이다.
    // 그 행들은 방문이력/대화내용 본문을 갖고 있으니 실제 방문으로 본다.
    var type = String(r[6] || '').trim();
    var v = (!type || type === '지점방문') ? 2 : 1;
    var key = branchKey(bank, branch);
    if (!state[key] || v > state[key]) state[key] = v;
  }
  return state;
}

// 지점위치 시트를 지점키 -> {lat, lng} 로 읽는다. 좌표가 이상하면 없는 것으로 친다.
function readGeoByKey() {
  var rows = readRowsCached(SHEET_GEO);
  var map = {};
  for (var i = 1; i < rows.length; i++) {
    var key = String(rows[i][0] || '').trim();
    if (!key) continue;
    // '실패'/'의심'은 지도에 올리지 않는다. 틀린 곳에 찍힌 핀은 없는 핀보다 나쁘다.
    var st = String(rows[i][5] || '').trim();
    if (st !== '자동' && st !== '확정') continue;
    var lat = Number(rows[i][3]);
    var lng = Number(rows[i][4]);
    if (!isValidKoreaCoord(lat, lng)) continue;
    map[key] = { lat: lat, lng: lng };
  }
  return map;
}

// 지도용 데이터. 은행명/지점명은 프런트가 branchListData에 이미 갖고 있으므로 싣지 않는다.
function handleMapData() {
  var email = getCurrentUserEmail().toLowerCase();
  var targets = listTargetBranches(email);
  var visitState = buildVisitStateThisMonth(email);
  var geo = readGeoByKey();

  var points = [];
  var missing = [];
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var g = geo[t.key];
    if (!g) { missing.push({ 은행명: t.은행명, 지점명: t.지점명 }); continue; }
    points.push({ k: t.key, lat: g.lat, lng: g.lng, v: visitState[t.key] || 0 });
  }

  return {
    ok: true,
    month: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM'),
    total: targets.length,
    points: points,
    missing: missing
  };
}

// 진단용(읽기 전용): 담당자이메일(L열) 분포와, 판매자명이 있는 행의 소유자 현황.
// 로그인한 사용자와 L열 값이 어긋나면 목록·상세가 비어 보이므로 그 여부를 확인한다.
function handleOwnerAudit() {
  var rows = readRowsCached(SHEET_SELLER);
  var byOwner = {};
  var named = 0, namedBlankOwner = 0;
  for (var i = 1; i < rows.length; i++) {
    if (isHeaderEchoRow(rows, i)) continue;
    var owner = String(rows[i][11] || '').trim().toLowerCase() || '(비어있음)';
    var name = String(rows[i][3] || '').trim();
    if (!byOwner[owner]) byOwner[owner] = { 전체행: 0, 판매자명있는행: 0 };
    byOwner[owner].전체행++;
    if (name) {
      byOwner[owner].판매자명있는행++;
      named++;
      if (owner === '(비어있음)') namedBlankOwner++;
    }
  }
  return {
    ok: true,
    로그인이메일: getCurrentUserEmail() || '(없음 - 토큰 미첨부)',
    총행수: rows.length,
    판매자명있는행: named,
    소유자비어있는행: namedBlankOwner,
    소유자별: byOwner
  };
}

// 진단용(읽기 전용): 특정 담당자로 로그인했을 때 목록과 상세가 각각 몇 명을 보게 되는지 비교한다.
// 지도 목록에는 지점이 뜨는데 상세는 비어 보이는 원인을 좁히기 위한 것.
// 인증 없이도 전체가 조회되는 엔드포인트이므로 이 함수가 새로 열어주는 권한은 없다.
function handleDiagAs(as, bank, branch) {
  var email = String(as || '').trim().toLowerCase();
  var rows = readRowsCached(SHEET_SELLER);
  var bankCol = fillMergedColumn(rows, 1);
  var branchCol = fillMergedColumn(rows, 2);

  // ① handleListBranches 관점 (지도 목록이 만들어지는 방식)
  var lbFound = false, lbSellers = 0;
  for (var i = 1; i < rows.length; i++) {
    if (isHeaderEchoRow(rows, i)) continue;
    var re = String(rows[i][11] || '').trim().toLowerCase();
    if (email && re && re !== email) continue;
    if (String(bankCol[i] || '').trim() !== bank) continue;
    if (String(branchCol[i] || '').trim() !== branch) continue;
    lbFound = true;
    if (String(rows[i][3] || '').trim()) lbSellers++;
  }

  // ② handleBranchDetail 관점 (팝업이 쓰는 방식)
  var group = findMatchingGroup(rows, bank, branch);
  var bdSellers = 0, dropByEmail = 0, dropNoName = 0, owners = {};
  for (var g = 0; g < group.length; g++) {
    var idx = group[g];
    if (isHeaderEchoRow(rows, idx)) continue;
    var owner = String(rows[idx][11] || '').trim().toLowerCase() || '(비어있음)';
    owners[owner] = (owners[owner] || 0) + 1;
    if (email && owner !== '(비어있음)' && owner !== email) { dropByEmail++; continue; }
    if (!String(rows[idx][3] || '').trim()) { dropNoName++; continue; }
    bdSellers++;
  }

  return {
    ok: true, 기준이메일: email || '(필터 없음)', 은행: bank, 지점: branch,
    목록_지점존재: lbFound, 목록_판매자수: lbSellers,
    상세_그룹크기: group.length, 상세_판매자수: bdSellers,
    제외_다른담당자: dropByEmail, 제외_이름없음: dropNoName,
    그룹내_담당자분포: owners
  };
}

// 지도에서 지점을 눌렀을 때 보여줄 판매자 상세.
// 입력해 둔 5개 항목은 양이 많아 mapData에 미리 싣지 않고, 누른 지점 것만 그때 가져온다.
// key(지점키)만으로도 조회할 수 있다. 프런트의 지점 목록이 비어 있어도(부팅 요청 실패 등)
// 지도에서 누른 지점의 상세를 받을 수 있어야 하기 때문이다.
function handleBranchDetail(bank, branch, key) {
  var rows = readRowsCached(SHEET_SELLER);
  bank = String(bank || '').trim();
  branch = String(branch || '').trim();

  if ((!bank || !branch) && String(key || '').trim()) {
    var bankCol0 = fillMergedColumn(rows, 1);
    var branchCol0 = fillMergedColumn(rows, 2);
    for (var s = 1; s < rows.length; s++) {
      if (isHeaderEchoRow(rows, s)) continue;
      var b0 = String(bankCol0[s] || '').trim();
      var r0 = String(branchCol0[s] || '').trim();
      if (!b0 || !r0) continue;
      if (branchKey(b0, r0) !== String(key).trim()) continue;
      bank = b0; branch = r0;
      break;
    }
  }
  if (!bank || !branch) {
    return { ok: false, message: '지점을 찾을 수 없습니다.' };
  }

  var email = getCurrentUserEmail().toLowerCase();
  var group = findMatchingGroup(rows, bank, branch);

  var sellers = [];
  for (var i = 0; i < group.length; i++) {
    var idx = group[i];
    if (isHeaderEchoRow(rows, idx)) continue;
    var rowEmail = String(rows[idx][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    var r = rows[idx];
    var name = String(r[3] || '').trim();
    if (!name) continue;
    sellers.push({
      판매자명: name,
      직책: String(r[4] || '').trim(),
      가족관계: String(r[5] || '').trim(),
      자택: String(r[6] || '').trim(),
      판매성향: String(r[7] || '').trim(),
      방문이력: String(r[8] || '').trim(),
      기타대화내용: String(r[9] || '').trim()
    });
  }
  return { ok: true, 은행명: bank, 지점명: branch, sellers: sellers };
}

// 좌표 수집이 잘 됐는지 확인용(읽기 전용). 상태별 개수와 표본을 돌려준다.
function handleGeoStatus() {
  var rows = readRowsCached(SHEET_GEO);
  if (rows.length === 0) return { ok: true, 전체: 0, message: '지점위치 시트가 아직 없습니다.' };

  var byStatus = {};
  var bySource = {};
  var badCoord = [];
  var samples = [];
  var failed = [];

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!String(r[0] || '').trim()) continue;
    var st = String(r[5] || '').trim() || '(미처리)';
    byStatus[st] = (byStatus[st] || 0) + 1;
    var src = String(r[7] || '').trim();
    if (src) bySource[src] = (bySource[src] || 0) + 1;

    var lat = Number(r[3]), lng = Number(r[4]);
    if (st === '자동' || st === '확정') {
      if (!isValidKoreaCoord(lat, lng)) badCoord.push(r[1] + ' ' + r[2] + ' (' + lat + ',' + lng + ')');
      else if (samples.length < 12) {
        samples.push({ 은행: r[1], 지점: r[2], 위도: lat, 경도: lng, 출처: src, 매칭결과: String(r[8] || '') });
      }
    } else if (st === '실패' && failed.length < 40) {
      failed.push(r[1] + ' ' + r[2]);
    }
  }

  return { ok: true, 전체: rows.length - 1, 상태별: byStatus, 출처별: bySource,
           좌표이상: badCoord, 표본: samples, 실패목록: failed };
}

// --- 좌표 수집 (관리자용: Apps Script 편집기에서 실행) ------------------------

function getKakaoRestKey() {
  var key = (PropertiesService.getScriptProperties().getProperty('KAKAO_REST_KEY') || '').trim();
  if (!key) {
    throw new Error('KAKAO_REST_KEY가 없습니다. 프로젝트 설정 > 스크립트 속성에 카카오 REST API 키를 추가하세요.');
  }
  return key;
}

function kakaoGet(path, params) {
  var qs = Object.keys(params).map(function (k) {
    return k + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var res = UrlFetchApp.fetch('https://dapi.kakao.com' + path + '?' + qs, {
    method: 'get',
    headers: { Authorization: 'KakaoAK ' + getKakaoRestKey() },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) throw new Error('카카오 API ' + code + ': ' + body);
  return JSON.parse(body);
}

// 주소로 좌표 찾기 (가장 정확). 정제한 도로명으로 먼저 시도하고, 안 되면 원본 그대로 한 번 더.
function geocodeByAddress(address) {
  var tries = [];
  var cleaned = cleanRoadAddress(address);
  if (cleaned) tries.push(cleaned);
  if (address && address !== cleaned) tries.push(address);

  for (var t = 0; t < tries.length; t++) {
    var data;
    try { data = kakaoGet('/v2/local/search/address.json', { query: tries[t], size: 1 }); }
    catch (e) { continue; }
    var docs = data.documents || [];
    if (!docs.length) continue;
    var d = docs[0];
    var lat = Number(d.y), lng = Number(d.x);
    if (!isValidKoreaCoord(lat, lng)) continue;
    return { lat: lat, lng: lng, label: d.address_name || tries[t], source: '주소검색' };
  }
  return null;
}

// 이름으로 좌표 찾기.
// 가장 위험한 실패는 "은행은 맞는데 지점이 다른 곳"이다. 실제로 "기업은행 남동공단비전"을
// 찾다가 부산의 "IBK기업은행 금사공단"이 잡힌 적이 있다. 은행명과 은행 카테고리만으로는
// 그 은행의 아무 지점이나 통과하므로, 반드시 지점명 자체가 일치해야 채택한다.
// 카카오가 붙이는 브랜드 접두어. 시트에는 없고 카카오에만 있어서 그대로 비교하면 어긋난다.
// (예: 시트 "농협은행 인천논현역" vs 카카오 "NH농협은행 인천논현금융센터")
var BANK_BRAND_PREFIXES = ['NH', 'KB', 'IBK', 'BNK', 'DGB', 'KDB', 'SC', 'IM', 'JB', 'KEB'];

function stripBrandPrefix(key) {
  for (var i = 0; i < BANK_BRAND_PREFIXES.length; i++) {
    var p = BANK_BRAND_PREFIXES[i];
    if (key.indexOf(p) === 0) return key.substring(p.length);
  }
  return key;
}

// 비교용 정규화: 공백/한글숫자 정리에 더해 대소문자까지 무시한다
// (시트 "IM뱅크" vs 카카오 "iM뱅크"가 다른 문자열로 취급되던 문제).
function matchKey(s) {
  return normalizeText(s).toUpperCase();
}

function geocodeByName(bank, branch) {
  var branchRaw = String(branch || '').trim();
  var bankKey = matchKey(bank);

  // 지점명이 "군자농협 거모지점"처럼 은행 이름으로 시작하면 그쪽이 진짜 은행이다.
  // (은행명 칸에 "농축협" 같은 상위 분류가 들어있거나, 은행명이 지점명에 중복된 경우)
  var lead = branchRaw.match(/^([가-힣A-Za-z]+(?:농협|축협|은행|뱅크))\s+/);
  var effBankKey = bankKey, effBranch = branchRaw;
  if (lead) {
    effBankKey = matchKey(lead[1]);
    effBranch = branchRaw.substring(lead[0].length).trim() || branchRaw;
  }
  var coreBranch = stripBrandPrefix(branchCore(matchKey(effBranch)));
  if (!coreBranch) return null;

  var queries = [bank + ' ' + branchRaw, branchRaw, lead ? lead[1] + ' ' + effBranch : null];
  var best = null, bestScore = 0;

  for (var q = 0; q < queries.length; q++) {
    if (!queries[q]) continue;
    var data;
    try { data = kakaoGet('/v2/local/search/keyword.json', { query: queries[q], size: 15 }); }
    catch (e) { continue; }
    var docs = data.documents || [];
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      var lat = Number(d.y), lng = Number(d.x);
      if (!isValidKoreaCoord(lat, lng)) continue;

      var placeKey = matchKey(d.place_name);
      if (placeKey.indexOf(effBankKey) === -1) continue; // 다른 은행 → 탈락

      // 장소명에서 은행명과 브랜드 접두어를 걷어낸 나머지가 그 지점을 가리키는 부분이다.
      var placeBranch = stripBrandPrefix(branchCore(placeKey.split(effBankKey).join('')));
      if (!placeBranch) continue;

      // 지점명이 일치해야만 점수를 준다. 은행명/카테고리는 가산점일 뿐 단독 합격 불가.
      var score;
      if (placeBranch.indexOf(coreBranch) !== -1 || coreBranch.indexOf(placeBranch) !== -1) score = 1;
      else score = similarity(placeBranch, coreBranch);
      if (d.category_group_code === 'BK9') score += 0.05; // 동점일 때만 갈리는 미세 가산점

      if (score > bestScore) {
        bestScore = score;
        best = { lat: lat, lng: lng, label: d.place_name, source: '이름검색' };
      }
    }
    if (bestScore >= 1) break; // 지점명 완전 일치면 더 볼 필요 없음
  }
  // 0.6 미만이면 "그 은행의 다른 지점"일 가능성이 크다. 틀린 핀은 없는 핀보다 나쁘다.
  return bestScore >= 0.6 ? best : null;
}

// 관공서 안에 있는 출장소는 카카오에 지점명으로 등록돼 있지 않다("단원구청(출)" 검색 결과 0건).
// 이 경우 건물 자체를 찾는다 — 출장소가 그 건물 안에 있으므로 찾아갈 위치로는 정확하다.
// 구청/시청/군청으로 끝나는 것만 시도해서 "배곧" 같은 모호한 이름은 손대지 않는다.
function geocodeGovernmentOffice(branch) {
  var core = branchCore(String(branch || '').trim());
  if (!/(구청|시청|군청)$/.test(core)) return null;
  var data;
  try { data = kakaoGet('/v2/local/search/keyword.json', { query: core, size: 10 }); }
  catch (e) { return null; }
  var docs = data.documents || [];
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    var lat = Number(d.y), lng = Number(d.x);
    if (!isValidKoreaCoord(lat, lng)) continue;
    if (matchKey(d.place_name).indexOf(matchKey(core)) === -1) continue;
    return { lat: lat, lng: lng, label: d.place_name + ' (건물 기준)', source: '건물추정' };
  }
  return null;
}

// 판매자정보의 모든 지점에 대해 지점위치 시트에 빈 행을 만든다. 기존 행은 건드리지 않는다.
function syncGeoSheet() {
  var sheet = getGeoSheet();
  var rows = readRows(SHEET_GEO);
  var have = {};
  for (var i = 1; i < rows.length; i++) have[String(rows[i][0] || '').trim()] = true;

  var toAdd = [];
  var all = listAllBranchesForGeo();
  for (var j = 0; j < all.length; j++) {
    if (have[all[j].key]) continue;
    toAdd.push([all[j].key, all[j].은행명, all[j].지점명, '', '', '', '', '', '', '']);
  }
  if (toAdd.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAdd.length, GEO_COL_COUNT).setValues(toAdd);
    SpreadsheetApp.flush();
    invalidateAllCaches();
  }
  return toAdd.length;
}

// 좌표를 채운다. 상태가 '확정'(손으로 고친 것)이나 '자동'(이미 성공)인 행은 절대 건드리지 않으므로
// 몇 번을 다시 실행해도 안전하고, 중간에 멈춰도 이어서 진행된다.
function geocodeBatch(limit) {
  limit = limit || 2000;
  var sheet = getGeoSheet();
  var rows = readRows(SHEET_GEO);

  var pending = [];
  for (var i = 1; i < rows.length; i++) {
    var status = String(rows[i][5] || '').trim();
    if (status === '확정' || status === '자동') continue;
    if (!String(rows[i][0] || '').trim()) continue;
    pending.push(i);
  }

  var t0 = new Date().getTime();
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var done = 0, ok = 0, fail = 0;
  var failSamples = [];

  for (var p = 0; p < pending.length && done < limit; p++) {
    if (new Date().getTime() - t0 > 240000) break; // 6분 제한 전에 스스로 멈춘다
    var idx = pending[p];
    var r = rows[idx];
    var bank = String(r[1] || '').trim();
    var branch = String(r[2] || '').trim();
    var addr = String(r[6] || '').trim();

    // 시트 중간의 머리글 행이 지점위치에 들어온 것은 지점이 아니므로 검색하지 않는다.
    if (bank === '은행명' && branch === '지점명') {
      r[5] = '제외'; r[9] = stamp;
      continue;
    }

    var hit = null;
    try {
      if (addr) hit = geocodeByAddress(addr);
      if (!hit) hit = geocodeByName(bank, branch);
      if (!hit) hit = geocodeGovernmentOffice(branch);
    } catch (e) {
      hit = null;
    }
    done++;

    if (hit) {
      ok++;
      r[3] = hit.lat; r[4] = hit.lng; r[5] = '자동';
      r[7] = hit.source; r[8] = hit.label; r[9] = stamp;
    } else {
      fail++;
      r[5] = '실패'; r[9] = stamp;
      if (failSamples.length < 20) failSamples.push(bank + ' ' + branch);
    }
  }

  // 행마다 쓰면 수백 번 왕복이라 느리다. D~J 전체를 한 번에 기록한다.
  // (슬라이스로 자르면 시트 열 수가 모자랄 때 길이가 어긋나므로 명시적으로 7칸을 만든다)
  if (rows.length > 1) {
    var block = [];
    for (var b = 1; b < rows.length; b++) {
      var rr = rows[b];
      block.push([rr[3] || '', rr[4] || '', rr[5] || '', rr[6] || '', rr[7] || '', rr[8] || '', rr[9] || '']);
    }
    sheet.getRange(2, 4, block.length, 7).setValues(block);
  }
  SpreadsheetApp.flush();
  invalidateAllCaches(); // 편집기 실행은 doGet을 안 거치므로 여기서 직접 캐시를 버린다

  var result = { 처리: done, 성공: ok, 실패: fail, 남은개수: pending.length - done, 실패예시: failSamples };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

// 이름 검색은 "은행은 맞는데 지점이 다른 곳"을 집을 수 있다. 담당 구역은 대체로 한 지역에
// 모여 있으므로, 다른 지점들의 중앙값에서 크게 벗어난 좌표는 오검색으로 보고 걸러낸다.
// 중앙값을 실제 데이터에서 계산하므로 담당 지역이 어디든(부산이든 인천이든) 그대로 작동한다.
function flagDistantOutliers(maxKm) {
  maxKm = maxKm || 100;
  var sheet = getGeoSheet();
  var rows = readRows(SHEET_GEO);

  var pts = [];
  for (var i = 1; i < rows.length; i++) {
    var st = String(rows[i][5] || '').trim();
    if (st !== '자동') continue; // 손으로 확정한 좌표는 건드리지 않는다
    var lat = Number(rows[i][3]), lng = Number(rows[i][4]);
    if (isValidKoreaCoord(lat, lng)) pts.push({ i: i, lat: lat, lng: lng });
  }
  if (pts.length < 10) return { ok: true, message: '표본이 적어 건너뜀', 검사대상: pts.length };

  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  var mLat = median(pts.map(function (p) { return p.lat; }));
  var mLng = median(pts.map(function (p) { return p.lng; }));

  var flagged = [];
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  for (var k = 0; k < pts.length; k++) {
    var p = pts[k];
    // 위도 1도 ≈ 111km, 경도 1도 ≈ 88km(위도 37도 기준)
    var dx = (p.lat - mLat) * 111, dy = (p.lng - mLng) * 88;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= maxKm) continue;
    rows[p.i][5] = '의심';
    rows[p.i][9] = stamp;
    flagged.push(rows[p.i][1] + ' ' + rows[p.i][2] + ' (' + Math.round(dist) + 'km)');
  }

  if (flagged.length) {
    var block = [];
    for (var b = 1; b < rows.length; b++) {
      var rr = rows[b];
      block.push([rr[3] || '', rr[4] || '', rr[5] || '', rr[6] || '', rr[7] || '', rr[8] || '', rr[9] || '']);
    }
    sheet.getRange(2, 4, block.length, 7).setValues(block);
    SpreadsheetApp.flush();
    invalidateAllCaches();
  }
  return { ok: true, 검사대상: pts.length, 중앙값: [mLat, mLng], 의심표시: flagged.length, 목록: flagged };
}

// 이름 검색으로 찍힌 좌표를 새 판정 기준으로 다시 검사한다.
// 지점명이 실제로 일치하는지 보는 기준이 강화됐으므로, 예전에 잘못 붙은 것들이 걸러진다.
function regeocodeNames() {
  var sheet = getGeoSheet();
  var rows = readRows(SHEET_GEO);
  var reset = 0;
  for (var i = 1; i < rows.length; i++) {
    var st = String(rows[i][5] || '').trim();
    if (st === '확정') continue;                       // 손으로 고친 것은 보존
    if (String(rows[i][7] || '').trim() !== '이름검색') continue;
    rows[i][3] = ''; rows[i][4] = ''; rows[i][5] = ''; rows[i][7] = ''; rows[i][8] = '';
    reset++;
  }
  var block = [];
  for (var b = 1; b < rows.length; b++) {
    var rr = rows[b];
    block.push([rr[3] || '', rr[4] || '', rr[5] || '', rr[6] || '', rr[7] || '', rr[8] || '', rr[9] || '']);
  }
  sheet.getRange(2, 4, block.length, 7).setValues(block);
  SpreadsheetApp.flush();
  invalidateAllCaches();

  var res = geocodeBatch(2000);
  res.초기화 = reset;
  res.이상치 = flagDistantOutliers(100);
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}

// 담당자이메일(L열)에 이메일이 아닌 값이 들어간 행을 실제 이메일로 정정한다.
// 앱은 이 열로 "내 담당"을 가려내므로, 이름이 들어있으면 어느 계정과도 안 맞아
// 그 행들이 아무에게도 보이지 않는다.
// 정확히 일치하는 값만 바꾸므로 다른 행은 건드리지 않는다.
var OWNER_FIXES = {
  '차민국': 'kukkie1@hanmail.net'
};

function fixOwnerEmails() {
  var sheet = getSS().getSheetByName(SHEET_SELLER);
  var rows = readRows(SHEET_SELLER);
  var changed = 0;
  var before = {};

  for (var i = 1; i < rows.length; i++) {
    var cur = String(rows[i][11] || '').trim();
    var fixed = OWNER_FIXES[cur];
    if (!fixed) continue;
    before[cur] = (before[cur] || 0) + 1;
    rows[i][11] = fixed;
    changed++;
  }

  if (changed) {
    var col = [];
    for (var c = 1; c < rows.length; c++) col.push([rows[c][11] || '']);
    sheet.getRange(2, 12, col.length, 1).setValues(col);
    SpreadsheetApp.flush();
    invalidateAllCaches();
  }

  var res = { 정정한행: changed, 정정내역: before, 매핑: OWNER_FIXES };
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}

// 편집기에서 이것 하나만 실행하면 된다. 남은개수가 0이 될 때까지 다시 실행.
function geocodeAll() {
  var added = syncGeoSheet();
  var res = geocodeBatch(2000);
  res.신규지점추가 = added;
  res.이상치 = flagDistantOutliers(100);
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}

// 지점주소 시트(엑셀에서 붙여넣은 원본)를 읽어 지점위치의 주소(G열)를 채운다.
// 열 위치가 아니라 머리글 이름으로 찾으므로 엑셀 열 순서가 달라도 동작한다.
function importBranchAddresses() {
  var src = getSS().getSheetByName(SHEET_GEO_SRC);
  if (!src) {
    throw new Error('"' + SHEET_GEO_SRC + '" 시트가 없습니다. 엑셀 내용을 은행명/지점명/주소 머리글과 함께 붙여넣어 주세요.');
  }
  var srcRows = src.getDataRange().getValues();
  if (srcRows.length < 2) throw new Error('"' + SHEET_GEO_SRC + '" 시트에 데이터가 없습니다.');

  var header = srcRows[0].map(function (h) { return String(h || '').replace(/\s+/g, ''); });
  function findCol(cands) {
    for (var i = 0; i < header.length; i++) {
      for (var j = 0; j < cands.length; j++) {
        if (header[i].indexOf(cands[j]) !== -1) return i;
      }
    }
    return -1;
  }
  var cBank = findCol(['은행', '금융기관', '기관']);
  var cBranch = findCol(['지점', '점포', '영업점']);
  var cAddr = findCol(['주소', '소재지']);
  if (cBranch === -1 || cAddr === -1) {
    throw new Error('머리글에서 지점/주소 열을 찾지 못했습니다. 머리글: ' + header.join(', '));
  }

  var src2 = [];
  for (var i = 1; i < srcRows.length; i++) {
    var sBank = cBank === -1 ? '' : String(srcRows[i][cBank] || '').trim();
    var sBranch = String(srcRows[i][cBranch] || '').trim();
    var sAddr = String(srcRows[i][cAddr] || '').trim();
    if (!sBranch || !sAddr) continue;
    src2.push({ normBank: normalizeText(sBank), branch: sBranch, addr: sAddr });
  }

  syncGeoSheet();
  var sheet = getGeoSheet();
  var rows = readRows(SHEET_GEO);
  var filled = 0;
  var unmatched = [];
  // 0.85 미만은 매칭하지 않는다. 틀린 주소는 엉뚱한 건물로 찾아가게 하므로
  // 주소가 없는 것(→ 이름 검색으로 넘어감)보다 나쁘다.
  var MATCH_THRESHOLD = 0.85;

  for (var g = 1; g < rows.length; g++) {
    if (String(rows[g][6] || '').trim()) continue; // 이미 주소 있음
    var bank = String(rows[g][1] || '').trim();
    var branch = String(rows[g][2] || '').trim();
    var normBank = normalizeText(bank);

    var addr = null, bestScore = MATCH_THRESHOLD;
    for (var m = 0; m < src2.length; m++) {
      // 은행명은 표기가 달라도 되게 느슨히("NH농협은행" vs "농협은행"), 지점명은 엄격히 본다.
      if (!textMatches(src2[m].normBank, normBank)) continue;
      var s = branchNameScore(branch, src2[m].branch);
      if (s > bestScore) { bestScore = s; addr = src2[m].addr; }
    }

    if (addr) { rows[g][6] = addr; filled++; }
    else unmatched.push(bank + ' ' + branch);
  }

  if (rows.length > 1) {
    var col = [];
    for (var c = 1; c < rows.length; c++) col.push([rows[c][6] || '']);
    sheet.getRange(2, 7, col.length, 1).setValues(col);
  }
  SpreadsheetApp.flush();
  invalidateAllCaches();

  var out = { 주소채움: filled, 매칭실패: unmatched.length, 실패목록: unmatched.slice(0, 30) };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function sanitizeText(text) {
  return String(text || '')
    .replace(/[#*_`>{}\[\]\\|~^]/g, '')
    .replace(/^[\s\-]+/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function callClaude(prompt) {
  var text = callClaudeText(prompt + '\n\nJSON만 출력하세요. 다른 설명은 붙이지 마세요.');
  var jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : text);
}

// 스크립트 속성(프로젝트 설정 > 스크립트 속성)에 CLAUDE_API_KEY가 설정되어 있으면 그것을 우선 사용하고,
// 없으면 위쪽의 CLAUDE_API_KEY 변수를 사용한다. 앞뒤 공백은 항상 제거해서 붙여넣기 실수를 방지한다.
function getClaudeApiKey() {
  var fromProps = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  var key = (fromProps || CLAUDE_API_KEY || '').trim();
  if (!key || key === 'YOUR_CLAUDE_API_KEY_HERE') {
    throw new Error('CLAUDE_API_KEY가 설정되지 않았습니다. 프로젝트 설정 > 스크립트 속성에 CLAUDE_API_KEY를 추가하거나, Code.gs 맨 위 변수에 실제 Anthropic API 키를 입력하세요.');
  }
  return key;
}

// 요청 단위로 검증된 접속자 이메일 (doGet에서 토큰 검증 후 설정)
var _requestUserEmail = '';

function getCurrentUserEmail() {
  // 서명 토큰으로 검증된 이메일을 우선 사용하고, 없으면 세션 계정(소유자 직접 접속용)으로 폴백
  if (_requestUserEmail) return _requestUserEmail;
  return Session.getActiveUser().getEmail() || '';
}

// === 로그인/토큰 (PIN 기반) ==================================================
// 서명 비밀키는 소스코드(GitHub)에 두지 않고 Script Properties에 자동 생성·보관한다.
function getAuthSecret() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('AUTH_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('AUTH_SECRET', s); }
  return s;
}

function makeToken(email) {
  email = String(email || '').trim().toLowerCase();
  var sig = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(email, getAuthSecret()));
  return email + '|' + sig;
}

function verifyToken(token) {
  token = String(token || '');
  var i = token.lastIndexOf('|');
  if (i < 0) return '';
  var email = token.substring(0, i);
  var sig = token.substring(i + 1);
  return sig === makeToken(email).split('|')[1] ? email : '';
}

// 사용자목록 시트에서 이메일로 행을 찾음 (0-based row index 반환, 못 찾으면 -1)
function _findUserRowByEmail(rows, email) {
  email = String(email || '').trim().toLowerCase();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1] || '').trim().toLowerCase() === email) return i;
  }
  return -1;
}

// 로그인: 이메일 + PIN 검증. PIN 미설정 사용자는 이번에 입력한 PIN으로 최초 등록.
// 사용자목록 시트 컬럼: A=이름, B=이메일, C=PIN
function handleLogin(email, pin) {
  email = String(email || '').trim();
  pin = String(pin || '').trim();
  var usersSheet = getSS().getSheetByName(SHEET_USERS);
  if (!usersSheet) return { ok: false, error: 'no_users_sheet' };
  var rows = readRows(SHEET_USERS);
  var idx = _findUserRowByEmail(rows, email);
  if (idx < 0) return { ok: false, error: 'not_registered' };
  var name = String(rows[idx][0] || '').trim();
  var savedPin = String(rows[idx][2] || '').trim();
  if (!savedPin) {
    // 최초 로그인: PIN 설정 단계
    if (!pin) return { ok: false, error: 'set_pin', name: name };
    if (pin.length < 4) return { ok: false, error: 'pin_too_short', name: name };
    usersSheet.getRange(idx + 1, 3).setValue("'" + pin); // 앞자리 0 보존 위해 텍스트로 저장
    return { ok: true, name: name, email: email, token: makeToken(email), firstTime: true };
  }
  if (pin !== savedPin) return { ok: false, error: 'wrong_pin', name: name };
  return { ok: true, name: name, email: email, token: makeToken(email) };
}

// 첫 접속 시 사용자가 본인 이름을 고를 수 있도록 등록된 사용자 목록을 반환
function handleListUsers() {
  // 빈 결과는 캐시하지 않으므로, 행이 0개면 시트 자체가 없는 경우다.
  // (시트 존재 확인을 위해 매번 스프레드시트를 열지 않아도 된다)
  var rows = readRowsCached(SHEET_USERS);
  if (rows.length === 0) return { ok: false, error: 'no_users_sheet' };
  var users = [];
  for (var i = 1; i < rows.length; i++) {
    var name = String(rows[i][0] || '').trim();
    var email = String(rows[i][1] || '').trim();
    if (email) users.push({ name: name, email: email });
  }
  return { ok: true, users: users };
}

function handleGetMe() {
  var email = getCurrentUserEmail();
  if (!email) return { ok: false, error: 'login_required' };
  var rows = readRowsCached(SHEET_USERS);
  if (rows.length === 0) return { ok: false, error: 'no_users_sheet' };
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][1] || '').trim().toLowerCase() === email.toLowerCase()) {
      return { ok: true, name: String(rows[i][0] || '').trim(), email: email };
    }
  }
  return { ok: false, error: 'not_registered', email: email };
}

// === 업무 LIST ===
// 컬럼: [id, 순서, 입력일, 대상유형(거래처/직접입력), 은행, 지점, 판매자명, 직책, 대상텍스트, 메모, 알람일시, 담당자이메일]
function getTasksSheet() {
  var ss = getSS();
  var sheet = ss.getSheetByName(SHEET_TASKS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TASKS);
    sheet.appendRow(['id', '순서', '입력일', '대상유형', '은행', '지점', '판매자명', '직책', '대상텍스트', '메모', '알람일시', '담당자이메일']);
  }
  return sheet;
}

function getTasksDoneSheet() {
  var ss = getSS();
  var sheet = ss.getSheetByName(SHEET_TASKS_DONE);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TASKS_DONE);
    sheet.appendRow(['id', '입력일', '대상유형', '은행', '지점', '판매자명', '직책', '대상텍스트', '메모', '알람일시', '담당자이메일', '처리일시']);
  }
  return sheet;
}

function taskRowToObj(r) {
  return {
    id: String(r[0] || ''), 순서: Number(r[1]) || 0, 입력일: String(r[2] || ''),
    대상유형: String(r[3] || ''), 은행: String(r[4] || ''), 지점: String(r[5] || ''),
    판매자명: String(r[6] || ''), 직책: String(r[7] || ''), 대상텍스트: String(r[8] || ''),
    메모: String(r[9] || ''), 알람일시: String(r[10] || ''), 담당자이메일: String(r[11] || '')
  };
}

// 내 업무 목록(우선순위 순)
function handleListTasks() {
  var email = getCurrentUserEmail().toLowerCase();
  // 시트가 아직 없으면 readRowsCached가 빈 배열을 주므로, 그때만 시트를 만든다.
  // (매번 getTasksSheet를 부르면 캐시가 있어도 스프레드시트를 여느라 느려진다)
  var rows = readRowsCached(SHEET_TASKS);
  if (rows.length === 0) { getTasksSheet(); rows = readRows(SHEET_TASKS); }
  var tasks = [];
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    if (!rows[i][0]) continue;
    tasks.push(taskRowToObj(rows[i]));
  }
  tasks.sort(function (a, b) { return a.순서 - b.순서; });
  return { ok: true, tasks: tasks };
}

// 새 업무 추가
function handleAddTask(data) {
  var email = getCurrentUserEmail();
  var sheet = getTasksSheet();
  var rows = readRows(SHEET_TASKS);
  var maxOrder = 0;
  for (var i = 1; i < rows.length; i++) {
    var o = Number(rows[i][1]) || 0;
    if (o > maxOrder) maxOrder = o;
  }
  var id = Utilities.getUuid();
  var todayLabel = resolveDateLabel('');
  var targetType = String(data.targetType || '거래처') === '직접입력' ? '직접입력' : '거래처';
  sheet.appendRow([
    id, maxOrder + 1, todayLabel, targetType,
    targetType === '거래처' ? String(data.bank || '').trim() : '',
    targetType === '거래처' ? String(data.branch || '').trim() : '',
    targetType === '거래처' ? String(data.seller || '').trim() : '',
    targetType === '거래처' ? String(data.title || '').trim() : '',
    targetType === '직접입력' ? String(data.targetText || '').trim() : '',
    String(data.memo || '').trim(),
    String(data.alarm || '').trim(),
    email
  ]);
  return { ok: true, id: id };
}

// 업무 내용 수정 (대상/메모 변경, 순서·입력일·알람은 유지)
function handleEditTask(id, data) {
  if (!id) return { ok: false, message: 'id가 없습니다.' };
  var sheet = getTasksSheet();
  var rows = readRows(SHEET_TASKS);
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      var targetType = String(data.targetType || '거래처') === '직접입력' ? '직접입력' : '거래처';
      var rowNum = i + 1;
      sheet.getRange(rowNum, 4, 1, 6).setValues([[
        targetType,
        targetType === '거래처' ? String(data.bank || '').trim() : '',
        targetType === '거래처' ? String(data.branch || '').trim() : '',
        targetType === '거래처' ? String(data.seller || '').trim() : '',
        targetType === '거래처' ? String(data.title || '').trim() : '',
        targetType === '직접입력' ? String(data.targetText || '').trim() : ''
      ]]);
      sheet.getRange(rowNum, 10, 1, 1).setValue(String(data.memo || '').trim());
      return { ok: true };
    }
  }
  return { ok: false, message: '해당 업무를 찾을 수 없습니다.' };
}

// 업무 완료 처리: 완료된업무로 이동
function handleCompleteTask(id) {
  if (!id) return { ok: false, message: 'id가 없습니다.' };
  var sheet = getTasksSheet();
  var rows = readRows(SHEET_TASKS);
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      var r = rows[i];
      var doneSheet = getTasksDoneSheet();
      var doneAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
      doneSheet.appendRow([r[0], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], doneAt]);
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, message: '해당 업무를 찾을 수 없습니다.' };
}

// 업무 우선순위 위/아래 이동: 같은 사용자 목록 내에서 인접한 항목과 순서값을 교체
function handleMoveTask(id, direction) {
  if (!id) return { ok: false, message: 'id가 없습니다.' };
  var email = getCurrentUserEmail().toLowerCase();
  var sheet = getTasksSheet();
  var rows = readRows(SHEET_TASKS);

  var mine = []; // { rowNum, id, order }
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][11] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    if (!rows[i][0]) continue;
    mine.push({ rowNum: i + 1, id: String(rows[i][0]), order: Number(rows[i][1]) || 0 });
  }
  mine.sort(function (a, b) { return a.order - b.order; });

  var idx = mine.findIndex(function (t) { return t.id === id; });
  if (idx === -1) return { ok: false, message: '해당 업무를 찾을 수 없습니다.' };
  var swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= mine.length) return { ok: true }; // 이미 맨 위/아래

  var a = mine[idx], b = mine[swapIdx];
  sheet.getRange(a.rowNum, 2).setValue(b.order);
  sheet.getRange(b.rowNum, 2).setValue(a.order);
  return { ok: true };
}

// 알람 일시 설정/변경
function handleSetTaskAlarm(id, alarm) {
  if (!id) return { ok: false, message: 'id가 없습니다.' };
  var sheet = getTasksSheet();
  var rows = readRows(SHEET_TASKS);
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      sheet.getRange(i + 1, 11).setValue(alarm || '');
      return { ok: true };
    }
  }
  return { ok: false, message: '해당 업무를 찾을 수 없습니다.' };
}

// 완료된 업무 목록(최근 처리 순)
function handleListCompletedTasks() {
  var email = getCurrentUserEmail().toLowerCase();
  var rows = readRowsCached(SHEET_TASKS_DONE);
  if (rows.length === 0) { getTasksDoneSheet(); rows = readRows(SHEET_TASKS_DONE); }
  var tasks = [];
  for (var i = 1; i < rows.length; i++) {
    var rowEmail = String(rows[i][10] || '').trim().toLowerCase();
    if (email && rowEmail && rowEmail !== email) continue;
    if (!rows[i][0]) continue;
    tasks.push({
      id: String(rows[i][0] || ''), 입력일: String(rows[i][1] || ''),
      대상유형: String(rows[i][2] || ''), 은행: String(rows[i][3] || ''), 지점: String(rows[i][4] || ''),
      판매자명: String(rows[i][5] || ''), 직책: String(rows[i][6] || ''), 대상텍스트: String(rows[i][7] || ''),
      메모: String(rows[i][8] || ''), 알람일시: String(rows[i][9] || ''), 담당자이메일: String(rows[i][10] || ''),
      처리일시: String(rows[i][11] || '')
    });
  }
  tasks.sort(function (a, b) { return b.처리일시.localeCompare(a.처리일시); });
  return { ok: true, tasks: tasks };
}

// 완료된 업무 완전 삭제
function handleDeleteCompletedTask(id) {
  if (!id) return { ok: false, message: 'id가 없습니다.' };
  var sheet = getTasksDoneSheet();
  var rows = readRows(SHEET_TASKS_DONE);
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) {
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, message: '해당 업무를 찾을 수 없습니다.' };
}

function callClaudeText(prompt) {
  var apiKey = getClaudeApiKey();
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });
  var json = JSON.parse(res.getContentText());
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.content[0].text;
}
